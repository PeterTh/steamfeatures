// The published state is the durable queue. It must survive an Actions cache miss.
// Timestamps are attempts, not just successes: an unavailable app cannot monopolize it.
export const REFRESH_STATE_VERSION = 1;
export const DEFAULT_REFRESH_BUDGET = 4000;
export const MAX_REFRESH_BUDGET = 5000;
const DAY = 24 * 60 * 60 * 1000;
const STATUSES = new Set(['ok', 'failed', 'unavailable']);
const RELEASE_STATUSES = new Set(['released', 'upcoming', 'unknown']);
const OPTIONAL_METADATA_FIELDS = new Set([
  'appType', 'name', 'releaseStatus', 'releaseISO', 'releaseDate', 'reviews',
  'positivePercent', 'tags', 'featureIds', 'featureDataKnown', 'earlyAccess',
  'genres', 'tagDataKnown'
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function appId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid refresh Steam app ID');
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`Invalid refresh ${label} timestamp`);
  }
  return value;
}

function validateResultCode(status, value) {
  if (value === undefined) return;
  if (status === 'ok' || !Number.isSafeInteger(value) || value <= 1 || value > 0xffffffff || (status === 'unavailable') !== (value === 15)) {
    throw new Error('Invalid refresh result code');
  }
  return value;
}

/** Only an explicit per-app AccessDenied response qualifies for the exception. */
export function isSteamDenied(entry) {
  return entry?.status === 'unavailable' && entry.resultCode === 15;
}

function validateMetadata(value) {
  if (!isObject(value) || !Object.keys(value).length) throw new Error('Invalid refresh metadata');
  const metadata = {};
  for (const [key, field] of Object.entries(value)) {
    if (!OPTIONAL_METADATA_FIELDS.has(key)) throw new Error(`Unknown refresh metadata field ${key}`);
    if (field === null) {
      if (['appType', 'name', 'releaseStatus', 'featureDataKnown', 'tagDataKnown'].includes(key)) throw new Error(`Invalid refresh metadata ${key}`);
      metadata[key] = null;
      continue;
    }
    let valid = true;
    if (['appType', 'reviews', 'positivePercent'].includes(key)) valid = Number.isSafeInteger(field) && field >= 0 && (key !== 'positivePercent' || field <= 100);
    else if (key === 'name') valid = typeof field === 'string' && field.trim().length > 0;
    else if (key === 'releaseStatus') valid = RELEASE_STATUSES.has(field);
    else if (key === 'releaseISO') valid = typeof field === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(field) && Number.isFinite(Date.parse(`${field}T00:00:00.000Z`)) && new Date(`${field}T00:00:00.000Z`).toISOString().slice(0, 10) === field;
    else if (key === 'releaseDate') valid = typeof field === 'string' && field.trim().length > 0;
    else if (['earlyAccess', 'featureDataKnown', 'tagDataKnown'].includes(key)) valid = typeof field === 'boolean';
    else if (['tags', 'genres'].includes(key)) valid = Array.isArray(field) && field.every(item => typeof item === 'string' && item.trim().length > 0) && new Set(field).size === field.length;
    else if (key === 'featureIds') valid = Array.isArray(field) && field.every(item => Number.isSafeInteger(item) && item >= 0) && new Set(field).size === field.length;
    if (!valid) throw new Error(`Invalid refresh metadata ${key}`);
    metadata[key] = Array.isArray(field) ? [...field] : field;
  }
  return metadata;
}

export function createRefreshState() {
  return { version: REFRESH_STATE_VERSION, bootstrapComplete: false, apps: {} };
}

export function validateRefreshState(state) {
  if (!isObject(state) || state.version !== REFRESH_STATE_VERSION || !isObject(state.apps) || Object.keys(state).some(key => !['version', 'apps', 'discovery', 'lastDiscoveryAt', 'bootstrapComplete', 'bootstrapCursor', 'rotation'].includes(key))) {
    throw new Error('Invalid or unsupported Steam refresh state');
  }
  const normalized = createRefreshState();
  if (typeof state.bootstrapComplete !== 'boolean') throw new Error('Invalid refresh bootstrap status');
  normalized.bootstrapComplete = state.bootstrapComplete;
  if (state.rotation !== undefined) {
    if (!isObject(state.rotation)) throw new Error('Invalid refresh daily rotation');
    const { date, attempted } = state.rotation;
    if (Object.keys(state.rotation).some(key => !['date', 'attempted'].includes(key)) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date || !Number.isSafeInteger(attempted) || attempted < 0 || attempted > MAX_REFRESH_BUDGET) throw new Error('Invalid refresh daily rotation');
    normalized.rotation = { date, attempted };
  }
  if (state.bootstrapCursor !== undefined) {
    const cursor = state.bootstrapCursor;
    if (!isObject(cursor) || Object.keys(cursor).some(key => !['nextStart', 'queryComplete'].includes(key)) || !Number.isSafeInteger(cursor.nextStart) || cursor.nextStart < 0 || typeof cursor.queryComplete !== 'boolean') throw new Error('Invalid refresh bootstrap cursor');
    normalized.bootstrapCursor = { nextStart: cursor.nextStart, queryComplete: cursor.queryComplete };
  }
  if (state.lastDiscoveryAt !== undefined) normalized.lastDiscoveryAt = timestamp(state.lastDiscoveryAt, 'lastDiscoveryAt');
  if (state.discovery !== undefined) {
    if (!isObject(state.discovery) || Object.keys(state.discovery).some(key => !['since', 'until', 'nextStart'].includes(key))) throw new Error('Invalid refresh discovery cursor');
    const since = timestamp(state.discovery.since, 'discovery since');
    const until = timestamp(state.discovery.until, 'discovery until');
    const nextStart = state.discovery.nextStart;
    if (since > until || !Number.isSafeInteger(nextStart) || nextStart < 0) throw new Error('Invalid refresh discovery range');
    normalized.discovery = { since, until, nextStart };
  }
  for (const [key, value] of Object.entries(state.apps)) {
    const id = appId(Number(key));
    if (String(id) !== key || !isObject(value) || !STATUSES.has(value.status) || Object.keys(value).some(field => !['status', 'lastAttemptAt', 'checkedAt', 'retryNotBefore', 'failures', 'metadata', 'resultCode'].includes(field))) {
      throw new Error(`Invalid refresh state entry ${key}`);
    }
    const entry = { status: value.status, lastAttemptAt: timestamp(value.lastAttemptAt, 'lastAttemptAt') };
    const resultCode = validateResultCode(value.status, value.resultCode);
    if (resultCode !== undefined) entry.resultCode = resultCode;
    if (value.checkedAt !== undefined) {
      entry.checkedAt = timestamp(value.checkedAt, 'checkedAt');
      if (entry.checkedAt > entry.lastAttemptAt) throw new Error(`Refresh success follows latest attempt for ${id}`);
    }
    if (value.metadata !== undefined) {
      entry.metadata = validateMetadata(value.metadata);
      if (!entry.checkedAt) throw new Error(`Refresh metadata lacks successful timestamp for ${id}`);
    }
    if (entry.checkedAt && !entry.metadata) throw new Error(`Refresh successful timestamp lacks metadata for ${id}`);
    if (value.status === 'ok') {
      if (!entry.metadata || entry.checkedAt !== entry.lastAttemptAt || value.failures !== undefined || value.retryNotBefore !== undefined) throw new Error(`Invalid successful refresh entry ${id}`);
    } else {
      if (!Number.isSafeInteger(value.failures) || value.failures < 1 || value.failures > 30) throw new Error(`Invalid refresh failure count for ${id}`);
      entry.failures = value.failures;
      entry.retryNotBefore = timestamp(value.retryNotBefore, 'retryNotBefore');
      if (entry.retryNotBefore <= entry.lastAttemptAt) throw new Error(`Invalid refresh retry time for ${id}`);
    }
    normalized.apps[key] = entry;
  }
  return normalized;
}

/** Select a bounded, deterministic cycle of released apps without changing state.
 * New-release IDs should be passed as excludeIds after their separate discovery job.
 * Missing metadata only breaks ties between never-attempted apps, so a failed app
 * moves to the back rather than permanently taking the front of the queue.
 */
export function selectRefreshBatch({ games, state, budget = DEFAULT_REFRESH_BUDGET, now, excludeIds = [] }) {
  const checked = validateRefreshState(state);
  timestamp(now, 'now');
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_REFRESH_BUDGET) throw new Error(`Refresh budget must be between 1 and ${MAX_REFRESH_BUDGET}`);
  if (!Array.isArray(games) || !Array.isArray(excludeIds)) throw new Error('Invalid refresh candidate list');
  const excluded = new Set(excludeIds.map(appId));
  const seen = new Set();
  const candidates = [];
  for (const game of games) {
    if (!isObject(game)) throw new Error('Invalid refresh game');
    const id = appId(game.id);
    if (seen.has(id)) throw new Error(`Duplicate refresh candidate ${id}`);
    seen.add(id);
    const entry = checked.apps[id];
    const metadata = entry?.metadata;
    if (excluded.has(id) || (metadata?.appType !== undefined && metadata.appType !== 0) || (metadata?.releaseStatus ?? game.releaseStatus) !== 'released' || (entry?.retryNotBefore && entry.retryNotBefore > now)) continue;
    const reviews = metadata?.reviews ?? game.reviews;
    const tags = metadata?.tags ?? game.tags ?? game.tagIds;
    const missing = Number(reviews === null || reviews === undefined) + Number(!Array.isArray(tags) || tags.length === 0);
    candidates.push({ id, attempted: entry?.lastAttemptAt ?? '', missing });
  }
  candidates.sort((a, b) => a.attempted.localeCompare(b.attempted) || (!a.attempted ? b.missing - a.missing : 0) || a.id - b.id);
  return candidates.slice(0, budget).map(candidate => candidate.id);
}

/** Apply results atomically, preserving the last known values on every failure.
 * A successful partial response replaces only explicitly supplied fields. Null,
 * zero and an empty list are authoritative; omit unknown fields to retain them.
 */
export function applyRefreshResults(state, { results, now }) {
  const next = validateRefreshState(state);
  timestamp(now, 'now');
  if (!Array.isArray(results)) throw new Error('Invalid Steam refresh results');
  const seen = new Set();
  for (const result of results) {
    if (!isObject(result)) throw new Error('Invalid Steam refresh result');
    const id = appId(result.id);
    if (seen.has(id)) throw new Error(`Duplicate Steam refresh result ${id}`);
    seen.add(id);
    if (!STATUSES.has(result.status)) throw new Error(`Invalid Steam refresh status for ${id}`);
    const resultCode = validateResultCode(result.status, result.resultCode);
    const previous = next.apps[id];
    if (previous?.lastAttemptAt > now) throw new Error(`Refresh clock moved backwards for ${id}`);
    if (result.status === 'ok') {
      const provided = validateMetadata(result.metadata);
      const metadata = { ...previous?.metadata, ...provided };
      next.apps[id] = { status: 'ok', lastAttemptAt: now, checkedAt: now, metadata };
    } else {
      if (result.metadata !== undefined) throw new Error(`Failed Steam refresh cannot replace metadata for ${id}`);
      const failures = Math.min((previous?.failures ?? 0) + 1, 30);
      const retryDays = result.status === 'unavailable' ? 30 : Math.min(2 ** (failures - 1), 30);
      next.apps[id] = {
        status: result.status, lastAttemptAt: now,
        ...(resultCode !== undefined ? { resultCode } : {}),
        ...(previous?.checkedAt ? { checkedAt: previous.checkedAt, metadata: previous.metadata } : {}),
        failures, retryNotBefore: new Date(Date.parse(now) + retryDays * DAY).toISOString()
      };
    }
  }
  return next;
}
