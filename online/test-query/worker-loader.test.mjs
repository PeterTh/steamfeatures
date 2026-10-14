import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { gzipSync, brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { loadCatalog } from '../src/filter-worker.js';
import { BINARY_FORMAT } from '../src/catalog-binary.mjs';
import { BINARY_MAX_BYTES, COMPRESSED_MAX_BYTES } from '../src/catalog-descriptor.mjs';
import { encodeBinaryCatalog } from '../scripts/catalog-binary.mjs';
import { features } from '../src/features.mjs';
import { normalizeSteamEnrichment } from '../scripts/steam-enrichment.mjs';
import { partitionCatalog } from '../scripts/catalog-partitions.mjs';
import { runQuery } from '../src/query.mjs';

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
  assert.equal(loaded.compression, 'gzip');
  assert.equal(loaded.bytes, compressed.length);
  assert.deepEqual(requests, [
    { url: manifestURL, cache: 'no-cache' },
    { url: `${origin}/atlas/data/catalog.123.json.gz`, cache: 'force-cache' },
  ]);
});

test('browsers without gzip decompression use verified plain JSON', async () => {
  const { requests, options } = setup();
  const loaded = await loadCatalog(manifestURL, { ...options, DecompressionStreamImpl: null });
  assert.deepEqual(loaded.catalog, catalog);
  assert.equal(loaded.compression, 'uncompressed');
  assert.equal(loaded.bytes, bytes.length);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].url.endsWith('.json'));
});

test('missing or corrupt gzip falls back to the pinned plain catalog', async () => {
  for (const scenario of [{ gzipStatus: 404 }, { gzip: Buffer.from('corrupt') }]) {
    const { requests, options } = setup(scenario);
    const loaded = await loadCatalog(manifestURL, options);
    assert.deepEqual(loaded.catalog, catalog);
    assert.equal(loaded.compression, 'uncompressed');
    assert.equal(loaded.bytes, bytes.length);
    assert.equal(requests.length, 3);
  }
});

test('a corrupt fallback never reaches catalog parsing', async () => {
  const { options } = setup({ gzipStatus: 404, plain: Buffer.from('{}') });
  await assert.rejects(loadCatalog(manifestURL, options), /size does not match/);
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

const binaryBytes = Buffer.from(encodeBinaryCatalog(catalog));
const binaryGzip = gzipSync(binaryBytes);
const binaryBrotli = brotliCompressSync(binaryBytes);
const binaryFilename = `catalog.${hash(binaryBytes).slice(0, 16)}.bin`;
const binaryDescriptor = {
  format: BINARY_FORMAT, file: binaryFilename, sha256: hash(binaryBytes), bytes: binaryBytes.length,
  gzip: { file: `${binaryFilename}.gz`, sha256: hash(binaryGzip), bytes: binaryGzip.length },
  brotli: { file: `${binaryFilename}.br`, sha256: hash(binaryBrotli), bytes: binaryBrotli.length },
};
const binaryManifest = { ...manifest, current: { ...manifest.current, binary: binaryDescriptor } };

// Exercise Brotli deterministically even when the Node version predates native support.
class BothCompressionFormats {
  constructor(format) {
    if (format === 'gzip') return new DecompressionStream('gzip');
    if (format !== 'brotli') throw new Error('Unsupported compression');
    const chunks = [];
    return new TransformStream({
      transform(chunk) { chunks.push(chunk); },
      flush(controller) { controller.enqueue(brotliDecompressSync(Buffer.concat(chunks))); },
    });
  }
}
class GzipOnly {
  constructor(format) {
    if (format !== 'gzip') throw new Error('Unsupported compression');
    return new DecompressionStream(format);
  }
}
function binarySetup({ manifestValue = binaryManifest, brotli = binaryBrotli, gzip = binaryGzip, plain = binaryBytes,
  brotliStatus = 200, gzipStatus = 200, plainStatus = 200, redirect, headers } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, cache: options.cache });
    if (url === manifestURL) return new Response(JSON.stringify(manifestValue));
    let response;
    if (url.endsWith('.bin.br')) response = new Response(brotli, { status: brotliStatus, headers });
    else if (url.endsWith('.bin.gz')) response = new Response(gzip, { status: gzipStatus, headers });
    else if (url.endsWith('.bin')) response = new Response(plain, { status: plainStatus, headers });
    else throw new Error(`Unexpected URL ${url}; binary manifests must never download JSON.`);
    if (redirect) Object.defineProperty(response, 'url', { value: redirect });
    return response;
  };
  return { requests, options: { origin, fetchImpl, cryptoImpl: webcrypto, DecompressionStreamImpl: BothCompressionFormats } };
}
const paths = requests => requests.slice(1).map(request => new URL(request.url).pathname);
const changedBinary = descriptor => ({ ...binaryManifest, current: { ...binaryManifest.current, binary: descriptor } });
const flipped = value => { const changed = Buffer.from(value); changed[changed.length - 1] ^= 1; return changed; };

test('Brotli-capable browsers fetch and verify only the binary Brotli payload', async () => {
  const { requests, options } = binarySetup();
  const loaded = await loadCatalog(manifestURL, options);
  assert.deepEqual(loaded.catalog, catalog);
  assert.deepEqual(loaded.manifest, binaryManifest);
  assert.equal(loaded.compression, 'brotli');
  assert.equal(loaded.bytes, binaryBrotli.length);
  assert.deepEqual(requests, [
    { url: manifestURL, cache: 'no-cache' },
    { url: `${origin}/atlas/data/${binaryFilename}.br`, cache: 'force-cache' },
  ]);
});

test('unsupported Brotli is detected before download and goes directly to binary gzip', async () => {
  const { requests, options } = binarySetup();
  const loaded = await loadCatalog(manifestURL, { ...options, DecompressionStreamImpl: GzipOnly });
  assert.deepEqual(loaded.catalog, catalog);
  assert.equal(loaded.compression, 'gzip');
  assert.equal(loaded.bytes, binaryGzip.length);
  assert.deepEqual(paths(requests), [`/atlas/data/${binaryFilename}.gz`]);
});

test('browsers without decompression fetch raw binary instead of full JSON', async () => {
  for (const DecompressionStreamImpl of [null, class { constructor() { throw new Error('Unsupported'); } }]) {
    const { requests, options } = binarySetup();
    const loaded = await loadCatalog(manifestURL, { ...options, DecompressionStreamImpl });
    assert.deepEqual(loaded.catalog, catalog);
    assert.equal(loaded.compression, 'uncompressed');
    assert.equal(loaded.bytes, binaryBytes.length);
    assert.deepEqual(paths(requests), [`/atlas/data/${binaryFilename}`]);
  }
});

test('missing, corrupt, truncated, or undecodable Brotli uses verified binary gzip', async () => {
  const malformed = Buffer.alloc(binaryBrotli.length, 255);
  const malformedManifest = changedBinary({ ...binaryDescriptor,
    brotli: { ...binaryDescriptor.brotli, sha256: hash(malformed) } });
  for (const scenario of [
    { brotliStatus: 404 }, { brotli: flipped(binaryBrotli) }, { brotli: binaryBrotli.subarray(1) },
    { brotli: malformed, manifestValue: malformedManifest },
  ]) {
    const { requests, options } = binarySetup(scenario);
    const loaded = await loadCatalog(manifestURL, options);
    assert.deepEqual(loaded.catalog, catalog);
    assert.equal(loaded.compression, 'gzip');
    assert.equal(loaded.bytes, binaryGzip.length);
    assert.deepEqual(paths(requests), [`/atlas/data/${binaryFilename}.br`, `/atlas/data/${binaryFilename}.gz`]);
  }
});

test('a bad gzip fallback can use verified raw binary and never JSON', async () => {
  const { requests, options } = binarySetup({ brotliStatus: 404, gzip: flipped(binaryGzip) });
  const loaded = await loadCatalog(manifestURL, options);
  assert.deepEqual(loaded.catalog, catalog);
  assert.equal(loaded.compression, 'uncompressed');
  assert.equal(loaded.bytes, binaryBytes.length);
  assert.deepEqual(paths(requests), [
    `/atlas/data/${binaryFilename}.br`, `/atlas/data/${binaryFilename}.gz`, `/atlas/data/${binaryFilename}`,
  ]);
});

test('compressed checksum alone is insufficient: expanded bytes must match the raw checksum', async () => {
  const corrupt = brotliCompressSync(flipped(binaryBytes));
  const changed = changedBinary({ ...binaryDescriptor,
    brotli: { ...binaryDescriptor.brotli, bytes: corrupt.length, sha256: hash(corrupt) } });
  const { requests, options } = binarySetup({ brotli: corrupt, manifestValue: changed });
  const loaded = await loadCatalog(manifestURL, options);
  assert.deepEqual(loaded.catalog, catalog);
  assert.equal(loaded.compression, 'gzip');
  assert.equal(loaded.bytes, binaryGzip.length);
  assert.equal(requests.length, 3);
});

test('expanded byte limits are enforced while reading compressed data', async () => {
  const oversized = brotliCompressSync(Buffer.alloc(binaryBytes.length + 100_000));
  const changed = changedBinary({ ...binaryDescriptor,
    brotli: { ...binaryDescriptor.brotli, bytes: oversized.length, sha256: hash(oversized) } });
  const { options, requests } = binarySetup({ brotli: oversized, manifestValue: changed, gzipStatus: 404, plain: flipped(binaryBytes) });
  await assert.rejects(loadCatalog(manifestURL, options), /size does not match.*checksum does not match/);
  assert.equal(requests.length, 4);
});

test('unknown binary format, unpinned filenames, missing descriptors, and invalid sizes fail before downloading data', async () => {
  for (const descriptor of [
    { ...binaryDescriptor, format: 'future-format' }, null,
    { ...binaryDescriptor, file: `https://other.example/${binaryFilename}` },
    { ...binaryDescriptor, file: `../${binaryFilename}` },
    { ...binaryDescriptor, file: `${binaryFilename}?ignored=1` },
    { ...binaryDescriptor, sha256: '1'.repeat(64) },
    { ...binaryDescriptor, bytes: BINARY_MAX_BYTES + 1 },
    { ...binaryDescriptor, bytes: 0 },
    { ...binaryDescriptor, bytes: 1.5 },
    { ...binaryDescriptor, bytes: '100' },
    { ...binaryDescriptor, gzip: undefined },
    { ...binaryDescriptor, brotli: { ...binaryDescriptor.brotli, file: 'other.bin.br' } },
    { ...binaryDescriptor, gzip: { ...binaryDescriptor.gzip, bytes: COMPRESSED_MAX_BYTES + 1 } },
    { ...binaryDescriptor, gzip: { ...binaryDescriptor.gzip, sha256: 'invalid' } },
    { ...binaryDescriptor, gzip: { ...binaryDescriptor.gzip, sha256: `${binaryDescriptor.gzip.sha256}\n` } },
  ]) {
    const { requests, options } = binarySetup({ manifestValue: changedBinary(descriptor) });
    await assert.rejects(loadCatalog(manifestURL, options), /binary catalog format|descriptor/);
    assert.equal(requests.length, 1);
  }
});

test('same-origin redirects cannot escape the website data directory', async () => {
  for (const redirect of [`${origin}/other/data/${binaryFilename}`, `https://other.example/atlas/data/${binaryFilename}`]) {
    const { options, requests } = binarySetup({ redirect });
    await assert.rejects(loadCatalog(manifestURL, options), /data directory|another origin/);
    assert.equal(requests.length, 4);
  }
});

test('legacy JSON descriptors also reject paths outside the project data directory', async () => {
  for (const path of ['../../elsewhere.json', '/elsewhere.json', 'catalog.json?x=1', 'sub%2f..%2f..%2ffile.json']) {
    const changed = { ...manifest, current: { ...manifest.current, catalog: path } };
    const { requests, options } = setup({ manifestValue: changed });
    await assert.rejects(loadCatalog(manifestURL, options), /data directory/);
    assert.equal(requests.length, 1);
  }
});

test('invalid binary content does not silently load the legacy JSON descriptor', async () => {
  const invalid = Buffer.from('not a binary catalog');
  const gzip = gzipSync(invalid);
  const brotli = brotliCompressSync(invalid);
  const filename = `catalog.${hash(invalid).slice(0, 16)}.bin`;
  const descriptor = { format: BINARY_FORMAT, file: filename, sha256: hash(invalid), bytes: invalid.length,
    gzip: { file: `${filename}.gz`, sha256: hash(gzip), bytes: gzip.length },
    brotli: { file: `${filename}.br`, sha256: hash(brotli), bytes: brotli.length } };
  const { requests, options } = binarySetup({ manifestValue: changedBinary(descriptor), plain: invalid, gzip, brotli });
  await assert.rejects(loadCatalog(manifestURL, options), /binary catalog and its fallbacks could not load/);
  assert.ok(requests.slice(1).every(request => /\.bin(?:\.br|\.gz)?$/.test(request.url)));
});

test('oversized content-length and oversized manifests fail within read limits', async () => {
  const { options } = binarySetup({ headers: { 'content-length': BINARY_MAX_BYTES + 1 } });
  await assert.rejects(loadCatalog(manifestURL, options), /size does not match/);
  await assert.rejects(loadCatalog(manifestURL, { ...options,
    fetchImpl: async () => new Response(' '.repeat(2 * 1024 * 1024 + 1)),
  }), /manifest size.*limit/);
});

function progressiveSetup() {
  const source = { ...catalog, tags: ['RPG'], games: [
    { id: 1, name: 'Twenty', reviews: 20, featureIds: [], featureDataKnown: true, earlyAccess: false, releaseStatus: 'released', tagIds: [0] },
    { id: 2, name: 'Nineteen', reviews: 19, featureIds: [], featureDataKnown: true, earlyAccess: false, releaseStatus: 'released', tagIds: [0] },
    { id: 3, name: 'Unknown', reviews: null, featureIds: [], featureDataKnown: true, earlyAccess: false, releaseStatus: 'released' },
  ] };
  const files = new Map();
  const pack = value => {
    const raw = Buffer.from(encodeBinaryCatalog(value)), gzip = gzipSync(raw), brotli = brotliCompressSync(raw);
    const file = 'catalog.' + hash(raw).slice(0, 16) + '.bin';
    const descriptor = { format: BINARY_FORMAT, file, sha256: hash(raw), bytes: raw.length,
      gzip: { file: file + '.gz', sha256: hash(gzip), bytes: gzip.length },
      brotli: { file: file + '.br', sha256: hash(brotli), bytes: brotli.length } };
    files.set(file, raw); files.set(file + '.gz', gzip); files.set(file + '.br', brotli);
    return descriptor;
  };
  const parts = partitionCatalog(source), binary = pack(source);
  const progressive = { version: 1, minReviews: 20, snapshot: binary.sha256, priority: pack(parts.priority),
    remainder: pack(parts.remainder), statistics: parts.statistics };
  const value = { ...manifest, current: { ...manifest.current, binary, progressive } }, requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, cache: options.cache });
    if (url === manifestURL) return new Response(JSON.stringify(value));
    const bytes = files.get(new URL(url).pathname.split('/').at(-1));
    return bytes ? new Response(bytes) : new Response('Missing partition', { status: 404 });
  };
  return { source, value, files, requests, options: { origin, fetchImpl, cryptoImpl: webcrypto, DecompressionStreamImpl: BothCompressionFormats } };
}

test('progressive loading shows complete 20+ results without requesting the remainder and pins later loads to that snapshot', async () => {
  const fixture = progressiveSetup();
  const initial = await loadCatalog(manifestURL, { ...fixture.options, minReviews: 20 });
  assert.equal(initial.progressive.partial, true);
  assert.deepEqual(runQuery(initial.catalog, {}), runQuery(fixture.source, {}));
  assert.deepEqual(initial.progressive.plan.statistics.tagCounts, [2]);
  assert.equal(initial.progressive.plan.statistics.gameCount, 3);
  assert.equal(fixture.requests.length, 2);
  fixture.value.current.progressive = null; // A later deployment cannot change the pinned background plan.
  const complete = await loadCatalog(manifestURL, { ...fixture.options, plan: initial.progressive.plan });
  assert.equal(complete.progressive.partial, false);
  assert.equal(fixture.requests.filter(request => request.url === manifestURL).length, 1);
  assert.deepEqual(runQuery(complete.catalog, { minReviews: 0 }), runQuery(fixture.source, { minReviews: 0 }));
  for (const part of ['priority', 'remainder']) assert.deepEqual(complete.progressive.files[part], {
    compression: 'brotli', bytes: initial.progressive.plan[part].brotli.bytes,
  });
});

test('cold low-review links load both partitions and per-file metadata follows compression fallback', async () => {
  const fixture = progressiveSetup();
  const plan = fixture.value.current.progressive;
  fixture.files.set(plan.remainder.brotli.file, Buffer.from('Corrupt Brotli'));
  const loaded = await loadCatalog(manifestURL, { ...fixture.options, minReviews: 19 });
  assert.equal(loaded.progressive.partial, false);
  assert.deepEqual(runQuery(loaded.catalog, { minReviews: 0 }), runQuery(fixture.source, { minReviews: 0 }));
  assert.deepEqual(loaded.progressive.files.priority, { compression: 'brotli', bytes: plan.priority.brotli.bytes });
  assert.deepEqual(loaded.progressive.files.remainder, { compression: 'gzip', bytes: plan.remainder.gzip.bytes });
  assert.equal(loaded.bytes, plan.priority.brotli.bytes + plan.remainder.gzip.bytes);
});

test('malformed progressive snapshots, paths, thresholds and counts fail before downloading any partition', async () => {
  for (const mutate of [
    plan => { plan.snapshot = 'd'.repeat(64); }, plan => { plan.minReviews = 19; },
    plan => { plan.priority.file = '../escaped.bin'; }, plan => { plan.remainder.gzip.file = 'https://other.example/catalog.bin.gz'; },
    plan => { plan.statistics.tagCounts = [-1]; }, plan => { plan.statistics.knownTagCount = 4; },
    plan => { plan.statistics.languageCounts = []; },
  ]) {
    const fixture = progressiveSetup(); mutate(fixture.value.current.progressive);
    await assert.rejects(loadCatalog(manifestURL, { ...fixture.options, minReviews: 20 }), /progressive|descriptor/);
    assert.equal(fixture.requests.length, 1);
  }
});

test('worker rejects broad queries on the initial index and reports full-catalogue picker counts', async t => {
  const fixture = progressiveSetup(), oldSelf = globalThis.self, messages = [];
  let onMessage;
  globalThis.self = { addEventListener(type, listener) { if (type === 'message') onMessage = listener; }, postMessage(message) { messages.push(message); } };
  t.mock.method(globalThis, 'fetch', fixture.options.fetchImpl);
  try {
    await import('../src/filter-worker.js?progressive-worker-message-test');
    await onMessage({ data: { type: 'init', manifestURL, minReviews: 20 } });
    assert.equal(messages[0].type, 'ready'); assert.equal(messages[0].gameCount, 3);
    assert.deepEqual(messages[0].tagCounts, [2]); assert.equal(messages[0].progressive.partial, true);
    await onMessage({ data: { type: 'query', requestId: 1, query: { minReviews: 0 } } });
    assert.equal(messages[1].type, 'error'); assert.match(messages[1].message, /complete catalog/);
    await onMessage({ data: { type: 'query', requestId: 2, query: { minReviews: 20 } } });
    assert.equal(messages[2].result.total, 1);
    await onMessage({ data: { type: 'init', mode: 'full', plan: messages[0].progressive.plan } });
    assert.equal(messages[3].type, 'ready'); assert.equal(messages[3].progressive.partial, false);
    await onMessage({ data: { type: 'query', requestId: 3, query: { minReviews: 0 } } });
    assert.equal(messages[4].result.total, 3);
    // A cached older app sends no minReviews hint and cannot manage a handover.
    await onMessage({ data: { type: 'init', manifestURL } });
    assert.equal(messages[5].type, 'ready'); assert.equal(messages[5].progressive.partial, false);
    await onMessage({ data: { type: 'query', requestId: 4, query: { minReviews: 0 } } });
    assert.equal(messages[6].result.total, 3);
  } finally { if (oldSelf === undefined) delete globalThis.self; else globalThis.self = oldSelf; }
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
    assert.equal(messages[0].catalogCompression, null);
    assert.equal(messages[0].catalogBytes, null);
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
    assert.equal(messages[2].catalogCompression, null);
    assert.equal(messages[2].catalogBytes, null);
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

test('worker exposes compatibility notes separately from scoring and filtering features', async () => {
  const oldSelf = globalThis.self;
  let onMessage;
  const messages = [];
  globalThis.self = {
    addEventListener(type, listener) { if (type === 'message') onMessage = listener; },
    postMessage(message) { messages.push(message); },
  };
  try {
    await import('../src/filter-worker.js?compatibility-worker-message-test');
    const registry = new Map(features.map(feature => [feature.id, feature]));
    const details = normalizeSteamEnrichment({ id: 1, appinfo: { common: { steam_deck_compatibility: {
      category: '3', tests: [{ display: '4', token: '#SteamDeckVerified_TestResult_InterfaceTextIsLegible' }],
    } } } }, registry);
    const note = [...registry.values()].find(feature => feature.knowledgeGroup === 'steam-deck-tests');
    await onMessage({ data: { type: 'init', catalog: { version: 1, features: [...registry.values()], games: [
      { id: 1, name: 'Game', ...details, featureDataKnown: true, reviews: 100, earlyAccess: false, releaseStatus: 'released' },
    ] } } });
    assert.equal(messages[0].type, 'ready');
    assert.deepEqual(messages[0].compatibilityDetails, [note]);
    assert.equal(messages[0].features.some(feature => feature.id === note.id), false);
    await onMessage({ data: { type: 'query', requestId: 1, query: { includeHardware: true } } });
    const row = messages[1].result.rows[0];
    assert.ok(row.featureIds.includes(note.id));
    assert.equal(row.score, 1);
    assert.equal(row.count, 1);
  } finally {
    if (oldSelf === undefined) delete globalThis.self;
    else globalThis.self = oldSelf;
  }
});

test('worker ready reports the compression and file size actually loaded, including a fallback', async t => {
  const oldSelf = globalThis.self;
  let onMessage;
  const messages = [];
  globalThis.self = {
    addEventListener(type, listener) { if (type === 'message') onMessage = listener; },
    postMessage(message) { messages.push(message); },
  };
  try {
    await import('../src/filter-worker.js?compression-worker-message-test');
    const fetchMock = t.mock.method(globalThis, 'fetch', setup().options.fetchImpl);
    await onMessage({ data: { type: 'init', manifestURL } });
    assert.equal(messages[0].type, 'ready');
    assert.equal(messages[0].catalogCompression, 'gzip');
    assert.equal(messages[0].catalogBytes, compressed.length);

    fetchMock.mock.mockImplementation(setup({ gzipStatus: 404 }).options.fetchImpl);
    await onMessage({ data: { type: 'init', manifestURL } });
    assert.equal(messages[1].type, 'ready');
    assert.equal(messages[1].catalogCompression, 'uncompressed');
    assert.equal(messages[1].catalogBytes, bytes.length);
  } finally {
    if (oldSelf === undefined) delete globalThis.self;
    else globalThis.self = oldSelf;
  }
});
