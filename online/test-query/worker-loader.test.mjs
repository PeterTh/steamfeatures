import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { gzipSync, brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { loadCatalog } from '../src/filter-worker.js';
import { BINARY_FORMAT } from '../src/catalog-binary.mjs';
import { BINARY_MAX_BYTES, COMPRESSED_MAX_BYTES } from '../src/catalog-descriptor.mjs';
import { encodeBinaryCatalog } from '../scripts/catalog-binary.mjs';

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
