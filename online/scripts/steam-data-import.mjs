import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SteamDataStore, restoreSteamData } from './steam-data.mjs';
import { normalizeSteamEnrichment } from './steam-enrichment.mjs';
import { normalizeStoreItem } from './steam-refresh.mjs';
import { readSteamResponseArchive } from './steam-archive.mjs';
import { STEAM_DATA_REQUEST } from './steam-client.mjs';
import { headerImagePath } from './game-images.mjs';
import { normalizeGameCredits } from './game-credits.mjs';

export async function openSteamData({ filename, previous, journalDirectory, requireExisting = false, state, checkpointOnly = false }) {
  if (requireExisting) await stat(filename);
  await mkdir(dirname(filename), { recursive: true });
  const store = new SteamDataStore(filename);
  try {
    // Explicit offline finalization uses the collected snapshot as-is. Replaying
    // a deployment or discovery journal can expand its scope or rewrite times.
    if (checkpointOnly) return store;
    if (previous?.sourcePath && store.setting('restoredArchive') !== previous.descriptor.sha256) await restoreSteamData(store, previous.sourcePath, previous.descriptor, { state });
    // Replay only newer successful requests, including a run interrupted before
    // checkpointing. The older request profile cannot clear newly collected fields.
    for await (const envelope of readSteamResponseArchive(journalDirectory)) {
      if ((envelope.status !== undefined && (envelope.status < 200 || envelope.status >= 300)) ||
          (envelope.resultCode != null && String(envelope.resultCode) !== '1')) continue;
      if (envelope.method === 'IStoreService/GetTagList') {
        if (!store.setting('tags') && Array.isArray(envelope.body?.response?.tags)) store.setting('tags', envelope.body.response.tags);
        continue;
      }
      if (!['IStoreBrowseService/GetItems', 'IStoreQueryService/Query'].includes(envelope.method)) continue;
      store.transaction(() => {
        for (const item of envelope.body?.response?.store_items ?? []) {
          const id = item.id ?? item.appid;
          const current = store.get(id);
          if (current?.store_checked && current.store_checked >= envelope.fetchedAt) continue;
          store.putStore(id, item, { checkedAt: envelope.fetchedAt, request: envelope.input?.data_request });
        }
      });
    }
    return store;
  } catch (error) { store.close(); throw error; }
}

/** Keep daily StoreBrowse and PICS observations together, without a second crawl. */
export function withSteamData(client, picsClient, store) {
  async function persist(items, requested) {
    const checkedAt = new Date().toISOString();
    const byId = new Map(items.map(item => [item.id ?? item.appid, item]));
    store.transaction(() => { for (const id of requested) store.putStore(id, byId.get(id) ?? { id, success: 2 }, { checkedAt, request: STEAM_DATA_REQUEST }); });
    for (let offset = 0; offset < requested.length; offset += 100) {
      const batch = requested.slice(offset, offset + 100);
      const response = await picsClient.getItems(batch);
      store.transaction(() => { for (const id of batch) store.putAppInfo(id, response.apps[id]?.appinfo,
        { result: response.apps[id]?.appinfo ? 1 : response.unknownApps?.includes(id) ? 15 : 2 }); });
    }
  }
  return {
    get stats() { return client.stats; },
    async getTagList() { const tags = await client.getTagList(); store.setting('tags', tags); return tags; },
    async getItems(ids) { const items = await client.getItems(ids); await persist(items, ids); return items; },
    async queryReleased(input) { const page = await client.queryReleased(input); await persist(page.items, page.items.map(item => item.id ?? item.appid)); return page; }
  };
}

export function projectSteamData(store, state, features, { imagePaths, credits } = {}) {
  const registry = new Map(features.map(feature => [feature.id, feature]));
  const tagNames = new Map((store.setting('tags') ?? []).map(tag => [Number(tag.tagid), tag.name]));
  const projections = new Map();
  const aliases = new Map(features.flatMap(feature => feature.steamIds.map(id => [id, feature.id])));
  for (const row of store.rows()) {
    if (credits) credits.set(row.id, normalizeGameCredits(row));
    const imagePath = imagePaths && headerImagePath(row);
    if (imagePath && imagePath !== 'header.jpg') imagePaths.set(row.id, imagePath);
    const previous = state.apps[row.id];
    if (row.store_checked && (!previous || row.store_checked > previous.lastAttemptAt)) {
      if (row.store_result === 1) {
        const { metadata } = normalizeStoreItem(row.store, { features, tagNames });
        state.apps[row.id] = { status: 'ok', lastAttemptAt: row.store_checked, checkedAt: row.store_checked, metadata: { ...previous?.metadata, ...metadata } };
      } else if (row.store_result != null) {
        const failures = Math.min((previous?.failures ?? 0) + 1, 30);
        const days = row.store_result === 15 ? 30 : Math.min(2 ** (failures - 1), 30);
        state.apps[row.id] = { status: row.store_result === 15 ? 'unavailable' : 'failed', resultCode: row.store_result,
          lastAttemptAt: row.store_checked, failures, retryNotBefore: new Date(Date.parse(row.store_checked) + days * 86400000).toISOString(),
          ...(previous?.checkedAt ? { checkedAt: previous.checkedAt, metadata: previous.metadata } : {}) };
      }
    }
    const projection = normalizeSteamEnrichment(row, registry);
    // Successful public appinfo can still supply ordinary advertised categories
    // and a title when the storefront itself is unavailable.
    const common = row.appinfo?.common;
    if ((row.store_result !== 1 || row.store?.visible === false) && common) {
      if (typeof common.name === 'string' && common.name.trim()) projection.name = common.name.trim();
      if (common.type && common.type.toLowerCase() !== 'game') projection.nonGame = true;
      if (common.category && typeof common.category === 'object') {
        projection.baseFeatureIds = [...new Set(Object.entries(common.category).filter(([, value]) => ['1', 'true', 1, true].includes(value))
          .map(([key]) => aliases.get(Number(key.replace(/^category_/, '')))).filter(id => id !== undefined))].sort((a, b) => a - b);
      }
    }
    projections.set(row.id, projection);
  }
  const existing = new Set(features.map(feature => feature.id));
  features.push(...[...registry.values()].filter(feature => !existing.has(feature.id)).sort((a, b) => a.key.localeCompare(b.key)));
  return projections;
}

export function mergeSteamEnrichment(games, projections, features) {
  const extraIds = new Set(features.filter(feature => feature.knowledgeGroup).map(feature => feature.id));
  return games.flatMap(game => {
    const extra = projections.get(game.id);
    if (!extra) return [game];
    if (extra.nonGame) return [];
    const { featureIds, baseFeatureIds, knownFeatureGroups, nonGame, ...fields } = extra;
    // A complete observed section can remove a previous positive feature.
    const base = (baseFeatureIds ?? game.featureIds).filter(id => !extraIds.has(id));
    const merged = { ...game, ...fields, featureIds: [...new Set([...base, ...featureIds])].sort((a, b) => a - b),
      ...(baseFeatureIds ? { featureDataKnown: true } : {}), knownFeatureGroups };
    // Undefined projections clear stale optional data, but must be absent from
    // the browser catalog: binary dictionaries encode JSON values only.
    for (const [key, value] of Object.entries(fields)) if (value === undefined) delete merged[key];
    return [merged];
  });
}
