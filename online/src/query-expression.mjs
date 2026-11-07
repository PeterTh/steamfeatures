/** Boolean queries. Parsing is safe on the UI thread; regex matching runs only in the catalog worker. */
import { isFeatureKnown } from './extra-features.mjs';
import { compatibilityTargets } from './feature-presentation.mjs';
import { featureCodes } from './feature-codes.mjs';
import { LANGUAGE_KINDS, languageFlags } from './languages.mjs';
import { normalizeCreditSearch } from './game-credits.mjs';

export const EXPRESSION_LIMIT = 16384;
export const RELEASE_VALUES = ['released', 'released-ea', 'early-access', 'upcoming', 'all'];
export const EXPRESSION_FIELDS = ['feature', 'tag', 'title', 'developer', 'publisher', 'reviews', 'rating', 'release', 'date', ...compatibilityTargets.map(t => t.parameter), 'language', 'library'];
const numeric = new Set(['reviews', 'rating', 'date']);
const fold = value => String(value).normalize('NFKC').toLowerCase();
const negate = value => value === null ? null : !value;
const or = values => values.includes(true) ? true : values.includes(null) ? null : false;
const opposite = { '=': '!=', '!=': '=', '>': '<=', '>=': '<', '<': '>=', '<=': '>' };

export class ExpressionError extends Error {
  constructor(message, start = 0, end = start + 1) { super(message); this.name = 'ExpressionError'; this.start = start; this.end = end; }
}

export function knownReleaseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] ? value : null;
}
export function resolveReleaseBound(value, end = false) {
  if (typeof value === 'string' && /^\d{4}$/.test(value)) value += end ? '-12-31' : '-01-01';
  else if (typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)) {
    let day = end ? 31 : 1;
    while (day > 28 && knownReleaseDate(`${value}-${day}`) === null) day--;
    value += `-${String(day).padStart(2, '0')}`;
  }
  return knownReleaseDate(value);
}

function tokenize(text, highlighting = false) {
  const tokens = []; let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    const start = i, char = text[i++];
    if ('():'.includes(char)) tokens.push({ type: char, value: char, start, end: i });
    else if ('<>!='.includes(char)) {
      if (text[i] === '=') i++;
      const value = text.slice(start, i);
      if (!highlighting && !['=', '!=', '<', '<=', '>', '>='].includes(value)) throw new ExpressionError('Expected a comparison operator.', start, i);
      tokens.push({ type: 'compare', value, start, end: i });
    } else if (char === '"') {
      let closed = false;
      while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i++] === '"') { closed = true; break; } }
      if (!closed && !highlighting) throw new ExpressionError('Close this quoted value with a double quote.', start, text.length);
      i = Math.min(i, text.length);
      let value = text.slice(start, i);
      if (!highlighting) try { value = JSON.parse(value); } catch { throw new ExpressionError('Invalid quoted value. Escape quotes and backslashes with a backslash.', start, i); }
      tokens.push({ type: 'value', value, start, end: i });
    } else if (char === '/') {
      let bracket = false, closed = false;
      while (i < text.length) {
        const c = text[i++];
        if (c === '\\') { i++; continue; }
        if (c === '[') bracket = true;
        if (c === ']') bracket = false;
        if (c === '/' && !bracket) { closed = true; break; }
      }
      if (!closed && !highlighting) throw new ExpressionError('Close this regular expression with /. Escape a literal slash as \\/.', start, text.length);
      i = Math.min(i, text.length);
      const source = text.slice(start + 1, closed ? i - 1 : i), flagStart = i;
      while (/[a-z]/i.test(text[i] ?? '') && i < text.length) i++;
      const flags = text.slice(flagStart, i);
      if (!highlighting) {
        if (source.length > 2048) throw new ExpressionError('Regular expressions may contain up to 2,048 characters.', start, i);
        if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) throw new ExpressionError('Regex flags may be i, m, s, or u, once each. Stateful g and y flags are not supported.', flagStart, i);
        try { new RegExp(source, flags); } catch (error) { throw new ExpressionError(`Invalid regular expression: ${error.message}`, start, i); }
      }
      tokens.push({ type: 'regex', value: source, flags: [...flags].sort().join(''), start, end: i });
    } else {
      while (i < text.length && !/[\s():<>!=]/.test(text[i])) i++;
      tokens.push({ type: 'word', value: text.slice(start, i), start, end: i });
    }
  }
  tokens.push({ type: 'end', start: i, end: i }); return tokens;
}

/** Tolerate unfinished input and never compile regexes while coloring the editor. */
export function expressionHighlights(text) {
  if (text.length > EXPRESSION_LIMIT) return [];
  let previous;
  const tokens = tokenize(text, true).filter(token => token.type !== 'end').map(token => {
    let kind = 'punctuation';
    if (token.type === '(' || token.type === ')') kind = 'parenthesis';
    else if (token.type === 'regex') kind = 'regex';
    else if (token.type === 'value') kind = 'value';
    else if (token.type === 'compare') kind = 'operator';
    else if (token.type === 'word') {
      const isValue = previous?.type === ':' || previous?.type === 'compare';
      kind = !isValue && /^(AND|OR|NOT)$/i.test(token.value) ? 'operator'
        : !isValue && EXPRESSION_FIELDS.includes(token.value.toLowerCase()) ? 'field'
        : /^(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|\d{4}-\d{2}(?:-\d{2})?)$/.test(token.value) ? 'number' : 'value';
    }
    previous = token;
    return { start: token.start, end: token.end, kind };
  });
  const openings = [];
  for (const token of tokens) {
    if (token.kind !== 'parenthesis') continue;
    if (text[token.start] === '(') openings.push(token);
    else {
      const opening = openings.pop();
      if (opening) { opening.match = token.start; token.match = opening.start; }
    }
  }
  return tokens;
}

/** Validate syntax and literal dictionary values without executing user regexes. */
export function parseExpression(text, catalog) {
  if (typeof text !== 'string') throw new ExpressionError('The advanced query must be text.');
  if (text.length > EXPRESSION_LIMIT) throw new ExpressionError('The query may contain up to 16,384 characters.');
  const tokens = tokenize(text); let at = 0, atoms = 0;
  const peek = () => tokens[at];
  const keyword = word => peek().type === 'word' && peek().value.toUpperCase() === word;
  const take = type => { const token = tokens[at++]; if (token.type !== type) throw new ExpressionError(`Expected ${type === ')' ? 'a closing parenthesis' : type}.`, token.start, token.end); return token; };
  function primary(depth) {
    if (depth > 64) throw new ExpressionError('Use at most 64 levels of nesting.', peek().start);
    if (keyword('NOT')) { const token = tokens[at++]; return { type: 'not', child: primary(depth + 1), start: token.start }; }
    if (peek().type === '(') { at++; const child = expression(depth + 1); take(')'); return child; }
    const token = take('word'), field = token.value.toLowerCase();
    if (!EXPRESSION_FIELDS.includes(field)) throw new ExpressionError(`Unknown field: ${token.value}.`, token.start, token.end);
    const op = tokens[at++];
    if (numeric.has(field) ? op.type !== 'compare' : op.type !== ':') throw new ExpressionError(numeric.has(field) ? `Use a comparison such as ${field} >= 20.` : `Use ${field}:value.`, op.start, op.end);
    const value = tokens[at++];
    if (!['word', 'value', 'regex'].includes(value.type)) throw new ExpressionError(`Enter a value for ${field}.`, value.start, value.end);
    if (numeric.has(field) && value.type === 'regex') throw new ExpressionError('Regexes match string fields, not numbers or dates.', value.start, value.end);
    const node = { type: 'atom', field, op: op.value, value: value.value, start: token.start, end: value.end };
    if (value.type === 'regex') node.regex = value.flags;
    if (field === 'language') { take(':'); const kind = take('word'); node.kind = kind.value.toLowerCase(); node.end = kind.end; }
    if (++atoms > 512) throw new ExpressionError('Use at most 512 conditions.', token.start);
    validateAtom(node, catalog); return node;
  }
  function conjunction(depth) { const children = [primary(depth)]; while (keyword('AND')) { at++; children.push(primary(depth)); } return children.length === 1 ? children[0] : { type: 'and', children }; }
  function expression(depth) { const children = [conjunction(depth)]; while (keyword('OR')) { at++; children.push(conjunction(depth)); } return children.length === 1 ? children[0] : { type: 'or', children }; }
  if (peek().type === 'end') return { type: 'all' };
  const tree = expression(0);
  if (peek().type !== 'end') throw new ExpressionError('Expected AND, OR, or the end of the query.', peek().start, peek().end);
  return tree;
}

function validateAtom(node, catalog) {
  const fail = message => { throw new ExpressionError(message, node.start, node.end); };
  const { field } = node;
  if (field === 'date') { if (!resolveReleaseBound(node.value)) fail('Use a valid date: YYYY, YYYY-MM, or YYYY-MM-DD.'); return; }
  if (field === 'reviews' || field === 'rating') {
    const number = Number(node.value);
    if (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(node.value) || !Number.isFinite(number) || number < 0 || (field === 'reviews' ? !Number.isSafeInteger(number) : number > 100)) fail(field === 'reviews' ? 'Review counts must be nonnegative whole numbers.' : 'Ratings must be percentages from 0 to 100.');
    node.value = number; return;
  }
  if (field === 'language' && !LANGUAGE_KINDS.some(k => k.key === node.kind)) fail('Choose interface, audio, or subtitles for language support.');
  if (node.regex !== undefined) return;
  node.value = node.value.normalize('NFKC').trim();
  if (['title', 'developer', 'publisher'].includes(field)) return;
  let values;
  if (field === 'release') values = RELEASE_VALUES;
  else if (field === 'library') values = ['owned', 'wishlist'];
  else if (compatibilityTargets.some(t => t.parameter === field)) values = compatibilityTargets.find(t => t.parameter === field).ratings.map(r => r.value);
  else if (!catalog) return;
  else if (field === 'feature') {
    const features = catalog.features.filter(f => !f.hardware), codes = featureCodes(features);
    const feature = codes.resolve(node.value) ?? features.find(f => fold(f.key) === fold(node.value));
    if (!feature) fail(`Unknown feature: ${node.value}. Choose a feature key or table code.`);
    node.value = feature.key; return;
  } else if (field === 'tag') values = catalog.tags ?? [];
  else if (field === 'language') values = (catalog.languages ?? []).map(l => l.key);
  const match = values.find(value => fold(value) === fold(node.value));
  if (match === undefined) fail(`Unknown ${field}: ${node.value}.`);
  node.value = match;
}

export function formatExpression(node) {
  if (node.type === 'all') return '';
  if (node.type === 'atom') {
    const value = node.regex !== undefined ? `/${node.value}/${node.regex}` : numeric.has(node.field) ? String(node.value) : /^[\w.-]+$/.test(node.value) ? node.value : JSON.stringify(node.value);
    return `${node.field}${node.op === ':' ? ':' : ' ' + node.op + ' '}${value}${node.kind ? ':' + node.kind : ''}`;
  }
  if (node.type === 'not') return `NOT ${['atom', 'not'].includes(node.child.type) ? formatExpression(node.child) : '(' + formatExpression(node.child) + ')'}`;
  return node.children.map(child => ['and', 'or'].includes(child.type) && child.type !== node.type ? '(' + formatExpression(child) + ')' : formatExpression(child)).join(node.type === 'and' ? ' AND ' : ' OR ');
}

export function expressionRequirements(tree) {
  const fields = new Set(); let regex = false;
  function visit(node) { if (node.type === 'atom') { fields.add(node.field); regex ||= node.regex !== undefined; } else if (node.type === 'not') visit(node.child); else node.children?.forEach(visit); }
  visit(tree);
  function bound(node) {
    if (node.type === 'and') return Math.max(...node.children.map(bound));
    if (node.type === 'or') return Math.min(...node.children.map(bound));
    if (node.type !== 'atom' || node.field !== 'reviews') return 0;
    return node.op === '>' ? node.value + 1 : ['>=', '='].includes(node.op) ? node.value : 0;
  }
  return { credits: fields.has('developer') || fields.has('publisher'), library: fields.has('library'), regex, minReviews: bound(tree) };
}

function compare(actual, op, low, high = low) {
  if (actual === null) return null;
  if (op === '=') return actual >= low && actual <= high;
  if (op === '!=') return actual < low || actual > high;
  if (op === '>=') return actual >= low;
  if (op === '>') return actual > high;
  if (op === '<=') return actual <= high;
  return actual < low;
}
function releaseMatch(game, value) {
  if (value === 'all') return true;
  if (!['released', 'upcoming'].includes(game.releaseStatus)) return null;
  if (value === 'upcoming') return game.releaseStatus === 'upcoming';
  if (game.releaseStatus !== 'released') return false;
  if (value === 'released-ea') return true;
  return game.earlyAccess === true ? value === 'early-access' : game.earlyAccess === false ? value === 'released' : null;
}

/** This function executes patterns: call in a worker (or Node), never in the browser UI. */
export function compileExpression(tree, prepared, library = {}) {
  const ignoredLibraries = new Set();
  const regexMatch = node => {
    const regex = new RegExp(node.value, node.regex);
    return value => {
      try { return regex.test(value); }
      catch { throw new ExpressionError('A regular expression exceeded this browser’s matching limit. Simplify it and apply again.', node.start, node.end); }
    };
  };
  function compile(node) {
    if (node.type === 'all') return () => true;
    if (node.type === 'not') { const child = compile(node.child); return child ? row => negate(child(row)) : null; }
    if (node.children) {
      const children = node.children.map(compile).filter(Boolean);
      if (!children.length) return null;
      if (node.type === 'and') return row => { let unknown = false; for (const child of children) { const value = child(row); if (value === false) return false; unknown ||= value === null; } return unknown ? null : true; };
      return row => { let unknown = false; for (const child of children) { const value = child(row); if (value === true) return true; unknown ||= value === null; } return unknown ? null : false; };
    }
    const { field, value, op } = node, pattern = node.regex !== undefined ? regexMatch(node) : null;
    if (field === 'library') {
      const kinds = pattern ? ['owned', 'wishlist'].filter(pattern) : [value];
      const available = kinds.filter(kind => { if (library[kind] instanceof Set) return true; ignoredLibraries.add(kind); return false; });
      return kinds.length && !available.length ? null : row => available.some(kind => library[kind].has(row.game.id));
    }
    if (field === 'title') { const term = fold(value); return pattern ? row => pattern(row.game.name ?? '') : row => row.title.includes(term); }
    if (field === 'developer' || field === 'publisher') {
      if (!prepared.gameCredits) throw new Error('Developer and publisher data has not loaded.');
      const role = field === 'developer' ? 0 : 1;
      const names = pattern ? prepared.gameCredits.names.map(pattern) : prepared.creditSearchNames.map(name => name.includes(normalizeCreditSearch(value)));
      return row => row.credits?.[role] == null ? null : row.credits[role].some(id => names[id]);
    }
    if (field === 'reviews' || field === 'rating') return row => compare(row[field], op, value);
    if (field === 'date') { const low = resolveReleaseBound(value), high = resolveReleaseBound(value, true); return row => compare(row.release, op, low, high); }
    if (field === 'release') {
      const values = pattern ? RELEASE_VALUES.filter(pattern) : [value];
      return row => or(values.map(item => releaseMatch(row.game, item)));
    }
    if (field === 'feature') {
      const codes = featureCodes(prepared.features), features = prepared.features.filter(f => !f.hardware && (pattern ? [f.key, f.name, codes.token(f)].some(pattern) : f.key === value));
      return row => features.length ? or(features.map(f => isFeatureKnown(row.game, f) ? row.game.featureIds.includes(f.id) : null)) : row.game.featureDataKnown ? false : null;
    }
    if (field === 'tag') {
      const ids = new Set(prepared.tags.flatMap((tag, id) => (pattern ? pattern(tag) : tag === value) ? [id] : []));
      return row => row.game.tagDataKnown ? row.game.tagIds.some(id => ids.has(id)) : null;
    }
    if (field === 'language') {
      const languages = prepared.languages.filter(l => pattern ? [l.key, l.name].some(pattern) : l.key === value), bit = LANGUAGE_KINDS.find(k => k.key === node.kind).bit;
      return row => row.languageSupport === null ? null : languages.some(l => Boolean(languageFlags(row.languageSupport, l.id) & bit));
    }
    const target = compatibilityTargets.find(t => t.parameter === field), ids = target.ratings.filter(r => pattern ? pattern(r.value) : r.value === value).map(r => r.id);
    return row => target.ratings.some(r => row.game.featureIds.includes(r.id)) ? ids.some(id => row.game.featureIds.includes(id)) : null;
  }
  const predicate = compile(tree) ?? (() => true);
  return { matches: row => predicate(row) === true, ignoredLibraries: [...ignoredLibraries] };
}

export function basicExpression(query, catalog, libraryFilters = {}) {
  const parts = [], atom = (field, value, excluded = false) => parts.push(`${excluded ? 'NOT ' : ''}${field}:${JSON.stringify(value)}`);
  for (const [field, name] of [['q', 'title'], ['developer', 'developer'], ['publisher', 'publisher']]) if (query[field]) atom(name, query[field]);
  for (const kind of ['has', 'not']) for (const id of query[kind]) atom('feature', catalog.features.find(f => f.id === id).key, kind === 'not');
  for (const kind of ['hasTags', 'notTags']) for (const tag of query[kind]) atom('tag', tag, kind === 'notTags');
  for (const kind of ['hasLanguages', 'notLanguages']) for (const language of query[kind]) parts.push(`${kind === 'notLanguages' ? 'NOT ' : ''}language:${language}`);
  for (const [field, name, op] of [['minReviews', 'reviews', '>='], ['maxReviews', 'reviews', '<='], ['minRating', 'rating', '>='], ['maxRating', 'rating', '<=']]) {
    if (query[field] !== null && (field !== 'minReviews' || query[field] > 0)) parts.push(`${name} ${op} ${query[field]}`);
  }
  if (query.release !== 'all') atom('release', query.release);
  if (query.releaseFrom) parts.push(`date >= ${query.releaseFrom}`);
  if (query.releaseTo) parts.push(`date <= ${query.releaseTo}`);
  for (const target of compatibilityTargets) if (query.compatibility[target.key] !== 'ignore') atom(target.parameter, query.compatibility[target.key]);
  for (const kind of ['owned', 'wishlist']) if (libraryFilters[kind]) atom('library', kind, libraryFilters[kind] === 'not');
  return formatExpression(parseExpression(parts.join(' AND '), catalog));
}

function containsLibraryRegex(node) {
  if (node.type === 'atom') return node.field === 'library' && node.regex !== undefined;
  return node.type === 'not' ? containsLibraryRegex(node.child) : (node.children?.some(containsLibraryRegex) ?? false);
}

function simplify(node, negative = false) {
  if (node.type === 'not') return simplify(node.child, !negative);
  if (!node.children) return negative ? { type: 'not', child: node } : node;
  const type = negative ? node.type === 'and' ? 'or' : 'and' : node.type;
  let children = node.children.map(n => simplify(n, negative)).flatMap(n => n.type === type ? n.children : [n]);
  children = [...new Map(children.map(n => [formatExpression(n), n])).values()];
  // Absorption is valid for unknown values too; excluded-middle rewrites are not.
  // Library regexes may select only missing lists and be pruned instead of having a truth value.
  const keys = new Set(children.filter(child => !containsLibraryRegex(child)).map(formatExpression));
  children = children.filter(n => !n.children || !n.children.some(c => keys.has(formatExpression(c))));
  return children.length === 1 ? children[0] : { type, children };
}

/** Keep representable mandatory conjuncts. Never split an OR into separate requirements. */
export function expressionToBasic(text, catalog, availableLibrary = { owned: true, wishlist: true }) {
  const omitted = [], groups = new Map();
  function pruneMissing(node, negative = false) {
    if (node.type === 'atom' && node.field === 'library' && node.regex === undefined && !availableLibrary[node.value]) {
      omitted.push(formatExpression(negative ? { type: 'not', child: node } : node)); return null;
    }
    if (node.type === 'not') { const child = pruneMissing(node.child, !negative); return child ? { ...node, child } : null; }
    if (node.children) { const children = node.children.map(child => pruneMissing(child, negative)).filter(Boolean); return children.length ? { ...node, children } : null; }
    return node;
  }
  // Prune missing literal lists before simplification, without executing regexes on the UI thread.
  const tree = simplify(pruneMissing(parseExpression(text, catalog)) ?? { type: 'all' });
  const filters = { expression: null, q: '', developer: '', publisher: '', has: [], not: [], hasTags: [], notTags: [], hasLanguages: [], notLanguages: [], minReviews: 0, maxReviews: null, minRating: null, maxRating: null, release: 'all', releaseFrom: '', releaseTo: '', compatibility: Object.fromEntries(compatibilityTargets.map(t => [t.key, 'ignore'])) };
  const libraryFilters = { owned: '', wishlist: '' };
  for (const term of tree.type === 'and' ? tree.children : [tree]) {
    if (term.type === 'all') continue;
    const atom = term.type === 'not' ? term.child : term;
    if (atom.type !== 'atom' || atom.regex !== undefined) { omitted.push(formatExpression(term)); continue; }
    const key = ['feature', 'tag', 'language', 'library'].includes(atom.field) ? `${atom.field}:${atom.value}:${atom.kind ?? ''}` : atom.field;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...atom, negative: term.type === 'not', original: term });
  }
  for (const entries of groups.values()) {
    const first = entries[0], { field, value } = first;
    const lose = () => omitted.push(...entries.map(e => formatExpression(e.original)));
    if (['feature', 'tag', 'language', 'library'].includes(field)) {
      if (entries.some(e => e.negative !== first.negative) || (field === 'library' && !availableLibrary[value])) { lose(); continue; }
      if (field === 'library') libraryFilters[value] = first.negative ? 'not' : 'has';
      else if (field === 'feature') filters[first.negative ? 'not' : 'has'].push(catalog.features.find(f => f.key === value).id);
      else filters[field === 'tag' ? first.negative ? 'notTags' : 'hasTags' : first.negative ? 'notLanguages' : 'hasLanguages'].push(field === 'tag' ? value : `${value}:${first.kind}`);
      continue;
    }
    if (numeric.has(field)) {
      let low = null, high = null, valid = true;
      const lower = v => { low = low === null || v > low ? v : low; }, upper = v => { high = high === null || v < high ? v : high; };
      for (const e of entries) {
        let op = e.negative ? opposite[e.op] : e.op, v = e.value;
        if (op === '!=' || (field === 'rating' && ['<', '>'].includes(op))) { valid = false; break; }
        if (field === 'date') {
          const start = resolveReleaseBound(v), end = resolveReleaseBound(v, true);
          if (op === '=') { lower(start); upper(end); }
          else if (op === '>=') lower(start);
          else if (op === '<=') upper(end);
          else { const d = new Date((op === '>' ? end : start) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + (op === '>' ? 1 : -1)); const day = d.toISOString().slice(0, 10); if (!knownReleaseDate(day)) { valid = false; break; } (op === '>' ? lower : upper)(day); }
        } else {
          if (op === '>') { op = '>='; v++; } else if (op === '<') { op = '<='; v--; }
          if (v < 0 || !Number.isFinite(v) || (field === 'reviews' && !Number.isSafeInteger(v))) { valid = false; break; }
          if (op === '=' || op === '>=') lower(v);
          if (op === '=' || op === '<=') upper(v);
        }
      }
      if (!valid || (low !== null && high !== null && low > high)) { lose(); continue; }
      if (field === 'date') { filters.releaseFrom = low ?? ''; filters.releaseTo = high ?? ''; }
      else if (field === 'reviews') { filters.minReviews = low ?? 0; filters.maxReviews = high ?? (low === 0 ? Number.MAX_SAFE_INTEGER : null); }
      else { filters.minRating = low; filters.maxRating = high; }
      continue;
    }
    if (entries.some(e => e.negative)) { lose(); continue; }
    if (['title', 'developer', 'publisher'].includes(field)) {
      const strongest = entries.find(e => entries.every(other => fold(e.value).includes(fold(other.value))));
      if (!strongest || (field !== 'title' && !strongest.value)) lose(); else filters[field === 'title' ? 'q' : field] = strongest.value;
    } else if (field === 'release') {
      const values = [...new Set(entries.map(e => e.value).filter(v => v !== 'all'))];
      if (values.includes('released') || values.includes('early-access')) { const i = values.indexOf('released-ea'); if (i >= 0) values.splice(i, 1); }
      if (values.length > 1) lose(); else filters.release = values[0] ?? 'all';
    } else {
      if (entries.some(e => e.value !== value)) lose();
      else filters.compatibility[compatibilityTargets.find(t => t.parameter === field).key] = value;
    }
  }
  return { filters, libraryFilters, omitted };
}

/** Suggestions replace the value at the caret, not the rest of the expression. */
export function expressionCompletions(text, caret, catalog) {
  if (text.length > EXPRESSION_LIMIT) return [];
  const before = text.slice(0, caret);
  let unfinishedQuote = null;
  try { tokenize(before); } catch (error) {
    if (before[error.start] === '/') return [];
    if (before[error.start] === '"') unfinishedQuote = error.start;
  }
  // Work on the current incomplete term; don't offer completions inside a regex.
  const match = before.match(/(?:^|\s|\()([a-z]+):("(?:[^"\\]|\\.)*|[^\s():]*)$/i);
  let start, end = caret, options, fragment;
  if (match) {
    const field = match[1].toLowerCase(), typed = match[2];
    if (typed.startsWith('/')) return [];
    start = caret - typed.length; fragment = typed.replace(/^"/, '').replace(/\\"/g, '"');
    if (unfinishedQuote !== null && unfinishedQuote !== start) return [];
    if (text[start] === '"') { let i = Math.max(caret, start + 1); while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; } end = text[i] === '"' ? i + 1 : caret; }
    else { while (end < text.length && !/[\s():]/.test(text[end])) end++; }
    if (field === 'feature') options = catalog.features.filter(f => !f.hardware).map(f => ({ label: `${f.name} · ${f.short ?? f.key}`, value: f.key }));
    else if (field === 'tag') options = (catalog.tags ?? []).map(value => ({ label: value, value }));
    else if (field === 'language') options = (catalog.languages ?? []).map(l => ({ label: l.name, value: l.key, suffix: text[end] === ':' ? '' : ':interface' }));
    else {
      const values = field === 'release' ? RELEASE_VALUES : field === 'library' ? ['owned', 'wishlist'] : compatibilityTargets.find(t => t.parameter === field)?.ratings.map(r => r.value);
      if (!values) return [];
      options = values.map(value => ({ label: value, value }));
    }
    options = options.filter(o => fold(o.label + ' ' + o.value).includes(fold(fragment))).sort((a, b) => Number(!fold(a.label).startsWith(fold(fragment))) - Number(!fold(b.label).startsWith(fold(fragment))) || a.label.localeCompare(b.label));
    return options.slice(0, 12).map(o => ({ label: o.label, text: (/^[\w.-]+$/.test(o.value) ? o.value : JSON.stringify(o.value)) + (o.suffix ?? ''), start, end })).filter(option => option.text !== text.slice(start, end));
  }
  if (unfinishedQuote !== null) return [];
  const kind = before.match(/language:(?:[\w-]+|"[^"\n]*"):(\w*)$/i);
  if (kind) return LANGUAGE_KINDS.filter(k => k.key.startsWith(kind[1].toLowerCase())).map(k => ({ label: k.name, text: k.key, start: caret - kind[1].length, end: caret + (text.slice(caret).match(/^\w*/)?.[0].length ?? 0) }));
  const word = before.match(/(?:^\s*|\b(?:AND|OR|NOT)\s+|\(\s*)([a-z]*)$/i);
  if (!word) return [];
  end = caret + (text.slice(caret).match(/^[a-z]*/i)?.[0].length ?? 0);
  const separator = text.slice(end).match(/^\s*(?::|>=|<=|!=|=|>|<)\s*/)?.[0] ?? '';
  return EXPRESSION_FIELDS.filter(f => f.startsWith(word[1].toLowerCase())).map(field => ({
    label: field, start: caret - word[1].length, end: end + separator.length,
    text: field + (separator && separator.includes(':') !== numeric.has(field) ? separator : numeric.has(field) ? ' >= ' : ':'),
  }));
}
