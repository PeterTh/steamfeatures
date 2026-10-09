import { prepareCatalog, runQuery } from './query.mjs';

function sameOriginURL(path, base, origin) {
  const url = new URL(path, base);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
    throw new Error('Catalog files must use the same origin as the website.');
  }
  return url;
}

async function digest(bytes, expected, cryptoImpl, label) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error(`Missing or invalid ${label} checksum.`);
  if (!cryptoImpl?.subtle) throw new Error('This browser cannot verify the catalog. Use HTTPS or a localhost preview.');
  const hash = await cryptoImpl.subtle.digest('SHA-256', bytes);
  const actual = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== expected.toLowerCase()) throw new Error(`The ${label} checksum does not match. Please retry the download.`);
}

async function fetchResponse(url, fetchImpl, cache) {
  const response = await fetchImpl(url.href, {
    cache, credentials: 'same-origin', signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Could not download ${url.pathname} (HTTP ${response.status}).`);
  if (response.url && new URL(response.url).origin !== url.origin) throw new Error('Catalog download redirected to another origin.');
  return response;
}

/** Download a pinned catalog, keeping both decompression and parsing off the UI thread. */
export async function loadCatalog(manifestURL, {
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  DecompressionStreamImpl = globalThis.DecompressionStream,
  origin = globalThis.location?.origin,
} = {}) {
  const manifestAddress = new URL(manifestURL, globalThis.location?.href);
  const expectedOrigin = origin ?? manifestAddress.origin;
  sameOriginURL(manifestAddress, manifestAddress, expectedOrigin);
  const response = await fetchResponse(manifestAddress, fetchImpl, 'no-cache');
  const manifest = await response.json();
  if (manifest?.version !== 1 || !manifest.current) throw new Error('This catalog manifest version is not supported.');
  const current = manifest.current;
  if (typeof current.catalog !== 'string' || !current.catalog) throw new Error('The manifest does not identify a catalog.');
  const plainURL = sameOriginURL(current.catalog, manifestAddress, expectedOrigin);
  let bytes;
  let compressedError;
  if (current.compressedCatalog && typeof DecompressionStreamImpl === 'function') {
    try {
      const gzipURL = sameOriginURL(current.compressedCatalog, manifestAddress, expectedOrigin);
      const gzipResponse = await fetchResponse(gzipURL, fetchImpl, 'force-cache');
      const compressed = await gzipResponse.arrayBuffer();
      await digest(compressed, current.gzipSha256, cryptoImpl, 'compressed catalog');
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStreamImpl('gzip'));
      bytes = await new Response(stream).arrayBuffer();
      await digest(bytes, current.sha256, cryptoImpl, 'catalog');
    } catch (error) {
      compressedError = error;
      bytes = undefined;
    }
  }
  if (!bytes) {
    try {
      const plainResponse = await fetchResponse(plainURL, fetchImpl, 'force-cache');
      bytes = await plainResponse.arrayBuffer();
      await digest(bytes, current.sha256, cryptoImpl, 'catalog');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(compressedError ? `The compressed and fallback catalogs could not load. ${detail}` : detail);
    }
  }
  if (Number.isSafeInteger(current.bytes) && bytes.byteLength !== current.bytes) throw new Error('The catalog size does not match its manifest.');
  let catalog;
  try { catalog = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error('The downloaded catalog is not valid JSON.'); }
  if (catalog?.version !== 1) throw new Error('This game catalog version is not supported.');
  return { catalog, manifest };
}

let prepared = null;
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
          : await loadCatalog(message.manifestURL);
        if (token !== initialization) return;
        const { catalog, manifest } = loaded;
        if (catalog?.version !== 1) throw new Error('This game catalog version is not supported.');
        prepared = prepareCatalog(catalog);
        self.postMessage({
          type: 'ready', gameCount: prepared.games.length, features: prepared.features,
          tags: prepared.tags, tagCounts: prepared.tagCounts, knownTagCount: prepared.knownTagCount,
          importedAt: catalog.importedAt ?? manifest?.importedAt ?? null,
          sources: catalog.sources ?? manifest?.sources ?? {},
          coverage: catalog.coverage ?? manifest?.coverage ?? {},
          refresh: catalog.refresh ?? manifest?.refresh ?? null,
          fixture: catalog.fixture === true || manifest?.fixture === true,
          catalogHash: manifest?.current?.sha256 ?? null,
        });
      } else if (message.type === 'query') {
        if (!prepared) throw new Error('The game catalog has not loaded yet.');
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
