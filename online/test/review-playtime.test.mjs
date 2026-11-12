import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createSteamClient } from '../scripts/steam-client.mjs';
import { SteamPlaytimeStore, exportPlaytime, PURCHASE_TYPE } from '../scripts/steam-playtime.mjs';
import { collectSteamPlaytime } from '../scripts/collect-steam-playtime.mjs';
import { summarizePlaytime, roundTenths, roundCount, applyReviewPlaytime, PLAYTIME_CAP_TENTHS } from '../scripts/review-playtime.mjs';
import { emptyPlaytimeState, validatePlaytimeState, decodePlaytimeState, checkedPlaytimeState, writePlaytimeState, PlaytimeState,
  playtimeIndex, loadPlaytimeState, seedReviewPlaytimeState } from '../scripts/review-playtime-state.mjs';
import { encodeBinaryCatalog } from '../scripts/catalog-binary.mjs';
import { decodeBinaryCatalog } from '../src/catalog-binary.mjs';

const pages = minutes => ({ id: 1, outcome: 'success', method: 'pages', total: minutes.length,
  unknownAtReview: minutes.filter(value => value === null).length, reviewRows: minutes.map((value, i) => [String(i), 0, 0, value, 0, 0, 0, 'english']) });
const bands = (total, cumulative, unknownAtReview = 0) => ({ id: 2, outcome: 'success', method: 'bands', total, cumulative, unknownAtReview, reviewRows: [] });

test('rounding keeps tenths below 10 h, two significant digits above, and caps at 900 h', () => {
  assert.deepEqual([0, 4, 12.4, 99.6, 123, 155, 1534, 8960, 9100, 20000].map(roundTenths), [0, 4, 12, 100, 120, 160, 1500, 9000, 9000, 9000]);
});

test('known-review counts stay exact below 100 and keep two significant digits above', () => {
  assert.deepEqual([20, 99, 100, 123, 155, 392077].map(roundCount), [20, 99, 100, 120, 160, 390000]);
});

test('paged games use exact percentiles of known playtime', () => {
  // 21 reviews at 0..20 hours plus one without playtime.
  const summary = summarizePlaytime(pages([...Array.from({ length: 21 }, (_, i) => i * 60), null]));
  assert.deepEqual(summary, [21, 50, 100, 150]);
});

test('band games interpolate geometrically within bands and report the cap beyond 900 h', () => {
  // 100 known reviews: 20 at <=3h, 60 at <=7h, all at <=14h.
  const [known, p25, p50, p75] = summarizePlaytime(bands(100, [20, 60, 100, 100, 100, 100, 100, 100, 100]));
  assert.equal(known, 100);
  assert.equal(p25, roundTenths(10 * 3 * (7 / 3) ** (5 / 40)));
  assert.equal(p50, roundTenths(10 * 3 * (7 / 3) ** (30 / 40)));
  assert.equal(p75, roundTenths(10 * 7 * 2 ** (15 / 40)));
  assert.equal(summarizePlaytime(bands(100, [10, 20, 20, 20, 20, 20, 20, 20, 20]))[3], PLAYTIME_CAP_TENTHS);
  assert.equal(summarizePlaytime(bands(100, [80, 80, 80, 80, 80, 80, 80, 80, 80]))[2], roundTenths(10 * 3 * 50 / 80), 'the first band is linear from zero');
});

test('mostly-unknown and small samples have no summary', () => {
  assert.equal(summarizePlaytime(bands(1000, Array(9).fill(119), 881)), null, 'Warzone-like: playtime tracked under another app');
  assert.equal(summarizePlaytime(pages([...Array(19).fill(60)])), null);
  assert.notEqual(summarizePlaytime(pages([...Array(20).fill(60)])), null);
  assert.equal(summarizePlaytime({ id: 3, outcome: 'unavailable' }), null);
});

test('applying summaries replaces earlier playtime fields and leaves other games untouched', () => {
  const index = new Map([[10, { playtimeP25: 10, playtimeP50: 20, playtimeP75: 40 }]]);
  const games = applyReviewPlaytime([{ id: 10, name: 'A' }, { id: 12, name: 'B', playtimeP50: 5, playtimeP25: 1, playtimeP75: 9 }, { id: 13 }], index);
  assert.deepEqual(games, [{ id: 10, name: 'A', playtimeP25: 10, playtimeP50: 20, playtimeP75: 40 }, { id: 12, name: 'B' }, { id: 13 }]);
});

test('playtime columns use compact unsigned integers in the browser catalog', () => {
  const catalog = { version: 1, features: [], games: [{ id: 1, name: 'A', featureIds: [], playtimeP25: 12, playtimeP50: 150, playtimeP75: 9000 }, { id: 2, name: 'B', featureIds: [] }] };
  const bytes = encodeBinaryCatalog(catalog);
  const header = bytes.toString('utf8', 0, 2000);
  for (const key of ['playtimeP25', 'playtimeP50', 'playtimeP75']) assert.ok(header.includes(`{"key":"${key}","type":"uint"}`), key);
  assert.deepEqual(decodeBinaryCatalog(bytes).games, catalog.games);
});

const review = (id, hoursAtReview, extra = {}) => ({ recommendationid: String(id), language: 'english', timestamp_created: 1700000000 + id,
  voted_up: true, steam_purchase: true, author: { num_reviews: 1, playtime_forever: 999, playtime_last_two_weeks: 0,
    ...(hoursAtReview === null ? {} : { playtime_at_review: Math.round(hoursAtReview * 60) }), last_played: 1700000500 }, ...extra });
function fakeSteam(apps) {
  return async url => {
    const input = JSON.parse(url.searchParams.get('input_json'));
    const app = apps[input.appid];
    let matching = app.filter(r => input.purchase_type === PURCHASE_TYPE.all || r.steam_purchase);
    if (input.playtime_max_hours) matching = matching.filter(r => r.author.playtime_at_review !== undefined && r.author.playtime_at_review <= input.playtime_max_hours * 60);
    const offset = !input.cursor || input.cursor === '*' ? 0 : Number(input.cursor);
    const page = matching.slice(offset, offset + input.num_per_page);
    return new Response(JSON.stringify({ response: { query_summary: { num_reviews: page.length }, reviews: page,
      cursor: String(offset + page.length), total_matching: matching.length } }), { headers: { 'x-eresult': '1' } });
  };
}

const STATE_TIME = '2026-11-12T00:00:00.000Z';
const measured = (summary, extra = {}) => ({ checkedAt: STATE_TIME, outcome: 'success', measuredAt: STATE_TIME, purchaseType: 0, catalogReviews: 100,
  method: 'pages', total: 100, known: 90, ...(summary ? { summary } : {}), ...extra });
const stateWith = apps => ({ ...emptyPlaytimeState(), sourceArchives: ['a'.repeat(64)], apps });

test('state entries validate, merge attempts and measurements independently, and project only summaries', () => {
  const valid = stateWith({ 10: measured([10, 20, 40]), 11: measured(null, { known: 5 }), 12: { checkedAt: STATE_TIME, outcome: 'unavailable', failures: 1, retryAt: STATE_TIME } });
  assert.deepEqual([...playtimeIndex(validatePlaytimeState(valid))], [[10, { playtimeP25: 10, playtimeP50: 20, playtimeP75: 40 }]]);
  for (const entry of [measured([20, 10, 40]), measured([10, 20, PLAYTIME_CAP_TENTHS + 1]), measured([1, 2, 3], { known: 19 }), measured(null, { method: 'other' }),
    { checkedAt: STATE_TIME, outcome: 'success' }, { checkedAt: STATE_TIME, outcome: 'unavailable', summary: [1, 2, 3] }]) {
    assert.throws(() => validatePlaytimeState(stateWith({ 1: entry })), /Invalid review playtime state entry/, JSON.stringify(entry));
  }
  const store = new PlaytimeState().merge(stateWith({ 1: measured([10, 20, 40]) }));
  // A later NoMatch keeps the earlier measurement; an older copy cannot replace either.
  store.merge(stateWith({ 1: { ...measured([10, 20, 40]), checkedAt: '2026-11-20T00:00:00.000Z', outcome: 'unavailable', failures: 1, retryAt: '2026-12-20T00:00:00.000Z' } }));
  store.merge(stateWith({ 1: measured([1, 2, 3], { checkedAt: '2026-11-01T00:00:00.000Z', measuredAt: '2026-11-01T00:00:00.000Z' }) }));
  assert.equal(store.get(1).outcome, 'unavailable');
  assert.deepEqual(store.get(1).summary, [10, 20, 40]);
  store.merge(stateWith({ 1: measured([30, 60, 90], { checkedAt: '2026-12-21T00:00:00.000Z', measuredAt: '2026-12-21T00:00:00.000Z' }) }));
  assert.deepEqual([store.get(1).outcome, store.get(1).summary, store.get(1).retryAt], ['success', [30, 60, 90], undefined]);
  const budgets = new PlaytimeState().merge({ ...stateWith({}), budget: { date: '2026-11-12', attempts: 40, elapsedMs: 1000 } })
    .merge({ ...stateWith({}), budget: { date: '2026-11-12', attempts: 10, elapsedMs: 5000 } });
  assert.deepEqual(budgets.budget, { date: '2026-11-12', attempts: 40, elapsedMs: 5000 }, 'reruns on the same day cannot reset the allowance');
});

test('the published checkpoint round-trips through its content-addressed descriptor', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'review-playtime-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = stateWith({ 10: measured([10, 20, 40]) });
  const descriptor = await writePlaytimeState(state, directory);
  const bytes = await readFile(join(directory, descriptor.file));
  assert.deepEqual(checkedPlaytimeState(bytes, descriptor), state);
  assert.throws(() => checkedPlaytimeState(bytes, { ...descriptor, apps: 2 }), /count mismatch/);
  assert.throws(() => checkedPlaytimeState(Buffer.from('bad'), descriptor), /checksum/);
  assert.throws(() => checkedPlaytimeState(bytes, { ...descriptor, file: 'other.json.gz' }), /descriptor/);
});

test('seeding reads a verified, completed archive into the maintenance state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'review-playtime-'));
  const store = new SteamPlaytimeStore(join(directory, 'playtime.sqlite'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const apps = {
    10: Array.from({ length: 40 }, (_, i) => review(i + 1, i)),                                // paged: exact
    20: Array.from({ length: 900 }, (_, i) => review(i + 1, [1, 5, 10, 20][i % 4])),           // bands
    30: Array.from({ length: 600 }, (_, i) => review(i + 1, i < 100 ? 2 : null)),              // mostly unknown
  };
  store.seed(Object.keys(apps).map(id => ({ id: Number(id), reviews: apps[id].length })), { test: true }, { minReviews: 20 });
  const client = createSteamClient({ spacingMs: 0, maxRetries: 0, fetchImpl: fakeSteam(apps), recordResponse: value => store.recordResponse(value) });
  const output = join(directory, 'review-playtime-state.json.gz');
  await collectSteamPlaytime({ store, client, limit: 2 });
  let descriptor = await exportPlaytime(store, directory);
  await writeFile(join(directory, 'archive.json'), JSON.stringify(descriptor));
  await assert.rejects(seedReviewPlaytimeState({ directory, output }), /completed collection/);
  await collectSteamPlaytime({ store, client });
  descriptor = await exportPlaytime(store, directory);
  await writeFile(join(directory, 'archive.json'), JSON.stringify(descriptor));
  assert.equal((await seedReviewPlaytimeState({ directory, output })).summarized, 2);
  const state = decodePlaytimeState(await readFile(output));
  assert.deepEqual(state.sourceArchives, [descriptor.sha256]);
  assert.deepEqual(state.apps[10].summary, [98, 200, 290]);
  assert.deepEqual([state.apps[10].method, state.apps[10].known, state.apps[10].catalogReviews], ['pages', 40, 40]);
  assert.deepEqual([state.apps[20].method, state.apps[20].known], ['bands', 900], 'the state keeps the exact known-review count');
  assert.deepEqual([state.apps[30].known, state.apps[30].summary], [100, undefined], 'measured without a summary');
});

test('imports merge the seed, published checkpoint and working copy, and publish the result', async t => {
  const { importCatalog } = await import('../scripts/import-catalog.mjs');
  const { runQuery } = await import('../src/query.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'review-playtime-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seedFile = join(directory, 'seed.json.gz'), workingFile = join(directory, 'working.json.gz');
  await writeFile(seedFile, gzipSync(JSON.stringify(stateWith({ 10: measured([300, 600, 1200]), 20: measured([400, 900, 2000]) }))));
  const newer = '2026-11-20T00:00:00.000Z';
  await writeFile(workingFile, gzipSync(JSON.stringify(stateWith({ 20: measured([100, 200, 400], { checkedAt: newer, measuredAt: newer }) }))));
  const { catalog, manifest } = await importCatalog({ output: join(directory, 'site'), fixture: true, reviewPlaytimeStateFile: seedFile, reviewPlaytimeWorkingFile: workingFile });
  assert.deepEqual(['playtimeP25', 'playtimeP50', 'playtimeP75'].map(key => catalog.games.find(game => game.id === 20)[key]), [100, 200, 400]);
  assert.equal(catalog.games.find(game => game.id === 10).playtimeP50, 600);
  const published = checkedPlaytimeState(await readFile(join(directory, 'site/data', manifest.reviewPlaytimeState.file)), manifest.reviewPlaytimeState);
  assert.equal(published.apps[20].measuredAt, newer);
  assert.equal(manifest.sources.reviewPlaytime.sha256, manifest.reviewPlaytimeState.sha256);
  assert.deepEqual(catalog.sources.reviewPlaytime, manifest.sources.reviewPlaytime);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'site/provenance-lock.json'), 'utf8')).reviewPlaytimeState, manifest.reviewPlaytimeState);
  const binary = decodeBinaryCatalog(await readFile(join(directory, 'site/data', manifest.current.binary.file)));
  assert.deepEqual(runQuery(binary, { minReviews: 0, release: 'all', minPlaytime: 50 }).rows.map(row => row.id), [10]);
  // The next build restores this site's checkpoint as its previous deployment.
  const restored = await loadPlaytimeState({ seedFile, localPreviousDirectory: join(directory, 'site') });
  assert.equal(restored.get(20).measuredAt, newer);
  const { catalog: plain, manifest: plainManifest } = await importCatalog({ output: join(directory, 'plain'), fixture: true, reviewPlaytimeStateFile: null });
  assert.equal(plain.sources.reviewPlaytime, undefined); assert.equal(plainManifest.reviewPlaytimeState, undefined);
  assert.ok(plain.games.every(game => game.playtimeP50 === undefined));
});

test('the bundled seed is a valid state whose summaries need enough recorded playtime', async () => {
  const state = decodePlaytimeState(await readFile(new URL('../data/review-playtime-state.json.gz', import.meta.url)));
  const entries = Object.values(state.apps);
  assert.ok(entries.length > 60000 && state.sourceArchives.length === 1);
  assert.deepEqual(state.apps[620].summary, [59, 110, 210], 'Portal 2');
  assert.equal(state.apps[1962663].summary, undefined, 'Warzone tracks playtime under another app');
  assert.ok(entries.every(entry => !entry.summary || entry.known >= 20));
});
