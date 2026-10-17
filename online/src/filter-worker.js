import { prepareCatalog, runQuery } from './query.mjs';
import { decodeBinaryCatalog } from './catalog-binary.mjs';
import { validateBinaryDescriptor, BINARY_MAX_BYTES, COMPRESSED_MAX_BYTES } from './catalog-descriptor.mjs';
import { isCompatibilityDetail } from './compatibility-details.mjs';
import { mergeCatalogPartitions, queryUsesPriority, validateProgressiveDescriptor, PRIORITY_MIN_REVIEWS } from './progressive-catalog.mjs';

const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;

function sameOriginURL(path, base, origin) {
  const url = new URL(path, base);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
    throw new Error('Catalog files must use the same origin as the website.');
  }
  return url;
}

function catalogURL(path, manifestAddress, origin) {
  const url = sameOriginURL(path, manifestAddress, origin);
  const directory = new URL('.', manifestAddress).pathname;
  if (!url.pathname.startsWith(directory) || url.search || url.hash || /%2f|%5c|%2e/i.test(url.pathname)) {
    throw new Error('Catalog files must stay inside the website data directory.');
  }
  return url;
}

function expectedSize(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${label} size in the manifest.`);
  return value;
}

/** Bound streamed downloads and decompression before either can allocate an oversized payload. */
async function readBytes(stream, size, maximum, label) {
  if (!stream) throw new Error(`The ${label} response has no body.`);
  const reader = stream.getReader();
  const limit = size ?? maximum;
  const output = size === undefined ? null : new Uint8Array(size);
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - length) throw new Error(`The ${label} size does not match its manifest or exceeds its limit.`);
      if (output) output.set(value, length);
      else chunks.push(value);
      length += value.byteLength;
    }
    if (size !== undefined && length !== size) throw new Error(`The ${label} size does not match its manifest.`);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (output) return output;
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return joined;
}

async function digest(bytes, expected, cryptoImpl, label) {
  if (typeof expected !== 'string' || expected.length !== 64 || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error(`Missing or invalid ${label} checksum.`);
  if (!cryptoImpl?.subtle) throw new Error('This browser cannot verify the catalog. Use HTTPS or a localhost preview.');
  const hash = await cryptoImpl.subtle.digest('SHA-256', bytes);
  const actual = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== expected.toLowerCase()) throw new Error(`The ${label} checksum does not match. Please retry the download.`);
}

async function fetchResponse(url, fetchImpl, cache, manifestAddress) {
  const response = await fetchImpl(url.href, {
    cache, credentials: 'same-origin', signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Could not download ${url.pathname} (HTTP ${response.status}).`);
  if (response.url) {
    if (new URL(response.url).origin !== url.origin) throw new Error('Catalog download redirected to another origin.');
    catalogURL(response.url, manifestAddress, url.origin);
  }
  return response;
}

async function downloadBytes(url, descriptor, fetchImpl, cryptoImpl, manifestAddress, maximum, label) {
  const response = await fetchResponse(url, fetchImpl, 'force-cache', manifestAddress);
  // Fetch removes HTTP Content-Encoding, whose Content-Length describes the
  // encoded transfer. Bound and verify the fetched archive itself below.
  const contentLength = response.headers.get('content-encoding') ? null : response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > descriptor.bytes) {
    await response.body?.cancel();
    throw new Error(`The ${label} size does not match its manifest.`);
  }
  const bytes = await readBytes(response.body, descriptor.bytes, maximum, label);
  await digest(bytes, descriptor.sha256, cryptoImpl, label);
  return bytes;
}

function decompressor(DecompressionStreamImpl, format) {
  if (typeof DecompressionStreamImpl !== 'function') return null;
  try { return new DecompressionStreamImpl(format); }
  catch { return null; }
}

async function binaryCatalog(descriptor, context) {
  validateBinaryDescriptor(descriptor);
  const { manifestAddress, expectedOrigin, fetchImpl, cryptoImpl, DecompressionStreamImpl } = context;
  const errors = [];
  // Probe support before fetching. Unsupported Brotli must not cost an extra request.
  for (const [key, format] of [['brotli', 'brotli'], ['gzip', 'gzip'], [null, null]]) {
    const stream = key ? decompressor(DecompressionStreamImpl, format) : null;
    if (key && !stream) continue;
    try {
      const payload = key ? descriptor[key] : descriptor;
      const url = catalogURL(payload.file, manifestAddress, expectedOrigin);
      let bytes = await downloadBytes(url, payload, fetchImpl, cryptoImpl, manifestAddress,
        key ? COMPRESSED_MAX_BYTES : BINARY_MAX_BYTES, key ? `${format} binary catalog` : 'binary catalog');
      if (stream) {
        bytes = await readBytes(new Blob([bytes]).stream().pipeThrough(stream), descriptor.bytes, BINARY_MAX_BYTES, 'binary catalog');
        await digest(bytes, descriptor.sha256, cryptoImpl, 'binary catalog');
      }
      const catalog = decodeBinaryCatalog(bytes);
      if (catalog?.version !== 1) throw new Error('This game catalog version is not supported.');
      return { catalog, compression: format ?? 'uncompressed', bytes: payload.bytes };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`The binary catalog and its fallbacks could not load. ${errors.join(' ')}`);
}

async function legacyCatalog(current, context) {
  const { manifestAddress, expectedOrigin, fetchImpl, cryptoImpl, DecompressionStreamImpl } = context;
  if (typeof current.catalog !== 'string' || !current.catalog) throw new Error('The manifest does not identify a catalog.');
  const plainURL = catalogURL(current.catalog, manifestAddress, expectedOrigin);
  expectedSize(current.bytes, BINARY_MAX_BYTES, 'catalog');
  const gzipURL = current.compressedCatalog ? catalogURL(current.compressedCatalog, manifestAddress, expectedOrigin) : null;
  if (gzipURL) expectedSize(current.gzipBytes, COMPRESSED_MAX_BYTES, 'compressed catalog');
  let bytes;
  let compression = 'uncompressed';
  let compressedError;
  const stream = gzipURL ? decompressor(DecompressionStreamImpl, 'gzip') : null;
  if (stream) {
    try {
      const compressed = await downloadBytes(gzipURL, { bytes: current.gzipBytes, sha256: current.gzipSha256 },
        fetchImpl, cryptoImpl, manifestAddress, COMPRESSED_MAX_BYTES, 'compressed catalog');
      bytes = await readBytes(new Blob([compressed]).stream().pipeThrough(stream), current.bytes, BINARY_MAX_BYTES, 'catalog');
      await digest(bytes, current.sha256, cryptoImpl, 'catalog');
      compression = 'gzip';
    } catch (error) {
      compressedError = error;
      bytes = undefined;
    }
  }
  if (!bytes) {
    try {
      bytes = await downloadBytes(plainURL, current, fetchImpl, cryptoImpl, manifestAddress, BINARY_MAX_BYTES, 'catalog');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(compressedError ? `The compressed and fallback catalogs could not load. ${detail}` : detail);
    }
  }
  let catalog;
  try { catalog = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error('The downloaded catalog is not valid JSON.'); }
  return { catalog, compression, bytes: compression === 'gzip' ? current.gzipBytes : current.bytes };
}

/** Download a pinned catalog, keeping both decompression and parsing off the UI thread. */
export async function loadCatalog(manifestURL, {
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  DecompressionStreamImpl = globalThis.DecompressionStream,
  origin = globalThis.location?.origin,
  minReviews = 0,
  plan = null,
} = {}) {
  const manifestAddress = new URL(manifestURL, globalThis.location?.href);
  const expectedOrigin = origin ?? manifestAddress.origin;
  sameOriginURL(manifestAddress, manifestAddress, expectedOrigin);
  let manifest = null;
  if (!plan) {
    const response = await fetchResponse(manifestAddress, fetchImpl, 'no-cache', manifestAddress);
    const manifestBytes = await readBytes(response.body, undefined, MANIFEST_MAX_BYTES, 'manifest');
    try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); }
    catch { throw new Error('The catalog manifest is not valid JSON.'); }
    if (manifest?.version !== 1 || !manifest.current) throw new Error('This catalog manifest version is not supported.');
    if (manifest.current.progressive !== undefined) {
      plan = validateProgressiveDescriptor(manifest.current.progressive, manifest.current.binary?.sha256);
    }
  }
  const context = { manifestAddress, expectedOrigin, fetchImpl, cryptoImpl, DecompressionStreamImpl };
  if (plan) {
    validateProgressiveDescriptor(plan, plan.snapshot);
    plan = { ...plan, manifestURL: manifestAddress.href };
    const partial = Number(minReviews) >= PRIORITY_MIN_REVIEWS;
    const names = partial ? ['priority'] : ['priority', 'remainder'];
    const parts = await Promise.all(names.map(name => binaryCatalog(plan[name], context)));
    const catalog = partial ? parts[0].catalog : mergeCatalogPartitions(parts[0].catalog, parts[1].catalog);
    const files = Object.fromEntries(names.map((name, i) => [name, { compression: parts[i].compression, bytes: parts[i].bytes }]));
    return { catalog, manifest, compression: parts[0].compression, bytes: parts.reduce((sum, part) => sum + part.bytes, 0),
      progressive: { partial, plan, files } };
  }
  const current = manifest.current;
  const { catalog, compression, bytes } = Object.hasOwn(current, 'binary')
    ? await binaryCatalog(current.binary, context)
    : await legacyCatalog(current, context);
  if (catalog?.version !== 1) throw new Error('This game catalog version is not supported.');
  return { catalog, manifest, compression, bytes };
}

let prepared = null, partial = false;
let initialization = 0;

// Guard permits importing loadCatalog in Node tests without emulating a worker.
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', async event => {
    const message = event.data ?? {};
    let token = initialization;
    try {
      if (message.type === 'init') {
        token = ++initialization;
        prepared = null;
        const loaded = message.catalog
          ? { catalog: message.catalog, manifest: null }
          : await loadCatalog(message.plan?.manifestURL ?? message.manifestURL, {
            // Older cached apps do not opt into partial loading and need a full index.
            plan: message.plan, minReviews: message.mode === 'full' ? 0 : message.minReviews ?? 0,
          });
        if (token !== initialization) return;
        const { catalog, manifest } = loaded;
        if (catalog?.version !== 1) throw new Error('This game catalog version is not supported.');
        prepared = prepareCatalog(catalog);
        partial = loaded.progressive?.partial === true;
        const stats = loaded.progressive?.plan.statistics;
        if (stats) {
          if (stats.tagCounts.length !== prepared.tags.length || Object.keys(stats.languageCounts).length !== prepared.languages.length ||
              prepared.languages.some(language => !Object.hasOwn(stats.languageCounts, language.id))) throw new Error('Catalog picker dictionaries do not match the manifest.');
          if (partial && prepared.games.some(row => row.reviews === null || row.reviews < PRIORITY_MIN_REVIEWS)) throw new Error('The initial catalog contains games below its review threshold.');
          if (!partial && (prepared.games.length !== stats.gameCount || prepared.knownTagCount !== stats.knownTagCount ||
              prepared.tagCounts.some((count, id) => count !== stats.tagCounts[id]) ||
              prepared.languages.some(language => prepared.languageCounts[language.id] !== stats.languageCounts[language.id]))) throw new Error('The complete catalog does not match the manifest statistics.');
        }
        self.postMessage({
          type: 'ready', gameCount: stats?.gameCount ?? prepared.games.length, features: prepared.features,
          compatibilityDetails: catalog.features.filter(feature => isCompatibilityDetail(feature)),
          tags: prepared.tags, tagCounts: stats?.tagCounts ?? prepared.tagCounts, knownTagCount: stats?.knownTagCount ?? prepared.knownTagCount,
          languages: prepared.languages, languageCounts: stats?.languageCounts ?? prepared.languageCounts,
          importedAt: catalog.importedAt ?? manifest?.importedAt ?? null,
          sources: catalog.sources ?? manifest?.sources ?? {},
          coverage: catalog.coverage ?? manifest?.coverage ?? {},
          refresh: catalog.refresh ?? manifest?.refresh ?? null,
          fixture: catalog.fixture === true || manifest?.fixture === true,
          catalogHash: manifest?.current?.sha256 ?? null,
          catalogCompression: loaded.compression ?? null,
          catalogBytes: loaded.bytes ?? null,
          progressive: loaded.progressive ?? null,
          gameImages: manifest?.gameImages ?? null,
        });
      } else if (message.type === 'query') {
        if (!prepared) throw new Error('The game catalog has not loaded yet.');
        if (partial && !queryUsesPriority(message.query, prepared)) throw new Error('This filter needs the complete catalog.');
        self.postMessage({ type: 'result', requestId: message.requestId, result: runQuery(prepared, message.query) });
      } else {
        throw new Error(`Unknown worker message: ${String(message.type)}.`);
      }
    } catch (error) {
      if (token !== initialization) return;
      self.postMessage({
        type: 'error', requestId: message.requestId, phase: message.type,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
