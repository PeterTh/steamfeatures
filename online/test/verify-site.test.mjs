import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { verifyPublishedSite, verifySite } from '../scripts/verify-site.mjs';
import { applyRefreshResults, createRefreshState } from '../scripts/refresh-state.mjs';
import { sha256 } from '../scripts/sources.mjs';

async function siteFixture(t) {
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
  const catalog = { version: 1, fixture: false, coverage: { games: 1 }, refresh: { bootstrapComplete: true },
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
  const manifest = { version: 1, fixture: false, coverage: { games: 1 }, refresh: { bootstrapComplete: true }, current,
    refreshState: await auxiliary('refresh', state), steamArchive: { ...await auxiliary('steam-raw', archive), apps: 1, successfulApps: 1 } };
  const saveManifest = () => put('data/manifest.json', JSON.stringify(manifest));
  await saveManifest();
  await put('provenance-lock.json', JSON.stringify({ catalog: current, refreshState: manifest.refreshState, steamArchive: manifest.steamArchive }));
  for (const name of ['index.html', 'app.js', 'style.css', 'query.mjs', 'features.mjs', 'filter-worker.js', 'brand.svg', '.nojekyll',
    'fonts/roboto-condensed-variable.woff', 'fonts/LICENSE.txt', 'fonts/NOTICE.txt', 'licenses/BlueBoxWare-MIT.txt', 'licenses/leinstay-GPL-3.0.txt', 'licenses/NOTICE.txt']) await put(name, 'Test fixture');
  return { directory, put, auxiliary, manifest, state, archive, saveManifest };
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
