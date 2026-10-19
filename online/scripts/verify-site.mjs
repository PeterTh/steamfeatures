import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { prepareCatalog } from '../src/query.mjs';
import { decodeBinaryCatalog } from '../src/catalog-binary.mjs';
import { BINARY_MAX_BYTES, JSON_MAX_BYTES, COMPRESSED_MAX_BYTES } from '../src/catalog-descriptor.mjs';
import { mergeCatalogPartitions, PRIORITY_MIN_REVIEWS } from '../src/progressive-catalog.mjs';
import { validateRefreshState } from './refresh-state.mjs';
import { validateSteamArchiveSnapshot } from './steam-archive-snapshot.mjs';
import { STEAM_DATA_FORMAT, readSteamDataArchive } from './steam-data.mjs';
import { readPreviousManifest, readPreviousRefreshState, sha256, validateCatalogDescriptor } from './sources.mjs';
import { verifyGameImages } from './game-images.mjs';
import { verifyGameCredits } from './game-credits.mjs';

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
  const bytes = await checkedFile(directory, descriptor.catalog, descriptor.sha256, descriptor.bytes, JSON_MAX_BYTES);
  const compressed = await checkedFile(directory, descriptor.compressedCatalog, descriptor.gzipSha256, descriptor.gzipBytes, COMPRESSED_MAX_BYTES);
  if (!gunzipSync(compressed, { maxOutputLength: JSON_MAX_BYTES }).equals(bytes)) throw new Error('Compressed catalog does not match the JSON catalog.');
  if (descriptor.binary) await verifyBinaryCatalog(directory, descriptor.binary, JSON.parse(bytes));
  if (descriptor.progressive) await verifyProgressiveCatalog(directory, descriptor.progressive, JSON.parse(bytes));
  return bytes;
}

function semanticMetadata(catalog) {
  const { games, tagIndex, features, tags = [], ...metadata } = catalog;
  return { ...metadata, features: [...features].sort((a, b) => a.id - b.id), tags: [...tags].sort() };
}

function semanticGame(game, tags) {
  const { tagIds, featureIds, ...fields } = game;
  return { ...fields, featureIds: [...featureIds].sort((a, b) => a - b), tags: tagIds.map(id => tags[id]).sort() };
}

async function readBinaryCatalog(directory, descriptor) {
  const bytes = await checkedFile(directory, descriptor.file, descriptor.sha256, descriptor.bytes, BINARY_MAX_BYTES);
  for (const [compression, decompress] of [['gzip', gunzipSync], ['brotli', brotliDecompressSync]]) {
    const packed = descriptor[compression];
    const compressed = await checkedFile(directory, packed.file, packed.sha256, packed.bytes, COMPRESSED_MAX_BYTES);
    if (!decompress(compressed, { maxOutputLength: BINARY_MAX_BYTES }).equals(bytes)) throw new Error(`Compressed ${compression} binary catalog does not match the raw binary catalog.`);
  }
  return decodeBinaryCatalog(bytes);
}

function compareCatalogs(binaryCatalog, jsonCatalog) {
  if (!isDeepStrictEqual(semanticMetadata(binaryCatalog), semanticMetadata(jsonCatalog))) throw new Error('Binary catalog metadata does not match the JSON catalog.');
  const expected = prepareCatalog(jsonCatalog);
  const actual = prepareCatalog(binaryCatalog);
  if (actual.games.length !== expected.games.length) throw new Error('Binary catalog game count does not match the JSON catalog.');
  const byId = new Map(actual.games.map(row => [row.game.id, row.game]));
  for (const { game } of expected.games) {
    const binaryGame = byId.get(game.id);
    if (!binaryGame || !isDeepStrictEqual(semanticGame(game, expected.tags), semanticGame(binaryGame, actual.tags))) {
      throw new Error(`Binary catalog game ${game.id} does not match the JSON catalog.`);
    }
  }
  return actual;
}

async function verifyBinaryCatalog(directory, descriptor, jsonCatalog) {
  compareCatalogs(await readBinaryCatalog(directory, descriptor), jsonCatalog);
}

async function verifyProgressiveCatalog(directory, descriptor, jsonCatalog) {
  const priority = await readBinaryCatalog(directory, descriptor.priority);
  const remainder = await readBinaryCatalog(directory, descriptor.remainder);
  const eligible = game => Number.isSafeInteger(game.reviews) && game.reviews >= PRIORITY_MIN_REVIEWS;
  if (!priority.games.every(eligible) || remainder.games.some(eligible)) throw new Error('Catalog partitions do not match their review threshold.');
  const actual = compareCatalogs(mergeCatalogPartitions(priority, remainder), jsonCatalog);
  if (!isDeepStrictEqual(descriptor.statistics, { gameCount: actual.games.length, tagCounts: actual.tagCounts,
    knownTagCount: actual.knownTagCount, languageCounts: actual.languageCounts })) throw new Error('Catalog partition statistics do not match the complete catalog.');
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
  if (manifest.gameCredits) await verifyGameCredits(data, manifest.gameCredits, catalog.games, manifest.current.binary?.sha256);
  if (manifest.gameImages) await verifyGameImages(data, manifest.gameImages);
  if (manifest.previous) await catalogBytes(data, manifest.previous);
  const state = validateRefreshState(await auxiliary(data, manifest.refreshState, 'refresh', 80 * 1024 * 1024, 300 * 1024 * 1024));
  if (!state.bootstrapComplete || Object.keys(state.apps).length === 0) throw new Error('Steam refresh state is incomplete; refusing a deployment that would repeat the backfill.');
  if (manifest.steamArchive.format === STEAM_DATA_FORMAT) {
    for await (const record of readSteamDataArchive(resolve(data, manifest.steamArchive.file), manifest.steamArchive)) { /* Streaming integrity and schema validation. */ }
  } else {
    const archive = validateSteamArchiveSnapshot(await auxiliary(data, manifest.steamArchive, 'steam-raw', 150 * 1024 * 1024, 1024 * 1024 * 1024));
    if (Object.keys(archive.apps).length !== manifest.steamArchive.apps) throw new Error('Steam raw archive app count does not match its manifest.');
  }
  const provenance = JSON.parse(await readFile(resolve(site, 'provenance-lock.json'), 'utf8'));
  if (!isDeepStrictEqual(provenance.gameCredits, manifest.gameCredits) || !isDeepStrictEqual(provenance.gameImages, manifest.gameImages) || provenance.catalog?.sha256 !== manifest.current.sha256 || !isDeepStrictEqual(provenance.catalog?.binary, manifest.current.binary) ||
      !isDeepStrictEqual(provenance.catalog?.progressive, manifest.current.progressive) || provenance.refreshState?.sha256 !== manifest.refreshState.sha256 || provenance.steamArchive?.sha256 !== manifest.steamArchive.sha256) {
    throw new Error('Provenance lock does not match the manifest.');
  }
  for (const name of ['index.html', 'app.js', 'style.css', 'query.mjs', 'features.mjs', 'feature-presentation.mjs', 'compatibility-details.mjs', 'extra-features.mjs', 'languages.mjs', 'game-images.mjs', 'game-credits.mjs', 'filter-worker.js', 'brand.svg', '.nojekyll',
    'fonts/promptfont.woff2', 'fonts/PromptFont-LICENSE.txt', 'fonts/PromptFont-NOTICE.txt',
    'fonts/roboto-condensed-variable.woff', 'fonts/LICENSE.txt', 'fonts/NOTICE.txt', 'licenses/BlueBoxWare-MIT.txt', 'licenses/leinstay-GPL-3.0.txt', 'licenses/NOTICE.txt']) {
    await readFile(resolve(site, name));
  }
  if (manifest.current.binary || manifest.previous?.binary) {
    await readFile(resolve(site, 'catalog-binary.mjs'));
    await readFile(resolve(site, 'catalog-descriptor.mjs'));
  }
  if (manifest.current.progressive || manifest.previous?.progressive) await readFile(resolve(site, 'progressive-catalog.mjs'));
  return { games: catalog.games.length, stateApps: Object.keys(state.apps).length, rawApps: manifest.steamArchive.apps, catalogSha256: manifest.current.sha256 };
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
