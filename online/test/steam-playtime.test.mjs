import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createSteamClient } from '../scripts/steam-client.mjs';
import { SteamPlaytimeStore, measurePlaytime, exportPlaytime, verifyPlaytime, purchaseTypeFor, retainedReview,
  cumulativeFromReviews, compactReview, PLAYTIME_EDGES_HOURS, PURCHASE_TYPE, KNOWN_PLAYTIME_MAX_HOURS, populationMismatch } from '../scripts/steam-playtime.mjs';
import { collectSteamPlaytime } from '../scripts/collect-steam-playtime.mjs';

const review = (id, hoursAtReview, extra = {}) => ({ recommendationid: String(id), language: 'english',
  review: 'private text', timestamp_created: 1700000000 + id, voted_up: true, steam_purchase: true, refunded: false,
  hardware: { os: 'Windows' }, developer_response: 'thanks',
  author: { steamid: '76561190000000000', num_reviews: 3, playtime_forever: Math.round(hoursAtReview * 60) + 30,
    playtime_last_two_weeks: 0, playtime_at_review: Math.round(hoursAtReview * 60), last_played: 1700000500 }, ...extra });

/** Minimal GetAppReviews: recent order, cursor = next offset, inclusive
 * playtime_max_hours, and purchase_type 0 hiding non-purchase reviews. */
function fakeSteam(apps, { failAt = null, log = [] } = {}) {
  return async url => {
    const input = JSON.parse(url.searchParams.get('input_json'));
    log.push(input);
    if (failAt && failAt(input, log.length)) return new Response('{}', { status: 503 });
    const app = apps[input.appid];
    if (!app) return new Response(JSON.stringify({ response: {} }), { headers: { 'x-eresult': '42' } });
    let matching = app.filter(r => input.purchase_type === PURCHASE_TYPE.all || r.steam_purchase);
    if (input.playtime_max_hours) matching = matching.filter(r => r.author.playtime_at_review <= input.playtime_max_hours * 60);
    const offset = !input.cursor || input.cursor === '*' ? 0 : Number(input.cursor);
    const page = matching.slice(offset, offset + input.num_per_page);
    return new Response(JSON.stringify({ response: { query_summary: { num_reviews: page.length }, reviews: page,
      cursor: String(offset + page.length), total_matching: matching.length } }), { headers: { 'x-eresult': '1' } });
  };
}
async function setup(t, games, apps, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'steam-playtime-'));
  const store = new SteamPlaytimeStore(join(directory, 'playtime.sqlite'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  store.seed(games, { test: true }, { minReviews: 20 });
  const log = [];
  const client = createSteamClient({ spacingMs: 0, maxRetries: 0, fetchImpl: fakeSteam(apps, { ...options, log }),
    recordResponse: value => store.recordResponse(value) });
  return { directory, store, client, log };
}
const many = (n, hours, start = 0) => Array.from({ length: n }, (_, i) => review(start + i + 1, hours(i)));

test('purchase population follows Steam summaries and the seed keeps only reviewed games', async t => {
  assert.equal(purchaseTypeFor({ genres: ['Action', 'Free To Play'] }), PURCHASE_TYPE.all);
  assert.equal(purchaseTypeFor({ genres: ['Indie'] }), PURCHASE_TYPE.steam);
  assert.equal(purchaseTypeFor({}), PURCHASE_TYPE.steam);
  const { store } = await setup(t, [{ id: 1, reviews: 19 }, { id: 2, reviews: 20, genres: ['Free To Play'] }, { id: 3, reviews: 500 }], {});
  assert.deepEqual(store.pending().map(app => [app.id, app.purchase_type]), [[3, 0], [2, 1]]);
  assert.equal(store.setting('seed').apps, 2);
  store.seed([{ id: 9, reviews: 1000 }], {});
  assert.equal(store.progress().apps, 2, 'scope is frozen');
});

test('retained responses drop review text, developer replies, hardware and author identity', () => {
  const kept = retainedReview(review(1, 2));
  assert.equal(kept.review, undefined); assert.equal(kept.developer_response, undefined); assert.equal(kept.hardware, undefined);
  assert.equal(kept.author.steamid, undefined);
  assert.equal(kept.author.playtime_at_review, 120);
  assert.equal(kept.recommendationid, '1'); assert.equal(kept.voted_up, true);
});

test('small games use one page, mid-sized games page completely, and large games stop bands at the total', async t => {
  const apps = {
    10: many(40, i => i % 5),                       // 0-4h: one request
    20: many(250, i => (i % 50) + 0.5),              // paged: 3 requests
    30: many(1200, i => [1, 5, 10, 20][i % 4]),      // bands stop once <=28h covers all
    40: many(700, i => i === 0 ? 2000 : 2),          // one 2000h reviewer: all edges measured
  };
  const games = Object.keys(apps).map(id => ({ id: Number(id), reviews: apps[id].length }));
  const { store, client, log, directory } = await setup(t, games, apps);
  const result = await collectSteamPlaytime({ store, client });
  assert.equal(result.complete, true);
  assert.deepEqual(result.methods, { pages: 2, bands: 2 });
  const requests = id => log.filter(input => input.appid === id);
  assert.equal(requests(10).length, 1);
  assert.equal(requests(20).length, 3);
  assert.deepEqual(requests(30).filter(input => input.playtime_max_hours).map(input => input.playtime_max_hours), [KNOWN_PLAYTIME_MAX_HOURS, 3, 7, 14, 28]);
  assert.equal(requests(40).filter(input => input.playtime_max_hours).length, PLAYTIME_EDGES_HOURS.length + 1);
  assert.ok(requests(30).every(input => input.purchase_type === 0 && input.filter === 1 && input.languages[0] === 'all'));
  const rows = [...store.records()].slice(1);
  const by = Object.fromEntries(rows.map(row => [row.id, row]));
  assert.deepEqual(by[10].cumulative, [32, ...Array(8).fill(40)]);
  assert.equal(by[20].reviewRows.length, 250);
  assert.deepEqual(by[20].cumulative, cumulativeFromReviews(apps[20].map(compactReview)));
  assert.deepEqual(by[30].cumulative, [300, 600, 900, 1200, 1200, 1200, 1200, 1200, 1200]);
  assert.equal(by[30].measuredEdges, 4);
  assert.equal(by[30].reviewRows.length, 100, 'first page retained as a lifetime-playtime sample');
  assert.deepEqual(by[40].cumulative, [699, 699, 699, 699, 699, 699, 699, 699, 699]);
  // Journal keeps metadata only.
  const body = JSON.parse(gunzipSync(store.db.prepare("SELECT body FROM responses WHERE kind='page' LIMIT 1").get().body));
  assert.ok(!JSON.stringify(body).includes('private text') && !JSON.stringify(body).includes('76561190000000000'));
  const descriptor = await exportPlaytime(store, directory);
  assert.deepEqual(await verifyPlaytime(join(directory, descriptor.file), descriptor), { apps: 4, sha256: descriptor.sha256 });
});

test('reviews without playtime at review neither inflate the top band nor prevent early stopping', async t => {
  const legacy = (id) => { const r = review(id, 0); delete r.author.playtime_at_review; return r; };
  const apps = { 7: [...many(550, i => i % 6), ...Array.from({ length: 50 }, (_, i) => legacy(5000 + i))],
    8: Array.from({ length: 700 }, (_, i) => legacy(9000 + i)),
    9: [...many(80, () => 2), legacy(7777)] };
  const { store, client, log, directory } = await setup(t, Object.keys(apps).map(id => ({ id: Number(id), reviews: apps[id].length })), apps);
  await collectSteamPlaytime({ store, client });
  const by = Object.fromEntries([...store.records()].slice(1).map(row => [row.id, row]));
  assert.equal(by[7].total, 600); assert.equal(by[7].unknownAtReview, 50);
  assert.deepEqual(by[7].cumulative, [368, ...Array(8).fill(550)]);
  assert.equal(by[7].measuredEdges, 2);
  assert.equal(log.filter(input => input.appid === 7).length, 4, 'first page, known count and two bands');
  assert.equal(by[8].measuredEdges, 0); assert.deepEqual(by[8].cumulative, Array(9).fill(0)); assert.equal(by[8].unknownAtReview, 700);
  assert.equal(by[9].method, 'pages'); assert.equal(by[9].unknownAtReview, 1); assert.equal(by[9].cumulative[0], 80);
  const descriptor = await exportPlaytime(store, directory);
  await verifyPlaytime(join(directory, descriptor.file), descriptor);
});

test('free-to-play games count every review; paid games ignore non-purchase activations', async t => {
  const keys = many(300, () => 0.2, 1000).map(r => ({ ...r, steam_purchase: false }));
  const paid = [...many(30, () => 10), ...keys];
  const { store, client, log } = await setup(t, [{ id: 1, reviews: 30 }, { id: 2, reviews: 330, genres: ['Free To Play'] }], { 1: paid, 2: paid });
  await collectSteamPlaytime({ store, client });
  const [, one, two] = [...store.records()];
  assert.equal(one.total, 30); assert.equal(one.cumulative[2], 30);
  assert.equal(two.total, 330); assert.equal(two.cumulative[0], 300);
  assert.ok(log.filter(input => input.appid === 2).every(input => input.purchase_type === 1));
});

test('incomplete paging falls back to band counts instead of trusting a partial review set', async t => {
  const apps = { 5: many(300, i => i % 20) };
  const fetchImpl = fakeSteam(apps);
  const truncated = async url => {
    const input = JSON.parse(url.searchParams.get('input_json'));
    if (input.cursor && input.cursor !== '*' && Number(input.cursor) >= 200) {
      return new Response(JSON.stringify({ response: { query_summary: { num_reviews: 0 }, reviews: [], cursor: input.cursor, total_matching: 300 } }), { headers: { 'x-eresult': '1' } });
    }
    return fetchImpl(url);
  };
  const result = await measurePlaytime(createSteamClient({ spacingMs: 0, maxRetries: 0, fetchImpl: truncated }), { id: 5, purchase_type: 0 });
  assert.equal(result.method, 'bands');
  assert.equal(result.total, 300);
  assert.deepEqual(result.cumulative, cumulativeFromReviews(apps[5].map(compactReview)));
});

test('NoMatch is unavailable; generic failures stop, stay unknown and resume from the first page', async t => {
  const apps = { 1: many(150, () => 4), 3: many(25, () => 1) };
  let fail = true;
  const { store, client, log } = await setup(t, [{ id: 1, reviews: 150 }, { id: 2, reviews: 100 }, { id: 3, reviews: 25 }], apps,
    { failAt: input => fail && input.appid === 1 && input.cursor === '100' });
  await assert.rejects(collectSteamPlaytime({ store, client }), /HTTP 503/);
  assert.equal(store.progress().failed, 1);
  assert.equal(store.progress().checked, 0);
  fail = false;
  const result = await collectSteamPlaytime({ store, client });
  assert.equal(result.complete, true);
  assert.equal(result.unavailable, 1);
  assert.equal(result.failed, 0);
  assert.equal(log.filter(input => input.appid === 1 && (!input.cursor || input.cursor === '*')).length, 2, 'app restarted from its first page');
  const [, one] = [...store.records()];
  assert.equal(one.reviewRows.length, 150);
});

test('request limits and stop signals leave the interrupted app unchecked', async t => {
  const apps = { 1: many(2000, i => i % 100), 2: many(30, () => 1) };
  const { store, client, log } = await setup(t, [{ id: 1, reviews: 2000 }, { id: 2, reviews: 30 }], apps);
  const partial = await collectSteamPlaytime({ store, client, limit: 4 });
  assert.equal(log.length, 4);
  assert.equal(partial.checked, 0);
  assert.equal(store.pending().length, 2);
  let stop = false;
  const result = await collectSteamPlaytime({ store, client, shouldStop: () => stop, progress: async () => { stop = true; } });
  assert.equal(result.checked, 1);
  assert.equal((await collectSteamPlaytime({ store, client })).complete, true);
});

test('verification rejects altered histograms and tampered archives', async t => {
  const apps = { 1: many(30, i => i) };
  const { store, client, directory } = await setup(t, [{ id: 1, reviews: 30 }], apps);
  await collectSteamPlaytime({ store, client });
  store.db.prepare("UPDATE observations SET cumulative='[1,1,1,1,1,1,1,1,1]'").run();
  await assert.rejects(exportPlaytime(store, directory), /histogram mismatch/);
  store.db.prepare('UPDATE observations SET cumulative=?').run(JSON.stringify(cumulativeFromReviews(apps[1].map(compactReview))));
  const descriptor = await exportPlaytime(store, directory);
  await assert.rejects(verifyPlaytime(join(directory, descriptor.file), { ...descriptor, sha256: '0'.repeat(64) }), /checksum/);
});

test('free games without the genre switch to the population matching the catalog summary', async t => {
  const players = many(300, () => 3, 2000).map(r => ({ ...r, steam_purchase: false }));
  const apps = { 1: [...many(30, () => 20), ...players], 2: [...many(300, () => 1), ...many(300, () => 1, 5000).map(r => ({ ...r, steam_purchase: false }))] };
  // App 2: the catalog count is stale (30), but all reviews (600) would be further off than Steam purchases (300).
  const { store, client, log, directory } = await setup(t, [{ id: 1, reviews: 330 }, { id: 2, reviews: 30 }], apps);
  const result = await collectSteamPlaytime({ store, client });
  assert.equal(result.complete, true);
  const by = Object.fromEntries([...store.records()].slice(1).map(row => [row.id, row]));
  assert.equal(by[1].purchaseType, PURCHASE_TYPE.all); assert.equal(by[1].seededPurchaseType, PURCHASE_TYPE.steam);
  assert.equal(by[1].total, 330); assert.equal(by[1].reviewRows.length, 330);
  assert.equal(by[1].cumulative[0], 300, 'only the matching population contributes review rows');
  assert.deepEqual(log.filter(input => input.appid === 1 && (!input.cursor || input.cursor === '*')).map(input => input.purchase_type), [0, 1]);
  assert.equal(by[2].purchaseType, PURCHASE_TYPE.steam); assert.equal(by[2].seededPurchaseType, undefined);
  assert.equal(by[2].total, 300);
  const descriptor = await exportPlaytime(store, directory);
  await verifyPlaytime(join(directory, descriptor.file), descriptor);
});

test('older checkpoints migrate in place and completed apps can be remeasured with a logged reason', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'steam-playtime-'));
  let store;
  t.after(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  const filename = join(directory, 'playtime.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(filename);
  old.exec(`CREATE TABLE responses (sequence INTEGER PRIMARY KEY, id INTEGER NOT NULL, kind TEXT NOT NULL, parameter TEXT,
    checked_at TEXT NOT NULL, status INTEGER NOT NULL, result_code TEXT, body BLOB NOT NULL);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL, outcome TEXT NOT NULL, method TEXT, total INTEGER,
    cumulative TEXT, measured_edges INTEGER, unknown_at_review INTEGER, first_response INTEGER, last_response INTEGER, error TEXT);`);
  old.close();
  const apps = { 1: [...many(30, () => 20), ...many(300, () => 3, 2000).map(r => ({ ...r, steam_purchase: false }))] };
  store = new SteamPlaytimeStore(filename);
  store.seed([{ id: 1, reviews: 330 }], {}, { minReviews: 20 });
  // Simulate the pre-check collector: measure Steam purchases only.
  const client = createSteamClient({ spacingMs: 0, maxRetries: 0, fetchImpl: fakeSteam(apps), recordResponse: value => store.recordResponse(value) });
  const first = store.lastSequence() + 1;
  const page = await client.getAppReviews({ appid: 1, filter: 1, languages: ['all'], purchase_type: 0, num_per_page: 100, cursor: '*' });
  store.db.prepare('UPDATE responses SET purchase_type=NULL').run();
  store.finish(1, { outcome: 'success', firstResponse: first, result: { method: 'pages', total: 30, cumulative: cumulativeFromReviews(page.reviews.map(compactReview)), measuredEdges: 9, unknownAtReview: 0 } });
  store.close();
  store = new SteamPlaytimeStore(filename);
  assert.equal([...store.records()][1].total, 30);
  assert.throws(() => store.remeasure([1], ''), /reason/);
  store.remeasure([1], 'free game measured as Steam purchases');
  assert.equal(store.pending().length, 1);
  assert.equal(store.setting('remeasured')[0].observations[0].total, 30);
  const again = createSteamClient({ spacingMs: 0, maxRetries: 0, fetchImpl: fakeSteam(apps), recordResponse: value => store.recordResponse(value) });
  await collectSteamPlaytime({ store, client: again });
  const record = [...store.records()][1];
  assert.equal(record.total, 330); assert.equal(record.reviewRows.length, 330);
  assert.throws(() => store.remeasure([99], 'missing'), /no completed/);
});

test('population checks trigger beyond 5% and 20 reviews of the catalog summary count', () => {
  // Measured on live data: Fall Guys and Forza Horizon 4 (delisted) were 12% and 8% short as Steam purchases.
  assert.equal(populationMismatch(411054, 467986), true);
  assert.equal(populationMismatch(278636, 303529), true);
  assert.equal(populationMismatch(397893, 391525), false, 'ordinary 1.6% drift');
  assert.equal(populationMismatch(35, 25), false, 'small counts drift');
  assert.equal(populationMismatch(130, 100), true);
  assert.equal(populationMismatch(100, 0), false, 'no usable catalog count');
});
