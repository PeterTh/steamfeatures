import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createSteamClient } from '../scripts/steam-client.mjs';
import { SteamSupplementStore, achievementSets, validateRequirements, exportSupplement, verifySupplement } from '../scripts/steam-supplement.mjs';
import { collectSteamSupplement, acquireCollectionLock, recordSupplementRequestFailure, main } from '../scripts/collect-steam-supplement.mjs';
import { writeAtomicJSON, createProgressWriter } from '../scripts/atomic-json.mjs';

const group = (groupid, other = {}) => ({ groupid, archived: false, developeronly: false, ispublic: true, total_achievements: 4, ...other });
const schema = groups => ({ schema_version: 1, schema_hash: 123, achievements: [], groups });
const requirements = id => ({ [id]: { success: true, data: { name: 'Do not retain', pc_requirements: { minimum: '<b>💻 Windows\nRAM</b>', recommended: '' }, mac_requirements: [], linux_requirements: {} } } });
const game = (id, reviews = 100, achievements = true) => ({ id, reviews, featureIds: achievements ? [22] : [] });
const json = (body, code = null) => new Response(JSON.stringify(body), { headers: code === null ? {} : { 'x-eresult': String(code) } });
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'steam-supplement-'));
  const filename = join(directory, 'state.sqlite');
  const store = new SteamSupplementStore(filename);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, filename, store };
}
function clientFor(store, fetchImpl, options = {}) {
  return createSteamClient({ spacingMs: 0, maxRetries: 0, fetchImpl, recordResponse: value => store.recordResponse(value), ...options });
}
function saveAchievement(store, id, response, code, outcome, checkedAt = '2026-10-21T10:00:00.000Z') {
  store.recordResponse({ method: 'IPlayerService/GetGameAchievements', input: { appid: id }, body: { response }, status: 200, resultCode: String(code) }, checkedAt);
  store.finish(id, 'achievements', { outcome, checkedAt, ...(outcome === 'success' ? { hasSets: achievementSets(response) } : { error: `Steam result ${code}` }) });
}

test('an achievement-only checkpoint never requests requirements and exports verified completed coverage', async t => {
  const { store, directory } = await setup(t);
  store.seed([game(10), game(20)], { sources: ['achievements'] });
  const requested = [];
  const client = clientFor(store, async url => {
    assert.equal(url.hostname, 'api.steampowered.com');
    requested.push(JSON.parse(url.searchParams.get('input_json')).appid);
    return json({ response: schema([group(0)]) }, 1);
  });
  const result = await collectSteamSupplement({ store, client });
  assert.deepEqual(requested, [10, 20]);
  assert.equal(result.complete, true);
  assert.equal(result.requirements.planned, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM responses WHERE source='requirements'").get().n, 0);
  const descriptor = await exportSupplement(store, directory);
  await verifySupplement(join(directory, descriptor.file), descriptor);
  assert.equal(store.readCounts().requirements.planned, 0);
});

test('achievement sets require a populated, additional, active public group; malformed schemas remain unknown', () => {
  assert.equal(achievementSets(schema([group(0)])), false);
  assert.equal(achievementSets(schema([group(0), group(1)])), true);
  for (const flags of [{ ispublic: false }, { developeronly: true }, { archived: true }, { total_achievements: 0 }]) {
    assert.equal(achievementSets(schema([group(0), group(1, flags)])), false);
  }
  for (const value of [{}, schema([]), schema([group(0), group(0)]), schema([group(1, { archived: undefined })])]) {
    assert.throws(() => achievementSets(value), /schema|group/);
  }
});

test('Steam may omit achievements only when all validated groups explicitly report zero', async t => {
  // Captured shape of Grapple's successful GetGameAchievements response.
  const empty = { schema_version: 3, schema_hash: 1466709475, groups: [group(0, { total_achievements: 0 })] };
  assert.equal(achievementSets(empty), false);
  for (const groups of [[group(0)], [group(0, { total_achievements: 0 }), group(1)]]) {
    assert.throws(() => achievementSets({ ...empty, groups }), /Incomplete/);
  }
  assert.throws(() => achievementSets({ ...empty, achievements: null }), /Incomplete/);
  assert.throws(() => achievementSets({ ...empty, groups: [group(0, { total_achievements: undefined })] }), /Malformed/);
  const { store, directory } = await setup(t);
  store.seed([game(1428870)], {});
  await collectSteamSupplement({ store, client: clientFor(store, async url => url.hostname === 'store.steampowered.com'
    ? json(requirements(1428870)) : json({ response: empty }, 1)) });
  assert.equal(store.progress().complete, true);
  const collected = [...store.records()][1].achievements;
  assert.equal(collected.outcome, 'success');
  assert.equal(collected.hasPublicSets, false);
  assert.equal(Object.hasOwn(collected.data, 'achievements'), false, 'raw schema stays unchanged');
  const descriptor = await exportSupplement(store, directory);
  await verifySupplement(join(directory, descriptor.file), descriptor);
});

for (const spacingMs of [1000, 1500, 2000]) test(`both Steam hosts share a ${spacingMs} ms post-response pause and requirements archive only publisher text`, async () => {
  let time = 0;
  const starts = [], urls = [], archived = [];
  const client = createSteamClient({ spacingMs, now: () => time, sleep: async ms => { time += ms; },
    recordResponse: value => archived.push(value), fetchImpl: async url => {
      starts.push(time); urls.push(new URL(url)); time += 250;
      return url.hostname === 'store.steampowered.com' ? json(requirements(620)) : json({ response: schema([group(0)]) }, 1);
    } });
  const [, result] = await Promise.all([client.getGameAchievements(620), client.getRequirements(620), client.getGameAchievements(620)]);
  assert.deepEqual(starts, [0, spacingMs + 250, 2 * (spacingMs + 250)]);
  assert.equal(urls[1].searchParams.get('appids'), '620');
  assert.equal(urls[1].searchParams.get('filters'), 'basic');
  assert.equal(urls[1].searchParams.get('l'), 'english');
  assert.equal(urls[1].searchParams.get('cc'), 'US');
  assert.deepEqual(result[620].data, { pc_requirements: requirements(620)[620].data.pc_requirements, mac_requirements: [], linux_requirements: {} });
  assert.deepEqual(archived[1].body, result);
  assert.equal(validateRequirements(result, 620), true);
  assert.equal(validateRequirements({ 620: { success: false } }, 620), false);
  assert.equal(validateRequirements({ 620: { success: true, data: {} } }, 620), false);
  assert.throws(() => validateRequirements({ 620: { success: true, data: null } }, 620), /Malformed/);
});

test('both hosts share rate-limit backoff and failures to archive stop the pass', async t => {
  const { store, directory } = await setup(t);
  await writeFile(join(directory, 'monitor-config.json'), JSON.stringify({ enabled: false, mode: 'session-sleep', spacingMs: 1000 }));
  store.seed([game(1)], {});
  let time = 0, calls = 0;
  const starts = [];
  const client = clientFor(store, async url => {
    starts.push(time);
    if (++calls === 1) return new Response('', { status: 429, headers: { 'retry-after': '12' } });
    return url.hostname === 'store.steampowered.com' ? json(requirements(1)) : json({ response: schema([group(0)]) }, 1);
  }, { spacingMs: 1000, throttleSpacingMs: 1500, now: () => time, sleep: async ms => { time += ms; }, maxRetries: 1,
    onRequestFailure: event => recordSupplementRequestFailure(store, directory, event) });
  await collectSteamSupplement({ store, client });
  assert.deepEqual(starts, [0, 12000, 13500]);
  assert.deepEqual(client.stats, { requests: 3, retries: 1 });
  assert.equal(client.spacingMs, 1500);
  assert.equal(store.setting('minimumSpacingMs'), 1500, 'Fallback must survive restarting with a faster requested rate');
  assert.equal(store.setting('retryAt'), '1970-01-01T00:00:12.000Z');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'monitor-config.json'), 'utf8')),
    { enabled: false, mode: 'session-sleep', spacingMs: 1500, pacingFallbackAt: '1970-01-01T00:00:00.000Z', pacingFallbackReason: 'HTTP 429 during faster pacing trial' });
  const failure = JSON.parse((await readFile(join(directory, 'request-failures.jsonl'), 'utf8')).trim());
  assert.equal(failure.status, 429);
  assert.equal(failure.retryAfterMs, 12000);
  assert.equal(failure.retryDelayMs, 12000);
  assert.equal(failure.willRetry, true);
  assert.equal(failure.spacingMs, 1500);
  assert.equal(store.progress().complete, true);
});

test('a partial pass prioritizes reviews, resumes per source, and freezes scope on reseeding', async t => {
  const { store, filename } = await setup(t);
  store.seed([game(1, 5), game(2, 100), game(3, 50, false)], { snapshot: 'first' });
  const calls = [];
  const fetchImpl = async url => {
    const source = url.hostname === 'store.steampowered.com' ? 'requirements' : 'achievements';
    const id = source === 'requirements' ? Number(url.searchParams.get('appids')) : JSON.parse(url.searchParams.get('input_json')).appid;
    calls.push([id, source]);
    return source === 'requirements' ? json(requirements(id)) : json({ response: schema([group(0), group(1)]) }, 1);
  };
  await collectSteamSupplement({ store, client: clientFor(store, fetchImpl), limit: 1 });
  assert.deepEqual(calls, [[2, 'achievements']]);
  // A new process sees durable observations and the original scope.
  const resumed = new SteamSupplementStore(filename);
  try {
    resumed.seed([game(99)], { snapshot: 'second' });
    await collectSteamSupplement({ store: resumed, client: clientFor(resumed, fetchImpl) });
    assert.deepEqual(calls, [[2, 'achievements'], [2, 'requirements'], [3, 'requirements'], [1, 'achievements'], [1, 'requirements']]);
    assert.equal(resumed.progress().complete, true);
    assert.equal(resumed.progress().publicAchievementSets, 2);
    assert.equal(resumed.setting('seed').snapshot, 'first');
    await collectSteamSupplement({ store: resumed, client: clientFor(resumed, () => assert.fail('completed sources must not repeat')) });
  } finally { resumed.close(); }
});

test('restart honors a saved slower pace even when the environment requests the faster trial', async t => {
  const { directory } = await setup(t);
  const checkpoint = new SteamSupplementStore(join(directory, 'supplement.sqlite'));
  checkpoint.seed([game(1)], { snapshot: 'fixed' });
  checkpoint.setting('minimumSpacingMs', 1500);
  checkpoint.close();
  const prior = process.env.STEAM_REQUEST_SPACING_MS;
  process.env.STEAM_REQUEST_SPACING_MS = '1000';
  try { await main(['--directory', directory, '--export-only']); }
  finally {
    if (prior === undefined) delete process.env.STEAM_REQUEST_SPACING_MS;
    else process.env.STEAM_REQUEST_SPACING_MS = prior;
  }
  const progress = JSON.parse(await readFile(join(directory, 'progress.json'), 'utf8'));
  assert.equal(progress.spacingMs, 1500);
  assert.equal(progress.phase, 'partial');
  assert.equal(progress.complete, false);
});

test('failure to log an API error stops recovery instead of deferring the logging failure', async t => {
  const { store } = await setup(t);
  store.seed([game(1)], {});
  const client = clientFor(store, async () => json({ response: {} }, 2),
    { onRequestFailure: async () => { throw new Error('disk full'); } });
  await assert.rejects(collectSteamSupplement({ store, client, deferGenericAchievementFailures: true }), /Could not record.*disk full/);
  assert.equal(client.stats.requests, 1);
  assert.equal(store.progress().achievements.failed, 1);
  assert.equal(store.progress().achievements.checked, 0);
  assert.equal(store.progress().requirements.checked, 0);
  assert.equal(store.progress().complete, false);
});

test('unavailable and empty requirements stay distinct; transport failure remains resumable', async t => {
  const { store } = await setup(t);
  store.seed([game(1), game(2)], {});
  let calls = 0;
  const failed = clientFor(store, async url => {
    calls++;
    if (calls === 1) return json({ response: {} }, 42);
    if (calls === 2) return json({ 1: { success: true, data: { pc_requirements: [], mac_requirements: [], linux_requirements: [] } } });
    throw new TypeError('offline');
  });
  await assert.rejects(collectSteamSupplement({ store, client: failed }), /offline/);
  const rows = [...store.records()];
  assert.equal(rows[1].achievements.outcome, 'unavailable');
  assert.equal(rows[1].achievements.hasPublicSets, undefined);
  assert.equal(rows[1].requirements.outcome, 'success');
  assert.deepEqual(rows[1].requirements.data.pc_requirements, []);
  assert.equal(rows[2].achievements.outcome, 'error');
  const resumed = clientFor(store, async url => url.hostname === 'store.steampowered.com' ? json({ 2: { success: false } }) : json({ response: schema([group(0)]) }, 1));
  await collectSteamSupplement({ store, client: resumed });
  assert.equal(resumed.stats.requests, 2);
  assert.equal(store.progress().complete, true);
  assert.equal([...store.records()][2].achievements.hasPublicSets, false);
  assert.equal([...store.records()][2].requirements.outcome, 'unavailable');
});

test('deferring one failed source preserves its unknown outcome, collects the rest, and cannot complete early', async t => {
  const { store } = await setup(t);
  store.seed([game(1), game(2)], { snapshot: 'frozen' });
  await assert.rejects(collectSteamSupplement({ store, client: clientFor(store, async () => json({ response: {} }, 2)) }), /result 2/);
  const failedBefore = store.db.prepare("SELECT * FROM observations WHERE id=1 AND source='achievements'").get();
  const calls = [];
  const fetchImpl = async url => {
    const source = url.hostname === 'store.steampowered.com' ? 'requirements' : 'achievements';
    const id = source === 'requirements' ? Number(url.searchParams.get('appids')) : JSON.parse(url.searchParams.get('input_json')).appid;
    calls.push([id, source]);
    return source === 'requirements' ? json(requirements(id)) : json({ response: schema([group(0)]) }, 1);
  };
  const result = await collectSteamSupplement({ store, client: clientFor(store, fetchImpl), deferredSources: ['1:achievements'] });
  assert.deepEqual(calls, [[1, 'requirements'], [2, 'achievements'], [2, 'requirements']]);
  assert.deepEqual(store.db.prepare("SELECT * FROM observations WHERE id=1 AND source='achievements'").get(), failedBefore);
  assert.equal([...store.records()][1].achievements.hasPublicSets, undefined);
  assert.equal(result.achievements.failed, 1);
  assert.equal(result.achievements.checked, 1);
  assert.equal(result.requirements.checked, 2);
  assert.equal(result.complete, false);
  assert.equal(store.setting('seed').snapshot, 'frozen');
  calls.length = 0;
  await collectSteamSupplement({ store, client: clientFor(store, fetchImpl) });
  assert.deepEqual(calls, [[1, 'achievements']]);
  assert.equal(store.progress().complete, true);
});

test('empty catalogs resolve old deferrals after a healthy control without changing raw data or observation times', async t => {
  const { store, directory } = await setup(t);
  store.seed([game(1), game(620)], { snapshot: 'frozen' });
  saveAchievement(store, 620, schema([group(0), group(1)]), 1, 'success');
  saveAchievement(store, 1, {}, 2, 'error');
  const previous = store.db.prepare("SELECT * FROM observations WHERE id=1 AND source='achievements'").get();
  const control = store.db.prepare("SELECT * FROM observations WHERE id=620 AND source='achievements'").get();
  const raw = store.db.prepare('SELECT * FROM responses ORDER BY sequence').all();
  const client = clientFor(store, async url => {
    assert.equal(JSON.parse(url.searchParams.get('input_json')).appid, 620);
    return json({ response: schema([group(0), group(1)]) }, 1);
  });
  const result = await collectSteamSupplement({ store, client, limit: 1, emptyAchievementCatalogsUnavailable: true,
    deferGenericAchievementFailures: true, deferredSources: ['1:achievements'] });
  assert.equal(client.stats.requests, 1, 'Only the queued control is requested within this budget');
  const resolved = store.db.prepare("SELECT * FROM observations WHERE id=1 AND source='achievements'").get();
  assert.equal(resolved.outcome, 'unavailable');
  for (const key of ['id', 'source', 'checked_at', 'latest_response', 'successful_response', 'has_sets']) assert.equal(resolved[key], previous[key]);
  assert.match(resolved.error, /No public achievement catalog/);
  assert.deepEqual(store.db.prepare("SELECT * FROM observations WHERE id=620 AND source='achievements'").get(), control);
  assert.deepEqual(store.db.prepare('SELECT * FROM responses WHERE sequence<=? ORDER BY sequence').all(raw.at(-1).sequence), raw);
  assert.equal(result.achievements.failed, 0);
  assert.equal(result.achievements.checked, 2);
  assert.equal(result.emptyAchievementCatalogsResolved, 1);
  assert.equal(result.deferredGenericFailures, 0);
  assert.deepEqual(result.deferredSources, []);
  assert.equal(result.publicAchievementSets, 1);
  assert.equal(store.setting('seed').snapshot, 'frozen');
  const descriptor = await exportSupplement(store, directory);
  await verifySupplement(join(directory, descriptor.file), descriptor);
});

test('new empty catalogs are checked unavailable while ordinary successful schemas establish service health', async t => {
  const { store } = await setup(t);
  store.seed([game(1, 300), game(2, 200), game(3, 100)], {});
  const client = clientFor(store, async url => {
    if (url.hostname === 'store.steampowered.com') return json(requirements(Number(url.searchParams.get('appids'))));
    const id = JSON.parse(url.searchParams.get('input_json')).appid;
    return id === 1 ? json({ response: schema([group(0), group(1)]) }, 1) : json({ response: {} }, 2);
  });
  const result = await collectSteamSupplement({ store, client, emptyAchievementCatalogsUnavailable: true });
  assert.equal(client.stats.requests, 6);
  assert.equal(result.complete, true);
  assert.equal(result.achievements.unavailable, 2);
  assert.equal(result.achievements.failed, 0);
  assert.equal(result.emptyAchievementCatalogsResolved, 2);
  assert.equal(result.publicAchievementSets, 1);
});

test('JSONL round-trips publisher Unicode line and paragraph separators without splitting records', async t => {
  const { store, directory } = await setup(t);
  store.seed([game(1, 100, false)], {});
  const publisherText = '💻 Windows\u2028CPU\u2029RAM\nliteral \\u2028 ' + '💻'.repeat(12000);
  const body = requirements(1);
  body[1].data.pc_requirements.minimum = publisherText;
  await collectSteamSupplement({ store, client: clientFor(store, async () => json(body)) });
  const descriptor = await exportSupplement(store, directory);
  await verifySupplement(join(directory, descriptor.file), descriptor);
  const encoded = gunzipSync(await readFile(join(directory, descriptor.file))).toString('utf8');
  assert.equal(encoded.includes('\u2028'), false);
  assert.equal(encoded.includes('\u2029'), false);
  const lines = encoded.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).requirements.data.pc_requirements.minimum, publisherText);
});

test('a failed service control leaves archived empty catalogs pending and preserves Retry-After', async t => {
  const { store } = await setup(t);
  store.seed([game(1), game(620)], {});
  saveAchievement(store, 620, schema([group(0)]), 1, 'success');
  saveAchievement(store, 1, {}, 2, 'error');
  const before = store.db.prepare('SELECT * FROM observations ORDER BY id,source').all();
  const client = clientFor(store, async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }));
  await assert.rejects(collectSteamSupplement({ store, client, emptyAchievementCatalogsUnavailable: true,
    now: () => '2026-10-22T01:00:00.000Z' }), /429/);
  assert.deepEqual(store.db.prepare('SELECT * FROM observations ORDER BY id,source').all(), before);
  assert.equal(store.setting('retryAt'), '2026-10-22T01:01:00.000Z');
  assert.equal(store.progress().achievements.failed, 1);
});

test('empty catalog interpretation preserves previous usable schemas and leaves other generic errors unknown', async t => {
  const { store } = await setup(t);
  store.seed([game(1), game(2), game(620)], {});
  saveAchievement(store, 620, schema([group(0)]), 1, 'success');
  saveAchievement(store, 1, schema([group(0), group(1)]), 1, 'success');
  saveAchievement(store, 1, {}, 2, 'error', '2026-10-21T11:00:00.000Z');
  saveAchievement(store, 2, { diagnostic: 'Temporary failure' }, 2, 'error');
  const before = store.db.prepare("SELECT * FROM observations WHERE outcome='error' ORDER BY id").all();
  const client = clientFor(store, async url => json(requirements(Number(url.searchParams.get('appids')))));
  const result = await collectSteamSupplement({ store, client, emptyAchievementCatalogsUnavailable: true,
    deferGenericAchievementFailures: true, limit: 1 });
  assert.deepEqual(store.db.prepare("SELECT * FROM observations WHERE outcome='error' ORDER BY id").all(), before);
  assert.equal(result.achievements.failed, 2);
  assert.equal(result.emptyAchievementCatalogsResolved, 0);
  assert.equal(result.publicAchievementSets, 1);
});

test('an empty catalog remains unknown when service health cannot be established', async t => {
  const { store } = await setup(t);
  store.seed([game(1)], {});
  await assert.rejects(collectSteamSupplement({ store, client: clientFor(store, async () => json({ response: {} }, 2)),
    emptyAchievementCatalogsUnavailable: true }), /result 2/);
  assert.equal(store.progress().achievements.failed, 1);
  assert.equal(store.progress().achievements.unavailable, 0);
  assert.equal(store.progress().achievements.checked, 0);
});

test('explicit recovery mode retains generic per-app failures as unknown and respects the request limit', async t => {
  const { store } = await setup(t);
  store.seed([game(1), game(2), game(3)], {});
  const client = clientFor(store, async url => {
    if (url.hostname === 'store.steampowered.com') return json(requirements(Number(url.searchParams.get('appids'))));
    const id = JSON.parse(url.searchParams.get('input_json')).appid;
    return id === 2 ? json({ response: schema([group(0)]) }, 1) : json({ response: {} }, 2);
  });
  await collectSteamSupplement({ store, client, deferGenericAchievementFailures: true, limit: 2 });
  assert.equal(client.stats.requests, 2);
  assert.equal(store.progress().requirements.checked, 1);
  const result = await collectSteamSupplement({ store, client, deferredSources: ['1:achievements'], deferGenericAchievementFailures: true });
  assert.equal(result.complete, false);
  assert.equal(result.achievements.failed, 2);
  assert.equal(result.achievements.checked, 1);
  assert.equal(result.requirements.checked, 3);
  assert.deepEqual(result.deferredSources, ['1:achievements']);
  assert.equal(result.deferredGenericFailures, 2);
  for (const row of [...store.records()].slice(1).filter(row => row.id !== 2)) {
    assert.equal(row.achievements.outcome, 'error');
    assert.equal(row.achievements.hasPublicSets, undefined);
  }
});

test('recovery mode stops after three consecutive generic achievement failures despite working requirements', async t => {
  const { store } = await setup(t);
  store.seed([game(1), game(2), game(3), game(4)], {});
  const client = clientFor(store, async url => url.hostname === 'store.steampowered.com'
    ? json(requirements(Number(url.searchParams.get('appids')))) : json({ response: {} }, 2));
  await assert.rejects(collectSteamSupplement({ store, client, deferGenericAchievementFailures: true }), /result 2/);
  assert.equal(client.stats.requests, 5);
  assert.equal(store.progress().achievements.failed, 3);
  assert.equal(store.progress().achievements.checked, 0);
  assert.equal(store.progress().requirements.checked, 2);
  assert.equal(store.progress().complete, false);
});

test('a known-good achievement control distinguishes app failures without changing completed observations', async t => {
  const { store } = await setup(t);
  store.seed([game(1), game(2), game(3), game(4)], {});
  const client = clientFor(store, async url => {
    if (url.hostname === 'store.steampowered.com') return json(requirements(Number(url.searchParams.get('appids'))));
    const id = JSON.parse(url.searchParams.get('input_json')).appid;
    return id === 1 ? json({ response: schema([group(0)]) }, 1) : json({ response: {} }, 2);
  });
  await collectSteamSupplement({ store, client, limit: 2 });
  const before = store.db.prepare("SELECT * FROM observations WHERE id=1 AND source='achievements'").get();
  const result = await collectSteamSupplement({ store, client, deferGenericAchievementFailures: true });
  assert.equal(client.stats.requests, 9);
  assert.equal(result.achievements.failed, 3);
  assert.equal(result.achievements.checked, 1);
  assert.equal(result.requirements.checked, 4);
  assert.equal(result.deferredGenericFailures, 3);
  assert.equal(result.complete, false);
  assert.deepEqual(store.db.prepare("SELECT * FROM observations WHERE id=1 AND source='achievements'").get(), before);
});

test('a rate-limited control stops recovery and persists its cooldown', async t => {
  const { store } = await setup(t);
  store.seed([game(1), game(2), game(3), game(4)], {});
  let blockControl = false;
  const client = clientFor(store, async url => {
    if (url.hostname === 'store.steampowered.com') return json(requirements(Number(url.searchParams.get('appids'))));
    const id = JSON.parse(url.searchParams.get('input_json')).appid;
    return id !== 1 ? json({ response: {} }, 2) : blockControl
      ? new Response('', { status: 429, headers: { 'retry-after': '60' } }) : json({ response: schema([group(0)]) }, 1);
  });
  await collectSteamSupplement({ store, client, limit: 2 });
  blockControl = true;
  const at = '2026-10-21T15:00:00.000Z';
  await assert.rejects(collectSteamSupplement({ store, client, deferGenericAchievementFailures: true, now: () => at }), /429/);
  assert.equal(store.setting('retryAt'), '2026-10-21T15:01:00.000Z');
  assert.equal(store.progress().achievements.failed, 3);
  assert.equal(store.progress().complete, false);
});

test('generic API failure, schema drift and disk errors stop rather than marking unavailable', async t => {
  const { store } = await setup(t);
  store.seed([game(1)], {});
  for (const response of [() => json({ response: {} }, 2), () => json({ response: { unexpected: true } }, 1)]) {
    await assert.rejects(collectSteamSupplement({ store, client: clientFor(store, response) }));
    assert.equal(store.progress().achievements.failed, 1);
    assert.equal(store.progress().achievements.checked, 0);
  }
  let calls = 0;
  const client = createSteamClient({ maxRetries: 2, fetchImpl: async () => { calls++; return json({ response: schema([group(0)]) }, 1); },
    recordResponse: () => { throw new Error('disk full'); } });
  await assert.rejects(collectSteamSupplement({ store, client }), /archive.*disk full/);
  assert.equal(calls, 1);
});

test('later failed observations preserve the last usable response and its own timestamp', async t => {
  const { store } = await setup(t);
  store.seed([game(1)], {});
  await collectSteamSupplement({ store, client: clientFor(store, async url => url.hostname === 'store.steampowered.com' ? json(requirements(1)) : json({ response: schema([group(0), group(1)]) }, 1)) });
  const before = [...store.records()][1];
  store.recordResponse({ method: 'IPlayerService/GetGameAchievements', input: { appid: 1 }, body: { response: {} }, status: 200, resultCode: '42' }, '2026-10-18T12:00:00.000Z');
  store.finish(1, 'achievements', { outcome: 'unavailable', checkedAt: '2026-10-18T12:00:00.000Z' });
  const after = [...store.records()][1];
  assert.deepEqual(after.achievements.data, before.achievements.data);
  assert.equal(after.achievements.successfulAt, before.achievements.successfulAt);
  assert.equal(after.achievements.checkedAt, '2026-10-18T12:00:00.000Z');
  assert.equal(after.achievements.hasPublicSets, true);
});

test('exports verify checksums/counts and round-trip Unicode and requirements HTML', async t => {
  const { store, directory } = await setup(t);
  store.seed([game(1)], {});
  await collectSteamSupplement({ store, client: clientFor(store, async url => url.hostname === 'store.steampowered.com' ? json(requirements(1)) : json({ response: schema([group(0), group(1)]) }, 1)) });
  const descriptor = await exportSupplement(store, directory);
  const filename = join(directory, descriptor.file);
  assert.deepEqual(await verifySupplement(filename, descriptor), { apps: 1, sha256: descriptor.sha256 });
  const records = gunzipSync(await readFile(filename)).toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records[1].requirements.data.pc_requirements.minimum, '<b>💻 Windows\nRAM</b>');
  assert.equal(records[1].requirements.data.name, undefined);
  await assert.rejects(verifySupplement(filename, { ...descriptor, sha256: '0'.repeat(64) }), /checksum/);
  await assert.rejects(verifySupplement(filename, { ...descriptor, apps: 2 }), /header/);
});

test('collection lock rejects a second live writer', async t => {
  const { directory } = await setup(t);
  const filename = join(directory, 'collection.lock');
  await acquireCollectionLock(filename);
  await assert.rejects(acquireCollectionLock(filename), /already running/);
});

test('transient Windows rename locks retain the prior progress file until replacement succeeds', async t => {
  const { directory } = await setup(t);
  const filename = join(directory, 'progress.json');
  await writeFile(filename, JSON.stringify({ phase: 'prior' }));
  const waits = [];
  let calls = 0;
  await writeAtomicJSON(filename, { phase: 'next' }, { sleep: async ms => { waits.push(ms); },
    renameFile: async (source, destination) => {
      assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { phase: 'prior' });
      assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), { phase: 'next' });
      if (++calls <= 3) throw Object.assign(new Error('file is busy'), { code: ['EPERM', 'EACCES', 'EBUSY'][calls - 1] });
      await rename(source, destination);
    } });
  assert.deepEqual(waits, [50, 100, 200]);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { phase: 'next' });
});

test('persistent progress-file locks and non-transient I/O errors fail without deleting prior progress', async t => {
  const { directory } = await setup(t);
  const filename = join(directory, 'progress.json');
  await writeFile(filename, JSON.stringify({ phase: 'prior' }));
  for (const [code, expectedCalls] of [['EPERM', 8], ['EIO', 1]]) {
    let calls = 0;
    await assert.rejects(writeAtomicJSON(filename, { phase: 'next' }, { sleep: async () => {}, renameFile: async () => {
      calls++; throw Object.assign(new Error('cannot replace'), { code });
    } }), error => error.code === code);
    assert.equal(calls, expectedCalls);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { phase: 'prior' });
  }
});

test('a transient progress-file lock does not repeat Steam requests or invalidate committed observations', async t => {
  const { directory, store } = await setup(t);
  store.seed([game(1)], {});
  const client = clientFor(store, async url => url.hostname === 'store.steampowered.com'
    ? json(requirements(1)) : json({ response: schema([group(0), group(1)]) }, 1));
  let calls = 0;
  await collectSteamSupplement({ store, client, progress: value => writeAtomicJSON(join(directory, 'progress.json'), value,
    { sleep: async () => {}, renameFile: async (source, destination) => {
      if (++calls === 1) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      await rename(source, destination);
    } }) });
  assert.equal(client.stats.requests, 2);
  assert.equal(store.progress().complete, true);
  assert.equal(store.progress().achievements.failed, 0);
  assert.equal(JSON.parse(await readFile(join(directory, 'progress.json'), 'utf8')).complete, true);
});

test('routine progress tolerates exhausted file-lock retries and publishes the latest snapshot later', async () => {
  let time = 0, locked = true;
  const writes = [], warnings = [];
  const progress = createProgressWriter('progress.json', { now: () => time, warn: warning => warnings.push(warning),
    writeJSON: async (filename, status) => {
      if (locked) throw Object.assign(new Error('locked after retries'), { code: 'EPERM' });
      writes.push(status);
    } });
  assert.equal(await progress({ phase: 'collecting', count: 1 }), false);
  time = 2000;
  locked = false;
  assert.equal(await progress({ phase: 'collecting', count: 2 }), false);
  assert.equal(writes.length, 0);
  time = 30000;
  assert.equal(await progress({ phase: 'collecting', count: 15 }), true);
  assert.equal(warnings.length, 1);
  assert.deepEqual(writes, [{ phase: 'collecting', count: 15 }]);
  assert.equal(await progress({ phase: 'complete', count: 16 }), true, 'terminal progress is not throttled');
});

test('terminal progress locks and non-lock I/O failures still stop the run', async () => {
  for (const [phase, code] of [['complete', 'EPERM'], ['stopped', 'EACCES'], ['starting', 'EPERM'], ['collecting', 'ENOSPC']]) {
    const progress = createProgressWriter('progress.json', { writeJSON: async () => { throw Object.assign(new Error('failed'), { code }); } });
    await assert.rejects(progress({ phase }), error => error.code === code);
  }
});

test('busy routine progress does not stop either source or repeat completed lookups', async t => {
  const { store } = await setup(t);
  store.seed([game(1)], {});
  let warnings = 0;
  const progress = createProgressWriter('progress.json', { warn: () => warnings++,
    writeJSON: async () => { throw Object.assign(new Error('locked after retries'), { code: 'EPERM' }); } });
  const client = clientFor(store, async url => url.hostname === 'store.steampowered.com'
    ? json(requirements(1)) : json({ response: schema([group(0), group(1)]) }, 1));
  await collectSteamSupplement({ store, client, progress });
  assert.equal(store.progress().complete, true);
  assert.equal(client.stats.requests, 2);
  assert.equal(warnings, 1);
  await collectSteamSupplement({ store, client: clientFor(store, () => assert.fail('completed sources must not repeat')) });
});

test('Retry-After is durable in SQLite even when stopped progress cannot be written', async t => {
  const { store, filename } = await setup(t);
  store.seed([game(1)], {});
  const client = clientFor(store, async () => new Response('', { status: 429, headers: { 'retry-after': '600' } }));
  const now = () => '2026-10-17T02:00:00.000Z';
  await assert.rejects(collectSteamSupplement({ store, client, now,
    progress: async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); } }), error => error.code === 'EPERM');
  const reopened = new SteamSupplementStore(filename);
  try {
    assert.equal(reopened.setting('retryAt'), '2026-10-17T02:10:00.000Z');
    assert.equal(reopened.progress().achievements.checked, 0);
    assert.equal(reopened.progress().achievements.failed, 1);
  } finally { reopened.close(); }
});
