import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { normalizeGameCredits, encodeGameCredits, writeGameCredits, verifyGameCredits } from '../scripts/game-credits.mjs';
import { decodeGameCredits, gameCreditNames } from '../src/game-credits.mjs';
import { loadGameCredits } from '../src/filter-worker.js';
import { attachGameCredits, normalizeQuery, parseQuery, serializeQuery, prepareCatalog, runQuery } from '../src/query.mjs';

const snapshot = 'a'.repeat(64);
const credits = new Map([
  [10, [['Alpha & Co', 'Second Studio'], ['Gamma Publishing']]],
  [20, [['Ａlpha & Co'], ['Other Publisher']]],
  [30, [null, []]],
  [40, [[], null]],
  [50, [['Déjà Vu'], ['Déjà Vu']]],
]);
const catalog = { version: 1, features: [], games: [...credits.keys()].reverse().map(id => ({
  id, name: 'Game ' + id, featureIds: [], featureDataKnown: true, reviews: 100,
  earlyAccess: false, releaseStatus: 'released', releaseISO: '2020-01-01',
})) };
const encode = () => encodeGameCredits(catalog.games, credits, snapshot);
const ids = result => result.rows.map(row => row.id).sort((a, b) => a - b);

test('credits preserve exact Unicode names, roles, multiple names, unknown and empty lists', () => {
  const decoded = decodeGameCredits(encode(), snapshot);
  assert.deepEqual([...decoded.appIds], [10, 20, 30, 40, 50]);
  for (let i = 0; i < decoded.appIds.length; i++) {
    const [developerNames, publisherNames] = credits.get(decoded.appIds[i]);
    assert.deepEqual(gameCreditNames(decoded, decoded.pairs[decoded.pairIds[i]]), { developerNames, publisherNames });
  }
  const repeated = decoded.pairs[decoded.pairIds[4]];
  assert.equal(repeated[0], repeated[1], 'identical roles share their list');
});

test('credits reject wrong snapshots, malformed indices, truncation and trailing data', () => {
  assert.throws(() => decodeGameCredits(encode(), 'b'.repeat(64)), /snapshot/);
  assert.throws(() => decodeGameCredits(encode().subarray(0, -1), snapshot), /truncated/);
  assert.throws(() => decodeGameCredits(Buffer.concat([encode(), Buffer.from([0])]), snapshot), /trailing/);
  const badId = Buffer.from(encode()); badId[71] = 0;
  assert.throws(() => decodeGameCredits(badId, snapshot), /app ID/);
  const badPair = Buffer.from(encode()); badPair[badPair.length - 1] = 127;
  assert.throws(() => decodeGameCredits(badPair, snapshot), /range/);
});

test('source selection preserves explicit empty Steam lists and falls back only for missing fields', () => {
  assert.deepEqual(normalizeGameCredits({ store: { basic_info: { developers: [], publishers: [{ name: 'Valve' }] } },
    fallback: { developers: ['Old'], publishers: ['Old'] } }), [[], ['Valve']]);
  assert.deepEqual(normalizeGameCredits({ fallback: { developers: ['Fallback'] }, appinfo: { extended: { developer: 'PICS', publisher: 'PICS publisher' } } }), [['Fallback'], ['PICS publisher']]);
  assert.deepEqual(normalizeGameCredits({}), [null, null]);
});

test('role substrings are independent, literal, normalized, and combine with other constraints', () => {
  const prepared = prepareCatalog(catalog), counts = prepared.games[0].counts;
  assert.throws(() => runQuery(prepared, { developer: 'Alpha' }), /not loaded/);
  assert.equal(attachGameCredits(prepared, decodeGameCredits(encode(), snapshot)), prepared);
  assert.equal(prepared.games[0].counts, counts, 'late attachment does not rebuild feature indexes');
  assert.deepEqual(ids(runQuery(prepared, { developer: 'ALPHA & CO' })), [10, 20]);
  assert.deepEqual(ids(runQuery(prepared, { developer: 'alpha', publisher: 'GAMMA' })), [10]);
  assert.deepEqual(ids(runQuery(prepared, { publisher: 'alpha' })), []);
  assert.deepEqual(ids(runQuery(prepared, { developer: 'co Second' })), [], 'names cannot match across list boundaries');
  assert.deepEqual(ids(runQuery(prepared, { developer: 'déjà' })), [50]);
  assert.deepEqual(ids(runQuery(prepared, { developer: '.', publisher: '.*' })), []);
  assert.deepEqual(ids(runQuery(prepared, {})), [10, 20, 30, 40, 50]);
  assert.deepEqual(ids(runQuery(prepared, { developer: 'alpha', q: '20' })), [20]);
  assert.deepEqual(ids(runQuery(prepared, { publisher: 'Other', minReviews: 101 })), []);
  assert.deepEqual(runQuery(prepared, { developer: 'Déjà' }).rows[0].publisherNames, ['Déjà Vu']);
  const other = { ...catalog, games: catalog.games.slice(1) };
  assert.throws(() => attachGameCredits(other, decodeGameCredits(encode(), snapshot)), /app IDs/);
});

test('developer/publisher URLs preserve punctuation, normalize whitespace and reset to defaults', () => {
  const query = normalizeQuery({ developer: '  Alpha & Co, Ltd. ', publisher: 'déjà + ?' }, []);
  const url = serializeQuery(query, []);
  assert.equal(new URLSearchParams(url).get('dev'), 'Alpha & Co, Ltd.');
  assert.equal(new URLSearchParams(url).get('pub'), 'déjà + ?');
  assert.deepEqual(parseQuery(url, []), query);
  assert.equal(serializeQuery({ developer: ' ', publisher: '' }, []), '');
  assert.throws(() => parseQuery('?dev=Alpha&dev=Beta', []), /Conflicting/);
});

test('packaged files verify, use gzip without probing unsupported Brotli, and recover to raw after corruption', async t => {
  const cache = resolve(dirname(fileURLToPath(import.meta.url)), '../.cache');
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(resolve(cache, 'credits-test-'));
  t.after(async () => { assert.equal(dirname(directory), cache); await rm(directory, { recursive: true, force: true }); });
  const descriptor = await writeGameCredits(catalog.games, credits, directory, snapshot);
  await verifyGameCredits(directory, descriptor, catalog.games, snapshot);
  const requests = [];
  let corruptGzip = false;
  class GzipOnly { constructor(format) { if (format !== 'gzip') throw new Error('unsupported'); return new DecompressionStream(format); } }
  const options = { cryptoImpl: webcrypto, DecompressionStreamImpl: GzipOnly,
    fetchImpl: async url => {
      requests.push(url);
      const filename = new URL(url).pathname.split('/').at(-1);
      const bytes = corruptGzip && filename.endsWith('.gz') ? Buffer.from('corrupt') : await readFile(resolve(directory, filename));
      return new Response(bytes, { headers: { 'content-encoding': 'gzip', 'content-length': '99999999' } });
    } };
  const loaded = await loadGameCredits(descriptor, 'https://example.test/data/manifest.json', snapshot, options);
  assert.equal(loaded.compression, 'gzip');
  assert.equal(requests.length, 1); assert.ok(requests[0].endsWith('.gz'));
  corruptGzip = true; requests.length = 0;
  assert.equal((await loadGameCredits(descriptor, 'https://example.test/data/manifest.json', snapshot, options)).compression, 'uncompressed');
  assert.equal(requests.length, 2);
  requests.length = 0;
  await assert.rejects(loadGameCredits(descriptor, 'https://example.test/data/manifest.json', 'b'.repeat(64), options), /snapshot/);
  assert.equal(requests.length, 0);
});
