import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { AchievementRefreshStore, emptyAchievementState, validateAchievementState, decodeAchievementState, checkedAchievementState,
  writeAchievementState, achievementStateIndex, selectAchievementChecks, refreshAchievementSets } from '../scripts/achievement-refresh.mjs';
import { importCatalog } from '../scripts/import-catalog.mjs';
import { acquireCollectionLock } from '../scripts/collect-steam-supplement.mjs';

const NOW = Date.parse('2026-10-23T12:00:00Z'), DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const known = (hasSets = false, at = NOW - 8 * DAY) => ({ checkedAt: iso(at), successfulAt: iso(at), outcome: 'success',
  hasSets, schemaVersion: 1, schemaHash: 123, release: 'released' });
const game = (id, reviews = 100, releaseStatus = 'released') => ({ id, reviews, releaseStatus, featureIds: [22] });
const schema = (hasSets, hash = 123) => ({ schema_version: 1, schema_hash: hash, achievements: [],
  groups: (hasSets ? [0, 1] : [0]).map(groupid => ({ groupid, ispublic: true, developeronly: false, archived: false, total_achievements: 1 })) });
const response = (body, code = 1) => new Response(JSON.stringify({ response: body }), { headers: { 'x-eresult': String(code) } });
async function setup(t, apps = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'steam-achievement-refresh-'));
  const store = new AchievementRefreshStore(join(directory, 'state.sqlite'));
  store.merge({ ...emptyAchievementState(), apps });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  let clock = NOW;
  const calls = [];
  const options = { store, directory, now: () => clock, sleep: async ms => { clock += ms; }, recordResponse: async () => {},
    fetchImpl: async url => {
      const input = JSON.parse(url.searchParams.get('input_json')); calls.push(input);
      clock += 10;
      return response(input.hash_only ? { schema_version: 1, schema_hash: 123 } : schema(true));
    } };
  return { directory, store, options, calls, advance: ms => { clock += ms; } };
}

test('unseen games precede older games; unchanged schemas require only a hash check', async t => {
  const { store, options, calls } = await setup(t, { 1: known(false), 2: known(true) });
  const result = await refreshAchievementSets({ ...options, games: [game(1, 10000), game(2), game(3, 0)], maxRequests: 2 });
  assert.deepEqual(calls.map(value => value.appid), [3, 1]);
  assert.equal(calls[0].hash_only, undefined); assert.equal(calls[1].hash_only, true);
  assert.equal(store.get(3).hasSets, true); assert.equal(store.get(1).hasSets, false);
  assert.equal(store.get(2).checkedAt, known(true).checkedAt);
  assert.equal(result.unchanged, 1); assert.equal(result.newGames, 1); assert.equal(result.reason, 'budget');
  assert.equal(store.setting('budget').attempts, 2);
});

test('a changed hash cannot overwrite a flag until a full valid schema is fetched, even across daily budgets', async t => {
  const { store, options, calls, advance } = await setup(t, { 1: known(false) });
  options.fetchImpl = async url => {
    const input = JSON.parse(url.searchParams.get('input_json')); calls.push(input);
    return response(input.hash_only ? { schema_version: 1, schema_hash: 456 } : schema(true, 456));
  };
  const first = await refreshAchievementSets({ ...options, games: [game(1)], maxRequests: 1 });
  assert.equal(first.reason, 'budget'); assert.equal(store.get(1).hasSets, false);
  assert.equal(store.get(1).schemaHash, 123); assert.equal(store.get(1).needsSchema, true);
  advance(DAY);
  await refreshAchievementSets({ ...options, games: [game(1)], maxRequests: 1 });
  assert.equal(calls.length, 2); assert.equal(calls[1].hash_only, undefined);
  assert.equal(store.get(1).hasSets, true); assert.equal(store.get(1).schemaHash, 456);
  assert.equal(store.get(1).needsSchema, undefined);
});

test('unavailable refreshes preserve earlier usable facts and unknown games never become negatives', async t => {
  const { store, options } = await setup(t, { 1: known(true) });
  options.fetchImpl = async () => response({}, 42);
  await refreshAchievementSets({ ...options, games: [game(1), game(2)] });
  assert.equal(store.get(1).outcome, 'unavailable'); assert.equal(store.get(1).hasSets, true);
  assert.equal(store.get(1).successfulAt, known(true).successfulAt);
  assert.equal(store.get(2).outcome, 'unavailable'); assert.equal(store.get(2).hasSets, undefined);
  assert.deepEqual([...achievementStateIndex(store.snapshot())], [[1, true]]);
});

test('an empty catalog is unavailable only after a full known-good service control', async t => {
  const { store, options, calls } = await setup(t, { 620: known(true) });
  options.fetchImpl = async url => {
    const input = JSON.parse(url.searchParams.get('input_json')); calls.push(input);
    return input.appid === 620 ? response(schema(true)) : response({}, 2);
  };
  const result = await refreshAchievementSets({ ...options, games: [game(3)] });
  assert.deepEqual(calls.map(value => value.appid), [3, 620]);
  assert.equal(calls[1].hash_only, undefined);
  assert.equal(result.unavailable, 1); assert.equal(store.get(3).hasSets, undefined);
  assert.match(store.get(3).error, /service health confirmed/);
});

test('unexpected schema failures stop the optional phase and preserve cached flags', async t => {
  const { store, options, calls } = await setup(t, { 1: known(true) });
  options.fetchImpl = async url => { calls.push(url); return response({ schema_version: 1, schema_hash: 999 }); };
  const result = await refreshAchievementSets({ ...options, games: [game(2), game(1)] });
  assert.equal(result.reason, 'service-error'); assert.equal(calls.length, 1);
  assert.equal(store.get(2).outcome, 'error'); assert.equal(store.get(2).hasSets, undefined);
  assert.equal(store.get(1).hasSets, true);
});

test('a preceding hash match cannot substitute for a full schema health control on empty errors', async t => {
  const { store, options, calls } = await setup(t, { 1: known(false), 2: known(true), 620: known(true) });
  options.fetchImpl = async url => {
    const input = JSON.parse(url.searchParams.get('input_json')); calls.push(input);
    if (input.appid === 2) return response({}, 2);
    return response(input.hash_only ? { schema_version: 1, schema_hash: 123 } : schema(true));
  };
  await refreshAchievementSets({ ...options, games: [game(1), game(2)] });
  assert.deepEqual(calls.map(value => value.appid), [1, 2, 620]);
  assert.equal(calls[2].hash_only, undefined);
  assert.equal(store.get(2).outcome, 'unavailable'); assert.equal(store.get(2).hasSets, true);
});

test('per-day attempts and elapsed time persist across repeated builds', async t => {
  const { store, options, calls, advance } = await setup(t);
  await refreshAchievementSets({ ...options, games: [game(1), game(2)], maxRequests: 1 });
  advance(2000);
  const second = await refreshAchievementSets({ ...options, games: [game(2)], maxRequests: 1 });
  assert.equal(second.reason, 'budget'); assert.equal(calls.length, 1);
  advance(DAY);
  await refreshAchievementSets({ ...options, games: [game(2)], maxRequests: 1 });
  assert.equal(calls.length, 2); assert.equal(store.setting('budget').attempts, 1);
});

test('time limit stops new requests without losing completed checks', async t => {
  const { store, options, calls, advance } = await setup(t);
  const fetch = options.fetchImpl;
  options.fetchImpl = async url => { advance(1200); return fetch(url); };
  const result = await refreshAchievementSets({ ...options, games: [game(1), game(2)], maxDurationMs: 1000 });
  assert.equal(result.reason, 'budget'); assert.equal(calls.length, 1);
  assert.equal(store.get(1).hasSets, true); assert.equal(store.get(2), undefined);
});

test('Retry-After and throttle fallback survive restarts; optional service failures leave cached flags usable', async t => {
  const { store, options, calls, advance } = await setup(t, { 1: known(true) });
  options.fetchImpl = async url => { calls.push(url); return new Response('busy', { status: 429, headers: { 'retry-after': '120' } }); };
  const result = await refreshAchievementSets({ ...options, games: [game(1)], maxDurationMs: 1000 });
  assert.equal(result.reason, 'budget'); assert.equal(calls.length, 1);
  assert.equal(store.setting('pacing').minimumSpacingMs, 1500);
  assert.ok(Date.parse(store.setting('pacing').cooldownAt) >= NOW + 120000);
  advance(2000);
  assert.equal((await refreshAchievementSets({ ...options, games: [game(1)] })).reason, 'cooldown');
  assert.equal(calls.length, 1); assert.equal(store.get(1).hasSets, true);
});

test('restoring older states cannot erase a newer failure, later usable flag or daily budget', async t => {
  const { store } = await setup(t, { 1: known(true) });
  store.put(1, { ...known(true), checkedAt: iso(NOW), outcome: 'unavailable' });
  store.setting('budget', { date: '2026-10-23', attempts: 500, elapsedMs: 20000 });
  const stale = { ...emptyAchievementState(), apps: { 1: known(false, NOW - 10 * DAY) } };
  store.merge(stale);
  assert.equal(store.get(1).hasSets, true); assert.equal(store.get(1).outcome, 'unavailable');
  assert.equal(store.setting('budget').attempts, 500);
  const newerGood = { ...emptyAchievementState(), apps: { 1: known(false, NOW - DAY) } };
  store.merge(newerGood);
  assert.equal(store.get(1).outcome, 'unavailable'); assert.equal(store.get(1).hasSets, false);
});

test('newly released unavailable games and interrupted changed schemas bypass ordinary stale rotation', () => {
  const entries = new Map([[1, known()], [2, { checkedAt: iso(NOW - DAY), outcome: 'unavailable', retryAt: iso(NOW + DAY), release: 'upcoming' }],
    [3, { ...known(), needsSchema: true }]]);
  assert.deepEqual(selectAchievementChecks([game(1, 1000), game(2), game(3), game(4, 0)], entries, NOW).map(row => row.id), [4, 2, 3, 1]);
});

test('published checkpoint round-trips, verifies counts/checksums and rejects fabricated negatives', async t => {
  const { store, directory } = await setup(t, { 1: known(false), 2: { checkedAt: iso(NOW), outcome: 'unavailable' } });
  const descriptor = await writeAchievementState(store.snapshot(), directory);
  const bytes = await readFile(join(directory, descriptor.file));
  assert.deepEqual(checkedAchievementState(bytes, descriptor), store.snapshot());
  assert.throws(() => checkedAchievementState(bytes, { ...descriptor, apps: 3 }), /count mismatch/);
  assert.throws(() => checkedAchievementState(Buffer.from('bad'), descriptor), /checksum/);
  assert.throws(() => validateAchievementState({ ...store.snapshot(), apps: { 1: { checkedAt: iso(NOW), outcome: 'success', hasSets: false } } }), /usable achievement/);
  assert.deepEqual(decodeAchievementState(bytes), store.snapshot());
});

test('the bundled offline projection and persistent seed contain exactly the same usable facts', async () => {
  const bytes = await readFile(new URL('../data/achievement-state.json.gz', import.meta.url));
  const state = decodeAchievementState(bytes);
  const projection = JSON.parse(await readFile(new URL('../data/achievement-sets.json', import.meta.url), 'utf8'));
  const index = achievementStateIndex(state);
  assert.equal(projection.source.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(projection.known, [...index.keys()].sort((a, b) => a - b));
  assert.deepEqual(projection.supported, [...index].filter(([, value]) => value).map(([id]) => id).sort((a, b) => a - b));
});

test('importer publishes and resumes the achievement checkpoint without per-game requirements calls', async t => {
  const { directory } = await setup(t);
  const seedFile = join(directory, 'seed.json.gz');
  await writeFile(seedFile, gzipSync(JSON.stringify(emptyAchievementState())));
  const calls = [];
  const output = join(directory, 'site');
  const { catalog, manifest } = await importCatalog({ fixture: true, output, checkpointFile: join(directory, 'main.json'), achievementStateFile: seedFile,
    achievementRefreshOptions: { recordResponse: async () => {}, maxRequests: 1, now: () => NOW, sleep: async () => {}, fetchImpl: async url => {
      assert.equal(url.hostname, 'api.steampowered.com'); calls.push(url); return response(schema(true));
    } } });
  assert.equal(calls.length, 1); assert.equal(manifest.achievementRefresh.newGames, 1);
  const state = checkedAchievementState(await readFile(join(output, 'data', manifest.achievementState.file)), manifest.achievementState);
  const supported = [...achievementStateIndex(state).keys()][0];
  assert.equal(catalog.games.find(game => game.id === supported).featureIds.includes(10002), true);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'provenance-lock.json'), 'utf8')).achievementState, manifest.achievementState);
  // Importer releases its own PID lock after the build.
  await acquireCollectionLock(join(directory, 'steam-achievements/refresh.lock'));
});
