import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { importCatalog } from '../scripts/import-catalog.mjs';
import { sha256 } from '../scripts/sources.mjs';
import { createFixture } from '../scripts/fixture.mjs';
import { decodeBinaryCatalog, BINARY_FORMAT } from '../src/catalog-binary.mjs';
import { prepareCatalog, runQuery } from '../src/query.mjs';
import { mergeCatalogPartitions } from '../src/progressive-catalog.mjs';
import { features } from '../src/features.mjs';

test('fixture import emits equivalent full and split binaries, compressed variants, JSON and provenance', async () => {
  const output = await mkdtemp(join(tmpdir(), 'steam-atlas-import-'));
  try {
    const { catalog, manifest } = await importCatalog({ output, fixture: true });
    assert.equal(catalog.fixture, true);
    assert.equal(catalog.games.length, 5);
    assert.equal(catalog.features.length, features.length);
    assert.equal(catalog.features.find(feature => feature.id === 23).weight, 3);
    assert.equal(catalog.features.find(feature => feature.id === 35).weight, -1);
    assert.equal(catalog.features.find(feature => feature.id === 1).multiplayer, true);
    assert.ok(catalog.features.every(feature => feature.id !== 31 && !feature.steamIds.includes(31)));
    assert.deepEqual(catalog.tags, ['Action', 'Co-op', 'MMORPG', 'Puzzle']);
    assert.deepEqual(catalog.tagIndex, { encoding: 'delta-game-indices-v1', lists: [[0, 1], [0], [2], [1]] });
    assert.ok(catalog.games.every(game => !Object.hasOwn(game, 'tagIds')));
    assert.equal(manifest.coverage.knownTags, 3);
    assert.equal(manifest.coverage.tagCount, 4);
    assert.equal(manifest.previous, null);
    const plain = await readFile(join(output, 'data', manifest.current.catalog));
    const compressed = await readFile(join(output, 'data', manifest.current.compressedCatalog));
    assert.equal(sha256(plain), manifest.current.sha256);
    assert.equal(sha256(compressed), manifest.current.gzipSha256);
    assert.deepEqual(gunzipSync(compressed), plain);
    assert.deepEqual(JSON.parse(plain), catalog);
    const descriptor = manifest.current.binary;
    assert.equal(descriptor.format, BINARY_FORMAT);
    const binary = await readFile(join(output, 'data', descriptor.file));
    assert.equal(binary.length, descriptor.bytes);
    assert.equal(sha256(binary), descriptor.sha256);
    for (const [encoding, decompress] of [['gzip', gunzipSync], ['brotli', brotliDecompressSync]]) {
      const packed = await readFile(join(output, 'data', descriptor[encoding].file));
      assert.equal(packed.length, descriptor[encoding].bytes);
      assert.equal(sha256(packed), descriptor[encoding].sha256);
      assert.deepEqual(decompress(packed), binary);
    }
    const decoded = decodeBinaryCatalog(binary);
    const split = manifest.current.progressive;
    assert.equal(split.minReviews, 20);
    assert.equal(split.snapshot, descriptor.sha256);
    const parts = [];
    for (const part of [split.priority, split.remainder]) {
      const raw = await readFile(join(output, 'data', part.file));
      assert.equal(raw.length, part.bytes); assert.equal(sha256(raw), part.sha256);
      for (const [encoding, decompress] of [['gzip', gunzipSync], ['brotli', brotliDecompressSync]]) {
        const packed = await readFile(join(output, 'data', part[encoding].file));
        assert.equal(packed.length, part[encoding].bytes); assert.equal(sha256(packed), part[encoding].sha256);
        assert.deepEqual(decompress(packed), raw);
      }
      parts.push(decodeBinaryCatalog(raw));
    }
    const merged = mergeCatalogPartitions(...parts), prepared = prepareCatalog(merged);
    assert.deepEqual(split.statistics, { gameCount: prepared.games.length, tagCounts: prepared.tagCounts,
      knownTagCount: prepared.knownTagCount, languageCounts: prepared.languageCounts });
    const records = value => prepareCatalog(value).games.map(row => row.game).sort((a, b) => a.id - b.id);
    assert.deepEqual(records(decoded), records(catalog));
    assert.deepEqual(records(merged), records(catalog));
    assert.deepEqual(runQuery(parts[0], {}), runQuery(catalog, {}));
    for (const query of [{}, { hasTags: ['Co-op'] }, { notTags: ['MMORPG'], minReviews: 0 }, { includeEarlyAccess: true, release: 'all', sort: 'title-asc' }]) {
      assert.deepEqual(runQuery(decoded, query), runQuery(catalog, query));
      assert.deepEqual(runQuery(merged, query), runQuery(catalog, query));
    }
    assert.deepEqual(JSON.parse(await readFile(join(output, 'provenance-lock.json'))).catalog, manifest.current);
    assert.match(await readFile(join(output, 'licenses/NOTICE.txt'), 'utf8'), /BlueBoxWare/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('corrupt source archive cannot publish a replacement manifest', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'steam-atlas-corrupt-'));
  try {
    const source = await createFixture(join(temporary, 'source'));
    await writeFile(source.reviewsFile, 'truncated source');
    const sourceFile = join(temporary, 'sources.json');
    await writeFile(sourceFile, JSON.stringify(source));
    const output = join(temporary, 'output');
    await assert.rejects(importCatalog({ sourceFile, output, fixture: true }), /checksum mismatch/);
    await assert.rejects(access(join(output, 'data/manifest.json')), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
