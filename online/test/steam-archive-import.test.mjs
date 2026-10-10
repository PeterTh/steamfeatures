import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createFixture } from '../scripts/fixture.mjs';
import { importCatalog } from '../scripts/import-catalog.mjs';
import { createSteamResponseArchive, readSteamResponseArchive } from '../scripts/steam-archive.mjs';
import { readPreviousSteamArchive, sha256 } from '../scripts/sources.mjs';
import { applyRefreshResults, createRefreshState } from '../scripts/refresh-state.mjs';

const NOW = '2026-10-09T12:00:00.000Z';
const MANIFEST_URL = new URL('https://peterth.github.io/steamfeatures/data/manifest.json');
const rawField = { arrays: [0, false, null, { future: 'preserved' }], unused_by_site: true };
const item = id => ({
  id, appid: id, success: 1, type: 0, visible: true, name: `Raw test ${id}`,
  categories: { supported_player_categoryids: [2], feature_categoryids: [22, 23] },
  tagids: [19], reviews: { summary_filtered: { review_count: 100, percent_positive: 90 } },
  release: { steam_release_date: 1577836800 }, future_details: rawField
});
const collect = async directory => { const records = []; for await (const record of readSteamResponseArchive(directory)) records.push(record); return records; };

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'steam-archive-import-test-'));
  const originalFetch = globalThis.fetch;
  const originalSpacing = process.env.STEAM_REQUEST_SPACING_MS;
  process.env.STEAM_REQUEST_SPACING_MS = '0';
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalSpacing === undefined) delete process.env.STEAM_REQUEST_SPACING_MS;
    else process.env.STEAM_REQUEST_SPACING_MS = originalSpacing;
    await rm(directory, { recursive: true, force: true });
  });
  const sources = await createFixture(join(directory, 'source'));
  const sourceFile = join(directory, 'sources.json');
  await writeFile(sourceFile, JSON.stringify(sources));
  const output = join(directory, 'output');
  const checkpointFile = join(directory, 'cache/state.json');
  return { directory, output, archive: join(directory, 'cache/steam-responses'), options: {
    sourceFile, output, checkpointFile, fixture: true, refresh: true, bootstrap: true, now: NOW
  } };
}

function steamFetch({ unavailable = false } = {}) {
  const calls = [];
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.steampowered.com');
    const input = JSON.parse(parsed.searchParams.get('input_json'));
    calls.push({ pathname: parsed.pathname, input });
    let response;
    switch (parsed.pathname) {
      case '/IStoreService/GetTagList/v1/':
        response = { tags: [{ tagid: 19, name: 'Action', future_tag: rawField }], dictionary_extra: rawField };
        break;
      case '/IStoreQueryService/Query/v1/':
        response = { metadata: { total_matching_records: 1, start: 0, count: 1 }, store_items: [item(10)], query_extra: rawField };
        break;
      case '/IStoreBrowseService/GetItems/v1/':
        response = { store_items: input.ids.map(({ appid }) => unavailable && appid === 20
          ? { id: appid, appid: 0, success: 2, unavailable_extra: rawField } : item(appid)), batch_extra: rawField };
        break;
      default: throw new Error(`Unexpected fake network request: ${parsed.pathname}`);
    }
    return new Response(JSON.stringify({ response, envelope_extra: rawField }), { headers: { 'x-eresult': '1' } });
  };
  return calls;
}

test('default importer client archives unconsumed fields and publishes a separately recoverable raw snapshot', async t => {
  const context = await setup(t);
  const calls = steamFetch();
  const { manifest, catalog } = await importCatalog(context.options);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].input.ids, [{ appid: 20 }, { appid: 30 }]);
  const records = await collect(context.archive);
  assert.equal(records.length, 3);
  assert.ok(records.every(record => record.status === 200 && record.resultCode === '1'));
  assert.ok(records.every(record => JSON.stringify(record.body.envelope_extra) === JSON.stringify(rawField)));
  const batch = records.find(record => record.method === 'IStoreBrowseService/GetItems');
  assert.deepEqual(batch.input, calls[2].input);
  assert.deepEqual(batch.body.response.batch_extra, rawField);
  assert.deepEqual(batch.body.response.store_items[0].future_details, rawField);
  assert.equal(catalog.games.find(game => game.id === 20).future_details, undefined);

  const descriptor = manifest.steamArchive;
  assert.equal(descriptor.apps, 3);
  assert.equal(descriptor.successfulApps, 3);
  const bytes = await readFile(join(context.output, 'data', descriptor.file));
  assert.equal(sha256(bytes), descriptor.sha256);
  assert.equal(bytes.length, descriptor.bytes);
  const snapshot = JSON.parse(gunzipSync(bytes));
  assert.deepEqual(snapshot.apps[10].latest.item.future_details, rawField);
  assert.deepEqual(snapshot.apps[20].latest.item.future_details, rawField);
  assert.deepEqual(snapshot.apps[30].latest.item.future_details, rawField);
  assert.deepEqual(snapshot.tagDictionary.body.response.tags[0].future_tag, rawField);
  assert.deepEqual(snapshot.requests[snapshot.apps[20].latest.request].input, calls[2].input);
  const lock = JSON.parse(await readFile(join(context.output, 'provenance-lock.json'), 'utf8'));
  assert.deepEqual(lock.steamArchive, descriptor);

  globalThis.fetch = async url => {
    assert.equal(String(url), new URL(descriptor.file, MANIFEST_URL).href);
    return new Response(bytes);
  };
  assert.deepEqual(await readPreviousSteamArchive({ manifest: { steamArchive: descriptor }, manifestURL: MANIFEST_URL }), snapshot);
});

test('failed bootstrap retains a full raw generic failure without publishing an incomplete catalog', async t => {
  const context = await setup(t);
  steamFetch({ unavailable: true });
  await assert.rejects(importCatalog(context.options), /1 unresolved released games/);
  await assert.rejects(access(join(context.output, 'data/manifest.json')), { code: 'ENOENT' });
  const checkpoint = JSON.parse(await readFile(context.options.checkpointFile, 'utf8'));
  assert.equal(checkpoint.bootstrapComplete, false);
  assert.equal(checkpoint.apps[20].status, 'failed');
  const records = await collect(context.archive);
  assert.equal(records.length, 3);
  const batch = records.find(record => record.method === 'IStoreBrowseService/GetItems');
  assert.deepEqual(batch.body.response.store_items.find(game => game.id === 20), {
    id: 20, appid: 0, success: 2, unavailable_extra: rawField
  });
  assert.deepEqual(batch.body.response.store_items.find(game => game.id === 30).future_details, rawField);
});

async function legacyCheckpoint(context) {
  const state = applyRefreshResults(createRefreshState(), {
    now: NOW,
    results: [10, 30].map(id => ({ id, status: 'ok', metadata: {
      appType: 0, name: `Saved Steam ${id}`, reviews: 100, positivePercent: 90,
      tags: ['Action'], tagDataKnown: true, featureIds: [2, 22], featureDataKnown: true,
      releaseStatus: 'released', earlyAccess: false, releaseISO: '2020-01-01', releaseDate: '2020-01-01'
    } })).concat({ id: 20, status: 'unavailable' })
  });
  state.bootstrapCursor = { nextStart: 1, queryComplete: true };
  state.lastDiscoveryAt = NOW;
  state.rotation = { date: NOW.slice(0, 10), attempted: 4000 };
  await mkdir(join(context.directory, 'cache'), { recursive: true });
  await writeFile(context.options.checkpointFile, JSON.stringify(state));
  return state;
}

async function archiveDenial(context, { code = 15, requestedId = 20, status = 200, fetchedAt = NOW, method = 'IStoreBrowseService/GetItems' } = {}) {
  const record = createSteamResponseArchive({ directory: context.archive, now: () => Date.parse(fetchedAt) });
  await record({
    method, status, resultCode: '1', input: { ids: [{ appid: requestedId }], context: { country_code: 'US', language: 'english' } },
    body: { response: { store_items: [{ id: 20, appid: 0, success: code, unavailable_extra: rawField }] } }
  });
}

test('offline finalization recovers an observed legacy denial without HTTP or changing attempt history', async t => {
  const context = await setup(t);
  const before = await legacyCheckpoint(context);
  await archiveDenial(context);
  // Leave this inaccessible game's reviews and tags unknown. Upcoming records
  // bring the fixture above the production importer's minimum catalog size.
  const sourceFile = context.options.sourceFile;
  const source = JSON.parse(await readFile(sourceFile, 'utf8'));
  const path = join(source.blueboxDirectory, 'data/0');
  const apps = JSON.parse(await readFile(path, 'utf8'));
  const reviews = JSON.parse(gunzipSync(await readFile(source.reviewsFile)));
  const unknown = reviews.find(game => game.steam_appid === 20);
  unknown.steam_reviews_count = null;
  unknown.steam_reviews_percent = null;
  unknown.tags = null;
  for (let id = 100000; id < 149995; id++) {
    apps[id] = { steam_appid: id, type: 'game', name: `Synthetic upcoming ${id}`, categories: [2], genres: [1], release_date: { coming_soon: true, date: 'Coming soon' } };
    reviews.push({ steam_appid: id, steam_reviews_count: 20, steam_reviews_percent: 80, tags: ['Action'] });
  }
  await writeFile(path, JSON.stringify(apps));
  const compressed = gzipSync(JSON.stringify(reviews));
  await writeFile(source.reviewsFile, compressed);
  source.sources.reviews.sha256 = sha256(compressed);
  await writeFile(sourceFile, JSON.stringify(source));
  const fetched = [];
  globalThis.fetch = async url => { fetched.push(String(url)); throw new Error('Offline finalization must never request HTTP'); };
  const { catalog, manifest } = await importCatalog({
    ...context.options, fixture: false, refresh: false, finalizeSteam: true,
    previousURL: 'https://peterth.github.io/steamfeatures/', now: '2026-10-10T12:00:00.000Z'
  });
  assert.deepEqual(fetched, []);
  const checkpoint = JSON.parse(await readFile(context.options.checkpointFile, 'utf8'));
  assert.equal(checkpoint.bootstrapComplete, true);
  assert.equal(checkpoint.bootstrapCursor, undefined);
  assert.deepEqual(checkpoint.apps[10], before.apps[10]);
  assert.deepEqual(checkpoint.apps[30], before.apps[30]);
  assert.deepEqual(checkpoint.apps[20], { ...before.apps[20], resultCode: 15 });
  assert.equal(checkpoint.lastDiscoveryAt, NOW);
  assert.deepEqual(checkpoint.rotation, before.rotation);
  const game = catalog.games.find(game => game.id === 20);
  assert.equal(game.name, 'Fixture: no Cloud badge');
  assert.equal(game.reviews, null);
  assert.equal(game.positivePercent, null);
  assert.deepEqual(game.featureIds, [2, 22]);
  assert.notEqual(game.tagDataKnown, true);
  assert.equal(game.metadataUpdatedAt, undefined);
  assert.notEqual(game.reviewSource, 'steam');
  assert.equal(manifest.refresh.bootstrapComplete, true);
  assert.equal(manifest.refresh.deniedReleased, 1);
  assert.equal(manifest.refresh.unresolvedReleased, 0);
  assert.equal(manifest.refresh.requests, 0);
  const report = JSON.parse(await readFile(join(context.output, 'refresh-report.json'), 'utf8'));
  assert.deepEqual(report.denied.map(game => game.id), [20]);
  assert.deepEqual(report.unresolved, []);
  const rawBytes = await readFile(join(context.output, 'data', manifest.steamArchive.file));
  const raw = JSON.parse(gunzipSync(rawBytes));
  assert.deepEqual(raw.apps[20].latest.item.unavailable_extra, rawField);
});

test('offline finalization cannot bypass missing state or an unfinished enumeration', async t => {
  const context = await setup(t);
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Must not fetch during finalization'); };
  const options = { ...context.options, refresh: false, finalizeSteam: true };
  await assert.rejects(importCatalog({ ...options, sourceFile: undefined }), /requires prepared --sources/);
  await assert.rejects(importCatalog(options), /requires a saved Steam checkpoint/);
  const state = await legacyCheckpoint(context);
  state.bootstrapCursor.queryComplete = false;
  await writeFile(options.checkpointFile, JSON.stringify(state));
  await archiveDenial(context);
  await assert.rejects(importCatalog(options), /enumeration is not complete/);
  assert.equal(calls, 0);
  await assert.rejects(access(join(context.output, 'data/manifest.json')), { code: 'ENOENT' });
});

test('offline finalization accepts only matching successful-request evidence of an actual per-app denial', async t => {
  const cases = [
    { name: 'no archived observation', archive: false },
    { name: 'generic result code', code: 2 },
    { name: 'unrequested app', requestedId: 30 },
    { name: 'whole request forbidden', status: 403 },
    { name: 'stale observation', fetchedAt: '2026-10-08T12:00:00.000Z' },
    { name: 'different method', method: 'IStoreQueryService/Query' },
    { name: 'network failure', entry: 'failed' },
    { name: 'successful but incomplete response', entry: 'partial' }
  ];
  for (const scenario of cases) await t.test(scenario.name, async subtest => {
    const context = await setup(subtest);
    const state = await legacyCheckpoint(context);
    if (scenario.entry === 'failed') state.apps[20].status = 'failed';
    if (scenario.entry === 'partial') state.apps[20] = {
      status: 'ok', lastAttemptAt: NOW, checkedAt: NOW,
      metadata: { appType: 0, featureIds: [2], featureDataKnown: true, tagDataKnown: true, tags: [] }
    };
    await writeFile(context.options.checkpointFile, JSON.stringify(state));
    if (scenario.archive !== false) await archiveDenial(context, scenario);
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('Must not fetch during finalization'); };
    await assert.rejects(importCatalog({ ...context.options, refresh: false, finalizeSteam: true }), /1 unresolved released games/);
    assert.equal(calls, 0);
    await assert.rejects(access(join(context.output, 'data/manifest.json')), { code: 'ENOENT' });
    const saved = JSON.parse(await readFile(context.options.checkpointFile, 'utf8'));
    assert.equal(saved.bootstrapComplete, false);
    assert.equal(saved.apps[20].resultCode, undefined);
    assert.equal(saved.apps[20].lastAttemptAt, NOW);
  });
});

test('published raw archive rejects checksum corruption and untrusted paths', async t => {
  await setup(t);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('corrupted archive'); };
  const descriptor = { file: 'steam-raw.0123456789abcdef.json.gz', sha256: 'a'.repeat(64) };
  const previous = { manifestURL: MANIFEST_URL, manifest: { steamArchive: descriptor } };
  await assert.rejects(readPreviousSteamArchive(previous), /raw archive checksum mismatch/);
  assert.equal(calls, 1);
  for (const file of ['../steam-raw.0123456789abcdef.json.gz', 'https://example.com/steam-raw.0123456789abcdef.json.gz', 'steam-raw.0123456789abcdef.json']) {
    await assert.rejects(readPreviousSteamArchive({ ...previous, manifest: { steamArchive: { ...descriptor, file } } }), /Untrusted Steam raw archive descriptor/);
  }
  assert.equal(calls, 1);
  assert.equal(await readPreviousSteamArchive({ manifest: {} }), null);
});

test('published raw archive validates its structure after a correct checksum', async t => {
  await setup(t);
  const bytes = gzipSync(JSON.stringify({ version: 1, apps: { 10: { latest: {} } }, requests: {} }));
  const digest = sha256(bytes);
  globalThis.fetch = async () => new Response(bytes);
  await assert.rejects(readPreviousSteamArchive({ manifestURL: MANIFEST_URL, manifest: {
    steamArchive: { file: `steam-raw.${digest.slice(0, 16)}.json.gz`, sha256: digest }
  } }), /Invalid Steam raw snapshot item or request reference/);
});
