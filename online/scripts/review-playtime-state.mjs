/** Maintained review playtime: a compact per-game state (scheduling facts plus the
 * published summary) and the browser projection. Full
 * responses are journaled separately and archived privately; this state is what the
 * site publishes as its maintenance checkpoint. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib';
import { verifyPlaytime, PURCHASE_TYPE } from './steam-playtime.mjs';
import { summarizePlaytime, knownPlaytimeReviews, PLAYTIME_CAP_TENTHS, MIN_KNOWN_REVIEWS } from './review-playtime.mjs';
import { download, sha256 } from './sources.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLAYTIME_STATE_FORMAT = 'steam-feature-atlas-playtime-state-v1';
export const PLAYTIME_STATE_SEED = resolve(ROOT, 'data/review-playtime-state.json.gz');
/** Working directory for a newer working copy of the state, merged by builds when present. */
export const PLAYTIME_REFRESH_DIRECTORY = resolve(ROOT, '.cache/review-playtime-refresh');
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : resolve(process.argv[i + 1]); };
  if (!process.argv.includes('--seed')) throw new Error('Usage: node scripts/review-playtime-state.mjs --seed [--directory <completed collection>] [--output <file>]');
  seedReviewPlaytimeState({ directory: option('--directory'), output: option('--output') })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
