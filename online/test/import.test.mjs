import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { importCatalog } from '../scripts/import-catalog.mjs';
import { sha256 } from '../scripts/sources.mjs';
import { createFixture } from '../scripts/fixture.mjs';

test('fixture import emits versioned JSON, matching gzip, licenses, provenance and an explicit fixture marker', async () => {
  const output = await mkdtemp(join(tmpdir(), 'steam-atlas-import-'));
  try {
    const { catalog, manifest } = await importCatalog({ output, fixture: true });
    assert.equal(catalog.fixture, true);
    assert.equal(catalog.games.length, 5);
    assert.equal(catalog.features.length, 62);
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
    assert.equal(JSON.parse(await readFile(join(output, 'provenance-lock.json'))).catalog.sha256, manifest.current.sha256);
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
