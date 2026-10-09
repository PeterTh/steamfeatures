import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createSteamResponseArchive } from '../scripts/steam-archive.mjs';
import { buildSteamArchiveSnapshot, validateSteamArchiveSnapshot } from '../scripts/steam-archive-snapshot.mjs';

const start = Date.UTC(2026, 9, 9, 12);
async function temporary(t) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'steam-raw-snapshot-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(`${parent}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory: join(directory, 'journal'), outputDirectory: join(directory, 'output') };
}
const request = (items, extra = {}) => ({ method: 'IStoreBrowseService/GetItems',
  input: { ids: items.map(item => ({ appid: item.id })), context: { language: 'english', country_code: 'US' }, data_request: { include_basic_info: true } },
  body: { response: { store_items: items } }, status: 200, resultCode: '1', ...extra });

test('snapshot retains unknown nested item fields and exact shared requests, compressed separately', async t => {
  const options = await temporary(t);
  const record = createSteamResponseArchive({ directory: options.directory, now: () => start });
  const items = [{ id: 1, success: 1, future_field: { values: [null, 0, false, 'text'], nested: { yes: true } }, basic_info: { developers: [{ name: 'Example' }] } }, { id: 2, success: 1, another_future_field: 42 }];
  const original = request(items);
  await record(original);
  const { snapshot, descriptor } = await buildSteamArchiveSnapshot(options);
  assert.deepEqual(snapshot.apps[1].latest.item, items[0]);
  assert.deepEqual(snapshot.apps[2].latest.item, items[1]);
  assert.equal(snapshot.apps[1].latest.request, snapshot.apps[2].latest.request);
  assert.equal(Object.keys(snapshot.requests).length, 1);
  assert.deepEqual(snapshot.requests[snapshot.apps[1].latest.request].input, original.input);
  const bytes = await readFile(join(options.outputDirectory, descriptor.file));
  assert.deepEqual(JSON.parse(gunzipSync(bytes)), snapshot);
  assert.equal(descriptor.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(descriptor.bytes, bytes.length);
  assert.equal(descriptor.apps, 2);
  assert.equal(descriptor.successfulApps, 2);
  assert.match(descriptor.file, /^steam-raw\.[a-f0-9]{16}\.json\.gz$/);
});

test('later journal updates merge prior snapshot without losing untouched apps or mutating prior data', async t => {
  const first = await temporary(t), next = await temporary(t);
  await createSteamResponseArchive({ directory: first.directory, now: () => start })(request([{ id: 1, success: 1, unknown: 'old' }, { id: 2, success: 1, unknown: 'retained' }]));
  const { snapshot: previous } = await buildSteamArchiveSnapshot(first);
  const original = structuredClone(previous);
  await createSteamResponseArchive({ directory: next.directory, now: () => start + 1000 })(request([{ id: 1, success: 1, unknown: { updated: true } }]));
  const { snapshot } = await buildSteamArchiveSnapshot({ ...next, previous });
  assert.deepEqual(snapshot.apps[1].latest.item.unknown, { updated: true });
  assert.equal(snapshot.apps[2].latest.item.unknown, 'retained');
  assert.deepEqual(previous, original);
});

test('unavailable observations with appid zero keep StoreItem id and the last successful item', async t => {
  const options = await temporary(t);
  let now = start;
  const record = createSteamResponseArchive({ directory: options.directory, now: () => now });
  const successful = { id: 1351630, appid: 1351630, success: 1, unknown: { useful: 'data' } };
  await record(request([successful]));
  now += 1000;
  const unavailable = { id: 1351630, appid: 0, success: 2, unknown_failure_reason: 'removed' };
  await record(request([unavailable]));
  const { snapshot, descriptor } = await buildSteamArchiveSnapshot(options);
  assert.deepEqual(snapshot.apps[1351630].latest.item, unavailable);
  assert.deepEqual(snapshot.apps[1351630].successful.item, successful);
  assert.equal(descriptor.successfulApps, 1);
  assert.equal(Object.keys(snapshot.requests).length, 2);
});

test('older replays cannot replace newer observations and unused requests are pruned', async t => {
  const first = await temporary(t), next = await temporary(t);
  await createSteamResponseArchive({ directory: first.directory, now: () => start + 2000 })(request([{ id: 1, success: 1, value: 'newest' }]));
  const { snapshot: previous } = await buildSteamArchiveSnapshot(first);
  await createSteamResponseArchive({ directory: next.directory, now: () => start })(request([{ id: 1, success: 1, value: 'old' }]));
  const { snapshot } = await buildSteamArchiveSnapshot({ ...next, previous });
  assert.equal(snapshot.apps[1].latest.item.value, 'newest');
  assert.equal(Object.keys(snapshot.requests).length, 1);
  assert.deepEqual(snapshot, previous);
});

test('recovery from unavailable removes redundant successful copy and prunes obsolete requests', async t => {
  const options = await temporary(t);
  let now = start;
  const record = createSteamResponseArchive({ directory: options.directory, now: () => now });
  for (const success of [1, 2, 1]) { await record(request([{ id: 1, success, value: now }])); now += 1000; }
  const { snapshot } = await buildSteamArchiveSnapshot(options);
  assert.equal(snapshot.apps[1].latest.item.value, start + 2000);
  assert.equal(snapshot.apps[1].successful, undefined);
  assert.equal(Object.keys(snapshot.requests).length, 1);
});

test('snapshot preserves complete newest successful tag dictionary body and Query item data', async t => {
  const options = await temporary(t);
  let now = start;
  const record = createSteamResponseArchive({ directory: options.directory, now: () => now });
  const body = { response: { tags: [{ tagid: 19, name: 'Action', unknown: ['future'] }] }, extra_envelope: { retained: true } };
  await record({ method: 'IStoreService/GetTagList', input: { language: 'english' }, body, status: 200, resultCode: '1' });
  now += 1000;
  await record(request([{ id: 2, success: 1, future: true }], { method: 'IStoreQueryService/Query', input: { query: { start: 0, count: 1000 }, context: { country_code: 'US' } } }));
  now += 1000;
  await record({ method: 'IStoreService/GetTagList', input: { language: 'english' }, body: { response: { tags: [] } }, status: 503, resultCode: '1' });
  const { snapshot } = await buildSteamArchiveSnapshot(options);
  assert.deepEqual(snapshot.tagDictionary.body, body);
  assert.equal(snapshot.apps[2].latest.item.future, true);
  assert.equal(Object.keys(snapshot.requests).length, 2);
});

test('HTTP and Steam result failures cannot replace a successful observation as last successful', async t => {
  const options = await temporary(t);
  let now = start;
  const record = createSteamResponseArchive({ directory: options.directory, now: () => now });
  await record(request([{ id: 1, success: 1, value: 'good' }]));
  now += 1000;
  await record(request([{ id: 1, success: 1, value: 'bad HTTP' }], { status: 503 }));
  now += 1000;
  await record(request([{ id: 1, success: 1, value: 'bad result' }], { resultCode: '2' }));
  const { snapshot } = await buildSteamArchiveSnapshot(options);
  assert.equal(snapshot.apps[1].latest.item.value, 'bad result');
  assert.equal(snapshot.apps[1].successful.item.value, 'good');
  assert.equal(Object.keys(snapshot.requests).length, 2);
});

test('invalid previous references, timestamps and item identities are rejected', async t => {
  const options = await temporary(t);
  await createSteamResponseArchive({ directory: options.directory, now: () => start })(request([{ id: 1, success: 1 }]));
  const { snapshot } = await buildSteamArchiveSnapshot(options);
  assert.equal(validateSteamArchiveSnapshot(snapshot), snapshot);
  const badReference = structuredClone(snapshot);
  badReference.apps[1].latest.request = 'missing';
  assert.throws(() => validateSteamArchiveSnapshot(badReference), /reference/);
  const badId = structuredClone(snapshot);
  badId.apps[1].latest.item.id = 2;
  assert.throws(() => validateSteamArchiveSnapshot(badId), /item/);
  const badTimestamp = structuredClone(snapshot);
  Object.values(badTimestamp.requests)[0].fetchedAt = 'not a date';
  assert.throws(() => validateSteamArchiveSnapshot(badTimestamp), /request/);
  await assert.rejects(buildSteamArchiveSnapshot({ ...options, previous: { version: 99 } }), /Unsupported/);
});
