import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_QUERY, normalizeQuery, parseQuery, serializeQuery, prepareCatalog, runQuery } from '../src/query.mjs';

const features = [
  { id: 1, key: 'multi-player', name: 'Multi-player', weight: 1, multiplayer: true },
  { id: 2, key: 'single-player', name: 'Single-player', weight: 1 },
  { id: 22, key: 'steam-achievements', name: 'Steam Achievements', weight: 2 },
  { id: 23, key: 'steam-cloud', name: 'Steam Cloud', weight: 3 },
];
const tags = ['Action', 'Co-op', 'Controller', 'Free to Play', 'RPG', 'RPG, Tactics', 'é + & #'].sort();
const tagIds = names => names.map(name => tags.indexOf(name));
const game = (id, name, extra = {}) => ({
  id, name, featureIds: [2, 22], featureDataKnown: true, reviews: 100,
  releaseStatus: 'released', earlyAccess: false, ...extra,
});
const catalog = { features, tags, games: [
  game(1, 'Alpha', { tagIds: tagIds(['Action', 'RPG']) }),
  game(2, 'Beta', { tagIds: tagIds(['Action', 'Co-op']), featureIds: [1, 22] }),
  game(3, 'Gamma', { tagIds: tagIds(['RPG']), featureIds: [2, 23] }),
  game(4, 'Missing tags'),
  game(5, 'Empty tags', { tagIds: [] }),
  game(6, 'Literal tag names', { tagIds: tagIds(['RPG, Tactics', 'é + & #']), featureIds: [22] }),
  game(7, 'Unknown features', { tagIds: tagIds(['Action']), featureIds: [], featureDataKnown: false }),
  game(8, 'Null tags', { tagIds: null }),
] };
const ids = result => result.rows.map(row => row.id).sort((a, b) => a - b);

function packTags(source) {
  const rowsByTag = source.tags.map(() => []);
  source.games.forEach((game, row) => {
    for (const id of new Set(game.tagIds ?? [])) rowsByTag[id].push(row);
  });
  return {
    ...source,
    games: source.games.map(({ tagIds, ...game }) => game),
    tagIndex: { encoding: 'delta-game-indices-v1', lists: rowsByTag.map(rows => rows.map((row, index) => row - (index ? rows[index - 1] : 0))) },
  };
}

test('tag requirements mean all and exclusions mean none, independently of feature knowledge', () => {
  assert.deepEqual(ids(runQuery(catalog, { hasTags: ['Action', 'RPG'] })), [1]);
  assert.deepEqual(ids(runQuery(catalog, { hasTags: ['Action'] })), [1, 2, 7]);
  assert.deepEqual(ids(runQuery(catalog, { notTags: ['Co-op'] })), [1, 3, 6, 7]);
  assert.deepEqual(ids(runQuery(catalog, { notTags: ['Co-op', 'RPG'] })), [6, 7]);
});

test('missing, null, and empty tag data cannot pass positive or negative tag constraints', () => {
  assert.equal(runQuery(catalog).total, 8);
  for (const query of [{ hasTags: ['RPG'] }, { notTags: ['Controller'] }]) {
    const result = ids(runQuery(catalog, query));
    for (const unknown of [4, 5, 8]) assert.ok(!result.includes(unknown));
  }
  assert.equal(runQuery(catalog, { hasTags: ['Controller'] }).total, 0);
});

test('explicitly known empty tags pass exclusions while legacy empty lists stay unknown', () => {
  const source = { features, tags, games: [
    game(1, 'Confirmed empty', { tagIds: [], tagDataKnown: true }),
    game(2, 'Legacy empty', { tagIds: [] }),
    game(3, 'Explicit unknown', { tagIds: [], tagDataKnown: false }),
    game(4, 'Listed tag overrides false flag', { tagIds: tagIds(['Action']), tagDataKnown: false }),
  ] };
  for (const candidate of [source, packTags(source)]) {
    const before = JSON.stringify(candidate);
    const prepared = prepareCatalog(candidate);
    assert.equal(prepared.knownTagCount, 2);
    assert.equal(prepared.tagCounts[tags.indexOf('Action')], 1);
    assert.deepEqual(ids(runQuery(prepared, { notTags: ['Action'] })), [1]);
    assert.deepEqual(ids(runQuery(prepared, { notTags: ['RPG'] })), [1, 4]);
    assert.deepEqual(ids(runQuery(prepared, { hasTags: ['Action'] })), [4]);
    assert.deepEqual(runQuery(prepared).rows.sort((a, b) => a.id - b.id).map(row => row.tagDataKnown), [true, false, false, true]);
    assert.equal(JSON.stringify(candidate), before);
  }
});

test('tag constraints combine with feature requirements, exclusions, and title search', () => {
  assert.deepEqual(ids(runQuery(catalog, { hasTags: ['Action'], has: [22], not: [1] })), [1]);
  assert.deepEqual(ids(runQuery(catalog, { hasTags: ['RPG'], not: [23] })), [1]);
  assert.deepEqual(ids(runQuery(catalog, { notTags: ['Co-op'], q: 'gamma', has: [23] })), [3]);
});

test('tag selection changes membership only, never feature scores, counts, columns, or bounds', () => {
  for (const includeMultiplayer of [false, true]) {
    const baseline = runQuery(catalog, { includeMultiplayer });
    const filtered = runQuery(catalog, { includeMultiplayer, hasTags: ['Action'] });
    assert.deepEqual(filtered.columns, baseline.columns);
    assert.equal(filtered.maxScore, baseline.maxScore);
    assert.equal(filtered.minScore, baseline.minScore);
    for (const row of filtered.rows) {
      const original = baseline.rows.find(game => game.id === row.id);
      assert.deepEqual([row.count, row.score, row.featureIds], [original.count, original.score, original.featureIds]);
    }
  }
});

test('tag URLs use repeated names and preserve commas, spaces, Unicode, plus, ampersand, and hash', () => {
  const query = normalizeQuery({ hasTags: ['é + & #', 'RPG, Tactics'], notTags: ['Free to Play', 'Co-op'] }, features, tags);
  const search = serializeQuery(query, features, tags);
  const params = new URLSearchParams(search);
  assert.deepEqual(params.getAll('tag'), ['RPG, Tactics', 'é + & #']);
  assert.deepEqual(params.getAll('notTag'), ['Co-op', 'Free to Play']);
  assert.deepEqual(parseQuery(search, features, tags), query);
  assert.deepEqual(ids(runQuery(catalog, parseQuery(search, features, tags))), [6]);
  assert.deepEqual(parseQuery('?tag=Action&tag=Action', features, tags).hasTags, ['Action']);
  assert.equal(serializeQuery(DEFAULT_QUERY, features, tags), '');
});

test('named tag URLs and results survive reordered dictionary indices', () => {
  const reorderedTags = [...tags].reverse();
  const reordered = { ...catalog, tags: reorderedTags, games: catalog.games.map(game => ({
    ...game,
    ...(Array.isArray(game.tagIds) ? { tagIds: game.tagIds.map(id => reorderedTags.indexOf(tags[id])) } : {}),
  })) };
  const query = { hasTags: ['RPG'], notTags: ['Co-op'] };
  const search = serializeQuery(query, features, tags);
  assert.equal(serializeQuery(query, features, reorderedTags), search);
  assert.deepEqual(parseQuery(search, features, reorderedTags), parseQuery(search, features, tags));
  assert.deepEqual(ids(runQuery(reordered, parseQuery(search, features, reorderedTags))), ids(runQuery(catalog, query)));
});

test('unknown, numeric, empty, and contradictory tag constraints fail instead of broadening results', () => {
  for (const search of ['?tag=Unknown', '?notTag=Unknown', '?tag=RPG&notTag=RPG', '?tag=', '?tag=Action,RPG']) {
    assert.throws(() => parseQuery(search, features, tags), /tag/, search);
  }
  assert.throws(() => normalizeQuery({ hasTags: [0] }, features, tags), /tag/);
  assert.throws(() => normalizeQuery({ hasTags: ['rpg'] }, features, tags), /tag/);
});

test('old catalogs with no tag dictionary still work without tag filters', () => {
  const old = { features, games: [game(1, 'Old catalog')] };
  const result = runQuery(old);
  assert.equal(result.total, 1);
  assert.deepEqual(result.rows[0].tagIds, []);
  assert.deepEqual(result.query.hasTags, []);
  assert.deepEqual(result.query.notTags, []);
  const prepared = prepareCatalog(old);
  assert.deepEqual(prepared.tags, []);
  assert.deepEqual(prepared.tagCounts, []);
  assert.equal(prepared.knownTagCount, 0);
  assert.throws(() => runQuery(old, { notTags: ['RPG'] }), /Unknown excluded tag/);
});

test('tag counts count each game once and dictionary/index validation catches corrupt data', () => {
  const local = { ...catalog, games: [...catalog.games, game(9, 'Repeated tag', { tagIds: [0, 0] })] };
  const before = JSON.stringify(local);
  const prepared = prepareCatalog(local);
  assert.equal(prepared.knownTagCount, 6);
  assert.deepEqual(prepared.tagCounts, [4, 1, 0, 0, 2, 1, 1]);
  assert.deepEqual(runQuery(prepared, { q: 'repeated' }).rows[0].tagIds, [0]);
  assert.equal(JSON.stringify(local), before);
  for (const invalid of [['Action', 'Action'], [''], ['   '], [42], 'Action', null]) {
    assert.throws(() => prepareCatalog({ features, tags: invalid, games: [] }), /tag/);
  }
  for (const invalid of [[-1], [tags.length], [0.5], ['0'], [null], 'RPG']) {
    assert.throws(() => prepareCatalog({ features, tags, games: [game(1, 'Invalid tags', { tagIds: invalid })] }), /tag/);
  }
});

test('delta tag postings decode by game row, preserve unknowns, and match inline queries without mutation', () => {
  const source = { ...catalog, games: catalog.games.map(game => ({ ...game, id: game.id * 101 })) };
  const packed = packTags(source);
  assert.deepEqual(packed.tagIndex.lists[0], [0, 1, 5]);
  const before = JSON.stringify(packed);
  const prepared = prepareCatalog(packed);
  assert.deepEqual(prepared.tagCounts, prepareCatalog(source).tagCounts);
  assert.equal(prepared.knownTagCount, 5);
  for (const query of [
    {}, { hasTags: ['Action'] }, { notTags: ['Co-op'] },
    { hasTags: ['RPG'], has: [22], not: [23] },
    { hasTags: ['RPG, Tactics', 'é + & #'] },
    { notTags: ['Controller'], includeMultiplayer: true, sort: 'score-asc' },
  ]) {
    const search = serializeQuery(query, features, tags);
    assert.deepEqual(runQuery(prepared, parseQuery(search, features, tags)), runQuery(source, query));
  }
  assert.deepEqual(runQuery(prepared, { q: 'missing' }).rows[0].tagIds, []);
  assert.equal(JSON.stringify(packed), before);
});

test('empty delta postings produce unknown tag membership and support an empty dictionary', () => {
  const local = { features, tags: ['Action'], games: [game(1, 'Unknown tags')], tagIndex: { encoding: 'delta-game-indices-v1', lists: [[]] } };
  assert.equal(prepareCatalog(local).knownTagCount, 0);
  assert.deepEqual(prepareCatalog(local).tagCounts, [0]);
  assert.equal(runQuery(local, { notTags: ['Action'] }).total, 0);
  const noTags = { ...local, tags: [], tagIndex: { encoding: 'delta-game-indices-v1', lists: [] } };
  assert.deepEqual(runQuery(noTags).rows[0].tagIds, []);
});

test('malformed delta postings and mixed tag representations fail explicitly', () => {
  const base = { features, tags: ['Action'], games: [game(10, 'First'), game(20, 'Second')] };
  const index = lists => ({ encoding: 'delta-game-indices-v1', lists });
  for (const tagIndex of [
    null, [], { encoding: 'unknown', lists: [[]] },
    index(null), index([]), index([[], []]), index([null]),
    index([[-1]]), index([[0.5]]), index([['0']]), index([[null]]),
    index([[0, 0]]), index([[2]]), index([[1, 1]]), index([[0, -1]]),
  ]) assert.throws(() => prepareCatalog({ ...base, tagIndex }), /tag index/i);
  for (const tagIds of [[], null, undefined, [0]]) {
    assert.throws(() => prepareCatalog({ ...base, games: [game(10, 'Mixed', { tagIds })], tagIndex: index([[0]]) }), /mixes tag index/);
  }
  assert.throws(() => prepareCatalog({ ...base, games: [], tagIndex: index([[0]]) }), /out of bounds/);
});
