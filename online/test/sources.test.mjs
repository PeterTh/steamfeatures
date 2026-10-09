import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readPreviousManifest, retainPreviousCatalog, sha256 } from '../scripts/sources.mjs';

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
