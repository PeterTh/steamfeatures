import { readSteamResponseArchive } from './steam-archive.mjs';

/** Fill missing checkpoint result codes from archived Steam responses.
 * Never infer a denial from an empty field, a missing response, or HTTP failure.
 * The caller supplies an already validated checkpoint; timestamps stay intact.
 */
export async function recoverArchivedDenials(state, directory) {
  const candidates = new Set(Object.keys(state.apps).filter(id => state.apps[id].status === 'unavailable' && state.apps[id].resultCode === undefined));
  if (!candidates.size) return state;
  const latest = new Map();
  for await (const record of readSteamResponseArchive(directory)) {
    if (record.method !== 'IStoreBrowseService/GetItems' || record.status < 200 || record.status >= 300 || !Number.isInteger(record.status) ||
      (record.resultCode != null && String(record.resultCode) !== '1') || !Array.isArray(record.input.ids) || !Array.isArray(record.body?.response?.store_items)) continue;
    const requested = new Set(record.input.ids.map(id => id.appid));
    for (const item of record.body.response.store_items) {
      const id = item?.id ?? item?.appid, key = String(id);
      if (!candidates.has(key) || !requested.has(id) || !Number.isSafeInteger(item.success) || item.success < 1 ||
        record.fetchedAt < state.apps[key].lastAttemptAt) continue;
      const previous = latest.get(key);
      // Ambiguous simultaneous responses must not promote an unproven denial.
      if (!previous || record.fetchedAt > previous.at) latest.set(key, { at: record.fetchedAt, code: item.success });
      else if (record.fetchedAt === previous.at && item.success !== previous.code) latest.set(key, { at: record.fetchedAt, code: null });
    }
  }
  for (const [id, observation] of latest) if (observation.code === 15) state.apps[id].resultCode = 15;
  return state;
}
