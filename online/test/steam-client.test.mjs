import test from 'node:test';
import assert from 'node:assert/strict';
import { createSteamClient, parseRetryAfter, SteamRequestBudgetError } from '../scripts/steam-client.mjs';

const json = response => new Response(JSON.stringify({ response }), { headers: { 'x-eresult': '1' } });
const tagResponse = () => json({ tags: [{ tagid: 19, name: 'Action' }] });
const inputOf = url => JSON.parse(new URL(url).searchParams.get('input_json'));

function clock() {
  let time = 0;
  const waits = [];
  return { now: () => time, sleep: async ms => { waits.push(ms); time += ms; }, waits };
}

test('GetItems batches at 100, deduplicates IDs and requests the complete static collection profile', async () => {
  const calls = [];
  const timer = clock();
  const client = createSteamClient({ ...timer, fetchImpl: async (url, options) => {
    const input = inputOf(url);
    calls.push({ url: String(url), input, options });
    return json({ store_items: input.ids.map(({ appid }) => ({ id: appid, appid, success: appid === 2 ? 2 : 1 })) });
  } });
  const ids = Array.from({ length: 201 }, (_, i) => i + 1);
  const items = await client.getItems([...ids, 2]);
  assert.equal(items.length, 201);
  assert.equal(items[1].success, 2);
  assert.deepEqual(calls.map(call => call.input.ids.length), [100, 100, 1]);
  assert.deepEqual(timer.waits, [2000, 2000]);
  assert.deepEqual(calls[0].input.context, { language: 'english', country_code: 'US' });
  assert.deepEqual(calls[0].input.data_request, {
    include_release: true, include_basic_info: true, include_reviews: true,
    include_tag_count: 100, include_best_purchase_option: false,
    include_platforms: true, include_extra_details: true, include_supported_languages: true,
    include_links: true, include_ratings: true, include_assets: true, include_full_description: true,
    include_screenshots: true, include_trailers: true, include_assets_without_overrides: true
  });
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(new URL(calls[0].url).hostname, 'api.steampowered.com');
  assert.equal(new URL(calls[0].url).searchParams.has('key'), false);
  assert.deepEqual(client.stats, { requests: 3, retries: 0 });
});

test('release discovery sends a bounded date window with the validated enum; bootstrap can omit it', async () => {
  const calls = [];
  const client = createSteamClient({ spacingMs: 0, fetchImpl: async url => {
    calls.push(inputOf(url));
    return json({ metadata: { total_matching_records: 4, start: 3, count: 1 }, store_items: [{ id: 1351630 }] });
  } });
  const result = await client.queryReleased({ since: 100, until: 200, start: 3, count: 10 });
  assert.deepEqual(result, { items: [{ id: 1351630 }], total: 4, start: 3, count: 1 });
  assert.deepEqual(calls[0].query, {
    start: 3, count: 10,
    filters: { released_only: true, type_filters: { include_games: true }, release_date_filter: { release_date_type: 1, start_date: 100, end_date: 200 } }
  });
  await client.queryReleased({ start: 3 });
  assert.equal(calls[1].query.filters.release_date_filter, undefined);
  assert.equal(calls[1].query.count, 1000);
  assert.equal(calls[1].query.sort, undefined);
  await assert.rejects(client.queryReleased({ since: 1 }), /until must be an integer/);
  await assert.rejects(client.queryReleased({ since: 2, until: 1 }), /since must not exceed/);
  await assert.rejects(client.queryReleased({ count: 1001 }), /count must be an integer/);
  assert.equal(calls.length, 2);
});

test('concurrent calls are serialized, spaced and use immutable stats snapshots', async () => {
  const timer = clock();
  const started = [];
  let active = 0;
  let maximumActive = 0;
  const client = createSteamClient({ ...timer, fetchImpl: async () => {
    maximumActive = Math.max(maximumActive, ++active);
    started.push(timer.now());
    await Promise.resolve();
    active--;
    return tagResponse();
  } });
  await Promise.all([client.getTagList(), client.getTagList(), client.getTagList()]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(started, [0, 2000, 4000]);
  const copy = client.stats;
  copy.requests = 999;
  assert.equal(client.stats.requests, 3);
});

test('429 honors Retry-After and bounded exponential backoff, counting retry attempts', async () => {
  const timer = clock();
  let count = 0;
  const client = createSteamClient({ ...timer, fetchImpl: async () => {
    count++;
    if (count === 1) return new Response('', { status: 429, headers: { 'Retry-After': '12' } });
    if (count === 2) return new Response('', { status: 503 });
    return tagResponse();
  } });
  await client.getTagList();
  assert.deepEqual(timer.waits, [12000, 10000]);
  assert.deepEqual(client.stats, { requests: 3, retries: 2 });
});

test('long Retry-After ends the client run instead of retrying early', async () => {
  const timer = clock();
  const client = createSteamClient({ ...timer, fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '3600' } }) });
  await assert.rejects(client.getTagList(), error => error.steamRequestFailure && error.rateLimited && error.status === 429);
  await assert.rejects(client.getTagList(), /HTTP 429/);
  assert.equal(client.stats.requests, 1);
  assert.deepEqual(timer.waits, []);
});

test('Retry-After cooldown is preserved after a final failed attempt', async () => {
  const timer = clock();
  let count = 0;
  const client = createSteamClient({ ...timer, maxRetries: 0, fetchImpl: async () => ++count === 1
    ? new Response('', { status: 429, headers: { 'Retry-After': '12' } }) : tagResponse() });
  await assert.rejects(client.getTagList(), /HTTP 429/);
  await client.getTagList();
  assert.deepEqual(timer.waits, [12000]);
});

test('Retry-After supports HTTP dates and rejects invalid values', () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);
  assert.equal(parseRetryAfter('Fri, 09 Oct 2026 12:01:00 GMT', now), 60000);
  assert.equal(parseRetryAfter('Fri, 09 Oct 2026 11:59:00 GMT', now), 0);
  assert.equal(parseRetryAfter('1.5', now), 1500);
  assert.equal(parseRetryAfter('nonsense', now), null);
  assert.equal(parseRetryAfter(null, now), null);
});

test('request budget includes retries and stops subsequent methods without HTTP traffic', async () => {
  const timer = clock();
  const client = createSteamClient({ ...timer, maxRequests: 2, fetchImpl: async () => { throw new Error('network unavailable'); } });
  await assert.rejects(client.getTagList(), error => error instanceof SteamRequestBudgetError && error.steamRequestFailure && error.requestBudgetExceeded);
  await assert.rejects(client.getItems([1]), SteamRequestBudgetError);
  assert.deepEqual(client.stats, { requests: 2, retries: 1 });
  assert.deepEqual(timer.waits, [5000]);
});

test('ordinary HTTP and malformed API errors fail without retries', async () => {
  for (const response of [
    () => new Response('', { status: 403 }),
    () => new Response('{"response":{}}', { headers: { 'x-eresult': '2' } }),
    () => new Response('{"unexpected":true}'),
    () => json({ tags: [{ tagid: 1, name: '' }] }),
    () => json({ tags: [{ tagid: 1, name: 'A' }, { tagid: 1, name: 'B' }] })
  ]) {
    const client = createSteamClient({ spacingMs: 0, fetchImpl: async () => response() });
    await assert.rejects(client.getTagList());
    assert.equal(client.stats.requests, 1);
  }
});

test('network failures are distinguishable from schema failures after bounded retries', async () => {
  const network = createSteamClient({ maxRetries: 0, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(network.getTagList(), error => error.steamRequestFailure && !error.rateLimited && !error.requestBudgetExceeded);
  const malformed = createSteamClient({ fetchImpl: async () => json({ tags: 'unexpected' }) });
  await assert.rejects(malformed.getTagList(), error => !error.steamRequestFailure);
  const forbidden = createSteamClient({ fetchImpl: async () => new Response('', { status: 403 }) });
  await assert.rejects(forbidden.getTagList(), error => error.steamRequestFailure && !error.rateLimited && error.status === 403);
});

test('query rejects mismatched paging and missing items instead of accepting incomplete results', async () => {
  for (const response of [
    { metadata: { total_matching_records: 10, start: 0, count: 1 } },
    { metadata: { total_matching_records: 10, start: 3, count: 1 }, store_items: [{ id: 1 }] },
    { metadata: { total_matching_records: 10, start: 0, count: 2 }, store_items: [{ id: 1 }] },
    { metadata: { total_matching_records: 10, start: 0, count: 0 } },
    { metadata: { start: 0, count: 0 } }
  ]) {
    const client = createSteamClient({ spacingMs: 0, fetchImpl: async () => json(response) });
    await assert.rejects(client.queryReleased());
  }
  const client = createSteamClient({ fetchImpl: async () => json({ metadata: { total_matching_records: 0 } }) });
  assert.deepEqual(await client.queryReleased(), { items: [], total: 0, start: 0, count: 0 });
});

test('GetItems rejects unexpected IDs and bad input without inventing unavailable records', async () => {
  const client = createSteamClient({ spacingMs: 0, fetchImpl: async () => json({ store_items: [{ id: 1 }, { id: 1 }] }) });
  await assert.rejects(client.getItems([1]), /duplicate ID/);
  await assert.rejects(client.getItems([2]), /unexpected/);
  await assert.rejects(client.getItems([0]), /appid must/);
  assert.deepEqual(await client.getItems([]), []);
  assert.equal(client.stats.requests, 2);
  assert.throws(() => createSteamClient({ maxRequests: 0 }), /maxRequests must/);
});

test('raw response hook preserves unknown fields and request details before item validation', async () => {
  const body = { response: { store_items: [{ id: 1, appid: 0, success: 2, future_field: { values: [1, null, 'kept'] } }], future_envelope: true } };
  const captures = [];
  const client = createSteamClient({ spacingMs: 0, fetchImpl: async () => new Response(JSON.stringify(body)), recordResponse: async value => captures.push(structuredClone(value)) });
  await client.getItems([1]);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].method, 'IStoreBrowseService/GetItems');
  assert.deepEqual(captures[0].input.ids, [{ appid: 1 }]);
  assert.deepEqual(captures[0].input.context, { country_code: 'US', language: 'english' });
  assert.deepEqual(captures[0].body, body);
  assert.equal(captures[0].status, 200);
  await assert.rejects(client.getItems([2]), /unexpected/);
  assert.equal(captures.length, 2, 'invalid item response was still archived');
});

test('raw response hook captures schema errors, API-result errors, and HTTP JSON errors', async () => {
  for (const fixture of [
    { body: { unexpected: { keep: true } }, status: 200, headers: {}, error: /envelope/ },
    { body: { response: { future_error: 'details' } }, status: 200, headers: { 'x-eresult': '2' }, error: /result 2/ },
    { body: { message: 'try later', details: [1, 2] }, status: 503, headers: {}, error: /HTTP 503/ }
  ]) {
    const captures = [];
    const client = createSteamClient({ maxRetries: 0, fetchImpl: async () => new Response(JSON.stringify(fixture.body), { status: fixture.status, headers: fixture.headers }), recordResponse: async value => captures.push(value) });
    await assert.rejects(client.getTagList(), fixture.error);
    assert.deepEqual(captures.map(value => value.body), [fixture.body]);
    assert.equal(captures[0].status, fixture.status);
  }
});

test('archive write failures stop immediately without retrying or masquerading as network failures', async () => {
  for (const status of [200, 503]) {
    const client = createSteamClient({ maxRetries: 2, fetchImpl: async () => new Response(JSON.stringify({ response: { tags: [{ tagid: 19, name: 'Action' }] } }), { status }), recordResponse: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC', steamRequestFailure: true }); } });
    await assert.rejects(client.getTagList(), error => /Could not archive.*disk full/.test(error.message) && !error.steamRequestFailure);
    assert.deepEqual(client.stats, { requests: 1, retries: 0 });
  }
  assert.throws(() => createSteamClient({ recordResponse: true }), /must be a function/);
});
