import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createSteamResponseArchive, readSteamResponseArchive } from '../scripts/steam-archive.mjs';

const now = () => Date.UTC(2026, 9, 9, 12);
const request = (body = { response: { store_items: [] } }) => ({ method: 'IStoreBrowseService/GetItems', input: { ids: [{ appid: 1 }] }, body });
const readAll = async directory => { const records = []; for await (const record of readSteamResponseArchive(directory)) records.push(record); return records; };
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'steam-archive-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('archives complete unknown response fields and request provenance without mutating input', async t => {
  const directory = await temporary(t);
  const record = createSteamResponseArchive({ directory, now });
  const original = request({ response: { store_items: [{ id: 1, future_field: { nested: [false, null, 0, 'text'] } }] }, future_envelope: 'keep' });
  const expected = structuredClone(original);
  const path = await record({ ...original, status: 200, resultCode: '1' });
  assert.deepEqual(original, expected);
  const [restored] = await readAll(directory);
  assert.deepEqual(restored, { version: 1, fetchedAt: '2026-10-09T12:00:00.000Z', ...expected, status: 200, resultCode: '1' });
  assert.deepEqual(JSON.parse(gunzipSync(await readFile(path))), restored);
  assert.equal((await readdir(directory)).length, 1);
});

test('snapshots before awaiting so caller mutations cannot change archived data', async t => {
  const directory = await temporary(t);
  const record = createSteamResponseArchive({ directory, now });
  const original = request({ unexpected: { value: 'before' } });
  const pending = record(original);
  original.body.unexpected.value = 'after';
  original.input.ids[0].appid = 2;
  await pending;
  const [restored] = await readAll(directory);
  assert.equal(restored.body.unexpected.value, 'before');
  assert.equal(restored.input.ids[0].appid, 1);
});

test('parallel identical responses with the same timestamp all survive and replay deterministically', async t => {
  const directory = await temporary(t);
  const record = createSteamResponseArchive({ directory, now });
  const paths = await Promise.all(Array.from({ length: 20 }, () => record(request())));
  assert.equal(new Set(paths).size, 20);
  assert.equal((await readAll(directory)).length, 20);
  assert.deepEqual(await readAll(directory), await readAll(directory));
});

test('replay orders timestamps and ignores incomplete temporary files', async t => {
  const directory = await temporary(t);
  let time = now() + 1000;
  const record = createSteamResponseArchive({ directory, now: () => time });
  await record(request({ sequence: 2 }));
  time = now();
  await record(request({ sequence: 1 }));
  await writeFile(join(directory, 'incomplete.json.gz.tmp'), 'truncated');
  await writeFile(join(directory, 'README.txt'), 'not an archive');
  assert.deepEqual((await readAll(directory)).map(item => item.body.sequence), [1, 2]);
  assert.deepEqual(await readAll(join(directory, 'not-created-yet')), []);
});

test('replay rejects corrupt gzip, hash mismatches, and malformed envelopes', async t => {
  const directory = await temporary(t);
  const record = createSteamResponseArchive({ directory, now });
  const path = await record(request());
  await writeFile(path, 'bad gzip');
  await assert.rejects(readAll(directory), /Invalid Steam response archive/);
  await writeFile(path, gzipSync(JSON.stringify({ changed: true })));
  await assert.rejects(readAll(directory), /SHA-256 mismatch/);
  await rm(path);
  const malformed = Buffer.from(JSON.stringify({ version: 99 }));
  const digest = createHash('sha256').update(malformed).digest('hex');
  await writeFile(join(directory, `20261009T120000000Z-${digest}-00000000-0000-0000-0000-000000000000.json.gz`), gzipSync(malformed));
  await assert.rejects(readAll(directory), /Unsupported Steam archive envelope/);
});

test('archive write failures propagate without changing another existing file', async t => {
  const directory = await temporary(t);
  const blocked = join(directory, 'existing-file');
  await writeFile(blocked, 'preserve');
  const record = createSteamResponseArchive({ directory: blocked, now });
  await assert.rejects(record(request()), error => ['EEXIST', 'ENOTDIR'].includes(error.code));
  assert.equal(await readFile(blocked, 'utf8'), 'preserve');
});

test('rejects invalid configuration and metadata while retaining semantically invalid JSON responses', async t => {
  const directory = await temporary(t);
  assert.throws(() => createSteamResponseArchive(), /directory is required/);
  assert.throws(() => createSteamResponseArchive({ directory, now: 1 }), /must be a function/);
  const record = createSteamResponseArchive({ directory, now });
  await assert.rejects(record({ ...request(), method: '../escape' }), /Invalid Steam archive method/);
  await assert.rejects(record({ ...request(), body: undefined }), /Missing Steam archive response body/);
  await assert.rejects(record({ ...request(), status: 0 }), /Invalid Steam archive HTTP status/);
  await record(request(null));
  assert.equal((await readAll(directory))[0].body, null);
});
