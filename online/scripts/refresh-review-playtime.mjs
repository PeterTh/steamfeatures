/** Daily review playtime refresh, run by the workflow's separate playtime job in parallel
 * with the build. It starts from the seed, the published checkpoint and the job's own
 * cached working copy, measures due games within a daily budget, journals every
 * (sanitized) response and saves the working copy for the next build to publish. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPreviousManifest } from './sources.mjs';
import { loadCatalog } from '../src/filter-worker.js';
import { createSteamResponseArchive } from './steam-archive.mjs';
import { retainedBody } from './steam-playtime.mjs';
import { loadPlaytimeState, refreshReviewPlaytime, savePlaytimeState, PLAYTIME_REFRESH_DIRECTORY } from './review-playtime-state.mjs';

const number = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  return value;
};

export async function main(args = process.argv.slice(2)) {
  const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const baseURL = option('--published-url', process.env.PAGES_BASE_URL);
  const directory = resolve(option('--directory', PLAYTIME_REFRESH_DIRECTORY));
  const workingFile = resolve(directory, 'state.json.gz');
  const previous = await readPreviousManifest(baseURL);
  if (!previous) throw new Error('The playtime refresh requires a published catalog (--published-url or PAGES_BASE_URL)');
  // Current review counts, release dates and genres come from the verified published catalog.
  const { catalog } = await loadCatalog(previous.manifestURL.href, { minReviews: 0 });
  const state = await loadPlaytimeState({ previous, workingFile });
  const archive = createSteamResponseArchive({ directory: resolve(directory, 'responses') });
  let savedAt = 0, lastLogged = 0;
  const result = await refreshReviewPlaytime({ state, games: catalog.games,
    maxRequests: number('STEAM_PLAYTIME_REQUEST_LIMIT', 500), maxDurationMs: number('STEAM_PLAYTIME_TIME_LIMIT_MS', 15 * 60000),
    spacingMs: number('STEAM_PLAYTIME_REQUEST_SPACING_MS', 1200),
    // Review text, developer responses, hardware strings and author IDs never reach the journal.
    recordResponse: response => archive({ ...response, body: retainedBody(response.body) }),
    checkpoint: async (final = false) => {
      if (!final && Date.now() - savedAt < 15000) return;
      await savePlaytimeState(state.snapshot(), workingFile); savedAt = Date.now();
    },
    progress: async summary => { if (Date.now() - lastLogged >= 60000) { console.log(JSON.stringify(summary)); lastLogged = Date.now(); } } });
  console.log('Review playtime refresh: ' + JSON.stringify(result));
  // The refresh is optional for deployment, but a stopped run should be visible.
  if (result.reason === 'service-error' || result.reason === 'cooldown') console.log(`::warning title=Review playtime refresh::${result.reason}: ${result.error ?? result.cooldownAt}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
