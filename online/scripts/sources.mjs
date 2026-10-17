import { mkdir, readFile, writeFile, access, rename, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { validateRefreshState } from './refresh-state.mjs';
import { validateSteamArchiveSnapshot } from './steam-archive-snapshot.mjs';
import { STEAM_DATA_FORMAT, validateSteamDataDescriptor } from './steam-data.mjs';
import { validateBinaryDescriptor, BINARY_MAX_BYTES, JSON_MAX_BYTES, COMPRESSED_MAX_BYTES } from '../src/catalog-descriptor.mjs';
import { validateProgressiveDescriptor } from '../src/progressive-catalog.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function download(url, { maximumBytes = 100 * 1024 * 1024, optional404 = false } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Remote sources require HTTPS');
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const headers = { 'User-Agent': 'steam-feature-atlas-bulk-import/1.0', Accept: 'application/vnd.github+json' };
      if (parsed.hostname === 'api.github.com' && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(180000) });
      if (optional404 && response.status === 404) return null;
      if (!response.ok) throw new Error(`${parsed.hostname}: HTTP ${response.status}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maximumBytes) throw new Error(`Source exceeds ${maximumBytes} bytes`);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) { lastError = error; if (attempt < 2) await pause(1000 * (attempt + 1)); }
  }
  throw lastError;
}

export async function fetchSources(cacheDirectory) {
  const cache = resolve(cacheDirectory);
  await mkdir(cache, { recursive: true });
  const [commit, release] = await Promise.all([
    download('https://api.github.com/repos/BlueBoxWare/steamdb/commits/main').then(bytes => JSON.parse(bytes)),
    download('https://api.github.com/repos/leinstay/steamdb/releases/latest').then(bytes => JSON.parse(bytes))
  ]);
  if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('Invalid BlueBoxWare commit');
  const asset = release.assets?.find(item => item.name === 'steamdb.min.json.gz');
  if (!asset || !Number.isSafeInteger(asset.id) || !asset.browser_download_url.startsWith('https://github.com/leinstay/steamdb/releases/download/')) {
    throw new Error('Missing or invalid bulk reviews asset');
  }
  const reviewCommit = JSON.parse(await download(`https://api.github.com/repos/leinstay/steamdb/commits/${encodeURIComponent(release.tag_name)}`));
  if (!/^[a-f0-9]{40}$/.test(reviewCommit.sha)) throw new Error('Invalid leinstay release revision');

  const repository = resolve(cache, 'bluebox');
  await mkdir(repository, { recursive: true });
  const git = args => execFileSync('git', ['-C', repository, ...args], {
    stdio: 'inherit', timeout: 900000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  try { await access(resolve(repository, '.git')); }
  catch { git(['init']); git(['remote', 'add', 'origin', 'https://github.com/BlueBoxWare/steamdb.git']); }
  // Fetch one immutable revision; no credentials, arbitrary shell strings or source code execution.
  git(['fetch', '--depth=1', 'origin', commit.sha]);
  git(['checkout', '--detach', 'FETCH_HEAD']);
  const reviewsFile = resolve(cache, `reviews.${asset.id}.json.gz`);
  let reviewBytes;
  try { reviewBytes = await readFile(reviewsFile); } catch { reviewBytes = await download(asset.browser_download_url); }
  const reviewHash = sha256(reviewBytes);
  if (asset.digest && asset.digest !== `sha256:${reviewHash}`) throw new Error('Review archive checksum mismatch');
  await writeFile(reviewsFile, reviewBytes);
  const reviewLicenseFile = resolve(cache, `reviews.${reviewCommit.sha}.LICENSE`);
  await writeFile(reviewLicenseFile, await download(`https://raw.githubusercontent.com/leinstay/steamdb/${reviewCommit.sha}/LICENSE`));
  return {
    blueboxDirectory: repository,
    reviewsFile,
    reviewLicenseFile,
    sources: {
      apps: { repository: 'https://github.com/BlueBoxWare/steamdb', revision: commit.sha, publishedAt: commit.commit.committer.date, license: 'MIT' },
      reviews: { repository: 'https://github.com/leinstay/steamdb', revision: reviewCommit.sha, release: release.tag_name, releaseId: release.id, assetId: asset.id, url: asset.browser_download_url, publishedAt: release.published_at, sha256: reviewHash, license: 'GPL-3.0' }
    }
  };
}

export function validateCatalogDescriptor(descriptor) {
  if (!descriptor || !/^catalog\.[a-f0-9]{16}\.json$/.test(descriptor.catalog) || descriptor.compressedCatalog !== `${descriptor.catalog}.gz`) {
    throw new Error('Untrusted prior catalog paths');
  }
  for (const key of ['sha256', 'gzipSha256']) if (!/^[a-f0-9]{64}$/.test(descriptor[key])) throw new Error('Invalid prior catalog checksum');
  if (descriptor.binary !== undefined) validateBinaryDescriptor(descriptor.binary);
  if (descriptor.progressive !== undefined) validateProgressiveDescriptor(descriptor.progressive, descriptor.binary?.sha256);
  return descriptor;
}

export async function readPreviousManifest(baseURL) {
  if (!baseURL) return null;
  const base = new URL(baseURL.endsWith('/') ? baseURL : `${baseURL}/`);
  if (base.protocol !== 'https:') throw new Error('Previous deployment must use HTTPS');
  const manifestURL = new URL('data/manifest.json', base);
  const bytes = await download(manifestURL, { maximumBytes: 1024 * 1024, optional404: true });
  if (!bytes) return null;
  const manifest = JSON.parse(bytes);
  if (manifest.version !== 1) throw new Error('Unsupported previous manifest');
  validateCatalogDescriptor(manifest.current);
  return { manifest, manifestURL };
}

export async function readPreviousRefreshState(previous) {
  const descriptor = previous?.manifest.refreshState;
  if (!descriptor) return null;
  if (!/^refresh\.[a-f0-9]{16}\.json\.gz$/.test(descriptor.file) || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new Error('Untrusted Steam refresh state descriptor');
  const bytes = await download(new URL(descriptor.file, previous.manifestURL), { maximumBytes: 80 * 1024 * 1024 });
  if (sha256(bytes) !== descriptor.sha256) throw new Error('Steam refresh state checksum mismatch');
  return validateRefreshState(JSON.parse(gunzipSync(bytes, { maxOutputLength: 300 * 1024 * 1024 })));
}

export async function readPreviousSteamArchive(previous) {
  const descriptor = previous?.manifest.steamArchive;
  if (!descriptor) return null;
  if (descriptor.format === STEAM_DATA_FORMAT) {
    validateSteamDataDescriptor(descriptor);
    const directory = fileURLToPath(new URL('../.cache/steam-data/downloads/', import.meta.url));
    await mkdir(directory, { recursive: true });
    const sourcePath = resolve(directory, descriptor.file);
    try {
      const digest = createHash('sha256'); let size = 0;
      for await (const chunk of createReadStream(sourcePath)) { digest.update(chunk); size += chunk.length; }
      if (size === descriptor.bytes && digest.digest('hex') === descriptor.sha256) return { sourcePath, descriptor };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const url = new URL(descriptor.file, previous.manifestURL);
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`Steam archive: HTTP ${response.status}`);
    const digest = createHash('sha256'); let size = 0;
    const temporary = `${sourcePath}.tmp`;
    try {
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, done) {
        size += chunk.length;
        if (size > descriptor.bytes) return done(new Error('Steam archive exceeds declared size'));
        digest.update(chunk); done(null, chunk);
      } }), createWriteStream(temporary));
      if (size !== descriptor.bytes || digest.digest('hex') !== descriptor.sha256) throw new Error('Steam raw archive checksum mismatch');
      await rename(temporary, sourcePath);
    } finally { await rm(temporary, { force: true }); }
    return { sourcePath, descriptor };
  }
  if (!/^steam-raw\.[a-f0-9]{16}\.json\.gz$/.test(descriptor.file) || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new Error('Untrusted Steam raw archive descriptor');
  const bytes = await download(new URL(descriptor.file, previous.manifestURL), { maximumBytes: 150 * 1024 * 1024 });
  if (sha256(bytes) !== descriptor.sha256) throw new Error('Steam raw archive checksum mismatch');
  return validateSteamArchiveSnapshot(JSON.parse(gunzipSync(bytes, { maxOutputLength: 1024 * 1024 * 1024 })));
}

export async function readLocalSteamArchive(directory) {
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(directory, 'data/manifest.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const descriptor = manifest.steamArchive;
  if (!descriptor) return null;
  if (descriptor.format === STEAM_DATA_FORMAT) {
    validateSteamDataDescriptor(descriptor);
    return { sourcePath: resolve(directory, 'data', descriptor.file), descriptor };
  }
  if (!/^steam-raw\.[a-f0-9]{16}\.json\.gz$/.test(descriptor.file) || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new Error('Untrusted Steam raw archive descriptor');
  const bytes = await readFile(resolve(directory, 'data', descriptor.file));
  if (bytes.length > 150 * 1024 * 1024 || sha256(bytes) !== descriptor.sha256) throw new Error('Steam raw archive checksum or size mismatch');
  return validateSteamArchiveSnapshot(JSON.parse(gunzipSync(bytes, { maxOutputLength: 1024 * 1024 * 1024 })));
}

export async function retainPreviousCatalog(previous, directory, currentDescriptor) {
  if (!previous || previous.manifest.current.sha256 === currentDescriptor.sha256) return null;
  const descriptor = validateCatalogDescriptor(previous.manifest.current);
  const files = [
    { file: descriptor.catalog, hash: descriptor.sha256, maximumBytes: JSON_MAX_BYTES },
    { file: descriptor.compressedCatalog, hash: descriptor.gzipSha256, maximumBytes: COMPRESSED_MAX_BYTES },
  ];
  for (const binary of [descriptor.binary, descriptor.progressive?.priority, descriptor.progressive?.remainder].filter(Boolean)) {
    for (const [entry, maximumBytes] of [[binary, BINARY_MAX_BYTES], [binary.gzip, COMPRESSED_MAX_BYTES], [binary.brotli, COMPRESSED_MAX_BYTES]]) {
      files.push({ file: entry.file, hash: entry.sha256, size: entry.bytes, maximumBytes });
    }
  }
  for (const { file, hash, size, maximumBytes } of new Map(files.map(entry => [entry.file, entry])).values()) {
    const targetURL = new URL(file, previous.manifestURL);
    if (targetURL.origin !== previous.manifestURL.origin || !targetURL.pathname.startsWith(new URL('.', previous.manifestURL).pathname)) throw new Error('Prior catalog escaped its origin');
    const bytes = await download(targetURL, { maximumBytes });
    if (sha256(bytes) !== hash || (size !== undefined && bytes.length !== size)) throw new Error('Previous catalog checksum or size mismatch');
    await writeFile(resolve(directory, file), bytes);
  }
  return descriptor;
}
