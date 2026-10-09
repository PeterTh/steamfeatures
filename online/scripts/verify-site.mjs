import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { prepareCatalog } from '../src/query.mjs';
import { validateRefreshState } from './refresh-state.mjs';
import { validateSteamArchiveSnapshot } from './steam-archive-snapshot.mjs';
import { readPreviousManifest, readPreviousRefreshState, sha256, validateCatalogDescriptor } from './sources.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIRST_DEPLOY = 'For the first deployment, upload steam-feature-atlas-bootstrap.tar.gz to a GitHub release, then run this workflow with bootstrap_release set to that release tag. No Steam backfill was started.';

function productionManifest(manifest, minimumGames) {
  if (manifest?.version !== 1 || manifest.fixture !== false || !Number.isSafeInteger(manifest.coverage?.games) || manifest.coverage.games < minimumGames) {
    throw new Error('A production catalog with at least ' + minimumGames + ' games is required.');
  }
  if (manifest.refresh?.bootstrapComplete !== true || !manifest.refreshState || !manifest.steamArchive) {
    throw new Error('A completed Steam refresh state and raw archive are required. ' + FIRST_DEPLOY);
  }
  validateCatalogDescriptor(manifest.current);
}

async function checkedFile(directory, filename, checksum, size, maximumBytes) {
  if (!/^[a-f0-9]{64}$/.test(checksum) || !Number.isSafeInteger(size) || size < 1 || size > maximumBytes) throw new Error('Invalid checksum or size for ' + filename);
  const bytes = await readFile(resolve(directory, filename));
  if (bytes.length !== size || sha256(bytes) !== checksum) throw new Error('Checksum or size mismatch: ' + filename);
  return bytes;
}

async function catalogBytes(directory, descriptor) {
  validateCatalogDescriptor(descriptor);
  if (!descriptor.catalog.includes(descriptor.sha256.slice(0, 16))) throw new Error('Catalog filename does not match its checksum.');
  const bytes = await checkedFile(directory, descriptor.catalog, descriptor.sha256, descriptor.bytes, 150 * 1024 * 1024);
  const compressed = await checkedFile(directory, descriptor.compressedCatalog, descriptor.gzipSha256, descriptor.gzipBytes, 40 * 1024 * 1024);
  if (!gunzipSync(compressed, { maxOutputLength: 150 * 1024 * 1024 }).equals(bytes)) throw new Error('Compressed catalog does not match the JSON catalog.');
  return bytes;
}

async function auxiliary(directory, descriptor, prefix, maximumBytes, expandedBytes) {
  if (!descriptor || !new RegExp(`^${prefix}\\.[a-f0-9]{16}\\.json\\.gz$`).test(descriptor.file) || !/^[a-f0-9]{64}$/.test(descriptor.sha256) || !descriptor.file.includes(descriptor.sha256.slice(0, 16))) {
    throw new Error('Invalid ' + prefix + ' descriptor.');
  }
  const bytes = await checkedFile(directory, descriptor.file, descriptor.sha256, descriptor.bytes, maximumBytes);
  return JSON.parse(gunzipSync(bytes, { maxOutputLength: expandedBytes }));
}

/** Verify everything needed to deploy and resume refreshes, without any network. */
export async function verifySite(directory = resolve(ROOT, 'dist'), { minimumGames = 50000 } = {}) {
  const site = resolve(directory);
  const data = resolve(site, 'data');
  const manifest = JSON.parse(await readFile(resolve(data, 'manifest.json'), 'utf8'));
  productionManifest(manifest, minimumGames);
  const catalog = JSON.parse(await catalogBytes(data, manifest.current));
  if (catalog.version !== 1 || catalog.fixture !== false || catalog.games?.length !== manifest.coverage.games || catalog.coverage?.games !== manifest.coverage.games || catalog.refresh?.bootstrapComplete !== true) {
    throw new Error('Catalog schema, coverage, or bootstrap status does not match its manifest.');
  }
  prepareCatalog(catalog);
  if (manifest.previous) await catalogBytes(data, manifest.previous);
  const state = validateRefreshState(await auxiliary(data, manifest.refreshState, 'refresh', 80 * 1024 * 1024, 300 * 1024 * 1024));
  if (!state.bootstrapComplete || Object.keys(state.apps).length === 0) throw new Error('Steam refresh state is incomplete; refusing a deployment that would repeat the backfill.');
  const archive = validateSteamArchiveSnapshot(await auxiliary(data, manifest.steamArchive, 'steam-raw', 150 * 1024 * 1024, 1024 * 1024 * 1024));
  if (Object.keys(archive.apps).length !== manifest.steamArchive.apps) throw new Error('Steam raw archive app count does not match its manifest.');
  const provenance = JSON.parse(await readFile(resolve(site, 'provenance-lock.json'), 'utf8'));
  if (provenance.catalog?.sha256 !== manifest.current.sha256 || provenance.refreshState?.sha256 !== manifest.refreshState.sha256 || provenance.steamArchive?.sha256 !== manifest.steamArchive.sha256) {
    throw new Error('Provenance lock does not match the manifest.');
  }
  for (const name of ['index.html', 'app.js', 'style.css', 'query.mjs', 'features.mjs', 'filter-worker.js', 'brand.svg', '.nojekyll',
    'fonts/roboto-condensed-variable.woff', 'fonts/LICENSE.txt', 'fonts/NOTICE.txt', 'licenses/BlueBoxWare-MIT.txt', 'licenses/leinstay-GPL-3.0.txt', 'licenses/NOTICE.txt']) {
    await readFile(resolve(site, name));
  }
  return { games: catalog.games.length, stateApps: Object.keys(state.apps).length, rawApps: Object.keys(archive.apps).length, catalogSha256: manifest.current.sha256 };
}

/** Fail before the importer can start a fresh backfill on an empty Pages site. */
export async function verifyPublishedSite(baseURL) {
  if (!baseURL) throw new Error('Pages URL is missing. ' + FIRST_DEPLOY);
  const previous = await readPreviousManifest(baseURL);
  if (!previous) throw new Error('No existing Pages catalog was found. ' + FIRST_DEPLOY);
  productionManifest(previous.manifest, 50000);
  const state = await readPreviousRefreshState(previous);
  if (!state?.bootstrapComplete || !Object.keys(state.apps).length) throw new Error('Published Steam refresh state is incomplete. ' + FIRST_DEPLOY);
  return { games: previous.manifest.coverage.games, bootstrapComplete: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const task = args[0] === '--published-url' ? verifyPublishedSite(args[1]) : verifySite(args[0]);
  task.then(summary => console.log(JSON.stringify(summary, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
