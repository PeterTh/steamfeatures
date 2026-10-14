import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { readPreviousManifest, retainPreviousCatalog, sha256, validateCatalogDescriptor } from '../scripts/sources.mjs';
import { writeBinaryCatalog, writeProgressiveCatalog } from '../scripts/catalog-package.mjs';

function binaryPrevious() {
  const plain = Buffer.from('{"previous":true}');
  const compressed = gzipSync(plain);
  const raw = Buffer.from('Example binary catalog payload');
  const gzip = gzipSync(raw);
  const brotli = brotliCompressSync(raw);
  const basename = `catalog.${sha256(raw).slice(0, 16)}.bin`;
  const binary = { format: 'steam-feature-atlas-binary-v1', file: basename, sha256: sha256(raw), bytes: raw.length,
    gzip: { file: `${basename}.gz`, sha256: sha256(gzip), bytes: gzip.length },
    brotli: { file: `${basename}.br`, sha256: sha256(brotli), bytes: brotli.length } };
  const descriptor = { catalog: `catalog.${sha256(plain).slice(0, 16)}.json`, compressedCatalog: `catalog.${sha256(plain).slice(0, 16)}.json.gz`,
    sha256: sha256(plain), gzipSha256: sha256(compressed), binary };
  const files = new Map([[descriptor.catalog, plain], [descriptor.compressedCatalog, compressed],
    [binary.file, raw], [binary.gzip.file, gzip], [binary.brotli.file, brotli]]);
  return { descriptor, files };
}

test('retain exactly the live predecessor, verify hashes and honor project subpaths', async () => {
  const originalFetch = globalThis.fetch;
  const temporary = await mkdtemp(join(tmpdir(), 'steam-atlas-retain-'));
  try {
    const plain = Buffer.from('{"previous":true}');
    const compressed = gzipSync(plain);
    const descriptor = { catalog: 'catalog.0123456789abcdef.json', compressedCatalog: 'catalog.0123456789abcdef.json.gz', sha256: sha256(plain), gzipSha256: sha256(compressed) };
    const urls = [];
    globalThis.fetch = async url => {
      urls.push(String(url));
      return new Response(String(url).endsWith('manifest.json') ? JSON.stringify({ version: 1, current: descriptor, previous: { ignored: true } }) : String(url).endsWith('.gz') ? compressed : plain);
    };
    const previous = await readPreviousManifest('https://peterth.github.io/steamfeatures/');
    const retained = await retainPreviousCatalog(previous, temporary, { sha256: 'd'.repeat(64) });
    assert.deepEqual(retained, descriptor);
    assert.equal(urls.length, 3);
    assert.ok(urls.every(url => url.startsWith('https://peterth.github.io/steamfeatures/data/')));
    assert.deepEqual(await readFile(join(temporary, descriptor.catalog)), plain);
    assert.equal(await retainPreviousCatalog(previous, temporary, descriptor), null);
  } finally { globalThis.fetch = originalFetch; await rm(temporary, { recursive: true, force: true }); }
});

test('first deployment accepts 404 but invalid paths in a prior manifest fail closed', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('', { status: 404 });
    assert.equal(await readPreviousManifest('https://peterth.github.io/steamfeatures/'), null);
    globalThis.fetch = async () => new Response(JSON.stringify({ version: 1, current: { catalog: '../escape.json' } }));
    await assert.rejects(readPreviousManifest('https://peterth.github.io/steamfeatures/'), /Untrusted/);
  } finally { globalThis.fetch = originalFetch; }
});

test('retention carries every checked binary variant alongside the JSON predecessor', async t => {
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'steam-atlas-retain-binary-'));
  t.after(async () => { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); });
  const { descriptor, files } = binaryPrevious();
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    return new Response(files.get(new URL(url).pathname.split('/').at(-1)));
  };
  const previous = { manifest: { current: descriptor }, manifestURL: new URL('https://example.github.io/steamfeatures/data/manifest.json') };
  assert.deepEqual(await retainPreviousCatalog(previous, directory, { sha256: 'd'.repeat(64) }), descriptor);
  assert.equal(urls.length, 5);
  assert.ok(urls.every(url => url.startsWith('https://example.github.io/steamfeatures/data/')));
  for (const [file, bytes] of files) assert.deepEqual(await readFile(join(directory, file)), bytes);
  assert.equal(await retainPreviousCatalog(previous, directory, descriptor), null);
  assert.equal(urls.length, 5);
});

for (const variant of ['raw', 'gzip', 'brotli']) {
  test(`retention rejects corrupt ${variant} binary bytes`, async t => {
    const originalFetch = globalThis.fetch;
    const directory = await mkdtemp(join(tmpdir(), 'steam-atlas-retain-corrupt-'));
    t.after(async () => { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); });
    const { descriptor, files } = binaryPrevious();
    const entry = variant === 'raw' ? descriptor.binary : descriptor.binary[variant];
    files.set(entry.file, Buffer.from('corrupt'));
    globalThis.fetch = async url => new Response(files.get(new URL(url).pathname.split('/').at(-1)));
    await assert.rejects(retainPreviousCatalog({ manifest: { current: descriptor }, manifestURL: new URL('https://example.test/data/manifest.json') }, directory, { sha256: 'd'.repeat(64) }), /checksum or size mismatch/);
  });
}

test('binary descriptors reject unsupported formats, unpinned or escaped paths, and invalid sizes', () => {
  const mutations = [
    descriptor => { descriptor.binary.format = 'unknown'; },
    descriptor => { descriptor.binary.file = '../catalog.0123456789abcdef.bin'; },
    descriptor => { descriptor.binary.sha256 = 'd'.repeat(64); },
    descriptor => { descriptor.binary.bytes = 0; },
    descriptor => { descriptor.binary.bytes = 151 * 1024 * 1024; },
    descriptor => { descriptor.binary.gzip.file = 'https://other.example/data.bin.gz'; },
    descriptor => { descriptor.binary.gzip.bytes = 1.5; },
    descriptor => { descriptor.binary.brotli.sha256 = 'bogus'; },
    descriptor => { delete descriptor.binary.brotli; },
  ];
  for (const mutate of mutations) {
    const { descriptor } = binaryPrevious();
    mutate(descriptor);
    assert.throws(() => validateCatalogDescriptor(descriptor));
  }
});

test('retention carries both partitions and rejects corrupt transport variants', async t => {
  const originalFetch = globalThis.fetch;
  const source = await mkdtemp(join(tmpdir(), 'steam-atlas-retain-split-source-'));
  const target = await mkdtemp(join(tmpdir(), 'steam-atlas-retain-split-target-'));
  t.after(async () => { globalThis.fetch = originalFetch; await rm(source, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); });
  const catalog = { version: 1, features: [], tags: [], games: [
    { id: 1, name: 'Twenty', reviews: 20, featureIds: [] }, { id: 2, name: 'Nineteen', reviews: 19, featureIds: [] },
  ] };
  const plain = Buffer.from(JSON.stringify(catalog)), compressed = gzipSync(plain);
  const binary = await writeBinaryCatalog(catalog, source), progressive = await writeProgressiveCatalog(catalog, source, binary.sha256);
  const descriptor = { catalog: 'catalog.' + sha256(plain).slice(0, 16) + '.json', sha256: sha256(plain), gzipSha256: sha256(compressed), binary, progressive };
  descriptor.compressedCatalog = descriptor.catalog + '.gz';
  const files = new Map([[descriptor.catalog, plain], [descriptor.compressedCatalog, compressed]]), urls = [];
  const entries = [binary, progressive.priority, progressive.remainder].flatMap(part => [part, part.gzip, part.brotli]);
  for (const entry of entries) files.set(entry.file, await readFile(join(source, entry.file)));
  globalThis.fetch = async url => { urls.push(String(url)); return new Response(files.get(new URL(url).pathname.split('/').at(-1))); };
  const previous = { manifest: { current: descriptor }, manifestURL: new URL('https://example.test/atlas/data/manifest.json') };
  assert.deepEqual(await retainPreviousCatalog(previous, target, { sha256: 'd'.repeat(64) }), descriptor);
  assert.equal(urls.length, files.size);
  for (const [file, bytes] of files) assert.deepEqual(await readFile(join(target, file)), bytes);
  for (const entry of entries.slice(3)) {
    const bytes = files.get(entry.file); files.set(entry.file, Buffer.from('Corrupt partition'));
    await assert.rejects(retainPreviousCatalog(previous, target, { sha256: 'd'.repeat(64) }), /checksum or size mismatch/);
    files.set(entry.file, bytes);
  }
});
