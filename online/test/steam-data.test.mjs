import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { SteamDataStore, writeSteamDataArchive, readSteamDataArchive, restoreSteamData, STEAM_DATA_FORMAT } from '../scripts/steam-data.mjs';
import { collectSteamData } from '../scripts/collect-steam-data.mjs';
import { STEAM_DATA_REQUEST } from '../scripts/steam-client.mjs';

const NOW = '2026-10-10T12:00:00.000Z';
const item = id => ({ id, appid: id, success: 1, visible: true, name: `Game ${id}`, extra_details: { no_mouse_keyboard_support: true } });
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'steam-data-'));
  const store = new SteamDataStore(join(directory, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store };
}

test('failed queries preserve data; explicit false and complete empty sections replace old positives', async t => {
  const { store } = await setup(t);
  store.seed(10, { name: 'Fallback', achievementCount: 12 });
  store.putStore(10, item(10), { request: STEAM_DATA_REQUEST });
  store.putAppInfo(10, { appid: '10', common: { category: { category_45: '1' } }, ufs: { sync_while_suspended: '1' } });
  store.putStore(10, { id: 10, success: 15 });
  store.putAppInfo(10, undefined, { result: 15 });
  assert.equal(store.get(10).store.extra_details.no_mouse_keyboard_support, true);
  assert.equal(store.get(10).appinfo.ufs.sync_while_suspended, '1');
  store.putStore(10, { id: 10, success: 1, visible: true }, { request: STEAM_DATA_REQUEST });
  assert.deepEqual(store.get(10).store.extra_details, {});
  store.putAppInfo(10, { appid: '10', common: {}, ufs: {} });
  assert.deepEqual(store.get(10).appinfo.ufs, {});
  assert.equal(store.get(10).fallback.achievementCount, 12);
});

test('public-only appinfo preserves private sections but replaces public categories; old profiles keep unrequested sections', async t => {
  const { store } = await setup(t);
  store.putAppInfo(10, { appid: '10', common: { category: { category_46: '1' }, nokeyboardmouse: '1' }, ufs: { sync_while_suspended: '1' }, config: { launch: {} } });
  store.putAppInfo(10, { appid: '10', public_only: '1', common: { category: {} } });
  assert.deepEqual(store.get(10).appinfo.common, { category: {} });
  assert.equal(store.get(10).appinfo.ufs.sync_while_suspended, '1');
  store.putStore(10, item(10), { request: STEAM_DATA_REQUEST });
  store.putStore(10, { id: 10, success: 1, visible: true, name: 'New title' }, { request: { include_basic_info: true } });
  assert.equal(store.get(10).store.name, 'New title');
  assert.equal(store.get(10).store.extra_details.no_mouse_keyboard_support, true);
});

test('collector commits batches, resumes without repeated lookups, and preserves unknown app results', async t => {
  const { store } = await setup(t);
  store.transaction(() => { for (let id = 1; id <= 205; id++) store.seed(id); });
  const calls = [], pics = [];
  let fail = true;
  const storeClient = {
    getTagList: async () => [{ tagid: 19, name: 'Action' }],
    getItems: async ids => { calls.push(ids); if (fail && ids[0] === 101) throw new Error('throttled'); return ids.map(item); }
  };
  const picsClient = { getItems: async ids => { pics.push(ids); return {
    apps: Object.fromEntries(ids.filter(id => id !== 205).map(id => [id, { appinfo: { appid: String(id), common: {}, public_only: '1' } }])), unknownApps: ids.includes(205) ? [205] : []
  }; } };
  await assert.rejects(collectSteamData({ store, storeClient, picsClient, now: () => NOW }), /throttled/);
  assert.equal(store.progress().storeChecked, 100);
  assert.equal(store.progress().picsChecked, 0);
  fail = false; calls.length = 0;
  const result = await collectSteamData({ store, storeClient, picsClient, now: () => NOW });
  assert.deepEqual(calls.map(ids => ids.length), [100, 5]);
  assert.equal(calls[0][0], 101);
  assert.deepEqual(pics.map(ids => ids.length), [100, 100, 5]);
  assert.equal(result.complete, true);
  assert.equal(store.get(205).pics_result, 15);
  calls.length = 0; pics.length = 0;
  await collectSteamData({ store, storeClient, picsClient, now: () => NOW });
  assert.equal(calls.length + pics.length, 0);
});

test('streaming archive round trips source payloads and future fields without operational history', async t => {
  const { store, directory } = await setup(t);
  store.seed(10, { name: 'Backup' });
  store.putStore(10, { ...item(10), future_field: { names: ['你好', 'ä'], value: false } });
  store.putAppInfo(10, { appid: '10', common: {}, ufs: { sync_while_suspended: '1' } });
  store.seed(20, { name: 'Unavailable game' });
  store.putStore(20, { id: 20, success: 15 });
  const descriptor = await writeSteamDataArchive({ records: store.records(), outputDirectory: directory, tagDictionary: [{ tagid: 19, name: 'Action' }], generatedAt: NOW });
  const path = join(directory, descriptor.file);
  const rows = [];
  for await (const row of readSteamDataArchive(path, descriptor)) rows.push(row);
  assert.equal(rows[0].format, STEAM_DATA_FORMAT);
  assert.deepEqual(rows.slice(1), [...store.records()]);
  assert.equal(descriptor.apps, 2);
  assert.equal(descriptor.successfulApps, 1);
  assert.equal(rows[1].store_checked, undefined);
  assert.equal(rows[2].store_result, undefined);
  const restored = new SteamDataStore(join(directory, 'restored.sqlite'));
  try {
    await restoreSteamData(restored, path, descriptor);
    assert.deepEqual([...restored.records()], [...store.records()]);
    assert.deepEqual(restored.setting('tags'), rows[0].tagDictionary);
  } finally { restored.close(); }
});

test('archive corruption, duplicate IDs and forged counts fail and cannot partially restore a checkpoint', async t => {
  const { store, directory } = await setup(t);
  const records = [{ id: 10, store: item(10) }, { id: 20, fallback: { name: 'Backup' } }];
  const descriptor = await writeSteamDataArchive({ records, outputDirectory: directory, generatedAt: NOW });
  const path = join(directory, descriptor.file);
  const original = await readFile(path);
  const read = async descriptor => { for await (const row of readSteamDataArchive(path, descriptor)) { /* consume validation */ } };
  await assert.rejects(read({ ...descriptor, apps: 3 }), /count mismatch/);
  const forged = { ...descriptor, sha256: '0'.repeat(64), file: `steam-raw.${'0'.repeat(16)}.jsonl.zst` };
  await assert.rejects(restoreSteamData(store, path, forged), /checksum/);
  assert.equal(store.progress().apps, 0);
  const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
  await writeFile(path, corrupt);
  await assert.rejects(read(descriptor));
  await writeFile(path, original.subarray(0, original.length - 2));
  await assert.rejects(read(descriptor), /size mismatch/);
  await assert.rejects(writeSteamDataArchive({ records: [records[0], records[0]], outputDirectory: directory }), /unique increasing/);
  const duplicate = zstdCompressSync(Buffer.from(JSON.stringify({ format: STEAM_DATA_FORMAT, generatedAt: NOW, tagDictionary: [] }) + '\n' + records.map(() => JSON.stringify(records[0])).join('\n') + '\n'));
  const hash = createHash('sha256').update(duplicate).digest('hex');
  await writeFile(path, duplicate);
  await assert.rejects(read({ ...descriptor, sha256: hash, file: `steam-raw.${hash.slice(0, 16)}.jsonl.zst`, bytes: duplicate.length }), /duplicate/);
});

test('archive restore compares each StoreBrowse check time rather than the later export time', async t => {
  const { store, directory } = await setup(t);
  const older = '2026-10-10T10:00:00.000Z', newer = '2026-10-10T11:00:00.000Z';
  store.putStore(10, { ...item(10), name: 'Newer cached response' }, { checkedAt: newer });
  store.putStore(20, { ...item(20), name: 'Older cached response' }, { checkedAt: older });
  const descriptor = await writeSteamDataArchive({ outputDirectory: directory, generatedAt: NOW, records: [
    { id: 10, store: { ...item(10), name: 'Older exported response' } },
    { id: 20, store: { ...item(20), name: 'Newer exported response' } },
  ] });
  const state = { apps: {
    10: { status: 'ok', lastAttemptAt: older },
    20: { status: 'ok', lastAttemptAt: newer },
  } };
  await restoreSteamData(store, join(directory, descriptor.file), descriptor, { state });
  assert.equal(store.get(10).store.name, 'Newer cached response');
  assert.equal(store.get(10).store_checked, newer);
  assert.equal(store.get(20).store.name, 'Newer exported response');
  assert.equal(store.get(20).store_checked, newer);
});

test('JSONL preserves Unicode separators and multibyte text across stream chunks', async t => {
  const { directory } = await setup(t);
  const records = [{ id: 10, store: { ...item(10), full_description_bbcode: ('Film\u2028Festival\u2029你好\r\n').repeat(12000) } },
    { id: 20, fallback: { name: 'Following record' } }];
  const descriptor = await writeSteamDataArchive({ records, outputDirectory: directory, generatedAt: NOW });
  const restored = [];
  for await (const row of readSteamDataArchive(join(directory, descriptor.file), descriptor)) restored.push(row);
  assert.deepEqual(restored.slice(1), records);
});
