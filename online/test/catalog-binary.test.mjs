import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBinaryCatalog } from '../scripts/catalog-binary.mjs';
import { BINARY_FORMAT, BINARY_MAGIC, BINARY_LIMITS, decodeBinaryCatalog } from '../src/catalog-binary.mjs';
import { runQuery, prepareCatalog } from '../src/query.mjs';

const features = [
  { id: 2, key: 'single-player', name: 'Single-player', weight: 1 },
  { id: 22, key: 'achievements', name: 'Achievements', weight: 2 },
  { id: 23, key: 'cloud', name: 'Cloud', weight: 3 },
  { id: 29, key: 'cards', name: 'Trading cards', weight: 1 },
  { id: 64, key: 'text', name: 'Text size', weight: 1, accessibility: true },
  { id: 65, key: 'speech', name: 'Speech', weight: 1, accessibility: true },
  { id: 66, key: 'contrast', name: 'Contrast', weight: 1, accessibility: true },
  { id: 67, key: 'colors', name: 'Color alternatives', weight: 1, accessibility: true },
  { id: 68, key: 'multi-player', name: 'Multi-player', weight: 1, multiplayer: true },
];
const game = (id, name, extra = {}) => ({
  id, name, featureIds: [2, 22], featureDataKnown: true, reviews: 100,
  positivePercent: 91, earlyAccess: false, releaseStatus: 'released',
  releaseISO: '2020-01-01', releaseDate: '1 Jan 2020', genres: ['Action'], ...extra,
});
const catalog = {
  version: 1, importedAt: '2026-10-09T12:00:00Z', features,
  sources: { steam: { country: 'US', notes: '日本語 😀' } },
  tags: ['Metroidvania', 'Co-op Campaign', 'MMORPG'],
  games: [
    game(10, 'Café ＡＢＣ 日本語 😀', { featureIds: [2, 22, 23, 68], tagDataKnown: true, custom: { nested: [false, null, 1.5, 'é'] } }),
    game(20, 'Zulu', { featureIds: [2], reviews: null, positivePercent: null, releaseISO: null, earlyAccess: null, custom: null }),
    game(30, 'Alpha', { featureIds: [2, 22, 23, 64], positivePercent: 99.75, earlyAccess: true }),
    game(40, 'Unknown', { featureIds: [], featureDataKnown: false, tagDataKnown: false, steamLookupResultCode: 15 }),
    game(50, 'Upcoming', { featureIds: [2, 23], releaseStatus: 'upcoming', reviews: 0, tagDataKnown: true }),
    game(60, '\uFEFFOpening mark', { featureIds: [2, 22, 23, 64, 68], tagDataKnown: true }),
  ],
  tagIndex: { encoding: 'delta-game-indices-v1', notes: 'Preserve additional metadata', lists: [[0, 2, 3], [0, 5], [1]] },
};
delete catalog.games[3].reviews;
delete catalog.games[3].positivePercent;

function canonical(catalog) {
  const indices = catalog.games.map((_, i) => i).sort((a, b) => catalog.games[a].id - catalog.games[b].id);
  const map = new Map(indices.map((old, current) => [old, current]));
  const result = { ...catalog, games: indices.map(i => catalog.games[i]) };
  if (catalog.tagIndex) result.tagIndex = { ...catalog.tagIndex, lists: catalog.tagIndex.lists.map(deltas => {
    let row = 0;
    const postings = deltas.map(delta => map.get(row += delta)).sort((a, b) => a - b);
    let previous = 0;
    return postings.map(row => { const delta = row - previous; previous = row; return delta; });
  }) };
  return result;
}

test('binary columns preserve all metadata, fields, absence/null, Unicode and tag memberships', () => {
  const encoded = encodeBinaryCatalog(catalog), decoded = decodeBinaryCatalog(encoded);
  assert.equal(BINARY_FORMAT, 'steam-feature-atlas-binary-v1');
  assert.deepEqual([...encoded.subarray(0, BINARY_MAGIC.length)], BINARY_MAGIC);
  assert.notDeepEqual(decoded.games.map(game => game.id), catalog.games.map(game => game.id), 'test exercises row reordering');
  assert.deepEqual(canonical(decoded), canonical(catalog));
  assert.equal(Object.hasOwn(decoded.games.find(game => game.id === 40), 'reviews'), false);
  assert.equal(decoded.games.find(game => game.id === 20).reviews, null);
  assert.deepEqual(encodeBinaryCatalog(decoded), encoded, 'row/dictionary ordering is deterministic');
});

test('all query sorts, toggles, feature/tag constraints, pagination and Unicode search stay equivalent', () => {
  const decoded = decodeBinaryCatalog(encodeBinaryCatalog(catalog));
  const sorts = ['score', 'features', 'reviews', 'rating', 'title', 'release'].flatMap(key => [`${key}-asc`, `${key}-desc`]);
  for (const sort of sorts) for (const includeAccessibility of [false, true]) for (const includeMultiplayer of [false, true]) {
    const input = { sort, includeAccessibility, includeMultiplayer, includeEarlyAccess: true, minReviews: 0, release: 'all' };
    assert.deepEqual(runQuery(decoded, input), runQuery(catalog, input));
  }
  for (const filter of [
    { has: ['cloud'], not: ['multi-player'] }, { hasTags: ['Co-op Campaign', 'Metroidvania'] },
    { notTags: ['MMORPG'] }, { hasTags: ['Metroidvania'], not: ['text'], sort: 'rating-desc' },
    { q: 'cafe\u0301 abc' }, { release: 'upcoming' }, { minReviews: 101 }, { page: 2 },
  ]) assert.deepEqual(runQuery(decoded, filter), runQuery(catalog, filter));
  assert.deepEqual(prepareCatalog(decoded).tagCounts, prepareCatalog(catalog).tagCounts);
});

test('catalogs without inverted tags preserve optional fields and per-game tag arrays', () => {
  const input = {
    version: 1, features, tags: ['Tag'],
    games: [game(3, 'Third', { tagIds: [0] }), game(1, 'First', { featureIds: null, tagIds: null }), game(2, 'Second')],
  };
  delete input.games[2].featureIds;
  const decoded = decodeBinaryCatalog(encodeBinaryCatalog(input));
  assert.deepEqual(canonical(decoded), canonical(input));
  assert.equal(Object.hasOwn(decoded, 'tagIndex'), false);
});

test('dictionary fallback preserves unusual feature arrays and UTF-16 strings losslessly', () => {
  const input = { features, games: [game(1, 'Lone \ud800 surrogate', { featureIds: [22, 2, 22] }), game(2, 'Fine', { featureIds: [] })] };
  assert.deepEqual(canonical(decodeBinaryCatalog(encodeBinaryCatalog(input))), canonical(input));
});

test('empty catalogs and maximum unsigned app IDs are supported', () => {
  const empty = { features: [], tags: [], games: [], tagIndex: { encoding: 'delta-game-indices-v1', lists: [] } };
  assert.deepEqual(decodeBinaryCatalog(encodeBinaryCatalog(empty)), empty);
  const bounds = { features: [], games: [game(0xffffffff, 'Last', { featureIds: [] }), game(1, 'First', { featureIds: [] })] };
  assert.deepEqual(canonical(decodeBinaryCatalog(encodeBinaryCatalog(bounds))), canonical(bounds));
});

test('numeric columns preserve safe-integer boundaries and fractional dictionary fallbacks', () => {
  for (const values of [
    [0, 1, 127, 128, Number.MAX_SAFE_INTEGER - 2, null],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, -3, 98.75, null],
  ]) {
    const input = { features: [], games: values.map((reviews, i) => ({ id: i + 1, reviews, positivePercent: reviews, steamLookupResultCode: reviews })) };
    input.games.push({ id: values.length + 1 });
    assert.deepEqual(decodeBinaryCatalog(encodeBinaryCatalog(input)), input);
  }
});

// Small hand-built inputs reach each validation boundary without allocating
// large fixtures or coupling corruption offsets to a particular encoder order.
function uint(value) {
  const bytes = [];
  while (value > 127) { bytes.push((value % 128) | 128); value = Math.floor(value / 128); }
  bytes.push(value);
  return Buffer.from(bytes);
}
function string(value) { const bytes = Buffer.from(value); return Buffer.concat([uint(bytes.length), bytes]); }
function header(extra = {}) {
  return { format: BINARY_FORMAT, metadata: { version: 1, features: [] }, fields: [{ key: 'id', type: 'id' }], featureIds: [], tagIndex: null, ...extra };
}
function wire(definition = header(), payload = [1, 2]) {
  return Buffer.concat([Buffer.from(BINARY_MAGIC), string(JSON.stringify(definition)), Buffer.from(payload)]);
}

test('rejects unsupported versions, bad magic, missing headers and trailing bytes', () => {
  const valid = wire();
  for (const offset of [0, BINARY_MAGIC.length - 1]) {
    const broken = Buffer.from(valid); broken[offset] ^= 3;
    assert.throws(() => decodeBinaryCatalog(broken), /magic or version/);
  }
  assert.throws(() => decodeBinaryCatalog(wire(header({ format: 'future-format' }))), /unsupported format/);
  assert.throws(() => decodeBinaryCatalog(new Uint8Array()), /truncated/);
  assert.throws(() => decodeBinaryCatalog(Buffer.concat([valid, Buffer.from([0])])), /trailing/);
  assert.throws(() => decodeBinaryCatalog('text'), /input size/);
});

test('rejects every truncated prefix of a real catalog', () => {
  const bytes = encodeBinaryCatalog(catalog);
  for (let length = 0; length < bytes.length; length++) assert.throws(() => decodeBinaryCatalog(bytes.subarray(0, length)), /Invalid binary catalog/);
});

test('rejects noncanonical, overflowing, overlong, or truncated varints', () => {
  for (const bytes of [[0x81, 0], [0x80], Array(8).fill(0xff), [...Array(7).fill(0xff), 0x7f]]) {
    assert.throws(() => decodeBinaryCatalog(Buffer.concat([Buffer.from(BINARY_MAGIC), Buffer.from(bytes)])), /Invalid binary catalog/);
  }
  assert.throws(() => decodeBinaryCatalog(wire(header(), [1, 0x82, 0])), /noncanonical/);
});

test('bounds headers, strings, game counts, and field counts before allocating', () => {
  assert.throws(() => decodeBinaryCatalog(Buffer.concat([Buffer.from(BINARY_MAGIC), uint(BINARY_LIMITS.headerBytes + 1)])), /integer out of range/);
  assert.throws(() => decodeBinaryCatalog(wire(header(), [...uint(BINARY_LIMITS.games + 1)])), /integer out of range/);
  assert.throws(() => decodeBinaryCatalog(wire(header(), [100, 2])), /impossible game count/);
  const tooManyFields = Array.from({ length: BINARY_LIMITS.fields + 1 }, (_, i) => ({ key: `k${i}`, type: 'dictionary' }));
  assert.throws(() => decodeBinaryCatalog(wire(header({ fields: tooManyFields }))), /field definitions/);
  const names = header({ fields: [{ key: 'id', type: 'id' }, { key: 'name', type: 'string' }] });
  assert.throws(() => decodeBinaryCatalog(wire(names, [1, 2, ...uint(BINARY_LIMITS.stringBytes + 1)])), /integer out of range/);
  assert.throws(() => decodeBinaryCatalog(wire(names, [1, 2, 2, 65])), /truncated/);
});

test('rejects invalid UTF-8 and malformed JSON', () => {
  assert.throws(() => decodeBinaryCatalog(Buffer.concat([Buffer.from(BINARY_MAGIC), Buffer.from([1, 0xff])])), /UTF-8/);
  assert.throws(() => decodeBinaryCatalog(Buffer.concat([Buffer.from(BINARY_MAGIC), string('{')])), /malformed JSON/);
  const names = header({ fields: [{ key: 'id', type: 'id' }, { key: 'name', type: 'string' }] });
  assert.throws(() => decodeBinaryCatalog(wire(names, [1, 2, 2, 0xc0, 0x80])), /UTF-8/);
});

test('rejects unsafe or duplicate fields, unsupported types, and structural metadata collisions', () => {
  for (const key of ['__proto__', 'constructor', 'prototype', 'id']) {
    const fields = [{ key: 'id', type: 'id' }, { key, type: 'dictionary' }];
    assert.throws(() => decodeBinaryCatalog(wire(header({ fields }))), /invalid or duplicate field/);
  }
  for (const fields of [[{ key: 'id', type: 'unknown' }], [{ key: 'id', type: 'dictionary' }], [{ key: 'x', type: 'id' }], [{ key: 'x', type: 'features' }]]) {
    assert.throws(() => decodeBinaryCatalog(wire(header({ fields }))), /field/);
  }
  for (const key of ['games', 'tagIndex', '__proto__']) {
    const metadata = { features: [], [key]: [] };
    assert.throws(() => decodeBinaryCatalog(wire(header({ metadata }))), /invalid metadata/);
  }
  assert.equal({}.polluted, undefined);
});

test('rejects zero, negative, duplicate, or overflowing game IDs', () => {
  for (const payload of [[1, 0], [1, 1], [2, 2, 0], [2, ...uint(0xffffffff * 2), 2]]) {
    assert.throws(() => decodeBinaryCatalog(wire(header(), payload)), /game ID/);
  }
});

test('rejects feature dictionary mismatches and nonzero padding bits', () => {
  const definition = header({ metadata: { features: [{ id: 2 }] }, featureIds: [2], fields: [{ key: 'id', type: 'id' }, { key: 'featureIds', type: 'features' }] });
  assert.deepEqual(decodeBinaryCatalog(wire(definition, [1, 2, 1])).games[0].featureIds, [2]);
  assert.throws(() => decodeBinaryCatalog(wire(definition, [1, 2, 2])), /padding/);
  for (const ids of [[3], [2, 2], []]) assert.throws(() => decodeBinaryCatalog(wire({ ...definition, featureIds: ids })), /feature dictionary/);
});

test('rejects impossible dictionary sizes, malformed values and out-of-range references', () => {
  const definition = header({ fields: [{ key: 'id', type: 'id' }, { key: 'optional', type: 'dictionary' }] });
  for (const payload of [[1, 2, 0], [1, 2, 3], [1, 2, 2]]) assert.throws(() => decodeBinaryCatalog(wire(definition, payload)), /dictionary size|integer out of range/);
  assert.throws(() => decodeBinaryCatalog(wire(definition, [1, 2, 1, 1, 123, 0])), /malformed dictionary/);
  assert.throws(() => decodeBinaryCatalog(wire(definition, [1, 2, 1, 0, 1])), /integer out of range/);
});

test('JSON dictionary keys are data, never prototype assignments', () => {
  const definition = header({ fields: [{ key: 'id', type: 'id' }, { key: 'extra', type: 'dictionary' }] });
  const token = string('{"__proto__":{"polluted":true}}');
  const value = decodeBinaryCatalog(wire(definition, [1, 2, 1, ...token, 0])).games[0].extra;
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.equal(value.polluted, undefined);
  assert.equal({}.polluted, undefined);
});

test('rejects invalid tag encoding, tag counts and postings', () => {
  const definition = header({ metadata: { features: [], tags: ['Tag'] }, tagIndex: { encoding: 'delta-game-indices-v1' } });
  assert.throws(() => decodeBinaryCatalog(wire({ ...definition, tagIndex: { encoding: 'future' } })), /unsupported tag index/);
  assert.throws(() => decodeBinaryCatalog(wire(definition, [1, 2, 0])), /posting count differs/);
  assert.throws(() => decodeBinaryCatalog(wire(definition, [1, 2, 1, 2, 0, 1])), /integer out of range/);
  assert.throws(() => decodeBinaryCatalog(wire(definition, [1, 2, 1, 1, 1])), /invalid tag posting/);
  assert.throws(() => decodeBinaryCatalog(wire(definition, [2, 2, 2, 1, 2, 0, 0])), /invalid tag posting/);
  assert.throws(() => decodeBinaryCatalog(wire(definition, [2, 2, 2, 1, 2, 0])), /impossible posting count/);
});

test('encoder refuses malformed inputs instead of emitting unusable files', () => {
  for (const input of [
    { features: [], games: [{ id: 1 }, { id: 1 }] },
    { features: [], games: [{ id: 0 }] },
    { features: [], games: [{ id: 1, extra: undefined }] },
    { features: [], games: [{ id: 1, ['__proto__']: {} }] },
    { features: [], games: [{ id: 1 }], tags: ['Tag'], tagIndex: { encoding: 'delta-game-indices-v1', lists: [[1]] } },
  ]) assert.throws(() => encodeBinaryCatalog(input), /binary catalog/);
});
