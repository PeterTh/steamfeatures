import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { loadCatalog } from '../src/filter-worker.js';

const catalog = { version: 1, importedAt: '2026-10-08T00:00:00Z', features: [], games: [] };
const bytes = Buffer.from(JSON.stringify(catalog));
const compressed = gzipSync(bytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const manifest = {
  version: 1,
  current: { catalog: 'catalog.123.json', compressedCatalog: 'catalog.123.json.gz',
    sha256: hash(bytes), gzipSha256: hash(compressed), bytes: bytes.length, gzipBytes: compressed.length },
};
const origin = 'https://example.github.io';
const manifestURL = `${origin}/atlas/data/manifest.json`;
function setup({ manifestValue = manifest, gzip = compressed, plain = bytes, gzipStatus = 200, plainStatus = 200 } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, cache: options.cache });
    if (url === manifestURL) return new Response(JSON.stringify(manifestValue), { status: 200 });
    if (url.endsWith('.json.gz')) return new Response(gzip, { status: gzipStatus });
    if (url.endsWith('.json')) return new Response(plain, { status: plainStatus });
    throw new Error(`Unexpected URL ${url}`);
  };
  return { requests, options: { origin, fetchImpl, cryptoImpl: webcrypto } };
}

test('gzip catalog is verified and resolved under a GitHub project subpath', async () => {
  const { requests, options } = setup();
  const loaded = await loadCatalog(manifestURL, options);
  assert.deepEqual(loaded.catalog, catalog);
  assert.deepEqual(loaded.manifest, manifest);
  assert.deepEqual(requests, [
    { url: manifestURL, cache: 'no-cache' },
    { url: `${origin}/atlas/data/catalog.123.json.gz`, cache: 'force-cache' },
  ]);
});

test('browsers without gzip decompression use verified plain JSON', async () => {
  const { requests, options } = setup();
  const loaded = await loadCatalog(manifestURL, { ...options, DecompressionStreamImpl: null });
  assert.deepEqual(loaded.catalog, catalog);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].url.endsWith('.json'));
});

test('missing or corrupt gzip falls back to the pinned plain catalog', async () => {
  for (const scenario of [{ gzipStatus: 404 }, { gzip: Buffer.from('corrupt') }]) {
    const { requests, options } = setup(scenario);
    assert.deepEqual((await loadCatalog(manifestURL, options)).catalog, catalog);
    assert.equal(requests.length, 3);
  }
});

test('a corrupt fallback never reaches catalog parsing', async () => {
  const { options } = setup({ gzipStatus: 404, plain: Buffer.from('{}') });
  await assert.rejects(loadCatalog(manifestURL, options), /checksum does not match/);
});

test('unsupported manifest and catalog versions fail explicitly', async () => {
  await assert.rejects(loadCatalog(manifestURL, setup({ manifestValue: { ...manifest, version: 2 } }).options), /manifest version/);
  const next = Buffer.from(JSON.stringify({ ...catalog, version: 2 }));
  const changedManifest = { ...manifest, current: { ...manifest.current, sha256: hash(next), bytes: next.length } };
  await assert.rejects(loadCatalog(manifestURL, setup({ manifestValue: changedManifest, gzipStatus: 404, plain: next }).options), /catalog version/);
});

test('external catalog paths and external manifest origins are rejected', async () => {
  const changed = { ...manifest, current: { ...manifest.current, catalog: 'https://other.example/catalog.json' } };
  await assert.rejects(loadCatalog(manifestURL, setup({ manifestValue: changed }).options), /same origin/);
  await assert.rejects(loadCatalog('https://other.example/manifest.json', setup().options), /same origin/);
});

test('missing checksum and mismatched byte counts are rejected', async () => {
  const withoutHash = { ...manifest, current: { ...manifest.current, sha256: null } };
  await assert.rejects(loadCatalog(manifestURL, setup({ manifestValue: withoutHash }).options), /checksum/);
  const wrongLength = { ...manifest, current: { ...manifest.current, bytes: bytes.length + 1 } };
  await assert.rejects(loadCatalog(manifestURL, setup({ manifestValue: wrongLength }).options), /size does not match/);
});

test('worker ready includes global tag frequencies and queries keep row tag indices', async () => {
  const oldSelf = globalThis.self;
  let onMessage;
  const messages = [];
  globalThis.self = {
    addEventListener(type, listener) { if (type === 'message') onMessage = listener; },
    postMessage(message) { messages.push(message); },
  };
  try {
    await import('../src/filter-worker.js?tag-worker-message-test');
    const source = {
      version: 1, features: [], tags: ['Action', 'RPG'], games: [
        { id: 1, name: 'Tagged', featureIds: [], featureDataKnown: true, tagIds: [0, 1], reviews: 100, earlyAccess: false, releaseStatus: 'released' },
        { id: 2, name: 'Unknown tags', featureIds: [], featureDataKnown: true, reviews: 100, earlyAccess: false, releaseStatus: 'released' },
      ],
    };
    await onMessage({ data: { type: 'init', catalog: source } });
    assert.equal(messages[0].type, 'ready');
    assert.deepEqual(messages[0].tags, ['Action', 'RPG']);
    assert.deepEqual(messages[0].tagCounts, [1, 1]);
    assert.equal(messages[0].knownTagCount, 1);
    await onMessage({ data: { type: 'query', requestId: 7, query: { hasTags: ['RPG'] } } });
    assert.equal(messages[1].type, 'result');
    assert.equal(messages[1].requestId, 7);
    assert.equal(messages[1].result.total, 1);
    assert.deepEqual(messages[1].result.rows[0].tagIds, [0, 1]);
    const packed = {
      ...source,
      games: source.games.map(({ tagIds, ...game }) => game),
      tagIndex: { encoding: 'delta-game-indices-v1', lists: [[0], [0]] },
    };
    await onMessage({ data: { type: 'init', catalog: packed } });
    assert.deepEqual(messages[2].tagCounts, [1, 1]);
    assert.equal(messages[2].knownTagCount, 1);
    await onMessage({ data: { type: 'query', requestId: 8, query: { notTags: ['Absent tag'] } } });
    assert.equal(messages[3].type, 'error');
    assert.equal(messages[3].requestId, 8);
    await onMessage({ data: { type: 'query', requestId: 9, query: { hasTags: ['Action'] } } });
    assert.equal(messages[4].result.total, 1);
    assert.deepEqual(messages[4].result.rows[0].tagIds, [0, 1]);
  } finally {
    if (oldSelf === undefined) delete globalThis.self;
    else globalThis.self = oldSelf;
  }
});
