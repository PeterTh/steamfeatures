import { createRefreshState, validateRefreshState, selectRefreshBatch, applyRefreshResults, isSteamDenied, DEFAULT_REFRESH_BUDGET } from './refresh-state.mjs';
import { OMITTED_CATEGORY_IDS, integerOrNull } from './normalize.mjs';

const DAY = 86400000;
const iso = value => new Date(value).toISOString();
const seconds = value => Math.floor(Date.parse(value) / 1000);

/** Normalize only fields actually returned by a successful Steam response. */
export function normalizeStoreItem(item, { features, tagNames }) {
  // GetItems failure records can keep the requested StoreItem.id while appid
  // is the protobuf default (0). Use the same identity as the API client.
  const id = integerOrNull(item?.id ?? item?.appid, 0xffffffff);
  if (!id) throw new Error('Steam returned an invalid app ID');
  if (!Number.isSafeInteger(item.success) || item.success < 1 || item.success > 0xffffffff) throw new Error(`Steam returned an invalid result code on ${id}`);
  if (item.success !== 1) return { id, status: item.success === 15 ? 'unavailable' : 'failed', resultCode: item.success };
  const appType = integerOrNull(item.type ?? 0);
  if (appType === null) throw new Error(`Invalid Steam app type on ${id}`);
  const metadata = { appType };
  if (typeof item.name === 'string' && item.name.trim()) metadata.name = item.name.trim();
  if (appType !== 0) return { id, status: 'ok', metadata };
  const aliases = new Map(features.flatMap(feature => feature.steamIds.map(alias => [alias, feature.id])));
  if ((item.categories && typeof item.categories === 'object') || item.visible === true) {
    const ids = ['supported_player_categoryids', 'feature_categoryids', 'controller_categoryids'].flatMap(key => {
      const values = item.categories?.[key] ?? [];
      if (!Array.isArray(values) || values.some(value => integerOrNull(value) === null)) throw new Error(`Invalid Steam categories on ${id}`);
      return values;
    });
    const unknown = ids.filter(value => !aliases.has(value) && !OMITTED_CATEGORY_IDS.has(value));
    if (unknown.length) throw new Error(`Unclassified Steam feature IDs ${unknown.join(', ')} on ${id}`);
    metadata.featureIds = [...new Set(ids.filter(value => aliases.has(value) && !OMITTED_CATEGORY_IDS.has(value)).map(value => aliases.get(value)))].sort((a, b) => a - b);
    metadata.featureDataKnown = true;
  }
  const summary = item.reviews?.summary_filtered;
  if (summary && typeof summary === 'object') {
    const reviews = integerOrNull(summary.review_count ?? 0);
    const positivePercent = integerOrNull(summary.percent_positive ?? 0, 100);
    if (reviews === null || positivePercent === null) throw new Error(`Invalid Steam review summary on ${id}`);
    metadata.reviews = reviews;
    metadata.positivePercent = reviews ? positivePercent : null;
  }
  if (Array.isArray(item.tagids) || Array.isArray(item.tags) || item.visible === true) {
    // Protobuf JSON may omit an empty repeated field. The caller always requests tags.
    const ids = item.tagids ?? item.tags?.map(tag => tag.tagid) ?? [];
    const tags = ids.map(tag => {
      if (!Number.isSafeInteger(tag) || !tagNames.has(tag)) throw new Error(`Unknown Steam tag ${tag} on ${id}`);
      return tagNames.get(tag);
    });
    metadata.tags = [...new Set(tags)].sort();
    metadata.tagDataKnown = true;
  }
  if (item.release && typeof item.release === 'object') {
    const release = item.release;
    metadata.releaseStatus = release.is_coming_soon || item.is_coming_soon ? 'upcoming' : 'released';
    metadata.earlyAccess = release.is_early_access === true || item.is_early_access === true;
    const timestamp = integerOrNull(release.steam_release_date);
    metadata.releaseISO = timestamp ? iso(timestamp * 1000).slice(0, 10) : null;
    metadata.releaseDate = release.coming_soon_display || release.custom_release_date_message || metadata.releaseISO;
  }
  return { id, status: 'ok', metadata };
}

/** Overlay the durable Steam cache on the bulk seed; never overwrite it with older bulk values. */
export function mergeSteamState(seedGames, seedTags, state) {
  const games = new Map(seedGames.map(game => [game.id, { ...game }]));
  const tagsByApp = new Map(seedTags);
  for (const [key, entry] of Object.entries(state.apps)) {
    const id = Number(key), metadata = entry.metadata;
    if (!metadata && !games.has(id)) continue;
    if (metadata && metadata.appType !== 0) { games.delete(id); tagsByApp.delete(id); continue; }
    const { appType, tags, ...fields } = metadata ?? {};
    const previous = games.get(id) ?? {
      id, name: `Steam app ${id}`, featureIds: [], featureDataKnown: false,
      reviews: null, positivePercent: null, releaseDate: null, releaseISO: null,
      releaseStatus: 'unknown', earlyAccess: null, genres: []
    };
    const game = { ...previous, ...fields, ...(metadata ? { metadataUpdatedAt: entry.checkedAt } : {}) };
    if (metadata && Object.hasOwn(metadata, 'reviews')) game.reviewSource = 'steam';
    delete game.steamLookupStatus;
    delete game.steamLookupResultCode;
    delete game.steamLookupAttemptedAt;
    if (isSteamDenied(entry)) {
      game.steamLookupStatus = 'unavailable';
      game.steamLookupResultCode = 15;
      game.steamLookupAttemptedAt = entry.lastAttemptAt;
    }
    if (Array.isArray(tags)) tagsByApp.set(id, tags);
    games.set(id, game);
  }
  return { games: [...games.values()].sort((a, b) => a.id - b.id), tagsByApp };
}

export function auditSteamCoverage(games, state) {
  const released = games.filter(game => game.releaseStatus === 'released');
  const denied = [], unresolved = [];
  let checked = 0;
  for (const game of released) {
    const entry = state.apps[game.id], metadata = entry?.metadata;
    const details = { id: game.id, name: game.name, status: entry?.status ?? 'not-checked', ...(entry?.resultCode !== undefined ? { resultCode: entry.resultCode } : {}) };
    if (isSteamDenied(entry)) denied.push(details);
    else if (entry?.status !== 'ok' || metadata?.appType === undefined || (metadata.appType === 0 && (!metadata.tagDataKnown || !Number.isSafeInteger(metadata.reviews) || !metadata.featureDataKnown))) unresolved.push(details);
    else checked++;
  }
  return { released: released.length, checked, denied, unresolved };
}

/** Incremental discovery plus a fair bounded cycle. Full enumeration is bootstrap-only. */
export async function refreshSteam({ games, features, state = createRefreshState(), client, now = new Date().toISOString(), budget = DEFAULT_REFRESH_BUDGET, bootstrap = false, checkpoint = async () => {}, maxDiscoveryPages = 5 }) {
  state = validateRefreshState(state);
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 5000) throw new Error('Steam refresh limit must be between 1 and 5000');
  if (!bootstrap && !state.bootstrapComplete) throw new Error('Steam bootstrap is required before incremental publication; run --bootstrap-steam');
  const tags = await client.getTagList();
  const tagNames = new Map(tags.map(tag => [Number(tag.tagid), tag.name]));
  if (!tagNames.size || [...tagNames.values()].some(name => typeof name !== 'string' || !name.trim())) throw new Error('Invalid Steam tag dictionary');
  const seen = new Set();
  const today = now.slice(0, 10);
  if (!bootstrap && state.rotation?.date !== today) state.rotation = { date: today, attempted: 0 };
  let discovered = 0, refreshed = 0, failures = 0;
  function apply(items, expectedIds) {
    const results = items.map(item => normalizeStoreItem(item, { features, tagNames }));
    const returned = new Set(results.map(result => result.id));
    if (expectedIds) {
      const expected = new Set(expectedIds);
      if (results.some(result => !expected.has(result.id))) throw new Error('Steam returned an unrequested app');
      for (const id of expectedIds) if (!returned.has(id)) results.push({ id, status: 'failed' });
    }
    for (const result of results) seen.add(result.id);
    failures += results.filter(result => result.status !== 'ok').length;
    state = applyRefreshResults(state, { results, now });
  }
  async function refreshIds(ids) {
    if (bootstrap && ids.length) console.log(`Steam bootstrap: checking ${ids.length} remaining entries by app ID`);
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      if (!bootstrap) state.rotation.attempted += batch.length;
      try { apply(await client.getItems(batch), batch); }
      catch (error) {
        // Network failures preserve cached metadata and advance attempts fairly.
        // Data/schema validation errors must stop publication rather than be hidden.
        if (!error.steamRequestFailure) throw error;
        state = applyRefreshResults(state, { results: batch.map(id => ({ id, status: 'failed' })), now });
        failures += batch.length;
        if (error.rateLimited || error.requestBudgetExceeded || error.status === 401 || error.status === 403) { await checkpoint(state); throw error; }
      }
      refreshed += batch.length;
      if (refreshed % 1000 === 0 || refreshed === ids.length) {
        if (bootstrap) console.log(`Steam bootstrap: ${refreshed}/${ids.length} remaining entries checked`);
        await checkpoint(state);
      }
    }
    await checkpoint(state);
  }
  if (bootstrap) {
    const cursor = state.bootstrapCursor ?? { nextStart: 0, queryComplete: false };
    while (!cursor.queryComplete) {
      const page = await client.queryReleased({ start: cursor.nextStart, count: 1000 });
      apply(page.items);
      discovered += page.items.length;
      cursor.nextStart += page.items.length;
      cursor.queryComplete = page.items.length === 0 || cursor.nextStart >= page.total;
      state.bootstrapCursor = { ...cursor };
      console.log(`Steam bootstrap: ${cursor.nextStart}/${page.total} listed games`);
      await checkpoint(state);
    }
    // Exact-ID lookup covers delisted/regional records and classifies stray playtests.
    const candidates = mergeSteamState(games, new Map(), state).games;
    const pending = candidates.filter(game => {
      const entry = state.apps[game.id], metadata = entry?.metadata;
      return game.releaseStatus === 'released' && !isSteamDenied(entry) && (!entry || entry.status !== 'ok' ||
        (entry.status === 'ok' && metadata.appType === 0 && (!metadata.tagDataKnown || !Number.isSafeInteger(metadata.reviews) || !metadata.featureDataKnown)));
    }).map(game => game.id);
    await refreshIds(pending);
    state.lastDiscoveryAt = now;
    // Never checkpoint a completed bootstrap before its strict audit passes.
    state.bootstrapComplete = auditSteamCoverage(mergeSteamState(games, new Map(), state).games, state).unresolved.length === 0;
    state.rotation = { date: today, attempted: budget };
    // Importer clears this only after the complete catalog passes its publication audit.
  } else {
    // An overlapping window catches delayed listings and jobs missed for several days.
    const window = state.discovery ?? { since: iso(Date.parse(state.lastDiscoveryAt ?? now) - 14 * DAY), until: now, nextStart: 0 };
    const discoveryDue = state.discovery || state.lastDiscoveryAt?.slice(0, 10) !== today;
    for (let pageNumber = 0; discoveryDue && pageNumber < maxDiscoveryPages; pageNumber++) {
      const page = await client.queryReleased({ since: seconds(window.since), until: seconds(window.until), start: window.nextStart, count: 1000 });
      apply(page.items);
      discovered += page.items.length;
      window.nextStart += page.items.length;
      if (page.items.length === 0 || window.nextStart >= page.total) {
        state.lastDiscoveryAt = window.until;
        delete state.discovery;
        break;
      }
      state.discovery = { ...window };
    }
    const candidates = mergeSteamState(games, new Map(), state).games;
    const remaining = Math.max(0, budget - state.rotation.attempted);
    if (remaining) await refreshIds(selectRefreshBatch({ games: candidates, state, budget: remaining, now, excludeIds: [...seen] }));
  }
  await checkpoint(state);
  return { state, summary: { enabled: true, existingLimit: budget, lastRunAt: now, bootstrapComplete: state.bootstrapComplete, checkedGames: Object.values(state.apps).filter(entry => entry.metadata?.appType === 0).length, discovered, refreshed, failures, requests: client.stats?.requests ?? null } };
}
