import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createSteamClient } from './steam-client.mjs';
import { createSteamResponseArchive } from './steam-archive.mjs';
import { achievementSets } from './steam-supplement.mjs';

export const ACHIEVEMENT_STATE_FORMAT = 'steam-feature-atlas-achievement-state-v1';
export const ACHIEVEMENT_STATE_SEED = resolve(dirname(fileURLToPath(import.meta.url)), '../data/achievement-state.json.gz');
const DAY = 86400000;
const iso = value => new Date(value).toISOString();
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const goodKeys = ['hasSets', 'schemaVersion', 'schemaHash', 'successfulAt'];

function validateEntry(entry) {
  if (!object(entry) || !validTime(entry.checkedAt) || !['success', 'unavailable', 'error'].includes(entry.outcome) ||
    (entry.retryAt !== undefined && !validTime(entry.retryAt)) ||
    (entry.failures !== undefined && (!Number.isSafeInteger(entry.failures) || entry.failures < 0)) ||
    (entry.needsSchema !== undefined && typeof entry.needsSchema !== 'boolean')) throw new Error('Invalid achievement checkpoint entry');
  if (entry.hasSets !== undefined && (typeof entry.hasSets !== 'boolean' || !validTime(entry.successfulAt) ||
    !Number.isSafeInteger(entry.schemaVersion) || entry.schemaVersion < 0 ||
    !Number.isSafeInteger(entry.schemaHash) || entry.schemaHash < 0 || entry.schemaHash > 0xffffffff)) {
    throw new Error('Invalid usable achievement checkpoint');
  }
  if (entry.outcome === 'success' && entry.hasSets === undefined) throw new Error('Missing successful achievement flag');
  return entry;
}

export function emptyAchievementState() {
  return { format: ACHIEVEMENT_STATE_FORMAT, sourceArchives: [], apps: {}, pacing: { minimumSpacingMs: 1000 },
    budget: { date: null, attempts: 0, elapsedMs: 0 } };
}

export function validateAchievementState(state) {
  if (state?.format !== ACHIEVEMENT_STATE_FORMAT || !object(state.apps) || Object.keys(state.apps).length > 1000000 ||
    !Array.isArray(state.sourceArchives) || state.sourceArchives.some(value => !/^[a-f0-9]{64}$/.test(value)) ||
    !Number.isSafeInteger(state.pacing?.minimumSpacingMs) || state.pacing.minimumSpacingMs < 1000 || state.pacing.minimumSpacingMs > 60000 ||
    (state.pacing.cooldownAt !== undefined && !validTime(state.pacing.cooldownAt)) ||
    (state.pacing.lastResponseAt !== undefined && !validTime(state.pacing.lastResponseAt)) ||
    !(state.budget?.date === null || /^\d{4}-\d{2}-\d{2}$/.test(state.budget?.date)) ||
    !Number.isSafeInteger(state.budget?.attempts) || state.budget.attempts < 0 ||
    !Number.isFinite(state.budget?.elapsedMs) || state.budget.elapsedMs < 0) throw new Error('Invalid achievement checkpoint');
  for (const [id, entry] of Object.entries(state.apps)) {
    if (!/^[1-9]\d*$/.test(id) || Number(id) > 0xffffffff) throw new Error('Invalid achievement checkpoint app ID');
    validateEntry(entry);
  }
  return state;
}

export function decodeAchievementState(bytes) {
  return validateAchievementState(JSON.parse(gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 })));
}

export function validateAchievementStateDescriptor(value) {
  if (value?.format !== ACHIEVEMENT_STATE_FORMAT || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    value.file !== `achievement-state.${value.sha256.slice(0, 16)}.json.gz` ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(value.apps) || value.apps < 0 || value.apps > 1000000) throw new Error('Invalid achievement checkpoint descriptor');
  return value;
}

export function checkedAchievementState(bytes, descriptor) {
  validateAchievementStateDescriptor(descriptor);
  if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256) throw new Error('Achievement checkpoint checksum mismatch');
  const state = decodeAchievementState(bytes);
  if (Object.keys(state.apps).length !== descriptor.apps) throw new Error('Achievement checkpoint count mismatch');
  return state;
}

export async function writeAchievementState(state, directory) {
  validateAchievementState(state);
  const bytes = gzipSync(Buffer.from(JSON.stringify(state)), { level: 9 });
  const sha256 = hash(bytes);
  const descriptor = validateAchievementStateDescriptor({ format: ACHIEVEMENT_STATE_FORMAT,
    file: `achievement-state.${sha256.slice(0, 16)}.json.gz`, sha256, bytes: bytes.length, apps: Object.keys(state.apps).length });
  checkedAchievementState(bytes, descriptor);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, descriptor.file), bytes);
  return descriptor;
}

/** Latest attempts and latest usable facts merge independently; unavailable
 * responses and interrupted runs can never erase a previously observed flag. */
function mergeEntry(old, value) {
  if (!old) return value;
  const attempt = value.checkedAt > old.checkedAt ? value : old;
  const usable = (value.successfulAt ?? '') > (old.successfulAt ?? '') ? value : old;
  const merged = { ...attempt };
  for (const key of goodKeys) {
    if (usable.hasSets !== undefined) merged[key] = usable[key];
    else delete merged[key];
  }
  return validateEntry(merged);
}

export class AchievementRefreshStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS achievements (id INTEGER PRIMARY KEY,value TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  setting(key, value) {
    if (value !== undefined) this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value));
    return JSON.parse(this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? 'null');
  }
  get(id) { const row = this.db.prepare('SELECT value FROM achievements WHERE id=?').get(id); return row ? validateEntry(JSON.parse(row.value)) : undefined; }
  put(id, entry) { this.db.prepare('INSERT OR REPLACE INTO achievements VALUES (?,?)').run(id, JSON.stringify(validateEntry(entry))); }
  entries() { return new Map(this.db.prepare('SELECT id,value FROM achievements ORDER BY id').all().map(row => [row.id, validateEntry(JSON.parse(row.value))])); }
  merge(state) {
    validateAchievementState(state);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.entries();
      for (const [id, entry] of Object.entries(state.apps)) this.put(Number(id), mergeEntry(existing.get(Number(id)), entry));
      this.setting('sourceArchives', [...new Set([...(this.setting('sourceArchives') ?? []), ...state.sourceArchives])]);
      const pacing = this.setting('pacing') ?? { minimumSpacingMs: 1000 };
      const combined = { minimumSpacingMs: Math.max(pacing.minimumSpacingMs, state.pacing.minimumSpacingMs) };
      for (const key of ['cooldownAt', 'lastResponseAt']) {
        const value = [pacing[key], state.pacing[key]].filter(Boolean).sort().at(-1);
        if (value) combined[key] = value;
      }
      this.setting('pacing', combined);
      const budget = this.setting('budget');
      this.setting('budget', !budget || (state.budget.date ?? '') > (budget.date ?? '') ? state.budget
        : budget.date === state.budget.date ? { ...budget, attempts: Math.max(budget.attempts, state.budget.attempts),
          elapsedMs: Math.max(budget.elapsedMs, state.budget.elapsedMs) } : budget);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  snapshot() {
    return validateAchievementState({ format: ACHIEVEMENT_STATE_FORMAT, sourceArchives: this.setting('sourceArchives') ?? [],
      pacing: this.setting('pacing') ?? { minimumSpacingMs: 1000 }, budget: this.setting('budget') ?? emptyAchievementState().budget,
      apps: Object.fromEntries(this.entries()) });
  }
}

export function achievementStateIndex(state) {
  return new Map(Object.entries(state.apps).filter(([, value]) => typeof value.hasSets === 'boolean').map(([id, value]) => [Number(id), value.hasSets]));
}

export function selectAchievementChecks(games, entries, now) {
  return games.filter(game => game.featureIds.includes(22)).flatMap(game => {
    const old = entries.get(game.id);
    const released = game.releaseStatus === 'released' && (old?.release === 'upcoming' ||
      (old?.outcome === 'unavailable' && old.release === undefined));
    if (old && !released && Date.parse(old.retryAt ?? old.checkedAt) > now) return [];
    if (old?.outcome === 'success' && !old.needsSchema && !released && now - Date.parse(old.checkedAt) < 7 * DAY) return [];
    const priority = !old ? 0 : released || old.needsSchema || (old.outcome === 'error' && old.hasSets === undefined) ? 1 : 2;
    return [{ ...game, priority, checkedAt: old?.checkedAt ?? '' }];
  }).sort((a, b) => a.priority - b.priority || (a.priority === 2 ? a.checkedAt.localeCompare(b.checkedAt) : 0)
    || (b.reviews ?? 0) - (a.reviews ?? 0) || a.id - b.id);
}

class AchievementBudgetError extends Error { constructor() { super('Achievement refresh budget reached'); this.name = 'AchievementBudgetError'; } }
function schemaIdentity(value) {
  if (!Number.isSafeInteger(value?.schema_version) || value.schema_version < 0 || !Number.isSafeInteger(value?.schema_hash) ||
    value.schema_hash < 0 || value.schema_hash > 0xffffffff) throw new Error('Invalid achievement schema identity');
  return { schemaVersion: value.schema_version, schemaHash: value.schema_hash };
}

/** A separately budgeted serial phase. StoreBrowse/PICS settings are untouched.
 * HTTP attempts (including retries) and elapsed time survive repeated builds. */
export async function refreshAchievementSets({ store, games, directory, fetchImpl = globalThis.fetch, now = Date.now,
  sleep, maxRequests = 2000, maxDurationMs = 30 * 60000, spacingMs = 1000, recordResponse, progress = async () => {} }) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 0 || maxRequests > 10000 ||
    !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 0 || maxDurationMs > 45 * 60000 ||
    !Number.isSafeInteger(spacingMs) || spacingMs < 1000 || spacingMs > 60000) throw new Error('Invalid achievement refresh budget');
  const started = now(), date = iso(started).slice(0, 10);
  const prior = store.setting('budget');
  const budget = prior?.date === date ? prior : { date, attempts: 0, elapsedMs: 0 };
  store.setting('budget', budget);
  const priorElapsed = budget.elapsedMs;
  const pacing = store.setting('pacing') ?? { minimumSpacingMs: 1000 };
  spacingMs = Math.max(spacingMs, pacing.minimumSpacingMs);
  const summary = { attempted: 0, checked: 0, newGames: 0, unchanged: 0, unavailable: 0, failures: 0, reason: 'complete' };
  const queue = selectAchievementChecks(games, store.entries(), started);
  summary.queued = queue.length;
  const resumeAt = Math.max(Date.parse(pacing.cooldownAt) || 0, (Date.parse(pacing.lastResponseAt) || 0) + spacingMs);
  if (resumeAt > started || !maxRequests || !maxDurationMs) return { ...summary, reason: resumeAt > started ? 'cooldown' : 'disabled',
    ...(resumeAt > started ? { cooldownAt: iso(resumeAt) } : {}) };
  const archive = recordResponse ?? createSteamResponseArchive({ directory: resolve(directory, 'responses'), now });
  let lastResponse, healthyAt = 0;
  const elapsed = () => priorElapsed + Math.max(0, now() - started);
  const saveBudget = () => { budget.elapsedMs = elapsed(); store.setting('budget', budget); };
  const client = createSteamClient({ spacingMs, throttleSpacingMs: Math.max(spacingMs, 1500), maxRequests: 10000,
    sleep: async ms => {
      if (budget.attempts >= maxRequests || ms >= maxDurationMs - elapsed()) throw new AchievementBudgetError();
      await (sleep ?? pause)(ms);
    }, now,
    fetchImpl: async (url, options) => {
      if (budget.attempts >= maxRequests || elapsed() >= maxDurationMs) throw new AchievementBudgetError();
      budget.attempts++; summary.attempted++; saveBudget();
      return fetchImpl(url, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, Math.ceil(maxDurationMs - elapsed())))]) });
    },
    recordResponse: async response => {
      await archive(response); lastResponse = response;
      pacing.lastResponseAt = iso(now()); store.setting('pacing', pacing); saveBudget();
    },
    onRequestFailure: async event => {
      if (event.errorName === 'AchievementBudgetError') return;
      pacing.lastResponseAt = iso(now());
      pacing.minimumSpacingMs = Math.max(pacing.minimumSpacingMs, event.spacingMs);
      const delay = Math.max(event.retryAfterMs ?? 0, event.retryDelayMs ?? 0, event.status === 429 && !event.willRetry ? 60000 : 0);
      if (delay) pacing.cooldownAt = iso(Math.max(Date.parse(pacing.cooldownAt) || 0, now() + delay));
      store.setting('pacing', pacing); saveBudget();
    },
  });
  const success = (id, schema, game) => {
    const checkedAt = iso(now());
    const entry = { checkedAt, outcome: 'success', successfulAt: checkedAt, hasSets: achievementSets(schema),
      ...schemaIdentity(schema), ...((game?.releaseStatus ?? store.get(id)?.release) ? { release: game?.releaseStatus ?? store.get(id)?.release } : {}) };
    store.put(id, entry); healthyAt = now(); return entry;
  };
  const healthy = async id => {
    if (healthyAt && now() - healthyAt < 60000) return true;
    const entries = store.entries();
    const control = entries.get(620)?.hasSets !== undefined && id !== 620 ? 620
      : [...entries].find(([key, value]) => key !== id && value.hasSets !== undefined)?.[0];
    if (!control) return false;
    success(control, await client.getGameAchievements(control));
    return true;
  };
  try {
    for (const game of queue) {
      if (budget.attempts >= maxRequests || elapsed() >= maxDurationMs) { summary.reason = 'budget'; break; }
      const old = store.get(game.id);
      try {
        if (old?.hasSets !== undefined && !old.needsSchema) {
          const identity = schemaIdentity(await client.getGameAchievements(game.id, { hashOnly: true }));
          if (identity.schemaHash === old.schemaHash && identity.schemaVersion === old.schemaVersion) {
            const checkedAt = iso(now());
            store.put(game.id, { checkedAt, outcome: 'success', successfulAt: checkedAt, hasSets: old.hasSets,
              ...identity, release: game.releaseStatus });
            summary.unchanged++; summary.checked++;
            await progress(summary); continue;
          }
          store.put(game.id, { ...old, checkedAt: iso(now()), outcome: 'error', needsSchema: true, retryAt: iso(now()) });
        }
        success(game.id, await client.getGameAchievements(game.id), game);
        summary.checked++; if (!old) summary.newGames++;
      } catch (error) {
        if (error instanceof AchievementBudgetError) { summary.reason = 'budget'; break; }
        const raw = lastResponse;
        const empty = error.resultCode === 2 && raw?.input.appid === game.id && raw.status === 200 &&
          object(raw.body) && Object.keys(raw.body).length === 1 && object(raw.body.response) && Object.keys(raw.body.response).length === 0;
        let unavailable = [9, 15, 42].includes(error.resultCode);
        if (empty) {
          try { unavailable = await healthy(game.id); }
          catch (controlError) { error = controlError; }
        }
        const current = store.get(game.id) ?? old ?? {};
        const checkedAt = iso(now()), failures = (current.failures ?? 0) + 1;
        const retryDelay = unavailable ? (game.releaseStatus === 'upcoming' ? 30 : 7) * DAY
          : Math.min(7 * DAY, 3600000 * 2 ** Math.min(failures - 1, 8));
        store.put(game.id, { ...current, checkedAt, outcome: unavailable ? 'unavailable' : 'error', failures,
          retryAt: iso(now() + retryDelay), release: game.releaseStatus, error: empty && unavailable ? 'No public achievement catalog; service health confirmed' : error.message });
        if (unavailable) { summary.unavailable++; summary.checked++; }
        else {
          summary.failures++;
          if (error instanceof AchievementBudgetError) { summary.reason = 'budget'; break; }
          // Stop this optional phase on transport/schema/service errors. The
          // catalog still builds from the last usable flags and saved cooldown.
          summary.reason = 'service-error'; summary.error = error.message; break;
        }
      }
      await progress(summary);
    }
  } finally { saveBudget(); }
  return { ...summary, dailyAttempts: budget.attempts, elapsedMs: budget.elapsedMs,
    remaining: selectAchievementChecks(games, store.entries(), now()).length, spacingMs: client.spacingMs };
}
