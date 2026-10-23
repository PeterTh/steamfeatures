import { appendFile, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createSteamClient } from './steam-client.mjs';
import { SteamSupplementStore, achievementSets, validateRequirements, exportSupplement } from './steam-supplement.mjs';
import { loadCatalog } from '../src/filter-worker.js';
import { writeAtomicJSON as atomicJSON, createProgressWriter } from './atomic-json.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJSON = async filename => JSON.parse(await readFile(filename, 'utf8'));
async function optionalJSON(filename) {
  try { return await readJSON(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function recordSupplementRequestFailure(store, directory, event) {
  if (event.retryable && event.retryAfterMs > 0) {
    const retryAt = Math.max(Date.parse(store.setting('retryAt')) || 0, Date.parse(event.at) + event.retryAfterMs);
    store.setting('retryAt', new Date(retryAt).toISOString());
  }
  if (event.status === 429) {
    const spacingMs = Math.max(store.setting('minimumSpacingMs') ?? 0, event.spacingMs);
    store.setting('minimumSpacingMs', spacingMs);
    const filename = resolve(directory, 'monitor-config.json');
    const config = await optionalJSON(filename);
    if (config && Number(config.spacingMs) < spacingMs) await atomicJSON(filename, { ...config, spacingMs,
      pacingFallbackAt: event.at, pacingFallbackReason: 'HTTP 429 during faster pacing trial' });
  }
  await appendFile(resolve(directory, 'request-failures.jsonl'), JSON.stringify(event) + '\n');
}
export async function acquireCollectionLock(filename) {
  const prior = await optionalJSON(filename);
  if (prior) {
    if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0) throw new Error('Invalid collection lock');
    try { process.kill(prior.pid, 0); throw new Error(`Supplement collection already running (PID ${prior.pid})`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await rm(filename);
  }
  const handle = await open(filename, 'wx');
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
  finally { await handle.close(); }
}

const NO_PUBLIC_CATALOG = 'No public achievement catalog (empty EResult 2 response; service health confirmed)';
function emptyAchievementCatalogAttempt(store, id) {
  const row = store.db.prepare(`SELECT o.id,o.checked_at,r.body FROM observations o
    JOIN responses r ON r.sequence=o.latest_response WHERE o.id=? AND o.source='achievements'
    AND o.outcome='error' AND o.successful_response IS NULL AND o.has_sets IS NULL
    AND r.status=200 AND r.result_code='2'`).get(id);
  if (!row) return null;
  const body = JSON.parse(gunzipSync(row.body));
  return body && Object.keys(body).length === 1 && body.response && !Array.isArray(body.response)
    && typeof body.response === 'object' && Object.keys(body.response).length === 0 ? row : null;
}

/** One queue across both hosts; resume only unfinished sources for each game.
 * A definite no-match is unavailable. Failures stay unknown: the default policy
 * stops, while explicit recovery may defer generic app failures after checking
 * service health. Neither path turns a failure into a negative observation. */
export async function collectSteamSupplement({ store, client, limit = 1000000, progress = async () => {},
  shouldStop = () => false, now = () => new Date().toISOString(), deferredSources = [], deferGenericAchievementFailures = false,
  emptyAchievementCatalogsUnavailable = false }) {
  let completed = 0, attempted = 0, consecutiveGenericFailures = 0, deferredThisRun = 0, lastHealthyAchievementAt = 0;
  let emptyAchievementCatalogsResolved = 0;
  const deferred = new Set(deferredSources);
  const genericDeferred = new Set(deferGenericAchievementFailures ? store.db.prepare(`SELECT o.id FROM observations o
    JOIN responses r ON r.sequence=o.latest_response
    WHERE o.source='achievements' AND o.outcome='error' AND r.result_code='2'`).all().map(row => `${row.id}:achievements`) : []);
  const snapshot = value => ({ ...value, ...(deferred.size || emptyAchievementCatalogsUnavailable ? { deferredSources: [...deferred] } : {}),
    ...(emptyAchievementCatalogsUnavailable ? { emptyAchievementCatalogsUnavailable, emptyAchievementCatalogsResolved } : {}),
    ...(deferGenericAchievementFailures ? { deferredThisRun, deferredGenericFailures: genericDeferred.size } : {}) });
  async function healthyForEmptyCatalog() {
    if (lastHealthyAchievementAt && Date.parse(now()) - lastHealthyAchievementAt < 60000) return true;
    const control = store.db.prepare(`SELECT o.id FROM observations o JOIN apps a ON a.id=o.id
      WHERE o.source='achievements' AND o.outcome='success'
      ORDER BY CASE WHEN o.id=620 THEN 0 ELSE 1 END,o.checked_at DESC LIMIT 1`).get();
    if (!control || attempted >= limit || shouldStop()) return false;
    attempted++;
    try { achievementSets(await client.getGameAchievements(control.id)); }
    catch (error) {
      if (error.retryAfterMs) store.setting('retryAt', new Date(Date.parse(now()) + error.retryAfterMs).toISOString());
      error.controlAppid = control.id;
      throw error;
    }
    lastHealthyAchievementAt = Date.parse(now());
    return true;
  }
  if (emptyAchievementCatalogsUnavailable) {
    const candidates = store.db.prepare("SELECT id FROM observations WHERE source='achievements' AND outcome='error'")
      .all().map(({ id }) => emptyAchievementCatalogAttempt(store, id)).filter(Boolean);
    if (candidates.length && await healthyForEmptyCatalog()) {
      for (const row of candidates) {
        store.finish(row.id, 'achievements', { outcome: 'unavailable', checkedAt: row.checked_at, error: NO_PUBLIC_CATALOG });
        genericDeferred.delete(`${row.id}:achievements`); deferred.delete(`${row.id}:achievements`);
      }
      emptyAchievementCatalogsResolved += candidates.length;
      await progress(snapshot({ phase: 'collecting', ...store.progress() }));
    }
  }
  for (const game of store.pending()) {
    for (const source of ['achievements', 'requirements']) {
      if (store.counts[source].planned === 0) continue;
      // Deferral changes only this pass's queue, never the saved outcome or scope.
      if (deferred.has(`${game.id}:${source}`) || genericDeferred.has(`${game.id}:${source}`)) continue;
      const outcome = source === 'achievements' ? game.achievement_outcome : game.requirements_outcome;
      if ((source === 'achievements' && !game.achievements) || ['success', 'unavailable'].includes(outcome)) continue;
      if (attempted >= limit || shouldStop()) return snapshot(store.progress());
      attempted++;
      let result;
      try {
        if (source === 'achievements') {
          const schema = await client.getGameAchievements(game.id);
          result = { outcome: 'success', hasSets: achievementSets(schema) };
        } else {
          const requirements = await client.getRequirements(game.id);
          result = { outcome: validateRequirements(requirements, game.id) ? 'success' : 'unavailable' };
        }
      } catch (error) {
        // EResult NoMatch=42, FileNotFound=9, AccessDenied=15. A generic
        // Fail/Busy result could be transient, so it must stop the run.
        if (source === 'achievements' && [9, 15, 42].includes(error.resultCode)) result = { outcome: 'unavailable', error: error.message };
        else {
          const retryAt = error.retryAfterMs ? new Date(Date.parse(now()) + error.retryAfterMs).toISOString() : null;
          // A locked progress file must not lose a server cooldown on restart.
          if (retryAt) store.setting('retryAt', retryAt);
          store.finish(game.id, source, { outcome: 'error', checkedAt: now(), error: error.message });
          if (emptyAchievementCatalogsUnavailable && source === 'achievements' && error.resultCode === 2
            && emptyAchievementCatalogAttempt(store, game.id) && await healthyForEmptyCatalog()) {
            store.finish(game.id, source, { outcome: 'unavailable', checkedAt: now(), error: NO_PUBLIC_CATALOG });
            consecutiveGenericFailures = 0; completed++; emptyAchievementCatalogsResolved++;
            await progress(snapshot({ phase: 'collecting', appid: game.id, source, completedThisRun: completed, ...store.progress() }));
            continue;
          }
          // Distinguish app-specific failures from an outage using a previously
          // successful game in the frozen scope, through the same request queue.
          let canDefer = deferGenericAchievementFailures && !retryAt && source === 'achievements' && error.resultCode === 2;
          if (canDefer && ++consecutiveGenericFailures >= 3 && Date.parse(now()) - lastHealthyAchievementAt >= 60000) {
            canDefer = false;
            const control = store.db.prepare(`SELECT o.id FROM observations o JOIN apps a ON a.id=o.id
              WHERE o.source='achievements' AND o.outcome='success'
              ORDER BY CASE WHEN o.id=620 THEN 0 ELSE 1 END,o.checked_at DESC LIMIT 1`).get();
            if (control) {
              if (attempted >= limit || shouldStop()) return snapshot(store.progress());
              attempted++;
              try {
                achievementSets(await client.getGameAchievements(control.id));
                lastHealthyAchievementAt = Date.parse(now()); canDefer = true;
              } catch (healthError) {
                const healthRetryAt = healthError.retryAfterMs ? new Date(Date.parse(now()) + healthError.retryAfterMs).toISOString() : null;
                if (healthRetryAt) store.setting('retryAt', healthRetryAt);
                await progress(snapshot({ phase: 'stopped', appid: game.id, source, ...store.progress(),
                  error: healthError.message, controlAppid: control.id, ...(healthRetryAt ? { retryAt: healthRetryAt } : {}) }));
                throw healthError;
              }
            }
          }
          if (canDefer) {
            genericDeferred.add(`${game.id}:${source}`); deferredThisRun++;
            await progress(snapshot({ phase: 'collecting', appid: game.id, source, completedThisRun: completed,
              ...store.progress(), deferredFailure: error.message }));
            continue;
          }
          await progress(snapshot({ phase: 'stopped', appid: game.id, source, ...store.progress(), error: error.message,
            ...(retryAt ? { retryAt } : {}) }));
          throw error;
        }
      }
      if (source === 'achievements') {
        consecutiveGenericFailures = 0;
        if (result.outcome === 'success') lastHealthyAchievementAt = Date.parse(now());
      }
      store.finish(game.id, source, { ...result, checkedAt: now() });
      completed++;
      await progress(snapshot({ phase: 'collecting', appid: game.id, source, completedThisRun: completed, ...store.progress() }));
    }
  }
  return snapshot(store.progress());
}

export async function main(args = process.argv.slice(2)) {
  const option = (name, fallback) => {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
    return args[i + 1];
  };
  const directory = resolve(option('--directory', resolve(ROOT, '.cache/steam-supplement')));
  const limit = Number(option('--limit', '1000000'));
  let spacingMs = Number(process.env.STEAM_REQUEST_SPACING_MS || 1500);
  const deferredSources = [...new Set(option('--defer-sources', '').split(',').filter(Boolean))];
  const deferGenericAchievementFailures = args.includes('--defer-generic-achievement-failures');
  if (deferredSources.some(key => !/^[1-9]\d*:(achievements|requirements)$/.test(key) || Number(key.split(':')[0]) > 0xffffffff)) {
    throw new Error('--defer-sources must contain comma-separated appid:achievements or appid:requirements entries');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000000) throw new Error('--limit must be between 1 and 1000000 requests');
  if (!Number.isSafeInteger(spacingMs) || spacingMs < 1000 || spacingMs > 60000) throw new Error('Supplement spacing must be between 1000 and 60000 ms');
  await mkdir(directory, { recursive: true });
  const lock = resolve(directory, 'collection.lock');
  await acquireCollectionLock(lock);
  let store;
  let stopping = false;
  const stop = () => { stopping = true; };
  const startedAt = new Date().toISOString();
  const progressFile = resolve(directory, 'progress.json');
  const writeProgress = createProgressWriter(progressFile);
  let lastLogged = 0;
  let lastStatus;
  const report = async value => {
    lastStatus = { pid: process.pid, startedAt, updatedAt: new Date().toISOString(), spacingMs,
      ...(deferredSources.length ? { deferredSources } : {}),
      ...(deferGenericAchievementFailures ? { deferGenericAchievementFailures: true } : {}), ...value };
    await writeProgress(lastStatus);
    if (value.phase !== 'collecting' || Date.now() - lastLogged >= 60000) {
      console.log(JSON.stringify(lastStatus)); lastLogged = Date.now();
    }
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    store = new SteamSupplementStore(resolve(directory, 'supplement.sqlite'));
    const minimumSpacingMs = store.setting('minimumSpacingMs') ?? 1000;
    if (!Number.isSafeInteger(minimumSpacingMs) || minimumSpacingMs < 1000 || minimumSpacingMs > 60000) throw new Error('Invalid saved minimum request spacing');
    spacingMs = Math.max(spacingMs, minimumSpacingMs);
    if (!store.setting('seed')) {
      await report({ phase: 'seeding', ...store.progress() });
      const seedFile = option('--seed-file', null);
      if (seedFile) {
        const seed = await readJSON(resolve(seedFile));
        store.seed(seed.games, { sourceFile: resolve(seedFile), seededAt: new Date().toISOString(),
          ...(args.includes('--achievements-only') ? { sources: ['achievements'] } : {}) });
      } else {
        const url = option('--manifest', 'https://steamfeatures.org/data/manifest.json');
        const { catalog, manifest } = await loadCatalog(url, { minReviews: 0 });
        store.seed(catalog.games, { manifest: url, importedAt: catalog.importedAt, snapshot: manifest.current.sha256,
          ...(args.includes('--achievements-only') ? { sources: ['achievements'] } : {}),
          seededAt: new Date().toISOString() });
      }
    }
    if (args.includes('--achievements-only') && store.counts.requirements.planned > 0) throw new Error('Achievement-only collection requires a separate checkpoint directory');
    for (const key of deferredSources) {
      if (!store.db.prepare('SELECT id FROM apps WHERE id=?').get(Number(key.split(':')[0]))) throw new Error('Deferred app is outside the frozen seed');
    }
    const previous = await optionalJSON(progressFile);
    // Preserve spacing and any explicit rate-limit cooldown across restarts.
    const lastResponse = store.db.prepare('SELECT MAX(checked_at) AS at FROM responses').get().at;
    const notBefore = Math.max(Date.parse(lastResponse) + spacingMs || 0,
      Date.parse(previous?.retryAt) || 0, Date.parse(store.setting('retryAt')) || 0);
    if (notBefore > Date.now()) { await report({ phase: 'cooldown', retryAt: new Date(notBefore).toISOString(), ...store.progress() }); await pause(notBefore - Date.now()); }
    let result = store.progress();
    if (!args.includes('--export-only')) {
      await report({ phase: 'starting', ...result });
      const client = createSteamClient({ spacingMs, throttleSpacingMs: Math.max(spacingMs, 1500), maxRequests: 1000000,
        recordResponse: value => store.recordResponse(value),
        onRequestFailure: async event => { spacingMs = event.spacingMs; await recordSupplementRequestFailure(store, directory, event); } });
      result = await collectSteamSupplement({ store, client, limit, deferredSources, deferGenericAchievementFailures,
        emptyAchievementCatalogsUnavailable: true, shouldStop: () => stopping,
        progress: value => report({ ...value, requests: client.stats }) });
    }
    if (result.complete || args.includes('--export-only')) {
      await report({ phase: 'exporting', ...result });
      const descriptor = await exportSupplement(store, directory);
      await atomicJSON(resolve(directory, 'archive.json'), descriptor);
      await report({ phase: result.complete ? 'complete' : 'partial', ...result, archive: descriptor });
    } else await report({ phase: 'partial', ...result });
  } catch (error) {
    if (lastStatus?.phase !== 'stopped') await report({ phase: 'stopped', ...(store?.progress() ?? {}), error: error.message });
    throw error;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    store?.close(); await rm(lock, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
