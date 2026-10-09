import test from 'node:test';
import assert from 'node:assert/strict';
import { features } from '../src/features.mjs';
import { createSteamClient } from '../scripts/steam-client.mjs';
import { createRefreshState, applyRefreshResults } from '../scripts/refresh-state.mjs';
import { normalizeStoreItem, mergeSteamState, auditSteamCoverage, refreshSteam } from '../scripts/steam-refresh.mjs';

const DAY = 86400000;
const at = day => `2026-10-${String(day).padStart(2, '0')}T04:17:00.000Z`;
const tagNames = new Map([[19, 'Action'], [21, 'RPG']]);
const raw = (id, fields = {}) => ({
  appid: id, success: 1, type: 0, name: `Game ${id}`,
  categories: { supported_player_categoryids: [2], feature_categoryids: [22, 23], controller_categoryids: [55, 56] },
  reviews: { summary_filtered: { review_count: 100, percent_positive: 95 } },
  tagids: [21, 19], release: { steam_release_date: 1625529600 }, ...fields
});
const game = (id, fields = {}) => ({
  id, name: `Seed ${id}`, featureIds: [2], featureDataKnown: true,
  reviews: 10, positivePercent: 90, releaseDate: '2020-01-01', releaseISO: '2020-01-01',
  releaseStatus: 'released', earlyAccess: false, genres: ['Action'], ...fields
});
const normalize = item => normalizeStoreItem(item, { features, tagNames });
function ready(ids = [1, 2, 3], day = 1) {
  const state = applyRefreshResults(createRefreshState(), { results: ids.map(id => normalize(raw(id))), now: at(day) });
  state.bootstrapComplete = true;
  state.lastDiscoveryAt = at(day);
  return state;
}
function clientStub({ query = async () => ({ items: [], total: 0 }), items = async ids => ids.map(id => raw(id)) } = {}) {
  return {
    queries: [], batches: [], stats: { requests: 0 },
    async getTagList() { this.stats.requests++; return [...tagNames].map(([tagid, name]) => ({ tagid, name })); },
    async queryReleased(args) { this.stats.requests++; this.queries.push(structuredClone(args)); return query(args, this.queries.length); },
    async getItems(ids) { this.stats.requests++; this.batches.push([...ids]); return items(ids, this.batches.length); }
  };
}

test('Steam Ys IX normalization maps feature aliases, tag names, and purchase-review totals', () => {
  const item = raw(1351630, {
    name: ' Ys IX: Monstrum Nox ',
    categories: { supported_player_categoryids: [2], feature_categoryids: [22, 23, 31], controller_categoryids: [55, 56] },
    reviews: { summary_filtered: { review_count: 1771, percent_positive: 93 } },
    tagids: [21, 19, 21]
  });
  const result = normalize(item);
  assert.equal(result.id, 1351630);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.metadata, {
    appType: 0, name: 'Ys IX: Monstrum Nox', featureIds: [2, 22, 23, 55], featureDataKnown: true,
    reviews: 1771, positivePercent: 93, tags: ['Action', 'RPG'], tagDataKnown: true,
    releaseStatus: 'released', earlyAccess: false, releaseISO: '2021-07-06', releaseDate: '2021-07-06'
  });
  assert.deepEqual(normalize(raw(1, { tagids: undefined, tags: [{ tagid: 21 }] })).metadata.tags, ['RPG']);
});

test('Steam zero-review and empty-tag defaults are known zero/empty, not missing values', () => {
  for (const summary of [{ review_count: 0, percent_positive: 0 }, {}]) {
    const result = normalize(raw(1, { reviews: { summary_filtered: summary }, tagids: [], categories: {} }));
    assert.equal(result.metadata.reviews, 0);
    assert.equal(result.metadata.positivePercent, null);
    assert.deepEqual(result.metadata.tags, []);
    assert.equal(result.metadata.tagDataKnown, true);
    assert.deepEqual(result.metadata.featureIds, []);
    assert.equal(result.metadata.featureDataKnown, true);
  }
});

test('StoreItem ID takes precedence over a default-zero appid on unsuccessful responses', () => {
  assert.deepEqual(normalize({ id: 123, appid: 0, success: 2 }), { id: 123, status: 'failed', resultCode: 2 });
  assert.deepEqual(normalize({ id: 123, success: 2 }), { id: 123, status: 'failed', resultCode: 2 });
  assert.deepEqual(normalize({ appid: 123, success: 15 }), { id: 123, status: 'unavailable', resultCode: 15 });
  for (const item of [{ appid: 0 }, { id: 0, appid: 123 }, { id: -1 }, { id: 0x100000000 }]) {
    assert.throws(() => normalize({ ...item, success: 2 }), /invalid app ID/);
  }
});

test('real client responses with appid zero resume completed enumeration and preserve failed gaps', async () => {
  const state = ready([1]);
  state.bootstrapComplete = false;
  state.bootstrapCursor = { nextStart: 131714, queryComplete: true };
  const calls = [];
  const client = createSteamClient({ spacingMs: 0, fetchImpl: async url => {
    const { pathname, searchParams } = new URL(url);
    calls.push(pathname);
    let response;
    if (pathname.includes('GetTagList')) response = { tags: [...tagNames].map(([tagid, name]) => ({ tagid, name })) };
    else {
      assert.ok(pathname.includes('GetItems'), 'completed Query pages must not be requested again');
      assert.deepEqual(JSON.parse(searchParams.get('input_json')).ids, [{ appid: 2 }, { appid: 3 }]);
      response = { store_items: [{ id: 2, appid: 0, success: 2 }, { ...raw(3), id: 3 }] };
    }
    return new Response(JSON.stringify({ response }), { headers: { 'x-eresult': '1' } });
  } });
  const checkpoints = [];
  const result = await refreshSteam({ games: [1, 2, 3].map(id => game(id)), features, state, client, bootstrap: true, now: at(10), checkpoint: async state => checkpoints.push(structuredClone(state)) });
  assert.equal(calls.length, 2);
  assert.equal(result.state.apps[1].checkedAt, at(1));
  assert.equal(result.state.apps[2].status, 'failed');
  assert.equal(result.state.apps[2].resultCode, 2);
  assert.equal(result.state.apps[3].metadata.reviews, 100);
  assert.equal(result.state.bootstrapComplete, false);
  assert.equal(result.summary.refreshed, 2);
  assert.equal(result.summary.failures, 1);
  assert.deepEqual(checkpoints.at(-1), result.state);
  const merged = mergeSteamState([1, 2, 3].map(id => game(id)), new Map(), result.state);
  assert.deepEqual(auditSteamCoverage(merged.games, result.state).unresolved, [{ id: 2, name: 'Seed 2', status: 'failed', resultCode: 2 }]);
});

test('successful responses with absent optional fields preserve cached metadata and supersede older seed values', () => {
  const before = ready([1]);
  const partial = normalize({ appid: 1, success: 1, type: 0, name: 'Updated name' });
  assert.deepEqual(partial.metadata, { appType: 0, name: 'Updated name' });
  const state = applyRefreshResults(before, { results: [partial], now: at(2) });
  const merged = mergeSteamState([game(1)], new Map([[1, ['Older tag']]]), state);
  const actual = merged.games[0];
  assert.equal(actual.name, 'Updated name');
  assert.equal(actual.reviews, 100);
  assert.equal(actual.reviewSource, 'steam');
  assert.equal(actual.metadataUpdatedAt, at(2));
  assert.deepEqual(actual.featureIds, [2, 22, 23, 55]);
  assert.deepEqual(merged.tagsByApp.get(1), ['Action', 'RPG']);
  assert.equal(before.apps[1].metadata.name, 'Game 1');
});

test('Steam app types correct software and playtest seed entries without using title heuristics', () => {
  const state = applyRefreshResults(createRefreshState(), {
    results: [normalize(raw(1, { type: 6 })), normalize(raw(2, { type: 12 })), normalize(raw(3, { name: 'A Game Called Playtest' }))], now: at(1)
  });
  assert.deepEqual(state.apps[1].metadata, { appType: 6, name: 'Game 1' });
  const merged = mergeSteamState([game(1), game(2), game(3)], new Map([[1, ['Software']], [2, ['Test']], [3, ['Old']]]), state);
  assert.deepEqual(merged.games.map(item => item.id), [3]);
  assert.deepEqual([...merged.tagsByApp.keys()], [3]);
  assert.equal(merged.games[0].name, 'A Game Called Playtest');
});

test('coverage audit distinguishes verified empty metadata from incomplete and unavailable released games', () => {
  const state = applyRefreshResults(createRefreshState(), {
    results: [
      normalize(raw(1, { reviews: { summary_filtered: {} }, tagids: [], categories: {} })),
      normalize(raw(2, { reviews: undefined })),
      { id: 3, status: 'unavailable' }, normalize(raw(4, { type: 12 }))
    ], now: at(1)
  });
  const { games } = mergeSteamState([1, 2, 3, 4].map(id => game(id)), new Map(), state);
  const audit = auditSteamCoverage(games, state);
  assert.equal(audit.released, 3);
  assert.equal(audit.checked, 1);
  assert.deepEqual(audit.unresolved.map(({ id, status }) => ({ id, status })), [{ id: 2, status: 'ok' }, { id: 3, status: 'unavailable' }]);
});

test('only a validated per-app AccessDenied result qualifies for the unavailable exception', () => {
  for (const success of [2, 3, 84, 0xffffffff]) {
    assert.deepEqual(normalize({ id: 1, success }), { id: 1, status: 'failed', resultCode: success });
  }
  assert.deepEqual(normalize({ id: 1, success: 15 }), { id: 1, status: 'unavailable', resultCode: 15 });
  for (const success of [undefined, null, 0, -1, 1.5, '15', true, 0x100000000]) {
    assert.throws(() => normalize({ id: 1, success }), /invalid result code/);
  }
});

test('coverage reports confirmed denials separately and keeps unknown or failed results blocking', () => {
  let state = ready([1, 2, 3, 4]);
  state = applyRefreshResults(state, { results: [
    normalize({ id: 2, success: 15 }), normalize({ id: 3, success: 2 }),
    { id: 4, status: 'unavailable' }, normalize({ id: 5, success: 15 }),
    normalize({ id: 6, success: 1, name: 'Incomplete' })
  ], now: at(2) });
  const merged = mergeSteamState([1, 2, 3, 4, 5, 6, 7].map(id => game(id)), new Map(), state);
  const audit = auditSteamCoverage(merged.games, state);
  assert.equal(audit.released, 7);
  assert.equal(audit.checked, 1);
  assert.deepEqual(audit.denied, [
    { id: 2, name: 'Game 2', status: 'unavailable', resultCode: 15 },
    { id: 5, name: 'Seed 5', status: 'unavailable', resultCode: 15 }
  ]);
  assert.deepEqual(audit.unresolved, [
    { id: 3, name: 'Game 3', status: 'failed', resultCode: 2 },
    { id: 4, name: 'Game 4', status: 'unavailable' },
    { id: 6, name: 'Incomplete', status: 'ok' },
    { id: 7, name: 'Seed 7', status: 'not-checked' }
  ]);
});

test('denied seed and cached games retain existing values with explicit lookup provenance', () => {
  let state = ready([1]);
  state = applyRefreshResults(state, { results: [1, 2, 3].map(id => normalize({ id, success: 15 })), now: at(2) });
  const seeds = [game(1), game(2, { reviews: null, featureDataKnown: false }), game(3)];
  const seedTags = new Map([[1, ['Old']], [3, ['Retained']]]);
  const merged = mergeSteamState(seeds, seedTags, state);
  const [cached, missing, legacy] = merged.games;
  for (const entry of merged.games) {
    assert.equal(entry.steamLookupStatus, 'unavailable');
    assert.equal(entry.steamLookupResultCode, 15);
    assert.equal(entry.steamLookupAttemptedAt, at(2));
  }
  assert.equal(cached.reviews, 100);
  assert.equal(cached.metadataUpdatedAt, at(1));
  assert.equal(cached.reviewSource, 'steam');
  assert.equal(missing.reviews, null);
  assert.equal(missing.featureDataKnown, false);
  assert.equal(missing.metadataUpdatedAt, undefined);
  assert.equal(missing.reviewSource, undefined);
  assert.equal(missing.tagDataKnown, undefined);
  assert.equal(legacy.reviews, 10);
  assert.equal(legacy.metadataUpdatedAt, undefined);
  assert.equal(merged.tagsByApp.has(2), false);
  assert.deepEqual(merged.tagsByApp.get(3), ['Retained']);
  assert.deepEqual(seeds, [game(1), game(2, { reviews: null, featureDataKnown: false }), game(3)]);
  const recovered = applyRefreshResults(state, { results: [normalize(raw(1))], now: at(3) });
  assert.equal(mergeSteamState(merged.games, merged.tagsByApp, recovered).games[0].steamLookupStatus, undefined);
});

test('bootstrap accepts confirmed denials without another lookup while all other gaps are retried', async () => {
  let state = ready([1, 2]);
  state = applyRefreshResults(state, { results: [
    normalize({ id: 2, success: 15 }), normalize({ id: 3, success: 15 }),
    { id: 4, status: 'unavailable' }, normalize({ id: 5, success: 2 })
  ], now: at(2) });
  state.bootstrapComplete = false;
  state.bootstrapCursor = { nextStart: 131714, queryComplete: true };
  const client = clientStub();
  const result = await refreshSteam({ games: [1, 2, 3, 4, 5].map(id => game(id)), features, state, client, bootstrap: true, now: at(10) });
  assert.deepEqual(client.queries, []);
  assert.deepEqual(client.batches, [[4, 5]]);
  assert.equal(result.state.bootstrapComplete, true);
  assert.equal(result.state.apps[2].lastAttemptAt, at(2));
  assert.equal(result.state.apps[3].checkedAt, undefined);
  assert.equal(auditSteamCoverage(mergeSteamState([1, 2, 3, 4, 5].map(id => game(id)), new Map(), result.state).games, result.state).denied.length, 2);
});

test('bootstrap enumerates released listings once, then exact-lookups missing released seed IDs', async () => {
  const client = clientStub({
    query: async () => ({ items: [raw(1), raw(4)], total: 2 }),
    items: async ids => ids.map(id => raw(id, { type: 12 }))
  });
  const checkpoints = [];
  const result = await refreshSteam({ games: [game(1), game(2), game(3, { releaseStatus: 'upcoming' })], features, client, bootstrap: true, now: at(10), checkpoint: async value => checkpoints.push(structuredClone(value)) });
  assert.deepEqual(client.queries, [{ start: 0, count: 1000 }]);
  assert.deepEqual(client.batches, [[2]]);
  assert.equal(result.state.bootstrapComplete, true);
  assert.equal(result.state.lastDiscoveryAt, at(10));
  assert.equal(result.summary.discovered, 2);
  assert.equal(result.summary.refreshed, 1);
  assert.ok(checkpoints.length >= 2);
  const merged = mergeSteamState([game(1), game(2)], new Map(), result.state);
  assert.deepEqual(merged.games.map(item => item.id), [1, 4]);
  assert.deepEqual(auditSteamCoverage(merged.games, result.state), { released: 2, checked: 2, denied: [], unresolved: [] });
});

test('incremental updates query only the overlapping release window plus the bounded oldest-app batch', async () => {
  const state = ready([1, 2, 3, 4, 5]);
  const client = clientStub({ query: async () => ({ items: [raw(6)], total: 1 }) });
  const result = await refreshSteam({ games: [1, 2, 3, 4, 5, 6].map(id => game(id)), features, client, state, budget: 2, now: at(10) });
  assert.deepEqual(client.queries, [{
    since: Math.floor((Date.parse(at(1)) - 14 * DAY) / 1000), until: Date.parse(at(10)) / 1000, start: 0, count: 1000
  }]);
  assert.deepEqual(client.batches, [[1, 2]]);
  assert.equal(result.summary.discovered, 1);
  assert.equal(result.summary.refreshed, 2);
  assert.equal(result.state.apps[6].checkedAt, at(10));
  assert.equal(result.state.apps[3].checkedAt, at(1));
});

test('same-day reruns share the daily rotation budget and the next UTC day starts a new allowance', async () => {
  const client = clientStub();
  const games = [1, 2, 3].map(id => game(id));
  const first = await refreshSteam({ games, features, client, state: ready(), budget: 2, now: at(10) });
  assert.deepEqual(first.state.rotation, { date: '2026-10-10', attempted: 2 });
  const second = await refreshSteam({ games, features, client, state: first.state, budget: 2, now: at(10) });
  assert.equal(second.summary.refreshed, 0);
  assert.deepEqual(second.state.rotation, first.state.rotation);
  assert.deepEqual(client.batches, [[1, 2]]);
  const third = await refreshSteam({ games, features, client, state: second.state, budget: 2, now: at(11) });
  assert.equal(third.summary.refreshed, 2);
  assert.deepEqual(third.state.rotation, { date: '2026-10-11', attempted: 2 });
  assert.deepEqual(client.batches, [[1, 2], [3, 1]]);
});

test('a saved partial daily allowance permits only its remaining attempts', async () => {
  const state = ready();
  state.rotation = { date: '2026-10-10', attempted: 1 };
  const client = clientStub();
  const result = await refreshSteam({ games: [1, 2, 3].map(id => game(id)), features, client, state, budget: 3, now: at(10) });
  assert.deepEqual(client.batches, [[1, 2]]);
  assert.deepEqual(result.state.rotation, { date: '2026-10-10', attempted: 3 });
});

test('bounded discovery stores a frozen window and resumes its offset on the next run', async () => {
  const client = clientStub({ query: async ({ start }) => start === 0 ? { items: [raw(6), raw(7)], total: 4 } : { items: [raw(8), raw(9)], total: 4 } });
  const first = await refreshSteam({ games: [1, 2, 3].map(id => game(id)), features, client, state: ready(), budget: 1, now: at(10), maxDiscoveryPages: 1 });
  assert.deepEqual(first.state.discovery, { since: new Date(Date.parse(at(1)) - 14 * DAY).toISOString(), until: at(10), nextStart: 2 });
  assert.equal(first.state.lastDiscoveryAt, at(1));
  const second = await refreshSteam({ games: [1, 2, 3].map(id => game(id)), features, client, state: first.state, budget: 1, now: at(11), maxDiscoveryPages: 1 });
  assert.deepEqual(client.queries[1], { ...client.queries[0], start: 2 });
  assert.equal(second.state.discovery, undefined);
  assert.equal(second.state.lastDiscoveryAt, at(10));
  assert.deepEqual(client.batches, [[1], [2]]);
});

test('network failure preserves cached numbers and lets the next old game take its turn', async () => {
  const client = clientStub({ items: async (ids, call) => {
    if (call === 1) throw Object.assign(new Error('Temporary connection failure'), { steamRequestFailure: true });
    return ids.map(id => raw(id));
  } });
  const before = ready();
  const first = await refreshSteam({ games: [1, 2, 3].map(id => game(id)), features, client, state: before, budget: 1, now: at(10) });
  assert.equal(first.state.apps[1].status, 'failed');
  assert.equal(first.state.apps[1].metadata.reviews, 100);
  assert.equal(first.state.apps[1].checkedAt, at(1));
  assert.equal(first.summary.failures, 1);
  assert.deepEqual(first.state.rotation, { date: '2026-10-10', attempted: 1 });
  const second = await refreshSteam({ games: [1, 2, 3].map(id => game(id)), features, client, state: first.state, budget: 1, now: at(11) });
  assert.deepEqual(client.batches, [[1], [2]]);
  assert.equal(second.state.apps[2].status, 'ok');
  assert.equal(second.state.apps[1].metadata.reviews, 100);
  assert.equal(before.apps[1].status, 'ok');
});

test('bootstrap resumes its stored listing offset without repeating completed query pages', async () => {
  const state = ready([1]);
  state.bootstrapComplete = false;
  state.bootstrapCursor = { nextStart: 1000, queryComplete: false };
  const client = clientStub({ query: async () => ({ items: [raw(2)], total: 1001 }) });
  const result = await refreshSteam({ games: [game(1), game(2), game(3)], features, state, client, bootstrap: true, now: at(10) });
  assert.deepEqual(client.queries, [{ start: 1000, count: 1000 }]);
  assert.deepEqual(client.batches, [[3]]);
  assert.equal(result.state.apps[1].checkedAt, at(1));
  assert.equal(result.state.apps[2].checkedAt, at(10));
});

test('explicit bootstrap resumption retries missing, failed, unavailable, and incomplete games without repeating enumeration', async () => {
  let state = ready([1]);
  state = applyRefreshResults(state, { results: [
    { id: 2, status: 'failed' },
    normalize({ appid: 3, success: 1, type: 0, name: 'Incomplete' }),
    normalize(raw(4, { type: 12 })),
    { id: 5, status: 'unavailable' }
  ], now: at(2) });
  state.bootstrapComplete = false;
  state.bootstrapCursor = { nextStart: 1000, queryComplete: true };
  const client = clientStub();
  const result = await refreshSteam({ games: [1, 2, 3, 4, 5, 6].map(id => game(id)), features, state, client, bootstrap: true, now: at(10) });
  assert.deepEqual(client.queries, []);
  assert.deepEqual(client.batches, [[2, 3, 5, 6]]);
  assert.equal(result.state.apps[3].metadata.tagDataKnown, true);
  assert.equal(result.state.apps[5].status, 'ok');
});

test('exact lookups use at most 100 IDs, and omitted requested items become failures rather than vanish', async () => {
  const state = ready(Array.from({ length: 205 }, (_, index) => index + 1));
  const client = clientStub({ items: async ids => ids.filter(id => id !== 202).map(id => raw(id)) });
  const result = await refreshSteam({ games: Array.from({ length: 205 }, (_, index) => game(index + 1)), features, state, client, budget: 205, now: at(10) });
  assert.deepEqual(client.batches.map(ids => ids.length), [100, 100, 5]);
  assert.equal(result.state.apps[202].status, 'failed');
  assert.equal(result.state.apps[202].metadata.reviews, 100);
  assert.equal(result.summary.refreshed, 205);
  assert.equal(result.summary.failures, 1);
});

test('rate limits checkpoint and stop the run instead of immediately trying more games', async () => {
  const client = clientStub({ items: async () => { throw Object.assign(new Error('HTTP 429'), { steamRequestFailure: true, rateLimited: true }); } });
  const checkpoints = [];
  await assert.rejects(refreshSteam({ games: Array.from({ length: 205 }, (_, index) => game(index + 1)), features, state: ready(), client, budget: 205, now: at(10), checkpoint: async state => checkpoints.push(structuredClone(state)) }), /429/);
  assert.equal(client.batches.length, 1);
  assert.equal(checkpoints.at(-1).apps[4].status, 'failed');
  assert.deepEqual(checkpoints.at(-1).rotation, { date: '2026-10-10', attempted: 100 });
});

test('malformed fields and unexpected exact-lookup IDs stop publication instead of becoming network failures', async () => {
  assert.throws(() => normalize(raw(1, { categories: { feature_categoryids: [999] } })), /Unclassified/);
  assert.throws(() => normalize(raw(1, { tagids: [999] })), /Unknown Steam tag/);
  assert.throws(() => normalize(raw(1, { reviews: { summary_filtered: { review_count: -1 } } })), /review summary/);
  const state = ready();
  const client = clientStub({ items: async () => [raw(999)] });
  await assert.rejects(refreshSteam({ games: [game(1)], features, state, client, budget: 1, now: at(10) }), /unrequested/);
  assert.equal(state.apps[999], undefined);
});

test('incremental publication requires a completed bootstrap before requesting Steam', async () => {
  const client = clientStub();
  await assert.rejects(refreshSteam({ games: [], features, client, now: at(10) }), /bootstrap is required/);
  assert.equal(client.stats.requests, 0);
});
