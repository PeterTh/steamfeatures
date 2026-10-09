// Storefront protobufs: https://github.com/SteamTracking/Protobufs/tree/master/webui
// These anonymous storefront methods are not a documented, stable public API.
// Live validation, 2026-10-09: GetItems accepts 100 IDs; Query accepts 1,000
// results; release_date_type=1 constrains steam_release_date. Omitting that
// enum silently disables the date window. No undocumented sort enum is used.
export const STEAM_CONTEXT = Object.freeze({ language: 'english', country_code: 'US' });
export const STEAM_DATA_REQUEST = Object.freeze({
  include_release: true,
  include_basic_info: true,
  include_reviews: true,
  include_tag_count: 100,
  include_best_purchase_option: false
});

const API_BASE = 'https://api.steampowered.com/';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export class SteamRequestBudgetError extends Error {
  constructor(limit) {
    super(`Steam request budget exhausted (${limit} attempts, including retries)`);
    this.name = 'SteamRequestBudgetError';
    this.steamRequestFailure = true;
    this.requestBudgetExceeded = true;
  }
}

export class SteamHttpError extends Error {
  constructor(status, retryAfterMs = null) {
    super(`Steam API: HTTP ${status}`);
    this.name = 'SteamHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.steamRequestFailure = true;
    this.rateLimited = status === 429;
  }
}

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

function storeItems(response, method, { allowEmpty = false } = {}) {
  if (!Array.isArray(response.store_items)) {
    if (allowEmpty && response.store_items === undefined) return [];
    throw new Error(`Steam ${method}: missing store_items`);
  }
  for (const item of response.store_items) {
    const id = item?.id ?? item?.appid;
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff) {
      throw new Error(`Steam ${method}: malformed store item`);
    }
  }
  return response.store_items;
}

/** A serial, rate-limited client. The request budget counts HTTP attempts,
 * including retries, across all methods. The caller owns paging and persistence.
 * Deliberately returns raw items, including unavailable/failed item results.
 */
export function createSteamClient({
  fetchImpl = globalThis.fetch,
  sleep = pause,
  now = Date.now,
  spacingMs = 2000,
  maxRequests = 100,
  maxRetries = 2,
  timeoutMs = 30000,
  maxRetryDelayMs = 120000,
  recordResponse
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof now !== 'function') {
    throw new Error('fetchImpl, sleep and now must be functions');
  }
  if (recordResponse !== undefined && typeof recordResponse !== 'function') throw new Error('recordResponse must be a function');
  integer(spacingMs, 'spacingMs', 0, 60000);
  integer(maxRequests, 'maxRequests', 1, 10000);
  integer(maxRetries, 'maxRetries', 0, 5);
  integer(timeoutMs, 'timeoutMs', 1, 180000);
  integer(maxRetryDelayMs, 'maxRetryDelayMs', 1000, 3600000);
  let queue = Promise.resolve();
  let nextRequestAt = 0;
  let cooldownError = null;
  const counters = { requests: 0, retries: 0 };

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  async function request(method, input) {
    const url = new URL(`${method}/v1/`, API_BASE);
    url.searchParams.set('input_json', JSON.stringify(input));
    for (let attempt = 0; ; attempt++) {
      if (cooldownError) throw cooldownError;
      if (counters.requests >= maxRequests) throw new SteamRequestBudgetError(maxRequests);
      const delay = nextRequestAt - now();
      if (delay > 0) await sleep(delay);
      counters.requests++;
      if (attempt > 0) counters.retries++;
      let retryable = false;
      async function record(body, response) {
        if (!recordResponse) return;
        try {
          await recordResponse({ method, input, body, status: response.status, resultCode: response.headers.get('x-eresult') });
        } catch (error) {
          // Disk failures must stop the run, never cause network retries or
          // checkpoint success for a response that has not been preserved.
          retryable = false;
          throw new Error(`Could not archive Steam ${method} response: ${error.message}`, { cause: error });
        }
      }
      try {
        let response;
        try {
          response = await fetchImpl(url, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              'User-Agent': 'SteamFeatureAtlas/1.0 (+https://github.com/peterth/steamfeatures)'
            },
            signal: AbortSignal.timeout(timeoutMs)
          });
        } catch (error) {
          retryable = true;
          error.steamRequestFailure = true;
          throw error;
        }
        if (!response.ok) {
          if (recordResponse) {
            let body;
            // Keep structured API errors too; an HTML error page is not game data.
            try { body = await response.json(); } catch { /* HTTP status still determines retry behavior. */ }
            if (body !== undefined) await record(body, response);
          } else await response.body?.cancel();
          retryable = response.status === 429 || response.status >= 500;
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
          throw new SteamHttpError(response.status, retryAfterMs);
        }
        const resultCode = response.headers.get('x-eresult');
        let body;
        try { body = await response.json(); }
        catch (error) {
          if (['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)) {
            retryable = true;
            error.steamRequestFailure = true;
          }
          throw error;
        }
        // Archive before interpreting anything: new fields and schema failures
        // must remain available for offline inspection and future importers.
        await record(body, response);
        if (resultCode && resultCode !== '1') throw new Error(`Steam ${method}: result ${resultCode}`);
        if (!body?.response || typeof body.response !== 'object' || Array.isArray(body.response)) {
          throw new Error(`Steam ${method}: malformed response envelope`);
        }
        return body.response;
      } catch (error) {
        if (retryable && error.retryAfterMs !== null && error.retryAfterMs !== undefined) {
          nextRequestAt = Math.max(nextRequestAt, now() + error.retryAfterMs);
          if (error.retryAfterMs > maxRetryDelayMs) cooldownError = error;
        }
        if (!retryable || attempt >= maxRetries) throw error;
        const backoffMs = Math.max(5000 * (2 ** attempt), error.retryAfterMs ?? 0);
        // A very long Retry-After stops this run instead of retrying prematurely.
        if (backoffMs > maxRetryDelayMs) throw error;
        nextRequestAt = Math.max(nextRequestAt, now() + backoffMs);
      } finally {
        nextRequestAt = Math.max(nextRequestAt, now() + spacingMs);
      }
    }
  }

  return {
    get stats() { return { ...counters }; },

    async getItems(appids) {
      if (!Array.isArray(appids)) throw new Error('appids must be an array');
      const unique = [...new Set(appids.map(id => integer(id, 'appid', 1, 0xffffffff)))];
      return enqueue(async () => {
        const items = [];
        for (let start = 0; start < unique.length; start += 100) {
          const batch = unique.slice(start, start + 100);
          const response = await request('IStoreBrowseService/GetItems', {
            ids: batch.map(appid => ({ appid })),
            context: STEAM_CONTEXT,
            data_request: STEAM_DATA_REQUEST
          });
          const returned = storeItems(response, 'GetItems');
          const seen = new Set();
          for (const item of returned) {
            const id = item.id ?? item.appid;
            if (!batch.includes(id) || seen.has(id)) throw new Error('Steam GetItems returned an unexpected or duplicate ID');
            seen.add(id);
          }
          items.push(...returned);
        }
        return items;
      });
    },

    async queryReleased({ since, until, start = 0, count = 1000 } = {}) {
      integer(start, 'start', 0, 0x7fffffff);
      integer(count, 'count', 1, 1000);
      const filters = { released_only: true, type_filters: { include_games: true } };
      if (since !== undefined || until !== undefined) {
        integer(since, 'since', 0, 0x7fffffff);
        integer(until, 'until', 1, 0x7fffffff);
        if (since > until) throw new Error('since must not exceed until');
        filters.release_date_filter = { release_date_type: 1, start_date: since, end_date: until };
      }
      return enqueue(async () => {
        const response = await request('IStoreQueryService/Query', {
          query_name: 'SteamFeatureAtlas',
          query: { start, count, filters },
          context: STEAM_CONTEXT,
          data_request: STEAM_DATA_REQUEST
        });
        const total = response.metadata?.total_matching_records;
        integer(total, 'Steam total_matching_records', 0, 0x7fffffff);
        const resultStart = response.metadata.start ?? 0;
        const resultCount = response.metadata.count ?? 0;
        integer(resultStart, 'Steam start', 0, 0x7fffffff);
        integer(resultCount, 'Steam count', 0, count);
        if (resultStart !== start) throw new Error('Steam Query returned an unexpected page offset');
        const items = storeItems(response, 'Query', { allowEmpty: resultCount === 0 });
        if (items.length !== resultCount) throw new Error('Steam Query count does not match its items');
        if (!resultCount && start < total) throw new Error('Steam Query returned an empty unfinished page');
        return { items, total, start: resultStart, count: resultCount };
      });
    },

    async getTagList() {
      return enqueue(async () => {
        const response = await request('IStoreService/GetTagList', { language: STEAM_CONTEXT.language });
        if (!Array.isArray(response.tags) || !response.tags.length) throw new Error('Steam GetTagList: missing tags');
        const ids = new Set();
        for (const tag of response.tags) {
          integer(tag?.tagid, 'Steam tagid', 1, 0xffffffff);
          if (typeof tag.name !== 'string' || !tag.name.trim() || ids.has(tag.tagid)) {
            throw new Error('Steam GetTagList: invalid or duplicate tag');
          }
          ids.add(tag.tagid);
        }
        return response.tags;
      });
    }
  };
}
