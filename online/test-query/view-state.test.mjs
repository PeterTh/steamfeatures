import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_QUERY, normalizeQuery, parseQuery, serializeQuery } from '../src/query.mjs';
import { parseView, serializeView } from '../src/view-state.mjs';
import { features as allFeatures } from '../src/features.mjs';

const features = [
  { id: 1, key: 'multi-player', name: 'Multi-player', multiplayer: true },
  { id: 2, key: 'single-player', name: 'Single-player' },
  { id: 23, key: 'steam-cloud', name: 'Steam Cloud', weight: 3 },
  { id: 64, key: 'adjustable-text-size', name: 'Adjustable Text Size', accessibility: true },
];
const tags = ['Co-op Campaign', 'Metroidvania', 'MMORPG'];

test('a highlight alone gets a versioned URL, and clearing it restores the default URL', () => {
  assert.equal(serializeView(DEFAULT_QUERY, 'steam-cloud', features), '?v=1&highlight=steam-cloud');
  assert.deepEqual(parseView('?v=1&highlight=steam-cloud', features), { query: DEFAULT_QUERY, highlight: 'steam-cloud' });
  assert.equal(serializeView(DEFAULT_QUERY, null, features), '');
  assert.deepEqual(parseView('', features), { query: DEFAULT_QUERY, highlight: null });
});

test('all query fields and tag filters round-trip separately from highlighting', () => {
  const query = normalizeQuery({
    q: '  Example: a & b  ', has: ['single-player'], not: ['steam-cloud'],
    hasTags: ['Metroidvania', 'Co-op Campaign'], notTags: ['MMORPG'],
    minReviews: 1001, includeEarlyAccess: true, includeAccessibility: true,
    includeMultiplayer: true, release: 'all', sort: 'rating-asc', page: 3,
  }, features, tags);
  const original = structuredClone(query);
  Object.freeze(query.has);
  Object.freeze(query.not);
  Object.freeze(query.hasTags);
  Object.freeze(query.notTags);
  Object.freeze(query);
  const search = serializeView(query, 'steam-cloud', features, tags);
  assert.deepEqual(parseView(search, features, tags), { query, highlight: 'steam-cloud' });
  assert.deepEqual(parseQuery(search, features, tags), query);
  assert.deepEqual(query, original);
  assert.equal(Object.hasOwn(query, 'highlight'), false);
  assert.equal(serializeView(query, null, features, tags), serializeQuery(query, features, tags));
});

test('invalid highlights are ignored without losing valid filters', () => {
  const filterSearch = '?v=1&has=single-player&notTag=MMORPG&sort=reviews-desc';
  const expected = parseQuery(filterSearch, features, tags);
  for (const suffix of [
    '&highlight=', '&highlight=unknown', '&highlight=23', '&highlight=Steam-Cloud',
    '&highlight=%20steam-cloud', '&highlight=steam-cloud%20',
    '&highlight=steam-cloud,multi-player',
    '&highlight=steam-cloud&highlight=multi-player',
    '&highlight=steam-cloud&highlight=',
    '&highlight=steam-cloud&highlight=unknown',
  ]) {
    assert.deepEqual(parseView(filterSearch + suffix, features, tags), { query: expected, highlight: null }, suffix);
  }
  for (const highlight of [undefined, '', 23, false, 'unknown', ['steam-cloud'], ' steam-cloud']) {
    assert.equal(serializeView(expected, highlight, features, tags), serializeQuery(expected, features, tags));
  }
});

test('matching duplicate highlights are accepted and canonicalized', () => {
  const parsed = parseView('?highlight=steam-cloud&highlight=steam-cloud', features);
  assert.equal(parsed.highlight, 'steam-cloud');
  assert.equal(serializeView(parsed.query, parsed.highlight, features), '?v=1&highlight=steam-cloud');
});

test('hidden multiplayer and accessibility columns retain their highlight', () => {
  for (const [key, toggle] of [['multi-player', 'includeMultiplayer'], ['adjustable-text-size', 'includeAccessibility']]) {
    for (const enabled of [false, true]) {
      const query = { ...DEFAULT_QUERY, [toggle]: enabled };
      const parsed = parseView(serializeView(query, key, features), features);
      assert.equal(parsed.highlight, key);
      assert.deepEqual(parsed.query, query);
    }
  }
});

test('a combined hardware column has its own highlight independent of rating filters', () => {
  const search = serializeView({ ...DEFAULT_QUERY, compatibility: { 'steam-deck': 'playable' }, includeHardware: true }, 'steam-deck', allFeatures);
  const parsed = parseView(search, allFeatures);
  assert.equal(parsed.highlight, 'steam-deck');
  assert.equal(parsed.query.compatibility['steam-deck'], 'playable');
  assert.equal(serializeView({ ...parsed.query, includeHardware: false }, parsed.highlight, allFeatures).includes('highlight=steam-deck'), true);
});

test('URLSearchParams input is not changed and string hashes are ignored', () => {
  const params = new URLSearchParams('v=1&highlight=steam-cloud&tag=Co-op+Campaign');
  const before = params.toString();
  const parsed = parseView(params, features, tags);
  assert.equal(params.toString(), before);
  assert.equal(parsed.highlight, 'steam-cloud');
  assert.deepEqual(parsed.query.hasTags, ['Co-op Campaign']);
  assert.deepEqual(parseView(`?${before}#about`, features, tags), parsed);
});

test('highlight parsing and serialization preserve strict query validation', () => {
  for (const search of [
    '?v=2', '?sort=invalid', '?has=unknown', '?tag=unknown',
    '?page=0', '?q=first&q=second', '?has=steam-cloud&not=steam-cloud',
  ]) {
    let expected;
    try { parseQuery(search, features, tags); } catch (error) { expected = error.message; }
    assert.ok(expected, search);
    assert.throws(() => parseView(`${search}&highlight=unknown`, features, tags), { message: expected });
  }
  assert.throws(() => serializeView({ sort: 'invalid' }, 'steam-cloud', features), { message: 'Unknown sort order: invalid.' });
  assert.throws(() => parseView('?highlight=steam-cloud', undefined), { message: 'The feature catalog is unavailable.' });
});
