/** Shared, dependency-free catalog queries for the UI, worker, and Node tests. */
export const PAGE_SIZE = 50;
export const DEFAULT_QUERY = Object.freeze({
  q: '', has: Object.freeze([]), not: Object.freeze([]),
  hasTags: Object.freeze([]), notTags: Object.freeze([]), minReviews: 20,
  includeEarlyAccess: false, includeAccessibility: false, includeMultiplayer: false,
  release: 'released', sort: 'score-desc', page: 1,
});

export const PRESETS = Object.freeze([
  Object.freeze({
    id: 'feature-leaders', title: 'Feature leaders',
    description: 'Released games ranked by weighted advertised features.',
    query: DEFAULT_QUERY,
  }),
  Object.freeze({
    id: 'missing-cloud', title: 'Hall of shame',
    description: 'Released single-player games without the MMO badge or MMORPG tag, with more than 1,000 reviews and no Steam Cloud badge listed.',
    query: Object.freeze({ ...DEFAULT_QUERY, has: Object.freeze(['single-player']), not: Object.freeze(['steam-cloud', 'mmo']), notTags: Object.freeze(['MMORPG']), minReviews: 1001, sort: 'reviews-desc' }),
  }),
]);

const SORTS = new Set(['score', 'features', 'reviews', 'rating', 'title', 'release'].flatMap(field => [`${field}-asc`, `${field}-desc`]));
const RELEASES = new Set(['released', 'upcoming', 'all']);
const titleCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const preparedCatalogs = new WeakMap();
const preparedMarker = Symbol('prepared-catalog');

function featureIndex(features) {
  if (!Array.isArray(features)) throw new Error('The feature catalog is unavailable.');
  const byId = new Map();
  const byKey = new Map();
  for (const feature of features) {
    if (!Number.isSafeInteger(feature.id) || feature.id < 0 || typeof feature.key !== 'string' || !feature.key) {
      throw new Error('The catalog contains an invalid feature definition.');
    }
    if (feature.weight !== undefined && !Number.isFinite(feature.weight)) throw new Error('The catalog contains an invalid feature weight.');
    if (byId.has(feature.id) || byKey.has(feature.key)) throw new Error('The catalog contains duplicate features.');
    byId.set(feature.id, feature);
    byKey.set(feature.key, feature);
  }
  return { byId, byKey };
}

function wholeNumber(value, fallback, minimum, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    throw new Error(`${label} must be a whole number of at least ${minimum}.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${label} must be a whole number of at least ${minimum}.`);
  return number;
}

function booleanValue(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === '1' || value === 1 || value === 'true') return true;
  if (value === false || value === '0' || value === 0 || value === 'false') return false;
  throw new Error(`${label} must be true or false.`);
}

function featureList(value, index, label) {
  if (value === undefined || value === null || value === '') return [];
  const entries = Array.isArray(value) ? value : [value];
  const ids = new Set();
  for (const entry of entries) {
    const feature = typeof entry === 'number' ? index.byId.get(entry) : index.byKey.get(String(entry).trim());
    if (!feature) throw new Error(`Unknown ${label} feature: ${String(entry)}.`);
    ids.add(feature.id);
  }
  return [...ids].sort((a, b) => a - b);
}

function tagIndex(tags) {
  if (!Array.isArray(tags)) throw new Error('The catalog contains an invalid tag dictionary.');
  const index = new Map();
  tags.forEach((tag, id) => {
    if (typeof tag !== 'string' || !tag.trim()) throw new Error('The catalog contains an invalid tag name.');
    if (index.has(tag)) throw new Error('The catalog contains duplicate tag names.');
    index.set(tag, id);
  });
  return index;
}

function tagList(value, index, label) {
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value) ? value : [value];
  const names = new Set();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !index.has(entry)) throw new Error(`Unknown ${label} tag: ${String(entry)}.`);
    names.add(entry);
  }
  return [...names].sort();
}

/** has/not accept canonical numeric IDs or stable feature keys; output uses IDs. */
export function normalizeQuery(input = {}, features, tags = []) {
  const index = featureIndex(features);
  const tagsByName = tagIndex(tags);
  const source = input ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid query.');
  const has = featureList(source.has, index, 'required');
  const not = featureList(source.not, index, 'excluded');
  const conflict = has.find(id => not.includes(id));
  if (conflict !== undefined) throw new Error(`A feature cannot be both required and excluded: ${index.byId.get(conflict).name}.`);
  const hasTags = tagList(source.hasTags, tagsByName, 'required');
  const notTags = tagList(source.notTags, tagsByName, 'excluded');
  const tagConflict = hasTags.find(tag => notTags.includes(tag));
  if (tagConflict !== undefined) throw new Error(`A tag cannot be both required and excluded: ${tagConflict}.`);
  const release = source.release ?? DEFAULT_QUERY.release;
  const sort = source.sort ?? DEFAULT_QUERY.sort;
  if (!RELEASES.has(release)) throw new Error(`Unknown release filter: ${String(release)}.`);
  if (!SORTS.has(sort)) throw new Error(`Unknown sort order: ${String(sort)}.`);
  return {
    q: String(source.q ?? '').normalize('NFKC').trim(), has, not, hasTags, notTags,
    minReviews: wholeNumber(source.minReviews, DEFAULT_QUERY.minReviews, 0, 'Minimum reviews'),
    includeEarlyAccess: booleanValue(source.includeEarlyAccess, DEFAULT_QUERY.includeEarlyAccess, 'Early Access'),
    includeAccessibility: booleanValue(source.includeAccessibility, DEFAULT_QUERY.includeAccessibility, 'Accessibility'),
    includeMultiplayer: booleanValue(source.includeMultiplayer, DEFAULT_QUERY.includeMultiplayer, 'Multiplayer'),
    release, sort,
    page: wholeNumber(source.page, DEFAULT_QUERY.page, 1, 'Page'),
  };
}

/** Read a query string or URLSearchParams; unknown feature filters never silently disappear. */
export function parseQuery(search = '', features, tags = []) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(String(search).replace(/^\?/, '').split('#')[0]);
  function single(key) {
    const values = params.getAll(key);
    if (new Set(values).size > 1) throw new Error(`Conflicting values for URL parameter: ${key}.`);
    return values[0];
  }
  const version = single('v');
  if (version !== undefined && version !== '1') throw new Error(`Unsupported query version: ${version}.`);
  const split = key => params.getAll(key).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
  return normalizeQuery({
    q: single('q'), has: split('has'), not: split('not'), minReviews: single('minReviews'),
    hasTags: params.getAll('tag'), notTags: params.getAll('notTag'),
    includeEarlyAccess: single('ea'), includeAccessibility: single('a11y'), includeMultiplayer: single('mp'),
    release: single('release'), sort: single('sort'), page: single('page'),
  }, features, tags);
}

/** Return a canonical query string, including its leading '?' (or '' for defaults). */
export function serializeQuery(input, features, tags = []) {
  const query = normalizeQuery(input, features, tags);
  const index = featureIndex(features);
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.has.length) params.set('has', query.has.map(id => index.byId.get(id).key).sort().join(','));
  if (query.not.length) params.set('not', query.not.map(id => index.byId.get(id).key).sort().join(','));
  for (const tag of query.hasTags) params.append('tag', tag);
  for (const tag of query.notTags) params.append('notTag', tag);
  if (query.minReviews !== DEFAULT_QUERY.minReviews) params.set('minReviews', String(query.minReviews));
  if (query.includeEarlyAccess) params.set('ea', '1');
  if (query.includeAccessibility) params.set('a11y', '1');
  if (query.includeMultiplayer) params.set('mp', '1');
  if (query.release !== DEFAULT_QUERY.release) params.set('release', query.release);
  if (query.sort !== DEFAULT_QUERY.sort) params.set('sort', query.sort);
  if (query.page !== DEFAULT_QUERY.page) params.set('page', String(query.page));
  return params.size ? `?v=1&${params.toString()}` : '';
}

function knownReviews(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function knownRating(value, reviews) {
  return reviews !== 0 && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/** Inverted tag postings use row deltas to keep the downloaded JSON compact. */
function decodeTagIndex(catalog, tagCount) {
  if (catalog.tagIndex === undefined) return null;
  const index = catalog.tagIndex;
  if (!index || typeof index !== 'object' || Array.isArray(index) || index.encoding !== 'delta-game-indices-v1') {
    throw new Error('The catalog contains an unsupported tag index encoding.');
  }
  if (!Array.isArray(index.lists) || index.lists.length !== tagCount) throw new Error('The tag index does not match the tag dictionary.');
  if (catalog.games.some(game => game && Object.hasOwn(game, 'tagIds'))) throw new Error('The catalog mixes tag index and per-game tag membership.');
  const rows = Array.from({ length: catalog.games.length }, () => []);
  index.lists.forEach((deltas, tagId) => {
    if (!Array.isArray(deltas)) throw new Error(`Invalid tag index list ${tagId}.`);
    let row = 0;
    deltas.forEach((delta, position) => {
      if (!Number.isSafeInteger(delta) || delta < 0 || (position > 0 && delta === 0)) throw new Error(`Invalid tag index delta for tag ${tagId}.`);
      row += delta;
      if (row >= rows.length) throw new Error(`Tag index row is out of bounds for tag ${tagId}.`);
      rows[row].push(tagId);
    });
  });
  return rows;
}

/** Build reusable indexes once per catalog, without mutating the supplied data. */
export function prepareCatalog(catalog) {
  if (catalog?.[preparedMarker]) return catalog;
  if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.games)) throw new Error('Invalid game catalog.');
  if (preparedCatalogs.has(catalog)) return preparedCatalogs.get(catalog);
  const index = featureIndex(catalog.features);
  const tags = catalog.tags === undefined ? [] : catalog.tags;
  const tagsByName = tagIndex(tags);
  const decodedTagIds = decodeTagIndex(catalog, tags.length);
  const tagCounts = Array(tags.length).fill(0);
  let knownTagCount = 0;
  const ids = new Set();
  const games = catalog.games.map((game, rowIndex) => {
    if (!Number.isSafeInteger(game.id) || game.id <= 0 || ids.has(game.id)) throw new Error('The catalog contains invalid or duplicate game IDs.');
    ids.add(game.id);
    const featureIds = [...new Set(game.featureIds ?? [])];
    if (featureIds.some(id => !index.byId.has(id))) throw new Error(`Unknown feature in game ${game.id}.`);
    if (game.tagIds != null && !Array.isArray(game.tagIds)) throw new Error(`Invalid tag membership in game ${game.id}.`);
    const tagIds = decodedTagIds ? decodedTagIds[rowIndex] : [...new Set(game.tagIds ?? [])].sort((a, b) => a - b);
    if (tagIds.some(id => !Number.isSafeInteger(id) || id < 0 || id >= tags.length)) throw new Error(`Invalid tag index in game ${game.id}.`);
    const tagDataKnown = tagIds.length > 0 || game.tagDataKnown === true;
    if (tagDataKnown) knownTagCount += 1;
    for (const id of tagIds) tagCounts[id] += 1;
    const known = game.featureDataKnown === true;
    // Precompute all four toggle combinations once; sorting never sums features.
    const counts = known ? [0, 0, 0, 0] : [null, null, null, null];
    const scores = known ? [0, 0, 0, 0] : [null, null, null, null];
    if (known) for (const id of featureIds) {
      const feature = index.byId.get(id);
      const group = (feature.accessibility ? 1 : 0) | (feature.multiplayer ? 2 : 0);
      for (let mask = 0; mask < 4; mask += 1) if ((group & mask) === group) {
        counts[mask] += 1;
        scores[mask] += feature.weight ?? 1;
      }
    }
    const reviews = knownReviews(game.reviews);
    return {
      game: { ...game, featureIds, tagIds, tagDataKnown },
      title: String(game.name ?? '').normalize('NFKC').toLocaleLowerCase('en'),
      reviews,
      rating: knownRating(game.positivePercent, reviews),
      counts, scores,
      release: typeof game.releaseISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(game.releaseISO) ? game.releaseISO : null,
    };
  });
  const prepared = { [preparedMarker]: true, features: catalog.features, tags, tagsByName, tagCounts, knownTagCount, games };
  preparedCatalogs.set(catalog, prepared);
  return prepared;
}

function compareNullable(a, b, direction = -1) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction * (typeof a === 'string' ? a.localeCompare(b) : a - b);
}

/** Pure query operation; feature constraints are independent of visible columns. */
export function runQuery(catalog, input = DEFAULT_QUERY) {
  const prepared = prepareCatalog(catalog);
  const query = normalizeQuery(input, prepared.features, prepared.tags);
  const requiredTags = query.hasTags.map(tag => prepared.tagsByName.get(tag));
  const excludedTags = query.notTags.map(tag => prepared.tagsByName.get(tag));
  const [sortField, sortDirection] = query.sort.split('-');
  const direction = sortDirection === 'asc' ? 1 : -1;
  const title = query.q.toLocaleLowerCase('en');
  const mask = (query.includeAccessibility ? 1 : 0) | (query.includeMultiplayer ? 2 : 0);
  const count = row => row.counts[mask];
  const score = row => row.scores[mask];
  const visibleFeatures = prepared.features.filter(feature =>
    (query.includeAccessibility || !feature.accessibility) && (query.includeMultiplayer || !feature.multiplayer));
  const matches = prepared.games.filter(row => {
    const game = row.game;
    if (!query.includeEarlyAccess && game.earlyAccess !== false) return false;
    if (query.release !== 'all' && game.releaseStatus !== query.release) return false;
    if (title && !row.title.includes(title)) return false;
    if (query.minReviews > 0 && (row.reviews === null || row.reviews < query.minReviews)) return false;
    if ((query.has.length || query.not.length) && game.featureDataKnown !== true) return false;
    if (query.has.some(id => !game.featureIds.includes(id))) return false;
    if (query.not.some(id => game.featureIds.includes(id))) return false;
    if ((requiredTags.length || excludedTags.length) && !game.tagDataKnown) return false;
    if (requiredTags.some(id => !game.tagIds.includes(id))) return false;
    if (excludedTags.some(id => game.tagIds.includes(id))) return false;
    return true;
  });
  const byScore = (a, b) => compareNullable(score(a), score(b));
  const byFeatures = (a, b) => compareNullable(count(a), count(b));
  const byReviews = (a, b) => compareNullable(a.reviews, b.reviews);
  const byTitle = (a, b) => titleCollator.compare(a.game.name, b.game.name);
  matches.sort((a, b) => {
    let primary = 0;
    if (sortField === 'score') primary = compareNullable(score(a), score(b), direction);
    else if (sortField === 'features') primary = compareNullable(count(a), count(b), direction);
    else if (sortField === 'reviews') primary = compareNullable(a.reviews, b.reviews, direction);
    else if (sortField === 'rating') primary = compareNullable(a.rating, b.rating, direction);
    else if (sortField === 'title') primary = direction * byTitle(a, b);
    else if (sortField === 'release') primary = compareNullable(a.release, b.release, direction);
    if (sortField === 'features' || sortField === 'rating') return primary || byReviews(a, b) || byTitle(a, b) || a.game.id - b.game.id;
    return primary || byScore(a, b) || byFeatures(a, b) || byReviews(a, b) || byTitle(a, b) || a.game.id - b.game.id;
  });
  const total = matches.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(query.page, pageCount);
  const start = (page - 1) * PAGE_SIZE;
  let currentRank = 0;
  let previousRankValue;
  const competitionRanks = sortField === 'score' || sortField === 'features';
  const rows = [];
  for (let position = 0; position < Math.min(total, start + PAGE_SIZE); position += 1) {
    const row = matches[position];
    const rankValue = sortField === 'features' ? count(row) : score(row);
    if (rankValue !== previousRankValue || position === 0) currentRank = position + 1;
    previousRankValue = rankValue;
    if (position >= start) rows.push({
      ...row.game, reviews: row.reviews, positivePercent: row.rating, count: count(row), score: score(row),
      rank: competitionRanks ? (rankValue === null ? null : currentRank) : position + 1,
    });
  }
  return {
    query: { ...query, page }, total, page, pageCount, rows,
    columns: visibleFeatures.map(feature => feature.id),
    maxScore: visibleFeatures.reduce((totalScore, feature) => totalScore + Math.max(feature.weight ?? 1, 0), 0),
    minScore: visibleFeatures.reduce((totalScore, feature) => totalScore + Math.min(feature.weight ?? 1, 0), 0),
  };
}
