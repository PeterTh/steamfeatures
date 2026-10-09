import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createFixture } from '../scripts/fixture.mjs';
import { importCatalog } from '../scripts/import-catalog.mjs';
import { createRefreshState, applyRefreshResults, validateRefreshState } from '../scripts/refresh-state.mjs';
import { readPreviousRefreshState, sha256 } from '../scripts/sources.mjs';

const NOW = '2026-10-09T12:00:00.000Z';
const PREVIOUS_URL = 'https://peterth.github.io/steamfeatures/';
const TAGS = [{ tagid: 19, name: 'Action' }];

test('automated deployments never bootstrap from absent or newer unfinished checkpoint state', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'steam-atlas-bootstrap-guard-'));
  const priorSetting = process.env.STEAM_ALLOW_BOOTSTRAP;
  t.after(async () => {
    if (priorSetting === undefined) delete process.env.STEAM_ALLOW_BOOTSTRAP;
    else process.env.STEAM_ALLOW_BOOTSTRAP = priorSetting;
    await rm(temporary, { recursive: true, force: true });
  });
  process.env.STEAM_ALLOW_BOOTSTRAP = '0';
  const { sourceFile } = await preparedSource(temporary);
  const client = fakeClient();
  const checkpointFile = join(temporary, 'checkpoint.json');
  const options = { sourceFile, output: join(temporary, 'output'), checkpointFile, fixture: true, refresh: true, steamClient: client, now: NOW };
  await assert.rejects(importCatalog(options), /Automatic Steam bootstrap is disabled/);
  assert.deepEqual(client.calls, []);
  const completed = previousPackage().state;
  const steamStateFile = join(temporary, 'completed.json');
  await writeFile(steamStateFile, JSON.stringify(completed));
  const unfinished = { ...createRefreshState(), lastDiscoveryAt: NOW };
  await writeFile(checkpointFile, JSON.stringify(unfinished));
  await assert.rejects(importCatalog({ ...options, steamStateFile }), /Automatic Steam bootstrap is disabled/);
  assert.deepEqual(client.calls, []);
});

function item(id, reviews = 100) {
  return {
    item_type: 0, id, appid: id, type: 0, success: 1, visible: true,
    name: `Steam refreshed ${id}`, categories: { supported_player_categoryids: [2], feature_categoryids: [22, 23] },
    tagids: [19], reviews: { summary_filtered: { review_count: reviews, percent_positive: reviews ? 90 : 0 } },
    release: { steam_release_date: 1577836800 }
  };
}

function fakeClient({ query, items } = {}) {
  const calls = [];
  return {
    calls,
    get stats() { return { requests: calls.length, retries: 0 }; },
    async getTagList() { calls.push({ method: 'tags' }); return TAGS; },
    async queryReleased(input) {
      calls.push({ method: 'query', input });
      return query ? query(input) : { items: [], total: 0, start: input.start, count: 0 };
    },
    async getItems(ids) { calls.push({ method: 'items', ids }); return items ? items(ids) : ids.map(id => item(id)); }
  };
}

async function preparedSource(directory, { productionSize = false } = {}) {
  const source = await createFixture(join(directory, 'source'));
  if (productionSize) {
    // Keep only three released candidates while exercising the actual production
    // importer and coverage guards. All filler apps are synthetic upcoming games.
    const path = join(source.blueboxDirectory, 'data/0');
    const apps = JSON.parse(await readFile(path, 'utf8'));
    const reviews = JSON.parse(gunzipSync(await readFile(source.reviewsFile)));
    for (let id = 100000; id < 149995; id++) {
      apps[id] = { steam_appid: id, type: 'game', name: `Synthetic upcoming ${id}`, categories: [2], genres: [1], release_date: { coming_soon: true, date: 'Coming soon' } };
      reviews.push({ steam_appid: id, steam_reviews_count: 20, steam_reviews_percent: 80, tags: ['Action'] });
    }
    await writeFile(path, JSON.stringify(apps));
    const compressed = gzipSync(JSON.stringify(reviews));
    await writeFile(source.reviewsFile, compressed);
    source.sources.reviews.sha256 = sha256(compressed);
  }
  const sourceFile = join(directory, 'sources.json');
  await writeFile(sourceFile, JSON.stringify(source));
  return { sourceFile, source };
}

function previousPackage() {
  let state = createRefreshState();
  for (const [id, day] of [[10, 8], [20, 5], [30, 6]]) {
    state = applyRefreshResults(state, {
      now: `2026-10-0${day}T12:00:00.000Z`,
      results: [{ id, status: 'ok', metadata: {
        appType: 0, name: `Cached Steam ${id}`, reviews: 999, positivePercent: 95,
        tags: ['Action'], tagDataKnown: true, featureIds: [2, 23], featureDataKnown: true,
        releaseStatus: 'released', earlyAccess: false, releaseISO: '2020-01-01', releaseDate: '2020-01-01'
      } }]
    });
  }
  state.bootstrapComplete = true;
  state.lastDiscoveryAt = '2026-10-08T12:00:00.000Z';
  const stateBytes = gzipSync(JSON.stringify(state));
  const stateHash = sha256(stateBytes);
  const refreshState = { file: `refresh.${stateHash.slice(0, 16)}.json.gz`, sha256: stateHash, bytes: stateBytes.length };
  const catalogBytes = Buffer.from('{"previousCatalogFixture":true}');
  const catalogGzip = gzipSync(catalogBytes);
  const catalogHash = sha256(catalogBytes);
  const current = { catalog: `catalog.${catalogHash.slice(0, 16)}.json`, compressedCatalog: `catalog.${catalogHash.slice(0, 16)}.json.gz`, sha256: catalogHash, gzipSha256: sha256(catalogGzip) };
  const manifest = { version: 1, current, refreshState };
  const files = new Map([
    ['manifest.json', Buffer.from(JSON.stringify(manifest))],
    [refreshState.file, stateBytes], [current.catalog, catalogBytes], [current.compressedCatalog, catalogGzip]
  ]);
  return { state, manifest, files };
}

test('Steam bootstrap publishes durable compressed state, hashes, audit and authoritative metadata', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'steam-atlas-steam-import-'));
  try {
    const { sourceFile } = await preparedSource(temporary);
    const client = fakeClient({
      query: () => ({ items: [item(10), item(70)], total: 2, start: 0, count: 2 }),
      items: ids => ids.map(id => id === 30 ? { id, appid: id, success: 1, type: 12 } : item(id, 0))
    });
    const output = join(temporary, 'output');
    const checkpointFile = join(temporary, 'checkpoint/state.json');
    const { manifest, catalog } = await importCatalog({ sourceFile, output, fixture: true, refresh: true, bootstrap: true, steamClient: client, now: NOW, checkpointFile });
    const compressedState = await readFile(join(output, 'data', manifest.refreshState.file));
    assert.equal(sha256(compressedState), manifest.refreshState.sha256);
    assert.equal(compressedState.length, manifest.refreshState.bytes);
    const state = validateRefreshState(JSON.parse(gunzipSync(compressedState)));
    assert.deepEqual(JSON.parse(await readFile(checkpointFile, 'utf8')), state);
    assert.equal(state.bootstrapComplete, true);
    assert.equal(state.lastDiscoveryAt, NOW);
    assert.equal(state.apps[30].metadata.appType, 12);
    assert.deepEqual(client.calls.filter(call => call.method === 'items').map(call => call.ids), [[20, 30]]);
    assert.equal(catalog.games.some(game => game.id === 30), false);
    assert.equal(catalog.games.find(game => game.id === 20).reviews, 0);
    assert.equal(catalog.games.find(game => game.id === 70).metadataUpdatedAt, NOW);
    assert.equal(catalog.games.find(game => game.id === 10).reviewSource, 'steam');
    const report = JSON.parse(await readFile(join(output, 'refresh-report.json'), 'utf8'));
    assert.deepEqual(report.unresolved, []);
    assert.equal(report.bootstrapComplete, true);
    const lock = JSON.parse(await readFile(join(output, 'provenance-lock.json'), 'utf8'));
    assert.deepEqual(lock.refreshState, manifest.refreshState);
    assert.deepEqual(lock.refresh, manifest.refresh);
    const compressedCatalog = await readFile(join(output, 'data', manifest.current.compressedCatalog));
    assert.equal(sha256(compressedCatalog), manifest.current.gzipSha256);
    assert.equal(sha256(gunzipSync(compressedCatalog)), manifest.current.sha256);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('generic failures and incomplete bootstrap records block publication, then resume exact IDs without recrawling', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'steam-atlas-steam-resume-'));
  try {
    const { sourceFile } = await preparedSource(temporary);
    const output = join(temporary, 'output');
    const checkpointFile = join(temporary, 'checkpoint/state.json');
    const incomplete = item(30);
    delete incomplete.reviews;
    const failingClient = fakeClient({
      query: () => ({ items: [item(10)], total: 1, start: 0, count: 1 }),
      items: ids => ids.map(id => id === 20 ? { id, appid: 0, success: 2 } : incomplete)
    });
    const options = { sourceFile, output, fixture: true, refresh: true, bootstrap: true, now: NOW, checkpointFile };
    await assert.rejects(importCatalog({ ...options, steamClient: failingClient }), /2 unresolved released games/);
    await assert.rejects(access(join(output, 'data/manifest.json')), { code: 'ENOENT' });
    let checkpoint = validateRefreshState(JSON.parse(await readFile(checkpointFile, 'utf8')));
    assert.equal(checkpoint.bootstrapComplete, false);
    assert.deepEqual(checkpoint.bootstrapCursor, { nextStart: 1, queryComplete: true });
    assert.equal(checkpoint.apps[20].status, 'failed');
    assert.equal(checkpoint.apps[30].status, 'ok');
    assert.equal(checkpoint.apps[30].metadata.reviews, undefined);
    const unresolved = JSON.parse(await readFile(join(temporary, 'checkpoint/steam-refresh-unresolved.json'), 'utf8'));
    assert.deepEqual(unresolved.unresolved.map(game => ({ id: game.id, status: game.status })), [
      { id: 20, status: 'failed' }, { id: 30, status: 'ok' }
    ]);

    const repairedClient = fakeClient({
      query: () => { throw new Error('A completed bootstrap query must not be restarted'); },
      items: ids => ids.map(id => item(id))
    });
    const { manifest } = await importCatalog({ ...options, steamClient: repairedClient, now: '2026-10-10T12:00:00.000Z' });
    assert.deepEqual(repairedClient.calls.filter(call => call.method === 'items').map(call => call.ids), [[20, 30]]);
    assert.equal(repairedClient.calls.some(call => call.method === 'query'), false);
    checkpoint = validateRefreshState(JSON.parse(await readFile(checkpointFile, 'utf8')));
    assert.equal(checkpoint.bootstrapComplete, true);
    assert.equal(checkpoint.bootstrapCursor, undefined);
    assert.equal(checkpoint.apps[20].status, 'ok');
    assert.equal(checkpoint.apps[30].metadata.reviews, 100);
    await access(join(output, 'data/manifest.json'));
    assert.equal(manifest.refresh.unresolvedReleased, 0);
    const publishedState = JSON.parse(gunzipSync(await readFile(join(output, 'data', manifest.refreshState.file))));
    assert.deepEqual(publishedState, checkpoint);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('explicit Steam access denials permit bootstrap while preserving bulk values and reporting the exception', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'steam-atlas-steam-denied-'));
  try {
    const { sourceFile } = await preparedSource(temporary);
    const output = join(temporary, 'output');
    const checkpointFile = join(temporary, 'checkpoint/state.json');
    const client = fakeClient({
      query: () => ({ items: [item(10)], total: 1, start: 0, count: 1 }),
      items: ids => ids.map(id => id === 20 ? { id, appid: 0, success: 15 } : item(id))
    });
    const { catalog, manifest } = await importCatalog({
      sourceFile, output, fixture: true, refresh: true, bootstrap: true,
      steamClient: client, now: NOW, checkpointFile
    });
    const deniedGame = catalog.games.find(game => game.id === 20);
    assert.equal(deniedGame.name, 'Fixture: no Cloud badge');
    assert.equal(deniedGame.reviews, 1001);
    assert.deepEqual(deniedGame.featureIds, [2, 22]);
    assert.notEqual(deniedGame.reviewSource, 'steam');
    assert.equal(deniedGame.metadataUpdatedAt, undefined);
    const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
    assert.equal(checkpoint.bootstrapComplete, true);
    assert.equal(checkpoint.apps[20].status, 'unavailable');
    assert.equal(checkpoint.apps[20].resultCode, 15);
    assert.equal(checkpoint.apps[20].metadata, undefined);
    assert.equal(checkpoint.apps[20].checkedAt, undefined);
    assert.equal(checkpoint.apps[20].lastAttemptAt, NOW);
    const report = JSON.parse(await readFile(join(output, 'refresh-report.json'), 'utf8'));
    assert.deepEqual(report.unresolved, []);
    assert.deepEqual(report.denied.map(game => game.id), [20]);
    assert.equal(manifest.refresh.deniedReleased, 1);
    assert.equal(manifest.refresh.unresolvedReleased, 0);
    assert.equal(manifest.refresh.bootstrapComplete, true);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('a cache miss restores the published queue and metadata without restarting a full crawl', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'steam-atlas-steam-restore-'));
  const originalFetch = globalThis.fetch;
  try {
    const { sourceFile } = await preparedSource(temporary, { productionSize: true });
    const previous = previousPackage();
    const fetched = [];
    globalThis.fetch = async url => {
      const parsed = new URL(url);
      assert.ok(parsed.href.startsWith(`${PREVIOUS_URL}data/`));
      fetched.push(parsed.pathname.split('/').at(-1));
      const bytes = previous.files.get(fetched.at(-1));
      assert.ok(bytes, `Unexpected network request: ${url}`);
      return new Response(bytes);
    };
    const checkpointFile = join(temporary, 'missing-actions-cache/state.json');
    await assert.rejects(access(checkpointFile), { code: 'ENOENT' });
    const client = fakeClient({ items: ids => ids.map(id => item(id, 1234)) });
    const { catalog, manifest } = await importCatalog({
      sourceFile, output: join(temporary, 'output'), previousURL: PREVIOUS_URL,
      refresh: true, bootstrap: false, steamLimit: 1, steamClient: client, now: NOW, checkpointFile
    });
    const queries = client.calls.filter(call => call.method === 'query');
    assert.equal(queries.length, 1);
    assert.equal(queries[0].input.since, Date.parse('2026-09-24T12:00:00.000Z') / 1000);
    assert.equal(queries[0].input.until, Date.parse(NOW) / 1000);
    assert.deepEqual(client.calls.filter(call => call.method === 'items').map(call => call.ids), [[20]]);
    assert.equal(catalog.games.find(game => game.id === 10).reviews, 999);
    assert.equal(catalog.games.find(game => game.id === 10).name, 'Cached Steam 10');
    assert.equal(catalog.games.find(game => game.id === 20).reviews, 1234);
    assert.equal(catalog.games.find(game => game.id === 10).metadataUpdatedAt, '2026-10-08T12:00:00.000Z');
    assert.deepEqual(manifest.previous, previous.manifest.current);
    assert.deepEqual(fetched, ['manifest.json', previous.manifest.refreshState.file, previous.manifest.current.catalog, previous.manifest.current.compressedCatalog]);
    const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
    assert.equal(checkpoint.bootstrapComplete, true);
    assert.equal(checkpoint.apps[20].lastAttemptAt, NOW);
    assert.equal(checkpoint.apps[30].lastAttemptAt, '2026-10-06T12:00:00.000Z');
  } finally { globalThis.fetch = originalFetch; await rm(temporary, { recursive: true, force: true }); }
});

test('corrupt published refresh state fails closed before Steam calls or replacement publication', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'steam-atlas-steam-corrupt-'));
  const originalFetch = globalThis.fetch;
  try {
    const { sourceFile } = await preparedSource(temporary);
    const previous = previousPackage();
    globalThis.fetch = async url => new Response(String(url).endsWith('manifest.json')
      ? previous.files.get('manifest.json') : Buffer.from('corrupt deployed state'));
    const client = fakeClient();
    const output = join(temporary, 'output');
    await assert.rejects(importCatalog({ sourceFile, output, previousURL: PREVIOUS_URL, refresh: true, steamClient: client, now: NOW, checkpointFile: join(temporary, 'missing-state.json') }), /refresh state checksum mismatch/);
    assert.deepEqual(client.calls, []);
    await assert.rejects(access(join(output, 'data/manifest.json')), { code: 'ENOENT' });
  } finally { globalThis.fetch = originalFetch; await rm(temporary, { recursive: true, force: true }); }
});

test('refresh state descriptors cannot escape the deployment directory', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error('No download should be attempted'); };
    for (const file of ['../refresh.0123456789abcdef.json.gz', 'https://example.com/refresh.0123456789abcdef.json.gz', 'refresh.0123456789abcdef.json']) {
      await assert.rejects(readPreviousRefreshState({ manifestURL: new URL(`${PREVIOUS_URL}data/manifest.json`), manifest: { refreshState: { file, sha256: 'a'.repeat(64) } } }), /Untrusted/);
    }
    assert.equal(calls, 0);
    assert.equal(await readPreviousRefreshState({ manifest: {} }), null);
  } finally { globalThis.fetch = originalFetch; }
});
