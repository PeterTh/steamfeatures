import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_QUERY, PRESETS, normalizeQuery, parseQuery, serializeQuery, prepareCatalog, runQuery } from '../src/query.mjs';

const features = [
  { id: 1, key: 'multi-player', name: 'Multi-player', accessibility: false, multiplayer: true, weight: 1 },
  { id: 2, key: 'single-player', name: 'Single-player', accessibility: false, multiplayer: false, weight: 1 },
  { id: 22, key: 'steam-achievements', name: 'Steam Achievements', accessibility: false, multiplayer: false, weight: 2 },
  { id: 23, key: 'steam-cloud', name: 'Steam Cloud', accessibility: false, multiplayer: false, weight: 5 },
  { id: 64, key: 'adjustable-text-size', name: 'Adjustable Text Size', accessibility: true, multiplayer: false, weight: 5 },
];
const game = (id, name, extra = {}) => ({
  id, name, featureIds: [22], featureDataKnown: true, reviews: 100, positivePercent: 90,
  releaseDate: '1 Jan, 2020', releaseISO: '2020-01-01', releaseStatus: 'released', earlyAccess: false,
  genres: [], ...extra,
});
const catalog = {
  version: 1, features,
  games: [
    game(101, 'Alpha', { featureIds: [22, 23], releaseISO: '2018-01-01' }),
    game(102, 'Beta', { featureIds: [22, 64], reviews: 20, releaseISO: '2022-01-01' }),
    game(103, 'Gamma', { reviews: 19 }),
    game(104, 'Delta', { featureIds: [22, 23, 64], reviews: 1001, earlyAccess: true }),
    game(105, 'Missing features', { featureIds: [], featureDataKnown: false, reviews: null }),
    game(106, 'Unknown release', { releaseStatus: 'unknown', releaseISO: null }),
    game(107, 'Upcoming', { releaseStatus: 'upcoming', releaseISO: '2027-01-01' }),
    game(108, 'Unknown Early Access', { earlyAccess: null }),
    game(109, 'No review data', { featureIds: [1], reviews: null }),
    game(110, 'Repeated feature', { featureIds: [22, 22], reviews: 5 }),
  ],
};
const ids = result => result.rows.map(row => row.id);

test('default filters and review threshold include exactly 20', () => {
  const result = runQuery(catalog);
  assert.deepEqual(ids(result), [101, 102]);
  assert.deepEqual(result.rows.map(row => [row.count, row.rank]), [[2, 1], [1, 2]]);
  assert.deepEqual(result.rows.map(row => row.score), [7, 2]);
  assert.deepEqual(result.columns, [2, 22, 23]);
  assert.equal(result.maxScore, 8);
  assert.deepEqual(result.query, DEFAULT_QUERY);
});

test('required features mean all, excluded features mean none', () => {
  assert.deepEqual(ids(runQuery(catalog, { has: [22, 23] })), [101]);
  assert.deepEqual(ids(runQuery(catalog, { has: ['steam-achievements'], not: ['steam-cloud'] })), [102]);
  assert.deepEqual(ids(runQuery(catalog, { not: [23, 1], minReviews: 0 })), [102, 103, 110]);
});

test('unknown feature membership cannot satisfy a negative filter', () => {
  const input = { minReviews: 0 };
  const result = runQuery(catalog, input);
  const missing = result.rows.find(row => row.id === 105);
  assert.equal(missing.count, null);
  assert.equal(missing.score, null);
  assert.equal(missing.rank, null);
  assert.equal(result.rows.at(-1).id, 105);
  assert.ok(!ids(runQuery(catalog, { ...input, not: [23] })).includes(105));
});

test('unknown reviews stay unknown and only qualify without a threshold', () => {
  const result = runQuery(catalog, { minReviews: 0 });
  assert.equal(result.rows.find(row => row.id === 109).reviews, null);
  assert.ok(!ids(runQuery(catalog, { minReviews: 1 })).includes(109));
  const byReviews = runQuery(catalog, { minReviews: 0, sort: 'reviews-desc' });
  assert.ok(byReviews.rows.slice(-2).every(row => row.reviews === null));
});

test('accessibility changes score and columns independently of explicit constraints', () => {
  const without = runQuery(catalog, { has: [64] });
  const withAccessibility = runQuery(catalog, { has: [64], includeAccessibility: true });
  assert.deepEqual(ids(without), [102]);
  assert.equal(without.rows[0].count, 1);
  assert.equal(without.rows[0].score, 2);
  assert.equal(withAccessibility.rows[0].count, 2);
  assert.equal(withAccessibility.rows[0].score, 7);
  assert.deepEqual(withAccessibility.columns, [2, 22, 23, 64]);
  assert.equal(withAccessibility.maxScore, 13);
  assert.equal(runQuery(catalog, { includeAccessibility: true }).rows[1].rank, 1);
});

test('release and Early Access unknowns follow their explicit inclusion rules', () => {
  assert.deepEqual(ids(runQuery(catalog, { release: 'upcoming' })), [107]);
  assert.ok(ids(runQuery(catalog, { release: 'all' })).includes(106));
  assert.ok(ids(runQuery(catalog, { release: 'all' })).includes(108));
  const inclusive = ids(runQuery(catalog, { includeEarlyAccess: true }));
  assert.ok(inclusive.includes(104));
  assert.ok(inclusive.includes(108));
});

test('substring search is case-insensitive, Unicode-normalized, and literal', () => {
  const local = { features, games: [game(1, 'Café ＡＢＣ [x]'), game(2, 'Cafe abc')] };
  assert.deepEqual(ids(runQuery(local, { q: 'CAFÉ abc' })), [1]);
  assert.deepEqual(ids(runQuery(local, { q: '[x]' })), [1]);
  assert.deepEqual(ids(runQuery(local, { q: 'cafe\u0301' })), [1]);
  const unicode = { features, games: [game(1, '\u0130STANBUL'), game(2, '\u039f\u03a3'), game(3, '\u212aELVIN')] };
  assert.deepEqual(ids(runQuery(unicode, { q: 'i\u0307stanbul' })), [1]);
  assert.deepEqual(ids(runQuery(unicode, { q: '\u03bf\u03c2' })), [2]);
  assert.deepEqual(ids(runQuery(unicode, { q: 'kelvin' })), [3]);
});

test('competition ranks span page boundaries and sorting is deterministic', () => {
  const local = { features, games: Array.from({ length: 105 }, (_, index) => game(index + 1, `Game ${index + 1}`)) };
  const second = runQuery(local, { page: 2 });
  assert.equal(second.total, 105);
  assert.equal(second.pageCount, 3);
  assert.equal(second.rows.length, 50);
  assert.equal(second.rows[0].id, 51);
  assert.ok(second.rows.every(row => row.rank === 1));
  const clamped = runQuery(local, { page: 999 });
  assert.equal(clamped.page, 3);
  assert.equal(clamped.query.page, 3);
  assert.equal(clamped.rows.length, 5);
  assert.equal(runQuery(local, { page: 2, sort: 'title-asc' }).rows[0].rank, 51);
  for (const sort of ['score-asc', 'score-desc', 'features-asc', 'features-desc']) {
    const page = runQuery(local, { page: 2, sort });
    assert.ok(page.rows.every(row => row.rank === 1), sort);
  }
});

test('empty results use a clamped first page', () => {
  const result = runQuery(catalog, { q: 'not a game', page: 4 });
  assert.equal(result.total, 0);
  assert.equal(result.page, 1);
  assert.equal(result.pageCount, 1);
  assert.deepEqual(result.rows, []);
});

test('release sort uses structured dates and puts unknown dates last', () => {
  assert.deepEqual(ids(runQuery(catalog, { release: 'all', sort: 'release-desc' })), [107, 102, 104, 108, 101, 106]);
});

test('URL state round trips Unicode, punctuation, feature slugs, and pagination', () => {
  const query = normalizeQuery({
    q: 'é + & #', has: [22, 1], not: [64], minReviews: 0,
    includeEarlyAccess: true, includeAccessibility: true, includeMultiplayer: true, release: 'all', sort: 'reviews-desc', page: 3,
  }, features);
  const search = serializeQuery(query, features);
  assert.ok(search.startsWith('?v=1&'));
  assert.ok(search.includes('mp=1'));
  assert.deepEqual(parseQuery(search, features), query);
  assert.equal(serializeQuery(DEFAULT_QUERY, features), '');
  assert.deepEqual(parseQuery('', features), DEFAULT_QUERY);
  assert.deepEqual(parseQuery('?has=steam-cloud&has=steam-achievements,steam-cloud', features).has, [22, 23]);
  assert.equal(parseQuery('?q=cloud#section', features).q, 'cloud');
  assert.equal(parseQuery('?mp=0', features).includeMultiplayer, false);
  assert.equal(parseQuery('?sort=features-desc', features).sort, 'features-desc');
  assert.equal(parseQuery('', features).sort, 'score-desc');
});

test('invalid filters never silently broaden a shared query', () => {
  for (const search of [
    '?has=nonexistent', '?has=steam-cloud&not=steam-cloud', '?v=2', '?ea=maybe',
    '?page=0', '?page=1.5', '?minReviews=-1', '?minReviews=20&minReviews=0',
    '?sort=bogus', '?release=unknown', '?mp=maybe',
  ]) assert.throws(() => parseQuery(search, features), undefined, search);
});

test('preset excludes MMO badges and MMORPG tags and matches equivalent manual filters', () => {
  const local = { features: [...features, { id: 20, key: 'mmo', name: 'MMO', accessibility: false, multiplayer: true, weight: 1 }], tags: ['MMORPG', 'RPG'], games: [
    game(1, 'Exactly one thousand', { reviews: 1000, featureIds: [2, 22] }),
    game(2, 'Qualifies', { reviews: 1001, featureIds: [2, 22] }),
    game(3, 'Has Cloud', { reviews: 9999, featureIds: [2, 22, 23] }),
    game(4, 'Unknown features', { reviews: 9999, featureDataKnown: false, featureIds: [] }),
    game(5, 'Only multiplayer', { reviews: 9999, featureIds: [1, 22] }),
    game(6, 'Single-player and multiplayer', { reviews: 1002, featureIds: [1, 2, 22] }),
    game(7, 'MMO with a single-player badge', { reviews: 99999, featureIds: [2, 20, 22] }),
    game(8, 'MMORPG without the MMO badge', { reviews: 99999, featureIds: [2, 22], tagIds: [0] }),
    game(9, 'Single-player RPG', { reviews: 1003, featureIds: [2, 22], tagIds: [1] }),
    game(10, 'Unknown tags', { reviews: 99999, featureIds: [2, 22], tagDataKnown: false }),
  ].map(row => ({ tagDataKnown: true, ...row })) };
  const preset = PRESETS.find(item => item.id === 'missing-cloud');
  assert.equal(preset.title, 'Hall of shame');
  assert.deepEqual(runQuery(local, preset.query), runQuery(local, { minReviews: 1001, has: [2], not: [20, 23], notTags: ['MMORPG'], sort: 'reviews-desc' }));
  assert.deepEqual(ids(runQuery(local, preset.query)), [9, 6, 2]);
  assert.deepEqual(ids(runQuery(local, { ...preset.query, includeMultiplayer: true })), [9, 6, 2]);
  const search = serializeQuery(preset.query, local.features, local.tags);
  assert.ok(search.includes('notTag=MMORPG'));
  assert.deepEqual(runQuery(local, parseQuery(search, local.features, local.tags)), runQuery(local, preset.query));
  assert.throws(() => normalizeQuery(preset.query, local.features, ['RPG']), /Unknown excluded tag: MMORPG/);
});

test('preparation deduplicates membership, reuses indexes, and leaves input untouched', () => {
  const before = JSON.stringify(catalog);
  const prepared = prepareCatalog(catalog);
  assert.equal(prepareCatalog(catalog), prepared);
  assert.equal(prepareCatalog(prepared), prepared);
  assert.equal(runQuery(prepared, { q: 'repeated', minReviews: 0 }).rows[0].count, 1);
  assert.equal(JSON.stringify(catalog), before);
  assert.throws(() => prepareCatalog({ features, games: [game(1, 'A'), game(1, 'B')] }), /duplicate/);
});

test('weighted score can outrank a larger raw count, while raw count sorting stays available', () => {
  const local = { features, games: [
    game(1, 'One valuable feature', { featureIds: [23], reviews: 10000 }),
    game(2, 'Two lighter features', { featureIds: [2, 22], reviews: 20000 }),
    game(3, 'Same score with more reviews', { featureIds: [2, 22], reviews: 30000 }),
    game(4, 'Hidden accessibility only', { featureIds: [64] }),
    game(5, 'One light feature', { featureIds: [2] }),
  ] };
  const weighted = runQuery(local);
  assert.deepEqual(ids(weighted), [1, 3, 2, 5, 4]);
  assert.deepEqual(weighted.rows.map(row => [row.score, row.rank]), [[5, 1], [3, 2], [3, 2], [1, 4], [0, 5]]);
  const unweighted = runQuery(local, { sort: 'features-desc' });
  assert.deepEqual(ids(unweighted), [3, 2, 1, 5, 4]);
  assert.deepEqual(unweighted.rows.map(row => [row.count, row.rank]), [[2, 1], [2, 1], [1, 3], [1, 3], [0, 5]]);
});

test('multiplayer columns and score toggle independently of explicit require/exclude filters', () => {
  const local = { features, games: [
    game(1, 'Multiplayer only', { featureIds: [1] }),
    game(2, 'Achievements only', { featureIds: [22] }),
  ] };
  const hidden = runQuery(local, { has: [1] });
  assert.deepEqual(ids(hidden), [1]);
  assert.deepEqual([hidden.rows[0].count, hidden.rows[0].score, hidden.rows[0].rank], [0, 0, 1]);
  assert.ok(!hidden.columns.includes(1));
  const visible = runQuery(local, { has: [1], includeMultiplayer: true });
  assert.deepEqual(ids(visible), [1]);
  assert.deepEqual([visible.rows[0].count, visible.rows[0].score, visible.maxScore], [1, 1, 9]);
  assert.ok(visible.columns.includes(1));
  assert.deepEqual(ids(runQuery(local, { not: [1] })), [2]);
});

test('features belonging to both optional groups require both toggles for counting', () => {
  const local = {
    features: [...features, { id: 65, key: 'both-groups', name: 'Both groups', accessibility: true, multiplayer: true, weight: 3 }],
    games: [game(1, 'Both groups', { featureIds: [1, 22, 64, 65] })],
  };
  for (const [includeAccessibility, includeMultiplayer, count, score, maxScore] of [
    [false, false, 1, 2, 8], [true, false, 2, 7, 13],
    [false, true, 2, 3, 9], [true, true, 4, 11, 17],
  ]) {
    const result = runQuery(local, { includeAccessibility, includeMultiplayer, has: [65] });
    assert.equal(result.rows[0].count, count);
    assert.equal(result.rows[0].score, score);
    assert.equal(result.maxScore, maxScore);
    assert.equal(result.columns.includes(65), includeAccessibility && includeMultiplayer);
  }
});

test('score ties share rank even when counts differ; raw count ties use reviews instead of weights', () => {
  const local = { features, games: [
    game(1, 'One feature', { featureIds: [23], reviews: 1000 }),
    game(2, 'Two features', { featureIds: [22, 64], reviews: 100 }),
    game(3, 'Lighter one feature', { featureIds: [22], reviews: 10000 }),
  ] };
  local.features = features.map(feature => feature.id === 64 ? { ...feature, weight: 3 } : feature);
  const result = runQuery(local, { includeAccessibility: true });
  assert.deepEqual(ids(result), [2, 1, 3]);
  assert.deepEqual(result.rows.map(row => row.rank), [1, 1, 3]);
  assert.deepEqual(ids(runQuery(local, { includeAccessibility: true, sort: 'features-desc' })), [2, 3, 1]);
  const ascendingScore = runQuery(local, { includeAccessibility: true, sort: 'score-asc' });
  assert.deepEqual(ids(ascendingScore), [3, 2, 1]);
  assert.deepEqual(ascendingScore.rows.map(row => row.rank), [1, 2, 2]);
  const ascendingCount = runQuery(local, { includeAccessibility: true, sort: 'features-asc' });
  assert.deepEqual(ids(ascendingCount), [3, 1, 2]);
  assert.deepEqual(ascendingCount.rows.map(row => row.rank), [1, 1, 3]);
});

test('empty visible registry scores zero rather than unknown; malformed weights are rejected', () => {
  const local = { features: features.filter(feature => feature.multiplayer), games: [game(1, 'Only multiplayer', { featureIds: [1] })] };
  const result = runQuery(local);
  assert.deepEqual(result.columns, []);
  assert.equal(result.maxScore, 0);
  assert.deepEqual([result.rows[0].count, result.rows[0].score], [0, 0]);
  for (const weight of [NaN, Infinity, -Infinity, '2', '-1', null]) {
    assert.throws(() => runQuery({ ...local, features: [{ ...local.features[0], weight }] }), /weight/);
  }
  const legacy = { features: [{ id: 22, key: 'steam-achievements', name: 'Achievements' }], games: [game(1, 'Previous catalog')] };
  assert.equal(runQuery(legacy).rows[0].score, 1);
});

test('zero-weight badges stay visible and count once without increasing score', () => {
  const local = {
    features: [{ id: 60, key: 'gamepad-recommended', name: 'Gamepad Recommended', weight: 0, accessibility: false, multiplayer: false }],
    games: [game(1, 'Recommendation', { featureIds: [60, 60] }), game(2, 'Unknown', { featureIds: [], featureDataKnown: false })],
  };
  const result = runQuery(local);
  assert.deepEqual(result.columns, [60]);
  assert.equal(result.maxScore, 0);
  assert.deepEqual(result.rows.map(row => [row.count, row.score, row.rank]), [[1, 0, 1], [null, null, null]]);
});

test('all six criteria support both directions, stable ties, unknowns last, and URL round trips', () => {
  const local = { features, games: [
    game(1, 'Alpha', { featureIds: [22], reviews: 10, positivePercent: 80, releaseISO: '2022-01-01' }),
    game(2, 'Beta', { featureIds: [23], reviews: 20, positivePercent: 95, releaseISO: '2020-01-01' }),
    game(3, 'Gamma', { featureIds: [22, 23], reviews: 5, positivePercent: 50, releaseISO: '2021-01-01' }),
    game(4, 'Delta', { featureIds: [], featureDataKnown: false, reviews: null, positivePercent: null, releaseISO: null }),
  ] };
  const cases = [
    ['score-asc', [1, 2, 3, 4], [1, 2, 3, null]],
    ['score-desc', [3, 2, 1, 4], [1, 2, 3, null]],
    ['features-asc', [2, 1, 3, 4], [1, 1, 3, null]],
    ['features-desc', [3, 2, 1, 4], [1, 2, 2, null]],
    ['reviews-asc', [3, 1, 2, 4]], ['reviews-desc', [2, 1, 3, 4]],
    ['rating-asc', [3, 1, 2, 4]], ['rating-desc', [2, 1, 3, 4]],
    ['title-asc', [1, 2, 4, 3]], ['title-desc', [3, 4, 2, 1]],
    ['release-asc', [2, 3, 1, 4]], ['release-desc', [1, 3, 2, 4]],
  ];
  for (const [sort, expectedIds, ranks = [1, 2, 3, 4]] of cases) {
    const query = normalizeQuery({ sort, minReviews: 0 }, features);
    const parsed = parseQuery(serializeQuery(query, features), features);
    assert.deepEqual(parsed, query, `${sort} URL`);
    const result = runQuery(local, parsed);
    assert.deepEqual(ids(result), expectedIds, sort);
    assert.deepEqual(result.rows.map(row => row.rank), ranks, `${sort} ranks`);
  }
});

test('review scores distinguish real zero percent from zero reviews and keep invalid ratings last', () => {
  const local = { features, games: [
    game(1, 'All negative', { reviews: 5, positivePercent: 0 }),
    game(2, 'All positive', { reviews: 5, positivePercent: 100 }),
    game(3, 'No reviews', { reviews: 0, positivePercent: 0 }),
    game(4, 'No reviews with stale percentage', { reviews: 0, positivePercent: 100 }),
    game(5, 'Known percentage without a count', { reviews: null, positivePercent: 80.5 }),
    ...[undefined, null, NaN, Infinity, -Infinity, -1, 101, '90'].map((positivePercent, index) =>
      game(index + 6, `Invalid percentage ${index}`, { reviews: 10, positivePercent })),
  ] };
  const unknownIds = [6, 7, 8, 9, 10, 11, 12, 13, 3, 4];
  for (const [sort, knownIds] of [['rating-asc', [1, 5, 2]], ['rating-desc', [2, 5, 1]]]) {
    const result = runQuery(local, { sort, minReviews: 0 });
    assert.deepEqual(ids(result), [...knownIds, ...unknownIds], sort);
    assert.deepEqual(result.rows.map(row => row.rank), Array.from({ length: 13 }, (_, index) => index + 1));
    assert.ok(result.rows.slice(3).every(row => row.positivePercent === null));
    assert.equal(result.rows.find(row => row.id === 1).positivePercent, 0);
    assert.equal(result.rows.find(row => row.id === 5).positivePercent, 80.5);
  }
  assert.equal(runQuery(local, { q: 'No reviews', minReviews: 0 }).rows[0].positivePercent, null);
  assert.equal(local.games[3].positivePercent, 100, 'normalization must not mutate source data');
});

test('review score ties prefer more reviews then title and ID independently of feature toggles', () => {
  const local = { features, games: [
    game(1, 'Sparse but popular', { reviews: 1000, featureIds: [] }),
    game(2, 'Features but fewer reviews', { reviews: 100, featureIds: [1, 2, 22, 23, 64] }),
    game(4, 'Same title', { reviews: 50, featureIds: [23, 64] }),
    game(3, 'Same title', { reviews: 50, featureIds: [] }),
    game(5, 'Alphabetically earlier', { reviews: 50, featureIds: [] }),
    game(6, 'Unknown count', { reviews: null, featureIds: [1, 2, 22, 23, 64] }),
  ] };
  for (const sort of ['rating-asc', 'rating-desc']) {
    for (const includeAccessibility of [false, true]) for (const includeMultiplayer of [false, true]) {
      const result = runQuery(local, { sort, minReviews: 0, includeAccessibility, includeMultiplayer });
      assert.deepEqual(ids(result), [1, 2, 5, 3, 4, 6]);
      assert.deepEqual(result.rows.map(row => row.rank), [1, 2, 3, 4, 5, 6]);
    }
  }
});

test('negative-weight badges reduce score without reducing count or the positive upper bound', () => {
  const local = {
    features: [
      { id: 22, key: 'steam-achievements', name: 'Achievements', weight: 2 },
      { id: 35, key: 'in-app-purchases', name: 'In-App Purchases', weight: -1 },
    ],
    games: [
      game(1, 'No penalty', { featureIds: [22] }),
      game(2, 'With penalty', { featureIds: [22, 35] }),
      game(3, 'Only penalty', { featureIds: [35] }),
      game(4, 'No listed features', { featureIds: [] }),
      game(5, 'Unknown features', { featureIds: [], featureDataKnown: false }),
    ],
  };
  const descending = runQuery(local);
  assert.deepEqual(ids(descending), [1, 2, 4, 3, 5]);
  assert.deepEqual(descending.rows.map(row => [row.count, row.score, row.rank]), [[1, 2, 1], [2, 1, 2], [0, 0, 3], [1, -1, 4], [null, null, null]]);
  assert.equal(descending.maxScore, 2);
  assert.equal(descending.minScore, -1);
  const ascending = runQuery(local, { sort: 'score-asc' });
  assert.deepEqual(ids(ascending), [3, 4, 2, 1, 5]);
  assert.deepEqual(ascending.rows.map(row => row.rank), [1, 2, 3, 4, null]);
  assert.deepEqual(ids(runQuery(local, { has: [35] })), [2, 3]);
  assert.deepEqual(ids(runQuery(local, { not: [35] })), [1, 4]);
});
