import test from 'node:test';
import assert from 'node:assert/strict';
import { PURCHASE_TYPE } from '../scripts/steam-playtime.mjs';
import { emptyPlaytimeState, PlaytimeState, selectPlaytimeChecks, refreshReviewPlaytime, estimatedRequests } from '../scripts/review-playtime-state.mjs';

const NOW = Date.parse('2026-12-01T12:00:00Z'), DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const game = (id, reviews, extra = {}) => ({ id, reviews, releaseISO: '2020-01-01', genres: [], ...extra });
const measured = (catalogReviews, at = NOW - 60 * DAY, summary = [10, 20, 40]) => ({ checkedAt: iso(at), outcome: 'success', measuredAt: iso(at),
  purchaseType: 0, catalogReviews, method: 'pages', total: catalogReviews, known: summary ? catalogReviews : 5, ...(summary ? { summary } : {}) });
const stateOf = apps => new PlaytimeState().merge({ ...emptyPlaytimeState(), apps });

test('coverage comes first: new games, retries and grown games without a summary, then follow-ups, then doubled estimates', () => {
  const released = iso(NOW - 100 * DAY).slice(0, 10);
  const entries = stateOf({
    2: { checkedAt: iso(NOW - 40 * DAY), outcome: 'unavailable', failures: 1, retryAt: iso(NOW - DAY) },        // retry due
    3: { checkedAt: iso(NOW - DAY), outcome: 'unavailable', failures: 1, retryAt: iso(NOW + 29 * DAY) },        // not yet
    4: measured(40, NOW - 30 * DAY, null),                                                                  // no summary, grew 40 -> 60
    5: measured(40, NOW - 30 * DAY, null),                                                                  // no summary, barely grew
    6: measured(100, NOW - 95 * DAY),                                                                       // measured at age 5 days
    7: measured(100, NOW - 50 * DAY),                                                                       // measured at age 50 days
    8: measured(100, NOW - 40 * DAY),                                                                       // doubled
    9: measured(100, NOW - 10 * DAY),                                                                       // doubled but recent
    10: measured(100),                                                                                     // unchanged
  }).entries();
  const games = [game(1, 50), game(2, 30), game(3, 30), game(4, 60), game(5, 45), game(6, 120, { releaseISO: released }),
    game(7, 120, { releaseISO: released }), game(8, 250), game(9, 250), game(10, 110), game(11, 19), game(12, 5000)];
  const queue = selectPlaytimeChecks(games, entries, NOW);
  assert.deepEqual(queue.map(row => [row.id, row.priority]), [[12, 0], [1, 0], [4, 1], [2, 1], [6, 2], [8, 3]]);
  assert.deepEqual(queue.map(row => row.cost), [12, 2, 2, 2, 3, 4]);
  assert.deepEqual([20, 100, 101, 500, 501].map(estimatedRequests), [2, 2, 3, 6, 12]);
});

test('follow-ups run at 30, 90 and 365 days while the previous measurement is less than half as old', () => {
  const release = NOW - 400 * DAY, releaseISO = iso(release);
  const due = (measuredAge, age) => selectPlaytimeChecks([game(1, 100, { releaseISO })], stateOf({ 1: measured(100, release + measuredAge * DAY) }).entries(),
    release + age * DAY).length === 1;
  assert.deepEqual([[3, 29], [3, 30], [20, 30], [20, 90], [40, 89], [44, 90], [46, 90], [100, 365], [200, 365], [365, 400]].map(([m, a]) => due(m, a)),
    [false, true, false, true, false, true, false, true, false, false]);
});

const review = (id, hours) => ({ recommendationid: String(id), timestamp_created: 1700000000 + id, voted_up: true, steam_purchase: true, language: 'english',
  review: 'secret text', author: { steamid: '765', playtime_forever: 999, playtime_at_review: Math.round(hours * 60) } });
function fakeSteam(apps, { unavailable = new Set(), failing = new Set() } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    const input = JSON.parse(url.searchParams.get('input_json')); calls.push(input);
    if (unavailable.has(input.appid)) return new Response('{}', { headers: { 'x-eresult': '42' } });
    if (failing.has(input.appid)) return new Response('oops', { status: 500 });
    let matching = apps[input.appid].filter(r => input.purchase_type === PURCHASE_TYPE.all || r.steam_purchase);
    if (input.playtime_max_hours) matching = matching.filter(r => r.author.playtime_at_review <= input.playtime_max_hours * 60);
    const offset = !input.cursor || input.cursor === '*' ? 0 : Number(input.cursor), page = matching.slice(offset, offset + input.num_per_page);
    return new Response(JSON.stringify({ response: { reviews: page, cursor: String(offset + page.length), total_matching: matching.length } }), { headers: { 'x-eresult': '1' } });
  };
  return { fetchImpl, calls };
}
function setup(apps, entries = {}, fake = {}) {
  let clock = NOW;
  const steam = fakeSteam(apps, fake), state = stateOf(entries), responses = [];
  const options = { state, now: () => clock, sleep: async ms => { clock += ms; }, fetchImpl: async (...args) => { clock += 100; return steam.fetchImpl(...args); },
    recordResponse: async response => { responses.push(response); }, spacingMs: 1200 };
  return { state, options, calls: steam.calls, responses, advance: ms => { clock += ms; }, clock: () => clock };
}
const reviews = (n, hours = i => i % 10) => Array.from({ length: n }, (_, i) => review(i + 1, hours(i)));

test('the refresh measures due games within a daily request allowance that survives reruns', async () => {
  const apps = { 1: reviews(250), 2: reviews(40), 3: reviews(30) };
  const { state, options, calls, advance } = setup(apps);
  const games = [game(1, 250), game(2, 40), game(3, 30)];
  const first = await refreshReviewPlaytime({ ...options, games, maxRequests: 3 });
  // Game 1 (4 estimated requests) cannot fit in 3; the smaller games still can.
  assert.deepEqual([first.measured, first.deferred, first.new, first.reason], [2, 1, 2, 'complete']);
  assert.deepEqual(calls.map(input => input.appid), [2, 3]);
  assert.deepEqual(state.get(2).summary, [20, 45, 70]);
  assert.deepEqual([state.get(2).catalogReviews, state.get(2).method, state.get(2).known], [40, 'pages', 40]);
  assert.equal(state.budget.attempts, 2);
  const rerun = await refreshReviewPlaytime({ ...options, games, maxRequests: 3 });
  assert.deepEqual([rerun.attempted, rerun.deferred], [0, 1], 'the same UTC day keeps its spent allowance');
  advance(DAY);
  const nextDay = await refreshReviewPlaytime({ ...options, games, maxRequests: 10 });
  assert.deepEqual([nextDay.measured, state.get(1).summary?.length, nextDay.remaining], [1, 3, 0]);
});

test('NoMatch backs off 30, 90 and 180 days and keeps earlier measurements; other failures stop the phase', async () => {
  const apps = { 1: reviews(40), 2: reviews(40), 3: reviews(40) };
  const { state, options, advance, clock } = setup(apps, { 1: measured(20, NOW - 400 * DAY) }, { unavailable: new Set([1]), failing: new Set([2]) });
  // Game 1's reviews doubled since its old measurement, so it is due; Steam now reports NoMatch.
  const first = await refreshReviewPlaytime({ ...options, games: [game(1, 40)] });
  assert.deepEqual([first.unavailable, first.reason], [1, 'complete']);
  assert.deepEqual([state.get(1).outcome, state.get(1).failures, state.get(1).summary], ['unavailable', 1, [10, 20, 40]]);
  assert.equal(Date.parse(state.get(1).retryAt) - Date.parse(state.get(1).checkedAt), 30 * DAY);
  const second = await refreshReviewPlaytime({ ...options, games: [game(2, 40), game(3, 40)] });
  assert.deepEqual([second.failures, second.reason, second.measured], [1, 'service-error', 0]);
  assert.deepEqual([state.get(2).outcome, state.get(2).failures], ['error', 1]);
  assert.equal(state.get(3), undefined, 'the phase stopped before game 3');
  for (const days of [90, 180, 180]) {
    advance(Date.parse(state.get(1).retryAt) - clock() + DAY); // jump past the retry time
    const before = state.get(1).failures;
    await refreshReviewPlaytime({ ...options, games: [game(1, 40)] });
    assert.equal(state.get(1).failures, before + 1);
    assert.equal(Date.parse(state.get(1).retryAt) - Date.parse(state.get(1).checkedAt), days * DAY);
  }
});

test('responses reach the journal callback and a cooldown postpones the run', async () => {
  const { state, options, responses } = setup({ 1: reviews(40) });
  await refreshReviewPlaytime({ ...options, games: [game(1, 40)] });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].method, 'IUserReviewsService/GetAppReviews');
  state.pacing.cooldownAt = iso(NOW + 3600000);
  const cooled = await refreshReviewPlaytime({ ...options, games: [game(2, 40)] });
  assert.deepEqual([cooled.reason, cooled.attempted], ['cooldown', 0]);
});
