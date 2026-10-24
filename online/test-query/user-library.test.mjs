import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUserLibrary, libraryAppIds } from '../src/user-library.mjs';
import { runQuery, serializeQuery, parseQuery } from '../src/query.mjs';

const catalog = { version: 1, features: [
  { id: 22, key: 'steam-achievements', short: 'ACH', name: 'Achievements', weight: 2 },
  { id: 23, key: 'steam-cloud', short: 'CLD', name: 'Cloud', weight: 3 },
], games: [
  [10, 'Alpha', 100, [22, 23]], [20, 'Beta', 10, [22]], [30, 'Gamma', 50, [23]], [40, 'Delta', 20, [22]],
].map(([id, name, reviews, featureIds]) => ({ id, name, reviews, featureIds, featureDataKnown: true, earlyAccess: false, releaseStatus: 'released' })) };

test('only owned and wishlist app IDs are retained from an export, normalized without coercion', () => {
  assert.deepEqual(parseUserLibrary('\uFEFF' + JSON.stringify({ rgOwnedApps: [620, 440, 620, 0xffffffff],
    rgWishlist: [999, 888, 999], rgIgnoredApps: [123], rgFollowedApps: [124], steamid: 'do-not-retain', login: 'do-not-retain' })),
    { appIds: [440, 620, 0xffffffff], wishlistIds: [888, 999] });
  for (const invalid of [null, {}, [0], [-1], [1.5], ['620'], [true], Array(1), [0x100000000], Array(1000001).fill(1)]) {
    assert.throws(() => libraryAppIds(invalid), /valid Steam app IDs/);
  }
});

test('missing wishlist data remains distinct from an explicitly empty wishlist', () => {
  assert.deepEqual(parseUserLibrary('{"rgOwnedApps":[10]}'), { appIds: [10], wishlistIds: null });
  assert.deepEqual(parseUserLibrary('{"rgOwnedApps":[10],"rgWishlist":[]}'), { appIds: [10], wishlistIds: [] });
  assert.deepEqual(parseUserLibrary('{"rgOwnedApps":[],"rgWishlist":[20]}'), { appIds: [], wishlistIds: [20] });
  assert.throws(() => parseUserLibrary('{"rgOwnedApps":[10],"rgWishlist":["20"]}'), /valid Steam app IDs/);
});

test('wrong files, malformed JSON and anonymous empty exports explain how to recover', () => {
  assert.throws(() => parseUserLibrary('<html>Steam</html>'), /valid JSON/);
  for (const value of [null, [], { response: { games: [] } }, { rgOwnedApps: {} }]) {
    assert.throws(() => parseUserLibrary(JSON.stringify(value)), /No Steam library/);
  }
  assert.throws(() => parseUserLibrary('{"rgOwnedApps":[]}'), /signed into Steam/);
});

test('local library membership combines with ordinary filters without changing scores or source data', () => {
  const before = JSON.stringify(catalog);
  const context = { libraryRules: [{ appIds: new Set([20, 40, 99999]), exclude: false }] };
  assert.deepEqual(runQuery(catalog, {}, context).rows.map(row => row.id), [40]);
  const library = runQuery(catalog, { minReviews: 0 }, context);
  assert.deepEqual(new Set(library.rows.map(row => row.id)), new Set([20, 40]));
  assert.equal(library.rows[0].score, runQuery(catalog, { q: 'Delta' }).rows[0].score);
  assert.equal(runQuery(catalog, { has: ['CLD'], minReviews: 0 }, context).total, 0);
  assert.equal(runQuery(catalog, {}, { libraryRules: [{ appIds: new Set(), exclude: false }] }).total, 0);
  assert.equal(runQuery(catalog).total, 3);
  assert.equal(JSON.stringify(catalog), before);
});

test('owned and wishlisted requirements and exclusions combine as independent rules', () => {
  const owned = new Set([10, 20]), wishlist = new Set([20, 30]);
  const ids = (excludeOwned, excludeWishlisted) => runQuery(catalog, { minReviews: 0 }, { libraryRules: [
    { appIds: owned, exclude: excludeOwned }, { appIds: wishlist, exclude: excludeWishlisted },
  ] }).rows.map(game => game.id).sort((a, b) => a - b);
  assert.deepEqual(ids(false, false), [20]);
  assert.deepEqual(ids(true, false), [30]);
  assert.deepEqual(ids(false, true), [10]);
  assert.deepEqual(ids(true, true), [40]);
  assert.equal(runQuery(catalog, {}, { libraryRules: [{ appIds: new Set(), exclude: true }] }).total, 3);
});

test('library IDs and selection never enter query results or shared URLs', () => {
  const input = { minReviews: 0, has: ['ACH'] };
  const result = runQuery(catalog, input, { libraryRules: [{ appIds: new Set([20]), exclude: false }] });
  const url = serializeQuery(result.query, catalog.features);
  assert.equal(url, serializeQuery(input, catalog.features));
  assert.equal(url.includes('20'), false);
  assert.equal('libraryRules' in result.query, false);
  assert.equal(runQuery(catalog, parseQuery(url, catalog.features)).total, 3);
});

test('worker library updates filter subsequent queries locally and can be cleared', async () => {
  const oldSelf = globalThis.self;
  let onMessage;
  const messages = [];
  globalThis.self = { addEventListener(type, listener) { if (type === 'message') onMessage = listener; },
    postMessage(message) { messages.push(message); } };
  try {
    await import('../src/filter-worker.js?user-library-worker-test');
    const init = onMessage({ data: { type: 'init', catalog } });
    await onMessage({ data: { type: 'library', rules: [{ appIds: [20, 40], exclude: false }] } });
    await init;
    await onMessage({ data: { type: 'query', requestId: 1, query: { minReviews: 0 } } });
    assert.deepEqual(new Set(messages.at(-1).result.rows.map(row => row.id)), new Set([20, 40]));
    await onMessage({ data: { type: 'library', rules: [{ appIds: [10, 40], exclude: true }, { appIds: [20, 30, 40], exclude: false }] } });
    await onMessage({ data: { type: 'query', requestId: 2, query: {} } });
    assert.deepEqual(messages.at(-1).result.rows.map(row => row.id), [30]);
    await onMessage({ data: { type: 'library', rules: [] } });
    await onMessage({ data: { type: 'query', requestId: 3, query: {} } });
    assert.equal(messages.at(-1).result.total, 3);
    assert.equal(messages.some(message => message.appIds || message.rules), false);
  } finally {
    if (oldSelf === undefined) delete globalThis.self;
    else globalThis.self = oldSelf;
  }
});
