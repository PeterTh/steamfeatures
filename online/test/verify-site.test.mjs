import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { verifyPublishedSite, verifySite } from '../scripts/verify-site.mjs';
import { applyRefreshResults, createRefreshState } from '../scripts/refresh-state.mjs';
import { sha256 } from '../scripts/sources.mjs';
import { writeBinaryCatalog } from '../scripts/catalog-package.mjs';

async function siteFixture(t, catalogInput) {
  const directory = await mkdtemp(join(tmpdir(), 'steam-atlas-verify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const put = async (name, content) => {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), content);
  };
  const auxiliary = async (prefix, object) => {
    const bytes = gzipSync(JSON.stringify(object));
    const hash = sha256(bytes);
    const descriptor = { file: `${prefix}.${hash.slice(0, 16)}.json.gz`, sha256: hash, bytes: bytes.length };
    await put('data/' + descriptor.file, bytes);
    return descriptor;
  };
  const catalog = catalogInput ?? { version: 1, fixture: false, coverage: { games: 1 }, refresh: { bootstrapComplete: true },
    features: [{ id: 2, key: 'single-player', name: 'Single-player', weight: 1 }], tags: [],
    games: [{ id: 10, name: 'Example', featureIds: [2], featureDataKnown: true }] };
  const bytes = Buffer.from(JSON.stringify(catalog));
  const compressed = gzipSync(bytes);
  const hash = sha256(bytes);
  const current = { catalog: `catalog.${hash.slice(0, 16)}.json`, compressedCatalog: `catalog.${hash.slice(0, 16)}.json.gz`, sha256: hash,
    gzipSha256: sha256(compressed), bytes: bytes.length, gzipBytes: compressed.length };
  await put('data/' + current.catalog, bytes);
  await put('data/' + current.compressedCatalog, compressed);
  const state = applyRefreshResults(createRefreshState(), { now: '2026-10-09T12:00:00.000Z', results: [{ id: 10, status: 'ok', metadata: { appType: 0, name: 'Example' } }] });
  state.bootstrapComplete = true;
  const request = { fetchedAt: '2026-10-09T12:00:00.000Z', method: 'IStoreBrowseService/GetItems', input: { ids: [{ appid: 10 }] }, status: 200 };
  const key = sha256(JSON.stringify(request));
  const archive = { version: 1, requests: { [key]: request }, apps: { 10: { latest: { request: key, item: { id: 10, success: 1 } } } } };
  const manifest = { version: 1, fixture: false, coverage: { games: catalog.games.length }, refresh: { bootstrapComplete: true }, current,
    refreshState: await auxiliary('refresh', state), steamArchive: { ...await auxiliary('steam-raw', archive), apps: 1, successfulApps: 1 } };
  const saveManifest = () => put('data/manifest.json', JSON.stringify(manifest));
  await saveManifest();
  const saveProvenance = () => put('provenance-lock.json', JSON.stringify({ catalog: manifest.current, refreshState: manifest.refreshState, steamArchive: manifest.steamArchive }));
  await saveProvenance();
  for (const name of ['index.html', 'app.js', 'style.css', 'query.mjs', 'features.mjs', 'feature-presentation.mjs', 'extra-features.mjs', 'filter-worker.js', 'brand.svg', '.nojekyll',
    'fonts/promptfont.woff2', 'fonts/PromptFont-LICENSE.txt', 'fonts/PromptFont-NOTICE.txt',
    'fonts/roboto-condensed-variable.woff', 'fonts/LICENSE.txt', 'fonts/NOTICE.txt', 'licenses/BlueBoxWare-MIT.txt', 'licenses/leinstay-GPL-3.0.txt', 'licenses/NOTICE.txt']) await put(name, 'Test fixture');
  const addBinary = async (binaryCatalog = catalog) => {
    manifest.current.binary = await writeBinaryCatalog(binaryCatalog, join(directory, 'data'));
    await put('catalog-binary.mjs', 'Test decoder asset');
    await put('catalog-descriptor.mjs', 'Test descriptor asset');
    await saveManifest();
    await saveProvenance();
    return manifest.current.binary;
  };
  return { directory, put, auxiliary, manifest, catalog, state, archive, saveManifest, saveProvenance, addBinary };
}

test('deployment verification accepts a complete package and enforces the production size floor', async t => {
  const { directory, manifest } = await siteFixture(t);
  assert.deepEqual(await verifySite(directory, { minimumGames: 1 }), { games: 1, stateApps: 1, rawApps: 1, catalogSha256: manifest.current.sha256 });
  await assert.rejects(verifySite(directory), /at least 50000 games/);
});

for (const field of ['catalog', 'compressedCatalog', 'refreshState', 'steamArchive']) {
  test(`deployment verification rejects corrupted ${field} bytes`, async t => {
    const { directory, manifest, put } = await siteFixture(t);
    const filename = field.endsWith('State') || field === 'steamArchive' ? manifest[field].file : manifest.current[field];
    await put('data/' + filename, 'corrupted');
    await assert.rejects(verifySite(directory, { minimumGames: 1 }), /Checksum or size mismatch/);
  });
}

test('deployment verification rejects a correctly hashed but unfinished state', async t => {
  const fixture = await siteFixture(t);
  fixture.state.bootstrapComplete = false;
  fixture.manifest.refreshState = await fixture.auxiliary('refresh', fixture.state);
  await fixture.saveManifest();
  await assert.rejects(verifySite(fixture.directory, { minimumGames: 1 }), /state is incomplete/);
});

test('deployment verification rejects a correctly hashed raw archive with a broken request reference', async t => {
  const fixture = await siteFixture(t);
  fixture.archive.apps[10].latest.request = '0'.repeat(64);
  fixture.manifest.steamArchive = { ...await fixture.auxiliary('steam-raw', fixture.archive), apps: 1 };
  await fixture.saveManifest();
  await assert.rejects(verifySite(fixture.directory, { minimumGames: 1 }), /Invalid Steam raw snapshot/);
});

test('deployment verification rejects fixture manifests and escaped data paths', async t => {
  const fixture = await siteFixture(t);
  fixture.manifest.fixture = true;
  await fixture.saveManifest();
  await assert.rejects(verifySite(fixture.directory, { minimumGames: 1 }), /production catalog/);
  fixture.manifest.fixture = false;
  fixture.manifest.refreshState.file = '../checkpoint.json.gz';
  await fixture.saveManifest();
  await assert.rejects(verifySite(fixture.directory, { minimumGames: 1 }), /Invalid refresh descriptor/);
});

test('published preflight stops on a first-deployment 404 with handoff instructions', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); return new Response('', { status: 404 }); };
  await assert.rejects(verifyPublishedSite('https://example.github.io/steamfeatures/'), /bootstrap_release.*No Steam backfill was started/);
  assert.deepEqual(calls, ['https://example.github.io/steamfeatures/data/manifest.json']);
});

test('published preflight requires the actual completed state, not only the manifest flag', async t => {
  const fixture = await siteFixture(t);
  fixture.manifest.coverage.games = 50000;
  fixture.state.bootstrapComplete = false;
  fixture.manifest.refreshState = await fixture.auxiliary('refresh', fixture.state);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async url => new Response(String(url).endsWith('/manifest.json') ? JSON.stringify(fixture.manifest) : await readFile(join(fixture.directory, 'data', fixture.manifest.refreshState.file)));
  await assert.rejects(verifyPublishedSite('https://example.github.io/steamfeatures/'), /Published Steam refresh state is incomplete/);
  fixture.state.bootstrapComplete = true;
  fixture.manifest.refreshState = await fixture.auxiliary('refresh', fixture.state);
  assert.deepEqual(await verifyPublishedSite('https://example.github.io/steamfeatures/'), { games: 50000, bootstrapComplete: true });
});

test('binary deployment verification compares game and tag semantics independent of row order', async t => {
  const catalog = { version: 1, fixture: false, coverage: { games: 3 }, refresh: { bootstrapComplete: true },
    features: [{ id: 2, key: 'single-player', name: 'Single-player', weight: 1 }, { id: 23, key: 'steam-cloud', name: 'Steam Cloud', weight: 3 }],
    tags: ['Puzzle', 'Co-op'], tagIndex: { encoding: 'delta-game-indices-v1', lists: [[0, 2], [1]] },
    games: [
      { id: 30, name: 'Thirty', featureIds: [2, 23], featureDataKnown: true, reviews: 100, positivePercent: 82.5 },
      { id: 20, name: 'Twenty', featureIds: [], featureDataKnown: false, reviews: null, positivePercent: null },
      { id: 10, name: 'Ten', featureIds: [2], featureDataKnown: true, customField: { retained: true } },
    ] };
  const fixture = await siteFixture(t, catalog);
  await fixture.addBinary();
  assert.equal((await verifySite(fixture.directory, { minimumGames: 1 })).games, 3);
});

for (const variant of ['raw', 'gzip', 'brotli']) {
  test(`binary deployment verification rejects corrupt ${variant} data`, async t => {
    const fixture = await siteFixture(t);
    const binary = await fixture.addBinary();
    const descriptor = variant === 'raw' ? binary : binary[variant];
    await fixture.put('data/' + descriptor.file, 'corrupt');
    await assert.rejects(verifySite(fixture.directory, { minimumGames: 1 }), /Checksum or size mismatch/);
  });
}

for (const [variant, compress] of [['gzip', gzipSync], ['brotli', brotliCompressSync]]) {
  test(`binary deployment verification rejects correctly hashed ${variant} data for a different payload`, async t => {
    const fixture = await siteFixture(t);
    const binary = await fixture.addBinary();
    const bytes = compress(Buffer.from('A different raw binary payload'));
    binary[variant].sha256 = sha256(bytes);
    binary[variant].bytes = bytes.length;
    await fixture.put('data/' + binary[variant].file, bytes);
    await fixture.saveManifest();
    await fixture.saveProvenance();
    await assert.rejects(verifySite(fixture.directory, { minimumGames: 1 }), /binary catalog does not match the raw binary catalog/);
  });
}

for (const field of ['game', 'tags', 'metadata']) {
  test(`binary deployment verification rejects valid checksums with changed ${field} semantics`, async t => {
    const fixture = await siteFixture(t);
    const altered = structuredClone(fixture.catalog);
    if (field === 'game') altered.games[0].name = 'Wrong title';
    if (field === 'metadata') altered.features[0].weight = 100;
    if (field === 'tags') {
      fixture.catalog.tags = ['Puzzle'];
      // Rebuild both JSON files with the same dictionary, but no game membership.
      const raw = Buffer.from(JSON.stringify(fixture.catalog));
      const compressed = gzipSync(raw);
      const hash = sha256(raw);
      fixture.manifest.current = { catalog: `catalog.${hash.slice(0, 16)}.json`, compressedCatalog: `catalog.${hash.slice(0, 16)}.json.gz`,
        sha256: hash, bytes: raw.length, gzipSha256: sha256(compressed), gzipBytes: compressed.length };
      await fixture.put('data/' + fixture.manifest.current.catalog, raw);
      await fixture.put('data/' + fixture.manifest.current.compressedCatalog, compressed);
      altered.tags = ['Puzzle'];
      altered.games[0].tagIds = [0];
    }
    await fixture.addBinary(altered);
    await assert.rejects(verifySite(fixture.directory, { minimumGames: 1 }), /Binary catalog (game 10|metadata) does not match the JSON catalog/);
  });
}

test('binary deployment verification checks provenance and the decoder asset', async t => {
  const fixture = await siteFixture(t);
  await fixture.addBinary();
  await fixture.put('provenance-lock.json', JSON.stringify({ catalog: { sha256: fixture.manifest.current.sha256 }, refreshState: fixture.manifest.refreshState, steamArchive: fixture.manifest.steamArchive }));
  await assert.rejects(verifySite(fixture.directory, { minimumGames: 1 }), /Provenance lock/);
  await fixture.saveProvenance();
  await rm(join(fixture.directory, 'catalog-binary.mjs'));
  await assert.rejects(verifySite(fixture.directory, { minimumGames: 1 }), /ENOENT/);
});

test('binary deployment verification checks retained previous payloads too', async t => {
  const fixture = await siteFixture(t);
  const previous = await siteFixture(t);
  const binary = await previous.addBinary({ ...previous.catalog, importedAt: 'older snapshot' });
  // Retain matching JSON and binary payloads for the previous snapshot.
  const oldCatalog = { ...previous.catalog, importedAt: 'older snapshot' };
  const bytes = Buffer.from(JSON.stringify(oldCatalog));
  const gzip = gzipSync(bytes);
  const hash = sha256(bytes);
  fixture.manifest.previous = { catalog: `catalog.${hash.slice(0, 16)}.json`, compressedCatalog: `catalog.${hash.slice(0, 16)}.json.gz`,
    sha256: hash, bytes: bytes.length, gzipSha256: sha256(gzip), gzipBytes: gzip.length, binary };
  await fixture.put('data/' + fixture.manifest.previous.catalog, bytes);
  await fixture.put('data/' + fixture.manifest.previous.compressedCatalog, gzip);
  for (const entry of [binary, binary.gzip, binary.brotli]) await fixture.put('data/' + entry.file, await readFile(join(previous.directory, 'data', entry.file)));
  await fixture.put('catalog-binary.mjs', 'Test decoder asset');
  await fixture.put('catalog-descriptor.mjs', 'Test descriptor asset');
  await fixture.saveManifest();
  await verifySite(fixture.directory, { minimumGames: 1 });
  await fixture.put('data/' + binary.brotli.file, 'corrupt retained payload');
  await assert.rejects(verifySite(fixture.directory, { minimumGames: 1 }), /Checksum or size mismatch/);
});
