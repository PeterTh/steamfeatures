/** Maintained review playtime: a compact per-game state (scheduling facts plus the
 * published summary), a daily budgeted refresh and the browser projection. Full
 * responses are journaled separately and archived privately; this state is what the
 * site publishes as its maintenance checkpoint. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib';
import { createSteamClient } from './steam-client.mjs';
import { measurePlaytime, purchaseTypeFor, verifyPlaytime, PURCHASE_TYPE, FULL_PAGING_MAX_REVIEWS, PAGE_SIZE, MIN_REVIEWS } from './steam-playtime.mjs';
import { summarizePlaytime, knownPlaytimeReviews, PLAYTIME_CAP_TENTHS, MIN_KNOWN_REVIEWS } from './review-playtime.mjs';
import { download, sha256 } from './sources.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLAYTIME_STATE_FORMAT = 'steam-feature-atlas-playtime-state-v1';
export const PLAYTIME_STATE_SEED = resolve(ROOT, 'data/review-playtime-state.json.gz');
/** Working directory of the refresh job: its state (cached between runs) and journals. */
export const PLAYTIME_REFRESH_DIRECTORY = resolve(ROOT, '.cache/review-playtime-refresh');
/** Early reviewers cannot have played long, so young games are measured again at these
 * ages (days after release) while the previous measurement is less than half as old. */
export const FOLLOW_UP_DAYS = Object.freeze([30, 90, 365]);
const DAY = 86400000;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const iso = value => new Date(value).toISOString();
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const usableKeys = ['measuredAt', 'purchaseType', 'catalogReviews', 'method', 'total', 'known', 'summary'];
const usable = entry => Object.fromEntries(usableKeys.filter(key => entry?.[key] !== undefined).map(key => [key, entry[key]]));

function validateEntry(entry) {
  const invalid = detail => new Error('Invalid review playtime state entry: ' + detail);
  if (!object(entry) || !validTime(entry.checkedAt) || !['success', 'unavailable', 'error'].includes(entry.outcome)) throw invalid('attempt');
  if ((entry.retryAt !== undefined && !validTime(entry.retryAt)) || (entry.failures !== undefined && !count(entry.failures)) ||
    (entry.error !== undefined && (typeof entry.error !== 'string' || entry.error.length > 500))) throw invalid('retry');
  if (entry.measuredAt === undefined) {
    if (usableKeys.some(key => entry[key] !== undefined) || entry.outcome === 'success') throw invalid('measurement');
    return entry;
  }
  if (!validTime(entry.measuredAt) || ![PURCHASE_TYPE.steam, PURCHASE_TYPE.all].includes(entry.purchaseType) || !count(entry.catalogReviews) ||
    !['pages', 'bands'].includes(entry.method) || !count(entry.total) || !count(entry.known)) throw invalid('measurement');
  if (entry.summary !== undefined && (!Array.isArray(entry.summary) || entry.summary.length !== 3 || entry.known < MIN_KNOWN_REVIEWS ||
    entry.summary.some((value, i) => !count(value) || value > PLAYTIME_CAP_TENTHS || (i && value < entry.summary[i - 1])))) throw invalid('summary');
  return entry;
}

export function emptyPlaytimeState() {
  return { format: PLAYTIME_STATE_FORMAT, sourceArchives: [], pacing: { minimumSpacingMs: 1000 }, budget: { date: null, attempts: 0, elapsedMs: 0 }, apps: {} };
}

export function validatePlaytimeState(state) {
  if (state?.format !== PLAYTIME_STATE_FORMAT || !object(state.apps) || Object.keys(state.apps).length > 1000000 ||
    !Array.isArray(state.sourceArchives) || state.sourceArchives.some(value => !/^[a-f0-9]{64}$/.test(value)) ||
    !Number.isSafeInteger(state.pacing?.minimumSpacingMs) || state.pacing.minimumSpacingMs < 1000 || state.pacing.minimumSpacingMs > 60000 ||
    (state.pacing.cooldownAt !== undefined && !validTime(state.pacing.cooldownAt)) ||
    (state.pacing.lastResponseAt !== undefined && !validTime(state.pacing.lastResponseAt)) ||
    !(state.budget?.date === null || /^\d{4}-\d{2}-\d{2}$/.test(state.budget?.date)) ||
    !count(state.budget?.attempts) || !Number.isFinite(state.budget?.elapsedMs) || state.budget.elapsedMs < 0) throw new Error('Invalid review playtime state');
  for (const [id, entry] of Object.entries(state.apps)) {
    if (!/^[1-9]\d*$/.test(id) || Number(id) > 0xffffffff) throw new Error('Invalid review playtime state app ID');
    validateEntry(entry);
  }
  return state;
}

export function decodePlaytimeState(bytes) {
  return validatePlaytimeState(JSON.parse(gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 })));
}

export function validatePlaytimeStateDescriptor(value) {
  if (value?.format !== PLAYTIME_STATE_FORMAT || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    value.file !== `review-playtime-state.${value.sha256.slice(0, 16)}.json.gz` ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_STATE_BYTES || !count(value.apps) || value.apps > 1000000) {
    throw new Error('Invalid review playtime state descriptor');
  }
  return value;
}

export function checkedPlaytimeState(bytes, descriptor) {
  validatePlaytimeStateDescriptor(descriptor);
  if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) throw new Error('Review playtime state checksum mismatch');
  const state = decodePlaytimeState(bytes);
  if (Object.keys(state.apps).length !== descriptor.apps) throw new Error('Review playtime state count mismatch');
  return state;
}

export const encodePlaytimeState = state => gzipSync(Buffer.from(JSON.stringify(validatePlaytimeState(state))), { level: 9 });

/** Publish the state beside the catalog under a content-addressed name. */
export async function writePlaytimeState(state, directory) {
  const bytes = encodePlaytimeState(state), digest = sha256(bytes);
  const descriptor = validatePlaytimeStateDescriptor({ format: PLAYTIME_STATE_FORMAT, file: `review-playtime-state.${digest.slice(0, 16)}.json.gz`,
    sha256: digest, bytes: bytes.length, apps: Object.keys(state.apps).length });
  checkedPlaytimeState(bytes, descriptor);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, descriptor.file), bytes);
  return descriptor;
}

/** Write a working copy atomically (the refresh job's cached checkpoint). */
export async function savePlaytimeState(state, filename) {
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename + '.tmp', encodePlaytimeState(state));
  await rename(filename + '.tmp', filename);
}

/** Latest attempts and latest measurements merge independently: an unavailable or
 * failed attempt never erases an earlier measurement, and older copies never win. */
function mergeEntry(old, value) {
  if (!old) return value;
  const attempt = value.checkedAt > old.checkedAt ? value : old;
  const measured = (value.measuredAt ?? '') > (old.measuredAt ?? '') ? value : old;
  const merged = { ...attempt };
  for (const key of usableKeys) delete merged[key];
  return validateEntry({ ...merged, ...usable(measured) });
}

export class PlaytimeState {
  constructor() { this.apps = new Map(); this.sourceArchives = new Set(); this.pacing = { minimumSpacingMs: 1000 }; this.budget = { date: null, attempts: 0, elapsedMs: 0 }; }
  get(id) { return this.apps.get(id); }
  put(id, entry) { this.apps.set(id, validateEntry(entry)); }
  entries() { return this.apps; }
  merge(state) {
    validatePlaytimeState(state);
    for (const [id, entry] of Object.entries(state.apps)) this.apps.set(Number(id), mergeEntry(this.apps.get(Number(id)), entry));
    for (const value of state.sourceArchives) this.sourceArchives.add(value);
    const pacing = { minimumSpacingMs: Math.max(this.pacing.minimumSpacingMs, state.pacing.minimumSpacingMs) };
    for (const key of ['cooldownAt', 'lastResponseAt']) {
      const value = [this.pacing[key], state.pacing[key]].filter(Boolean).sort().at(-1);
      if (value) pacing[key] = value;
    }
    this.pacing = pacing;
    const budget = this.budget, other = state.budget;
    this.budget = (other.date ?? '') > (budget.date ?? '') ? { ...other }
      : other.date === budget.date ? { date: budget.date, attempts: Math.max(budget.attempts, other.attempts), elapsedMs: Math.max(budget.elapsedMs, other.elapsedMs) } : budget;
    return this;
  }
  snapshot() {
    return validatePlaytimeState({ format: PLAYTIME_STATE_FORMAT, sourceArchives: [...this.sourceArchives].sort(), pacing: { ...this.pacing },
      budget: { ...this.budget }, apps: Object.fromEntries([...this.apps].sort((a, b) => a[0] - b[0])) });
  }
}

/** Browser projection: games with a summary get their three percentiles. */
export function playtimeIndex(state) {
  const index = new Map();
  for (const [id, entry] of Object.entries(state.apps)) {
    if (entry.summary) index.set(Number(id), { playtimeP25: entry.summary[0], playtimeP50: entry.summary[1], playtimeP75: entry.summary[2] });
  }
  return index;
}

/** Catalog provenance for the published state. */
export function playtimeSource(state, descriptor) {
  const measured = Object.values(state.apps).filter(entry => entry.measuredAt).map(entry => entry.measuredAt).sort();
  return { sha256: descriptor.sha256, sourceArchives: state.sourceArchives, measuredFrom: measured[0] ?? null, measuredThrough: measured.at(-1) ?? null,
    measuredGames: measured.length, summarizedGames: playtimeIndex(state).size };
}

/** Seed, then the published checkpoint, then a newer working copy from the refresh job. */
export async function loadPlaytimeState({ seedFile = PLAYTIME_STATE_SEED, previous, localPreviousDirectory, workingFile } = {}) {
  const store = new PlaytimeState();
  store.merge(decodePlaytimeState(await readFile(seedFile)));
  let source = previous;
  if (!source?.manifest.reviewPlaytimeState && localPreviousDirectory) {
    try { source = { manifest: JSON.parse(await readFile(resolve(localPreviousDirectory, 'data/manifest.json'), 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const descriptor = source?.manifest.reviewPlaytimeState;
  if (descriptor) {
    validatePlaytimeStateDescriptor(descriptor);
    const bytes = source.manifestURL ? await download(new URL(descriptor.file, source.manifestURL), { maximumBytes: descriptor.bytes })
      : await readFile(resolve(localPreviousDirectory, 'data', descriptor.file));
    store.merge(checkedPlaytimeState(bytes, descriptor));
  }
  if (workingFile) {
    try { store.merge(decodePlaytimeState(await readFile(workingFile))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return store;
}

/** Offline: the initial state from a verified, completed collection archive. */
export async function seedReviewPlaytimeState({ directory = resolve(ROOT, '.cache/steam-playtime'), output = PLAYTIME_STATE_SEED } = {}) {
  const descriptor = JSON.parse(await readFile(resolve(directory, 'archive.json'), 'utf8'));
  const filename = resolve(directory, descriptor.file);
  await verifyPlaytime(filename, descriptor);
  const state = emptyPlaytimeState();
  state.sourceArchives.push(descriptor.sha256);
  const input = createReadStream(filename).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header;
  try {
    for await (const line of lines) {
      const row = JSON.parse(line);
      if (!header) { header = row; if (!header.complete) throw new Error('Review playtime state requires a completed collection'); continue; }
      if (row.outcome === 'success') {
        const summary = summarizePlaytime(row);
        state.apps[row.id] = { checkedAt: row.checkedAt, outcome: 'success', measuredAt: row.checkedAt, purchaseType: row.purchaseType,
          catalogReviews: row.reviews, method: row.method, total: row.total, known: knownPlaytimeReviews(row), ...(summary ? { summary: summary.slice(1) } : {}) };
      } else if (row.outcome === 'unavailable') {
        state.apps[row.id] = { checkedAt: row.checkedAt, outcome: 'unavailable', failures: 1, retryAt: iso(Date.parse(row.checkedAt) + 30 * DAY) };
      } else throw new Error(`Unexpected ${row.outcome} observation for app ${row.id}`);
    }
  } finally { lines.close(); input.destroy(); }
  const last = Object.values(state.apps).map(entry => entry.checkedAt).sort().at(-1);
  if (last) state.pacing.lastResponseAt = last;
  await savePlaytimeState(state, output);
  return { apps: Object.keys(state.apps).length, summarized: playtimeIndex(state).size, bytes: (await readFile(output)).length, output };
}

/** Conservative request estimate: paging small games, bands (plus a possible
 * population check) for the rest. */
export const estimatedRequests = reviews => reviews <= FULL_PAGING_MAX_REVIEWS ? Math.ceil(Math.max(reviews, 1) / PAGE_SIZE) + 1 : 12;

function followUpDue(game, old, now) {
  const release = Date.parse(game.releaseISO);
  if (!Number.isFinite(release)) return false;
  const age = (now - release) / DAY, measuredAge = (Date.parse(old.measuredAt) - release) / DAY;
  return FOLLOW_UP_DAYS.some(days => age >= days && measuredAge < days / 2);
}

/** Coverage first: never-measured games (0), then retries and games without a summary
 * that have grown (1), then follow-ups for young games (2); leftover budget re-measures
 * established estimates whose review count has at least doubled (3). */
export function selectPlaytimeChecks(games, entries, now) {
  const queue = [];
  for (const game of games) {
    if (!Number.isSafeInteger(game.reviews) || game.reviews < MIN_REVIEWS) continue;
    const old = entries.get(game.id);
    if (old?.retryAt && Date.parse(old.retryAt) > now) continue;
    let priority = null, order = game.reviews;
    if (!old) priority = 0;
    else if (old.outcome !== 'success' || !old.measuredAt) priority = 1;
    else if (!old.summary) {
      if (now - Date.parse(old.checkedAt) >= 7 * DAY && game.reviews >= Math.max(old.catalogReviews * 1.25, old.catalogReviews + 5)) priority = 1;
    } else if (followUpDue(game, old, now)) priority = 2;
    else if (game.reviews >= 2 * Math.max(old.catalogReviews, 1) && now - Date.parse(old.measuredAt) >= 30 * DAY) { priority = 3; order = game.reviews / Math.max(old.catalogReviews, 1); }
    if (priority !== null) queue.push({ id: game.id, reviews: game.reviews, genres: game.genres, priority, order, cost: estimatedRequests(game.reviews) });
  }
  return queue.sort((a, b) => a.priority - b.priority || b.order - a.order || a.id - b.id);
}

class PlaytimeBudgetError extends Error { constructor() { super('Review playtime refresh budget reached'); this.name = 'PlaytimeBudgetError'; } }
const PRIORITY_NAMES = ['new', 'coverage', 'followUp', 'grown'];

/** A separately budgeted serial refresh. HTTP attempts (including retries) and elapsed
 * time count against a per-UTC-day allowance that survives reruns through the state. */
export async function refreshReviewPlaytime({ state, games, fetchImpl = globalThis.fetch, now = Date.now, sleep,
  maxRequests = 500, maxDurationMs = 15 * 60000, spacingMs = 1200, recordResponse = async () => {}, checkpoint = async () => {}, progress = async () => {} }) {
  if (!count(maxRequests) || maxRequests > 5000 || !count(maxDurationMs) || maxDurationMs > 45 * 60000 ||
    !Number.isSafeInteger(spacingMs) || spacingMs < 1000 || spacingMs > 60000) throw new Error('Invalid review playtime refresh budget');
  const started = now(), date = iso(started).slice(0, 10);
  if (state.budget.date !== date) state.budget = { date, attempts: 0, elapsedMs: 0 };
  const budget = state.budget, priorElapsed = budget.elapsedMs, pacing = state.pacing;
  spacingMs = Math.max(spacingMs, pacing.minimumSpacingMs);
  const summary = { attempted: 0, measured: 0, ...Object.fromEntries(PRIORITY_NAMES.map(name => [name, 0])), unavailable: 0, failures: 0, deferred: 0, reason: 'complete' };
  const queue = selectPlaytimeChecks(games, state.entries(), started);
  summary.queued = queue.length;
  const resumeAt = Math.max(Date.parse(pacing.cooldownAt) || 0, (Date.parse(pacing.lastResponseAt) || 0) + spacingMs);
  if (resumeAt > started + 60000 || !maxRequests || !maxDurationMs) return { ...summary, reason: resumeAt > started + 60000 ? 'cooldown' : 'disabled',
    ...(resumeAt > started + 60000 ? { cooldownAt: iso(resumeAt) } : {}) };
  const elapsed = () => priorElapsed + Math.max(0, now() - started);
  const saveBudget = () => { budget.elapsedMs = elapsed(); };
  const client = createSteamClient({ spacingMs, throttleSpacingMs: Math.max(spacingMs, 1500), maxRequests: 10000, maxRetries: 4, now,
    sleep: async ms => {
      if (budget.attempts >= maxRequests || ms >= maxDurationMs - elapsed()) throw new PlaytimeBudgetError();
      await (sleep ?? pause)(ms);
    },
    fetchImpl: async (url, options) => {
      if (budget.attempts >= maxRequests || elapsed() >= maxDurationMs) throw new PlaytimeBudgetError();
      budget.attempts++; summary.attempted++; saveBudget();
      return fetchImpl(url, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, Math.ceil(maxDurationMs - elapsed())))]) });
    },
    recordResponse: async response => { await recordResponse(response); pacing.lastResponseAt = iso(now()); saveBudget(); },
    onRequestFailure: async event => {
      if (event.errorName === 'PlaytimeBudgetError') return;
      pacing.lastResponseAt = iso(now());
      pacing.minimumSpacingMs = Math.max(pacing.minimumSpacingMs, event.spacingMs);
      const delay = Math.max(event.retryAfterMs ?? 0, event.retryDelayMs ?? 0, event.status === 429 && !event.willRetry ? 60000 : 0);
      if (delay) pacing.cooldownAt = iso(Math.max(Date.parse(pacing.cooldownAt) || 0, now() + delay));
      saveBudget();
    },
  });
  try {
    for (const game of queue) {
      if (budget.attempts >= maxRequests || elapsed() >= maxDurationMs) { summary.reason = 'budget'; break; }
      // Skip games that cannot finish within today's allowance; cheaper ones may still fit.
      if (budget.attempts + game.cost > maxRequests) { summary.deferred++; continue; }
      const old = state.get(game.id);
      try {
        const result = await measurePlaytime(client, { id: game.id, purchase_type: old?.purchaseType ?? purchaseTypeFor(game), reviews: game.reviews });
        const record = { outcome: 'success', ...result }, measured = summarizePlaytime(record), checkedAt = iso(now());
        state.put(game.id, { checkedAt, outcome: 'success', measuredAt: checkedAt, purchaseType: result.purchaseType, catalogReviews: game.reviews,
          method: result.method, total: result.total, known: knownPlaytimeReviews(record), ...(measured ? { summary: measured.slice(1) } : {}) });
        summary.measured++; summary[PRIORITY_NAMES[game.priority]]++;
      } catch (error) {
        if (error instanceof PlaytimeBudgetError) { summary.reason = 'budget'; break; }
        const failures = (old && old.outcome !== 'success' ? old.failures ?? 0 : 0) + 1, checkedAt = iso(now());
        if (error.resultCode === 42) {
          // NoMatch: delisted or hidden. Back off 30, 90, then 180 days; keep any earlier measurement.
          state.put(game.id, { ...usable(old), checkedAt, outcome: 'unavailable', failures, retryAt: iso(now() + [30, 90, 180][Math.min(failures, 3) - 1] * DAY) });
          summary.unavailable++;
        } else {
          state.put(game.id, { ...usable(old), checkedAt, outcome: 'error', failures, error: String(error.message).slice(0, 500),
            retryAt: iso(now() + Math.min(7 * DAY, 3600000 * 2 ** Math.min(failures - 1, 8))) });
          // Stop this optional phase on transport, service or schema errors; known facts stay usable.
          summary.failures++; summary.reason = 'service-error'; summary.error = error.message; break;
        }
      }
      await checkpoint(); await progress(summary);
    }
  } finally { saveBudget(); await checkpoint(true); }
  return { ...summary, dailyAttempts: budget.attempts, elapsedMs: budget.elapsedMs,
    remaining: selectPlaytimeChecks(games, state.entries(), now()).length, spacingMs: client.spacingMs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : resolve(process.argv[i + 1]); };
  if (!process.argv.includes('--seed')) throw new Error('Usage: node scripts/review-playtime-state.mjs --seed [--directory <completed collection>] [--output <file>]');
  seedReviewPlaytimeState({ directory: option('--directory'), output: option('--output') })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
