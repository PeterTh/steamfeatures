import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpression, formatExpression, expressionToBasic, basicExpression, expressionRequirements, expressionCompletions, expressionHighlights, EXPRESSION_LIMIT } from '../src/query-expression.mjs';
import { DEFAULT_QUERY, normalizeQuery, parseQuery, serializeQuery, runQuery, prepareCatalog, attachGameCredits } from '../src/query.mjs';
import { queryUsesPriority } from '../src/progressive-catalog.mjs';
import { extraFeatures } from '../src/extra-features.mjs';
import { LANGUAGES, encodeLanguageFlags } from '../src/languages.mjs';
import { encodeGameCredits } from '../scripts/game-credits.mjs';
import { decodeGameCredits } from '../src/game-credits.mjs';
import { expressionLineSteps, countExpressionLines } from '../src/query-line-counts.mjs';

const features = [
  { id: 18, key: 'partial-controller-support', short: 'PC', name: 'Partial controller support' },
  { id: 28, key: 'full-controller-support', short: 'FC', name: 'Full controller support' },
  { id: 23, key: 'steam-cloud', short: 'CLD', name: 'Steam Cloud' },
  ...extraFeatures,
];
const tags = ['Turn-Based Strategy', 'Turn-Based Tactics', 'RPG', 'A "quote" / & + #'];
const languages = LANGUAGES;
const game = (id, extra = {}) => ({ id, name: `Game ${id}`, featureDataKnown: true, featureIds: [], tagDataKnown: true, tagIds: [], releaseStatus: 'released', earlyAccess: false, releaseISO: '2020-06-15', reviews: 100, positivePercent: 90, ...extra });
const catalog = { features, tags, languages, games: [
  game(1, { name: 'Portal', featureIds: [28, 23, 10013], tagIds: [0], reviews: 10 }),
  game(2, { name: 'Portal 2', featureIds: [18], tagIds: [1], earlyAccess: true, reviews: 200 }),
  game(3, { name: 'PORTAL Stories', featureIds: [18, 28], tagIds: [0, 1, 2], releaseStatus: 'upcoming', reviews: 0 }),
  game(4, { name: 'Café / A "quote"', reviews: null, positivePercent: null, featureDataKnown: false, tagDataKnown: false, releaseISO: null, releaseStatus: 'unknown', earlyAccess: null }),
  game(5, { name: 'Another game', tagIds: [2], earlyAccess: null, reviews: 20, releaseISO: '2021-01-01' }),
] };
const ids = (expression, options, source = catalog) => runQuery(source, { expression, sort: 'title-asc' }, options).rows.map(g => g.id).sort((a, b) => a - b);

test('advanced URLs preserve line breaks, indentation, grouping, and literal spelling', () => {
  const expression = ' feature:FC \nAND (title:"Portal"\n  OR title:/^another/i)\n\nAND reviews >= 10\n';
  const query = normalizeQuery({ expression }, features, tags, languages);
  assert.equal(query.expression, expression);
  const encoded = serializeQuery(query, features, tags, languages);
  assert.match(encoded, /%0A/);
  assert.equal(parseQuery(encoded, features, tags, languages).expression, expression);
  assert.equal(runQuery(catalog, query).query.expression, expression);
  assert.equal(normalizeQuery({ expression: expression.replaceAll('\n', '\r\n') }, features, tags, languages).expression, expression);
});

test('line counts show cumulative results with nesting, regexes and missing or imported library lists', async () => {
  const text = 'feature:/controller-support/\nAND (tag:"Turn-Based Strategy" OR tag:"Turn-Based Tactics")\nAND ((reviews >= 10 AND rating >= 90) OR reviews >= 200)\nAND NOT release:early-access\nAND NOT library:owned';
  const prepared = prepareCatalog(catalog);
  assert.deepEqual((await countExpressionLines(text, prepared)).map(row => row.count), [3, 3, 2, 1, 1]);
  assert.deepEqual((await countExpressionLines(text, prepared, { owned: new Set([1]) })).map(row => row.count), [3, 3, 2, 1, 0]);
  assert.equal((await countExpressionLines(text, prepared, { owned: new Set() })).at(-1).count, 1);
  const mixed = 'title:Portal\nOR tag:RPG\nAND reviews >= 20\nAND NOT title:Another';
  assert.deepEqual((await countExpressionLines(mixed, prepared)).map(row => row.count), [3, 4, 4, 3]);
});

test('line counts skip incomplete prefixes and blank lines without closing groups or changing precedence', async () => {
  const text = '(\n title:Portal\n OR tag:RPG\n)\nAND (\n reviews >= 20\n OR library:owned\n)\n\n';
  assert.deepEqual(expressionLineSteps(text, catalog).map(step => step.line), [3, 7]);
  assert.deepEqual(await countExpressionLines(text, prepareCatalog(catalog)), [{ line: 3, count: 4 }, { line: 7, count: 2 }]);
  assert.deepEqual(await countExpressionLines('title:Portal AND\n reviews >= 20', prepareCatalog(catalog)), [{ line: 1, count: 1 }]);
  assert.deepEqual(await countExpressionLines('NOT (\n library:owned\n)\nOR title:Café', prepareCatalog(catalog)), [{ line: 2, count: 5 }, { line: 3, count: 1 }]);
  assert.deepEqual(await countExpressionLines('\n\n', prepareCatalog(catalog)), []);
  assert.throws(() => expressionLineSteps('title:Portal\nAND (', catalog));
});

test('optional line counting can be cancelled or time bounded and may reuse the final result', async () => {
  const prepared = prepareCatalog(catalog), text = 'title:Portal\nAND reviews >= 20';
  assert.equal(await countExpressionLines(text, prepared, {}, { cancelled: () => true }), null);
  await assert.rejects(countExpressionLines(text, prepared, {}, { budgetMs: 0 }), /too long/);
  assert.deepEqual(await countExpressionLines(text, prepared, {}, { finalTotal: 1 }), [{ line: 0, count: 3 }, { line: 1, count: 1 }]);
});

test('highlighting separates fields, operators and values without interpreting their contents', () => {
  const text = 'NOT (title:"AND tag: \\"quoted\\" <b>" OR title:/[a/](?:OR)\\/tag:/i) AND reviews >= 1e2 AND date < 2024-06';
  const tokens = expressionHighlights(text).map(({ start, end, kind }) => [text.slice(start, end), kind]);
  assert.deepEqual(tokens, [
    ['NOT', 'operator'], ['(', 'parenthesis'], ['title', 'field'], [':', 'punctuation'], ['"AND tag: \\"quoted\\" <b>"', 'value'],
    ['OR', 'operator'], ['title', 'field'], [':', 'punctuation'], ['/[a/](?:OR)\\/tag:/i', 'regex'], [')', 'parenthesis'],
    ['AND', 'operator'], ['reviews', 'field'], ['>=', 'operator'], ['1e2', 'number'], ['AND', 'operator'], ['date', 'field'], ['<', 'operator'], ['2024-06', 'number'],
  ]);
  for (const text of ['title:AND', 'title:reviews', 'language:english:audio']) {
    const tokens = expressionHighlights(text);
    assert.equal(tokens.at(-1).kind, 'value', text);
  }
});

test('parenthesis matching follows nested query groups, ignoring quoted and regex parentheses', () => {
  const text = 'title:"𐐷 (" AND (title:/[()](one|two)\\(/ OR (title:"\\" )" AND title:Portal))';
  const tokens = expressionHighlights(text).filter(token => token.kind === 'parenthesis');
  assert.equal(tokens.length, 4);
  assert.deepEqual(tokens.map(token => token.match), [tokens[3].start, tokens[2].start, tokens[1].start, tokens[0].start]);
  const draft = ') (title:Portal OR (title:"(")) (';
  const unfinished = expressionHighlights(draft).filter(token => token.kind === 'parenthesis');
  assert.equal(unfinished[0].match, undefined);
  assert.equal(unfinished.at(-1).match, undefined);
  assert.equal(unfinished[1].match, unfinished[4].start);
  assert.equal(unfinished[2].match, unfinished[3].start);
  assert.equal(expressionHighlights('title:"unfinished (').filter(token => token.kind === 'parenthesis').length, 0);
});

test('highlighting remains usable through incomplete and invalid drafts', () => {
  const draft = 'NOT (title:"Café \\"hi\\"" OR title:/[a/]\\/𐐷$/iu) AND reviews >= 20\n';
  for (let length = 0; length <= draft.length; length++) {
    const text = draft.slice(0, length), tokens = expressionHighlights(text);
    let previousEnd = 0;
    for (const token of tokens) {
      assert.ok(token.start >= previousEnd && token.end > token.start && token.end <= text.length, `Valid ranges at prefix ${length}`);
      assert.match(text.slice(previousEnd, token.start), /^\s*$/);
      previousEnd = token.end;
    }
    assert.match(text.slice(previousEnd), /^\s*$/);
  }
  for (const text of ['title:/[/', 'title:/(a+)+$/gg', 'title:"\\q"', 'reviews ! 20', 'title:/unfinished\\', 'title:"unfinished\\']) {
    assert.doesNotThrow(() => expressionHighlights(text));
    assert.throws(() => parseExpression(text, catalog));
  }
  assert.deepEqual(expressionHighlights('x'.repeat(EXPRESSION_LIMIT + 1)), []);
});

test('OR examples, arbitrary nesting, precedence, and no implicit basic constraints', () => {
  assert.deepEqual(ids('feature:FC OR feature:PC'), [1, 2, 3]);
  assert.deepEqual(ids('tag:"Turn-Based Strategy" OR tag:"Turn-Based Tactics"'), [1, 2, 3]);
  assert.deepEqual(ids('(feature:FC OR feature:PC) AND (reviews >= 100 OR release:upcoming)'), [2, 3]);
  assert.deepEqual(ids('feature:FC OR feature:PC AND reviews >= 100'), [1, 2, 3]);
  assert.deepEqual(ids('(feature:FC OR feature:PC) AND reviews >= 100'), [2]);
  assert.deepEqual(ids('NOT (tag:RPG OR feature:CLD)'), [2]);
  assert.deepEqual(ids(''), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids('reviews > 100 AND reviews < 10'), []);
  assert.deepEqual(ids('tag:RPG AND NOT tag:RPG'), []);
  const normalized = normalizeQuery({ expression: '', has: ['bad'], minReviews: 20, release: 'released' }, features, tags, languages);
  assert.equal(normalized.minReviews, 0); assert.equal(normalized.release, 'all'); assert.deepEqual(normalized.has, []);
});

test('unknown data stays unknown under negation; known OR branches and false AND branches determine results', () => {
  assert.deepEqual(ids('NOT feature:CLD'), [2, 3, 5]);
  assert.deepEqual(ids('NOT tag:RPG'), [1, 2]);
  assert.deepEqual(ids('NOT (feature:CLD OR NOT feature:CLD)'), []);
  assert.deepEqual(ids('title:"Café" OR feature:CLD'), [1, 4]);
  assert.deepEqual(ids('NOT (title:"Portal" AND feature:CLD)'), [2, 3, 4, 5]);
  assert.deepEqual(ids('NOT reviews >= 20'), [1, 3]);
  assert.deepEqual(ids('reviews >= 0'), [1, 2, 3, 5]);
  assert.deepEqual(ids('NOT deck:verified'), []);
});

test('regex strings, flags, escapes, classes, dictionary fields, and URL round trips', () => {
  for (const [expression, expected] of [
    ['title:/^portal(?: 2)?$/i', [1, 2]], ['title:/^Portal$/', [1]], ['title:/^portal$/', []],
    ['title:/[pP]ortal/', [1, 2]], ['title:/\\//', [4]], ['title:/[/]/', [4]],
    ['tag:/turn-based (strategy|tactics)/i', [1, 2, 3]], ['feature:/controller-support$/', [1, 2, 3]],
    ['feature:/^CLD$/', [1]], ['NOT tag:/RPG/', [1, 2]], ['deck:/verified|playable/', [1]],
    ['release:/^upcoming$/', [3]], ['title:"CAFÉ"', [4]], ['title:"[pP]ortal"', []],
  ]) {
    assert.deepEqual(ids(expression), expected, expression);
    const query = normalizeQuery({ expression, includeRemotePlay: true, sort: 'title-asc' }, features, tags, languages);
    assert.deepEqual(parseQuery(serializeQuery(query, features, tags, languages), features, tags, languages), query);
  }
  const special = 'title:' + JSON.stringify('A "quote" / & + #');
  assert.equal(formatExpression(parseExpression(special)), special);
  assert.equal(parseQuery('?v=2&expr=', features).expression, '');
  assert.deepEqual(parseQuery('', features), DEFAULT_QUERY);
  for (const url of ['?expr=title:Portal', '?v=2', '?v=2&expr=&has=CLD', '?v=2&expr=a&expr=b']) assert.throws(() => parseQuery(url, features));
});

test('invalid expressions have useful source positions and bounded syntax', () => {
  for (const expression of ['feature:no-such-feature', 'tag:"no-such-tag"', 'title:', 'NOT', '(title:a', 'title:a title:b', 'title:"oops', 'title:/[/', 'title:/(/', 'title:/x/g', 'title:/x/ii', 'rating > 101', 'reviews < 1.5', 'date = 2023-02-29', 'language:english:wrong', 'unknown:x']) {
    assert.throws(() => parseExpression(expression, catalog), error => Number.isInteger(error.start) && Number.isInteger(error.end), expression);
  }
  assert.throws(() => parseExpression(' '.repeat(EXPRESSION_LIMIT + 1)), /16,384/);
  assert.throws(() => parseExpression('NOT '.repeat(70) + 'title:a'), /nesting/);
  assert.throws(() => parseExpression(Array(513).fill('title:a').join(' OR ')), /512/);
  for (const text of ['title:a OR (title:b AND NOT title:c)', 'not (tag:rpg or feature:cld)', 'language:ENGLISH:audio', 'title:/a\\/b/i']) {
    const formatted = formatExpression(parseExpression(text, catalog));
    assert.equal(formatExpression(parseExpression(formatted, catalog)), formatted);
  }
});

test('missing library terms are structurally pruned, not replaced with true', () => {
  const options = { library: { owned: new Set([1, 2]), wishlist: new Set([2, 3]) } };
  assert.deepEqual(ids('library:owned OR library:wishlist', options), [1, 2, 3]);
  assert.deepEqual(ids('library:owned AND NOT library:wishlist', options), [1]);
  assert.deepEqual(ids('library:/owned|wishlist/', options), [1, 2, 3]);
  assert.deepEqual(ids('(library:owned OR tag:RPG) AND reviews >= 20'), [5]);
  assert.deepEqual(ids('NOT (library:owned OR tag:RPG)'), [1, 2]);
  assert.deepEqual(ids('NOT library:owned'), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids('library:owned OR library:wishlist', { library: { owned: new Set([1]) } }), [1]);
  assert.deepEqual(ids('library:owned', { library: { owned: new Set() } }), []);
  assert.deepEqual(ids('NOT library:owned', { library: { owned: new Set() } }), [1, 2, 3, 4, 5]);
  const result = runQuery(catalog, { expression: 'library:owned OR library:wishlist' }, options);
  assert.deepEqual(result.ignoredLibraries, []);
  assert.deepEqual(runQuery(catalog, { expression: 'NOT library:owned' }).ignoredLibraries, ['owned']);
  assert.equal(new URLSearchParams(serializeQuery(result.query, features, tags, languages)).get('expr'), 'library:owned OR library:wishlist');
  assert.equal('library' in result.query, false);
});

test('release periods, comparison boundaries and known-only exclusions', () => {
  assert.deepEqual(ids('date = 2020'), [1, 2, 3]);
  assert.deepEqual(ids('date > 2020'), [5]);
  assert.deepEqual(ids('date < 2021'), [1, 2, 3]);
  assert.deepEqual(ids('date != 2020-06'), [5]);
  assert.deepEqual(ids('release:released'), [1]);
  assert.deepEqual(ids('release:released-ea'), [1, 2, 5]);
  assert.deepEqual(ids('NOT release:released'), [2, 3]);
});

test('basic queries translate without changing results, including unknown values and library rules', () => {
  for (const patch of [{}, { minReviews: 0, release: 'all' }, { minReviews: 0, release: 'released-ea' }, { has: ['FC'], notTags: ['RPG'], release: 'all' }, { maxReviews: 20, minReviews: 0 }, { minRating: 0, release: 'all' }, { releaseFrom: '2020', releaseTo: '2020-06' }, { compatibility: { 'steam-deck': 'verified' } }]) {
    const query = normalizeQuery(patch, features, tags, languages), expression = basicExpression(query, catalog);
    assert.deepEqual(ids(expression), runQuery(catalog, query).rows.map(g => g.id).sort((a, b) => a - b), expression);
    const converted = expressionToBasic(expression, catalog);
    assert.deepEqual(converted.omitted, []);
    assert.deepEqual(ids(expression), runQuery(catalog, converted.filters).rows.map(g => g.id).sort((a, b) => a - b));
  }
});

test('basic conversion preserves conjunctions, negation, merged bounds and unknown-data semantics', () => {
  for (const text of ['NOT (feature:FC OR feature:CLD)', 'reviews > 10 AND reviews >= 20 AND reviews < 201', 'reviews >= 0', 'rating = 90', 'date = 2020', 'NOT date <= 2020', 'title:Portal AND title:"Portal 2"', 'tag:RPG AND (tag:RPG OR feature:CLD)', 'NOT NOT feature:FC', 'release:released-ea AND release:released']) {
    const conversion = expressionToBasic(text, catalog);
    assert.deepEqual(conversion.omitted, [], text);
    assert.deepEqual(runQuery(catalog, conversion.filters).rows.map(g => g.id).sort((a, b) => a - b), ids(text), text);
  }
  const converted = expressionToBasic('reviews >= 100 AND (tag:RPG OR feature:CLD) AND title:/portal/i', catalog);
  assert.equal(converted.filters.minReviews, 100); assert.equal(converted.filters.release, 'all'); assert.equal(converted.omitted.length, 2);
  assert.deepEqual(converted.filters.hasTags, []);
  for (const text of ['title:a AND title:b', 'feature:CLD AND NOT feature:CLD', 'reviews < 0', 'rating > 90']) assert.ok(expressionToBasic(text, catalog).omitted.length, text);
  assert.ok(expressionToBasic('library:owned', catalog, { owned: false }).omitted.length);
});

test('loading dependency proof follows every OR branch, including nested conditions', () => {
  for (const text of ['reviews >= 20', 'reviews > 19 AND tag:RPG', '(reviews >= 100 AND feature:FC) OR (reviews = 20 AND tag:RPG)']) assert.equal(queryUsesPriority({ expression: text }, catalog), true, text);
  for (const text of ['', 'reviews >= 100 OR tag:RPG', 'NOT reviews < 20', 'reviews > 10']) assert.equal(queryUsesPriority({ expression: text }, catalog), false, text);
  assert.equal(expressionRequirements(parseExpression('title:/Portal/ OR publisher:Valve')).credits, true);
  assert.equal(expressionRequirements(parseExpression('title:/Portal/')).regex, true);
});

test('basic conversion keeps effective conditions after pruning missing library lists', () => {
  const available = expressionToBasic('library:owned AND (library:owned OR tag:RPG)', catalog);
  assert.deepEqual(available.omitted, []);
  assert.equal(available.libraryFilters.owned, 'has');
  const missing = { owned: false, wishlist: false };
  for (const text of ['library:owned OR tag:RPG', 'library:owned AND (library:owned OR tag:RPG)', 'NOT (library:owned OR tag:RPG)', 'library:owned AND (tag:RPG OR library:wishlist)']) {
    const conversion = expressionToBasic(text, catalog, missing);
    assert.ok(conversion.omitted.some(term => term.includes('library:')), 'Removed symbolic library terms still get a warning');
    assert.deepEqual(runQuery(catalog, conversion.filters).rows.map(g => g.id).sort((a, b) => a - b), ids(text), text);
  }
  const regex = expressionToBasic('library:/owned/ AND (library:/owned/ OR tag:RPG)', catalog, missing);
  assert.ok(regex.omitted.some(term => term.includes('tag:RPG')), 'Regex library branches cannot silently absorb another condition');
});

test('completion handles incomplete quotes, middle edits, categories, languages, and regex boundaries', () => {
  const suggestions = expressionCompletions('tag:"Turn-Based St', 18, catalog);
  assert.ok(suggestions.some(s => s.text === '"Turn-Based Strategy"'));
  const middle = 'tag:"Turn-Based Tactics" AND reviews >= 20';
  const option = expressionCompletions(middle, 10, catalog).find(s => s.text === '"Turn-Based Strategy"');
  assert.ok(option); assert.equal(middle.slice(option.end), ' AND reviews >= 20');
  assert.deepEqual(expressionCompletions('title:/a', 8, catalog), []);
  for (const text of ['title:/hello tag:', 'title:"a tag:', 'title:/foo OR fea']) assert.deepEqual(expressionCompletions(text, text.length, catalog), [], text);
  assert.ok(expressionCompletions('language:english:a', 18, catalog).some(s => s.text === 'audio'));
  assert.ok(expressionCompletions('tag:RPG OR fea', 14, catalog).some(s => s.text === 'feature:'));
});

test('field completion replaces the whole field and preserves existing values and comparison operators', () => {
  for (const text of ['feature:steam-cloud AND title:Portal', 'reviews <= 200', 'rating != 90']) {
    const field = text.match(/^[a-z]+/)[0];
    for (const caret of [0, 3, field.length]) {
      const option = expressionCompletions(text, caret, catalog).find(s => s.label === field);
      assert.ok(option, text);
      assert.equal(text.slice(0, option.start) + option.text + text.slice(option.end), text);
    }
  }
  for (const text of ['\n  fea', '(\n  fea', 'tag:RPG AND\n  fea']) {
    const option = expressionCompletions(text, text.length, catalog).find(s => s.label === 'feature');
    assert.ok(option, text);
    assert.equal(text.slice(0, option.start) + option.text + text.slice(option.end), text.slice(0, -3) + 'feature:');
  }
});

test('language and credit conditions, including regex, distinguish missing from explicitly empty data', () => {
  const english = LANGUAGES.find(l => l.key === 'english').id, german = LANGUAGES.find(l => l.key === 'german').id;
  const source = { ...catalog, games: catalog.games.map(g => ({ ...g, ...(g.id === 4 ? {} : { languageBits: encodeLanguageFlags(g.id === 1 ? [[english, 7]] : g.id === 2 ? [[german, 3]] : []) }) })) };
  assert.deepEqual(ids('language:english:audio OR language:german:audio', undefined, source), [1, 2]);
  assert.deepEqual(ids('language:/english|german/:audio', undefined, source), [1, 2]);
  assert.deepEqual(ids('NOT language:english:audio', undefined, source), [2, 3, 5]);
  const basic = normalizeQuery({ release: 'all', minReviews: 0, hasLanguages: ['english:audio'], notLanguages: ['german:subtitles'] }, features, tags, languages);
  assert.deepEqual(ids(basicExpression(basic, source), undefined, source), [1]);
  const snapshot = 'a'.repeat(64), credits = new Map([[1, [['Valve'], ['Valve']]], [2, [['Valve', 'Other'], ['Company']]], [3, [[], []]], [4, [null, null]], [5, [['Another'], ['Valve']]]]);
  const prepared = attachGameCredits(prepareCatalog(source), decodeGameCredits(encodeGameCredits(source.games, credits, snapshot), snapshot));
  assert.deepEqual(ids('developer:/^valve$/i', undefined, prepared), [1, 2]);
  assert.deepEqual(ids('publisher:Valve AND NOT developer:Valve', undefined, prepared), [5]);
  assert.deepEqual(ids('NOT developer:/Valve/', undefined, prepared), [3, 5]);
  assert.deepEqual(ids('title:"Café" OR developer:Valve', undefined, prepared), [1, 2, 4]);
  assert.throws(() => ids('developer:Valve'), /has not loaded/);
  assert.deepEqual(ids('developer:""', undefined, prepared), [1, 2, 5]);
  assert.ok(expressionToBasic('developer:""', catalog).omitted.length, 'An empty name condition cannot become an inactive basic field');
});

test('worker uses named local lists inside expressions without applying the separate basic rules', async () => {
  const previous = globalThis.self, messages = []; let receive;
  globalThis.self = { addEventListener: (type, listener) => { if (type === 'message') receive = listener; }, postMessage: message => messages.push(message) };
  try {
    await import('../src/filter-worker.js?advanced-expression-worker-test');
    await receive({ data: { type: 'init', catalog: { ...catalog, version: 1 } } });
    await receive({ data: { type: 'library', rules: [{ appIds: [999], exclude: false }], lists: { owned: [5], wishlist: null } } });
    await receive({ data: { type: 'query', requestId: 1, query: { expression: 'library:owned OR title:/^portal$/i' } } });
    assert.deepEqual(messages.at(-1).result.rows.map(g => g.id).sort((a, b) => a - b), [1, 5]);
    await receive({ data: { type: 'library', rules: [], lists: { owned: null, wishlist: [] } } });
    await receive({ data: { type: 'query', requestId: 2, query: { expression: 'library:owned OR title:/^portal$/i' } } });
    assert.deepEqual(messages.at(-1).result.rows.map(g => g.id), [1]);
    assert.deepEqual(messages.at(-1).result.ignoredLibraries, ['owned']);
    const expression = 'title:Portal\nAND NOT library:owned';
    await receive({ data: { type: 'query', requestId: 3, query: { expression }, lineCounts: true } });
    assert.equal(messages.at(-3).type, 'result', 'Results arrive before line counting starts');
    assert.deepEqual(messages.at(-1).counts, [{ line: 0, count: 3 }, { line: 1, count: 3 }]);
    await receive({ data: { type: 'library', rules: [], lists: { owned: [1, 2], wishlist: [] } } });
    await receive({ data: { type: 'query', requestId: 4, query: { expression }, lineCounts: true } });
    assert.deepEqual(messages.at(-1).counts, [{ line: 0, count: 3 }, { line: 1, count: 1 }], 'Library changes invalidate cached counts');
    const beforeCounts = messages.length;
    await receive({ data: { type: 'line-counts', requestId: 4, query: { expression }, total: 1 } });
    assert.deepEqual(messages.slice(beforeCounts).map(message => message.type), ['line-counts-start', 'line-counts'], 'Counts can arrive after the background catalog without replacing results');
    const pending = receive({ data: { type: 'query', requestId: 5, query: { expression: 'title:Portal\nAND reviews >= 20' }, lineCounts: true } });
    await receive({ data: { type: 'query', requestId: 6, query: { expression: 'title:Another' } } });
    assert.equal(messages.at(-2).cancelled, true, 'Cancellation is acknowledged before a newer query completes');
    await pending;
    assert.equal(messages.at(-1).requestId, 5);
    assert.equal(messages.at(-1).cancelled, true, 'A newer query cancels earlier optional counting');
  } finally { globalThis.self = previous; }
});
