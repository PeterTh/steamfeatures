import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSteamClient } from './steam-client.mjs';
import { SteamPlaytimeStore, measurePlaytime, exportPlaytime, StopCollection, MIN_REVIEWS } from './steam-playtime.mjs';
import { acquireCollectionLock, recordSupplementRequestFailure } from './collect-steam-supplement.mjs';
import { loadCatalog } from '../src/filter-worker.js';
import { writeAtomicJSON as atomicJSON, createProgressWriter } from './atomic-json.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJSON = async filename => JSON.parse(await readFile(filename, 'utf8'));
async function optionalJSON(filename) {
  try { return await readJSON(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Popular apps first. Each app is checkpointed only after all of its requests
 * succeed; an interrupted app is measured again from its first page. EResult
 * NoMatch (42) is unavailable; any other failure stays unknown and stops. */
export async function collectSteamPlaytime({ store, client, limit = 1000000, progress = async () => {},
  shouldStop = () => false, now = () => new Date().toISOString() }) {
  let attempted = 0, completed = 0;
  const take = () => {
    if (attempted >= limit || shouldStop()) throw new StopCollection();
    attempted++;
  };
  for (const app of store.pending()) {
    if (attempted >= limit || shouldStop()) break;
    const firstResponse = store.lastSequence() + 1;
    let observation;
    try {
      const result = await measurePlaytime(client, app, take);
      observation = { outcome: 'success', result };
    } catch (error) {
      if (error instanceof StopCollection) break;
      if (error.resultCode === 42) observation = { outcome: 'unavailable', error: error.message };
      else {
        const retryAt = error.retryAfterMs ? new Date(Date.parse(now()) + error.retryAfterMs).toISOString() : null;
        if (retryAt) store.setting('retryAt', retryAt);
        store.finish(app.id, { outcome: 'error', checkedAt: now(), firstResponse, error: error.message });
        await progress({ phase: 'stopped', appid: app.id, ...store.progress(), error: error.message, ...(retryAt ? { retryAt } : {}) });
        throw error;
      }
    }
    store.finish(app.id, { ...observation, checkedAt: now(), firstResponse });
    completed++;
    await progress({ phase: 'collecting', appid: app.id, completedThisRun: completed, attemptedThisRun: attempted, ...store.progress() });
  }
  return store.progress();
}

export async function main(args = process.argv.slice(2)) {
  const option = (name, fallback) => {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
    return args[i + 1];
  };
  const directory = resolve(option('--directory', resolve(ROOT, '.cache/steam-playtime')));
  const limit = Number(option('--limit', '1000000'));
  const minReviews = Number(option('--min-reviews', String(MIN_REVIEWS)));
  let spacingMs = Number(process.env.STEAM_REQUEST_SPACING_MS || 1200);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000000) throw new Error('--limit must be between 1 and 1000000 requests');
  if (!Number.isSafeInteger(minReviews) || minReviews < 1) throw new Error('--min-reviews must be a positive integer');
  if (!Number.isSafeInteger(spacingMs) || spacingMs < 1000 || spacingMs > 60000) throw new Error('Playtime spacing must be between 1000 and 60000 ms');
  await mkdir(directory, { recursive: true });
  const lock = resolve(directory, 'collection.lock');
  await acquireCollectionLock(lock);
  let store, stopping = false, lastStatus, lastLogged = 0;
  const stop = () => { stopping = true; };
  const startedAt = new Date().toISOString();
  const progressFile = resolve(directory, 'progress.json');
  const writeProgress = createProgressWriter(progressFile);
  const report = async value => {
    lastStatus = { pid: process.pid, startedAt, updatedAt: new Date().toISOString(), spacingMs, ...value };
    await writeProgress(lastStatus);
    if (value.phase !== 'collecting' || Date.now() - lastLogged >= 60000) { console.log(JSON.stringify(lastStatus)); lastLogged = Date.now(); }
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    store = new SteamPlaytimeStore(resolve(directory, 'playtime.sqlite'));
    const minimumSpacingMs = store.setting('minimumSpacingMs') ?? 1000;
    if (!Number.isSafeInteger(minimumSpacingMs) || minimumSpacingMs < 1000 || minimumSpacingMs > 60000) throw new Error('Invalid saved minimum request spacing');
    spacingMs = Math.max(spacingMs, minimumSpacingMs);
    if (!store.setting('seed')) {
      await report({ phase: 'seeding', ...store.progress() });
      const seedFile = option('--seed-file', null);
      if (seedFile) {
        const seed = await readJSON(resolve(seedFile));
        store.seed(seed.games, { sourceFile: resolve(seedFile), seededAt: new Date().toISOString() }, { minReviews });
      } else {
        const url = option('--manifest', 'https://steamfeatures.org/data/manifest.json');
        const { catalog, manifest } = await loadCatalog(url, { minReviews: 0 });
        store.seed(catalog.games, { manifest: url, importedAt: catalog.importedAt, snapshot: manifest.current.sha256,
          seededAt: new Date().toISOString() }, { minReviews });
      }
    } else if (args.includes('--min-reviews') && store.setting('seed').minReviews !== minReviews) {
      throw new Error('--min-reviews differs from the frozen seed; use a separate --directory');
    }
    const remeasure = option('--remeasure', null);
    if (remeasure !== null) {
      const ids = remeasure.split(',').map(Number);
      if (!ids.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('--remeasure must list comma-separated app IDs');
      store.remeasure(ids, option('--reason', null) ?? (() => { throw new Error('--remeasure requires --reason'); })());
    }
    const previous = await optionalJSON(progressFile);
    const lastResponse = store.db.prepare('SELECT MAX(checked_at) AS at FROM responses').get().at;
    const notBefore = Math.max(Date.parse(lastResponse) + spacingMs || 0, Date.parse(previous?.retryAt) || 0, Date.parse(store.setting('retryAt')) || 0);
    if (notBefore > Date.now()) { await report({ phase: 'cooldown', retryAt: new Date(notBefore).toISOString(), ...store.progress() }); await pause(notBefore - Date.now()); }
    let result = store.progress();
    if (!args.includes('--export-only')) {
      await report({ phase: 'starting', ...result });
      const client = createSteamClient({ spacingMs, throttleSpacingMs: Math.max(spacingMs, 1500), maxRequests: 1000000, maxRetries: 4,
        recordResponse: value => store.recordResponse(value),
        onRequestFailure: async event => { spacingMs = event.spacingMs; await recordSupplementRequestFailure(store, directory, event); } });
      result = await collectSteamPlaytime({ store, client, limit, shouldStop: () => stopping,
        progress: value => report({ ...value, requests: client.stats }) });
    }
    if (result.complete || args.includes('--export-only')) {
      await report({ phase: 'exporting', ...result });
      const descriptor = await exportPlaytime(store, directory);
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
