export const GAME_IMAGE_SHARDS = 256;
export const GAME_IMAGE_MAX_BYTES = 256 * 1024;

export const gameImageBucket = id => Math.imul(id, 0x9e3779b1) >>> 24;
export const gameImageFile = bucket => bucket.toString(16).padStart(2, '0') + '.json';
export const validGameImages = value => value?.version === 1 && value.shardCount === GAME_IMAGE_SHARDS
  && typeof value.directory === 'string' && /^game-images\.[a-f0-9]{16}\/$/.test(value.directory);

export function validHeaderPath(value) {
  return typeof value === 'string' && value.length <= 512 && /\.(?:jpg|jpeg|png|webp|avif)$/i.test(value)
    && value.split('/').every(part => part !== '.' && part !== '..' && /^[a-z0-9_.-]+$/i.test(part));
}

export function steamHeaderURL(id, path = 'header.jpg') {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/${validHeaderPath(path) ? path : 'header.jpg'}`;
}

export function parseGameImageShard(text, bucket) {
  const entries = JSON.parse(text);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid game image lookup');
  for (const [id, path] of Object.entries(entries)) {
    if (!/^[1-9]\d*$/.test(id) || Number(id) > 0xffffffff || gameImageBucket(Number(id)) !== bucket || !validHeaderPath(path)) {
      throw new Error('Invalid game image entry');
    }
  }
  return entries;
}

export async function readGameImageResponse(response, bucket) {
  if (!response.ok || !response.body) throw new Error('Game image lookup unavailable');
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > GAME_IMAGE_MAX_BYTES) throw new Error('Game image lookup too large');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return parseGameImageShard(new TextDecoder().decode(bytes), bucket);
}

/** No requests until called; successful and in-flight bucket requests are shared. */
export function createGameImageLoader(descriptor, { manifestURL, fetchImpl = globalThis.fetch } = {}) {
  const cache = new Map();
  const directory = validGameImages(descriptor) ? new URL(descriptor.directory, manifestURL) : null;
  return async id => {
    if (!directory) return steamHeaderURL(id);
    const bucket = gameImageBucket(id);
    if (!cache.has(bucket)) {
      const pending = fetchImpl(new URL(gameImageFile(bucket), directory).href, {
        cache: 'force-cache', credentials: 'same-origin', signal: AbortSignal.timeout(5000)
      }).then(response => readGameImageResponse(response, bucket)).catch(() => { cache.delete(bucket); return {}; });
      cache.set(bucket, pending);
    }
    const entries = await cache.get(bucket);
    return steamHeaderURL(id, entries[id]);
  };
}
