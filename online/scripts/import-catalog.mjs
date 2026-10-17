import { mkdir, readFile, readdir, writeFile, copyFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { features as baseFeatures } from '../src/features.mjs';
import { LANGUAGES } from '../src/languages.mjs';
import { attachCommunityTags, buildFeatureCatalog, encodeTagIndex, indexCommunityTags, indexReviews, normalizeGame, parseGenreDefinitions, readCategoryIds, selectAppRecord, summarizeCoverage, validateCoverage } from './normalize.mjs';
import { fetchSources, readPreviousManifest, readPreviousRefreshState, readPreviousSteamArchive, readLocalSteamArchive, retainPreviousCatalog, sha256 } from './sources.mjs';
import { createSteamClient } from './steam-client.mjs';
import { createSteamResponseArchive } from './steam-archive.mjs';
import { buildSteamArchiveSnapshot } from './steam-archive-snapshot.mjs';
import { recoverArchivedDenials } from './steam-denials.mjs';
import { createRefreshState, validateRefreshState } from './refresh-state.mjs';
import { refreshSteam, mergeSteamState, auditSteamCoverage } from './steam-refresh.mjs';
import { writeBinaryCatalog, writeProgressiveCatalog } from './catalog-package.mjs';
import { openSteamData, withSteamData, projectSteamData, mergeSteamEnrichment } from './steam-data-import.mjs';
import { writeSteamDataArchive } from './steam-data.mjs';
import { archiveRecord } from './steam-enrichment.mjs';
import { createPicsClient } from './steam-pics.mjs';
import { writeGameImages, retainGameImages } from './game-images.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function importCatalog({ sourceFile, output = resolve(ROOT, 'dist'), previousURL = process.env.PAGES_BASE_URL, fixture = false,
  refresh = !fixture && !sourceFile, bootstrap = false, steamLimit = Number(process.env.STEAM_REFRESH_LIMIT || 4000),
  steamStateFile, steamClient, now, finalizeSteam = false, localPreviousDirectory, steamDataFile, checkpointFile = resolve(ROOT, '.cache/steam-refresh-state.json') } = {}) {
  let steamData, picsClient;
  const imagePaths = new Map();
  try {
  if (finalizeSteam && !sourceFile) throw new Error('Finalizing Steam data requires prepared --sources');
  if (finalizeSteam && (!Number.isSafeInteger(steamLimit) || steamLimit < 1 || steamLimit > 5000)) throw new Error('Steam refresh limit must be between 1 and 5000');
  if (finalizeSteam) refresh = true;
  const importedAt = now ?? new Date().toISOString();
  const previous = fixture || finalizeSteam ? null : await readPreviousManifest(previousURL);
  const inputs = sourceFile ? JSON.parse(await readFile(resolve(sourceFile), 'utf8')) : fixture ? await fixtureSources() : await fetchSources(resolve(ROOT, '.cache'));
  const { blueboxDirectory, reviewsFile, reviewLicenseFile, sources } = inputs;
  if (!sources?.apps?.revision || !sources?.reviews?.sha256) throw new Error('Prepared sources require pinned revisions and review checksum');
  const appDirectory = resolve(blueboxDirectory, 'data');
  const names = (await readdir(appDirectory)).filter(name => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b));
  if (!names.length) throw new Error('No numeric appdetails shards found');
  const digest = createHash('sha256');
  const records = new Map();
  let sourceApps = 0;
  for (const name of names) {
    const bytes = await readFile(resolve(appDirectory, name));
    digest.update(`${name}\0`).update(bytes);
    const shard = JSON.parse(bytes);
    if (!shard || typeof shard !== 'object' || Array.isArray(shard)) throw new Error(`Invalid appdetails shard ${name}`);
    for (const [key, record] of Object.entries(shard)) {
      sourceApps++;
      // Drop large descriptions/images before retaining the compact source records.
      const { steam_appid, name, type, categories, genres, release_date } = record;
      selectAppRecord(records, key, { steam_appid, name, type, categories, genres, release_date });
    }
  }
  const taxonomyBytes = await readFile(resolve(appDirectory, 'categories'));
  const genreBytes = await readFile(resolve(appDirectory, 'genres'));
  digest.update('categories\0').update(taxonomyBytes).update('genres\0').update(genreBytes);
  const appsHash = digest.digest('hex');
  if (sources.apps.sha256 && sources.apps.sha256 !== appsHash) throw new Error('Appdetails shard checksum mismatch');
  sources.apps.sha256 = appsHash;
  sources.apps.shards = names.length;
  const observed = new Set([...records.values()].filter(({ record }) => record.type === 'game').flatMap(({ record }) => readCategoryIds(record)));
  const { features, categoryMap } = buildFeatureCatalog(baseFeatures, JSON.parse(taxonomyBytes), observed);
  const compressedReviews = await readFile(reviewsFile);
  if (sha256(compressedReviews) !== sources.reviews.sha256) throw new Error('Prepared review file checksum mismatch');
  const reviewRows = JSON.parse(gunzipSync(compressedReviews, { maxOutputLength: 750 * 1024 * 1024 }));
  const reviewIndex = indexReviews(reviewRows);
  const genreNames = parseGenreDefinitions(genreBytes.toString('utf8'));
  let normalizedGames = [...records.values()].map(({ record }) => normalizeGame(record, reviewIndex.get(record.steam_appid), categoryMap, genreNames)).filter(Boolean).sort((a, b) => a.id - b.id);
  let tagsByApp = indexCommunityTags(reviewRows);
  let refreshState, refreshSummary, refreshAudit;
  let previousRawArchive;
  const rawArchiveDirectory = resolve(dirname(checkpointFile), 'steam-responses');
  if (refresh) {
    // Published state is durable; a newer checkpoint also retains attempts made
    // during an interrupted run, so retrying it cannot reset the daily budget.
    refreshState = await readPreviousRefreshState(previous);
    previousRawArchive = finalizeSteam && localPreviousDirectory ? await readLocalSteamArchive(localPreviousDirectory) : await readPreviousSteamArchive(previous);
    if (!refreshState && steamStateFile) refreshState = validateRefreshState(JSON.parse(await readFile(resolve(steamStateFile), 'utf8')));
    const newestAttempt = state => Object.values(state.apps).reduce((latest, entry) => entry.lastAttemptAt > latest ? entry.lastAttemptAt : latest, state.lastDiscoveryAt ?? '');
    try {
      const checkpoint = validateRefreshState(JSON.parse(await readFile(checkpointFile, 'utf8')));
      if (!refreshState || newestAttempt(checkpoint) > newestAttempt(refreshState)) refreshState = checkpoint;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (finalizeSteam && !refreshState) throw new Error('Finalizing Steam data requires a saved Steam checkpoint');
    refreshState ??= createRefreshState();
    if (steamDataFile || previousRawArchive?.sourcePath) steamData = await openSteamData({
      filename: steamDataFile ? resolve(steamDataFile) : resolve(dirname(checkpointFile), 'steam-data/steam.sqlite'),
      previous: previousRawArchive, journalDirectory: rawArchiveDirectory, requireExisting: Boolean(steamDataFile), state: refreshState,
      checkpointOnly: finalizeSteam && Boolean(steamDataFile)
    });
    await recoverArchivedDenials(refreshState, rawArchiveDirectory);
    bootstrap ||= !refreshState.bootstrapComplete;
    if (bootstrap && !finalizeSteam && process.env.STEAM_ALLOW_BOOTSTRAP === '0') {
      throw new Error('Automatic Steam bootstrap is disabled. Seed the first Pages deployment with the completed bootstrap release package; no Steam requests were made.');
    }
    const checkpoint = async state => {
      await mkdir(dirname(checkpointFile), { recursive: true });
      await writeFile(`${checkpointFile}.tmp`, JSON.stringify(state));
      await rename(`${checkpointFile}.tmp`, checkpointFile);
    };
    if (finalizeSteam) {
      if (!refreshState.bootstrapComplete && !refreshState.bootstrapCursor?.queryComplete) throw new Error('Steam bootstrap enumeration is not complete');
      refreshSummary = { enabled: true, existingLimit: steamLimit, lastRunAt: newestAttempt(refreshState) || null,
        bootstrapComplete: false, checkedGames: Object.values(refreshState.apps).filter(entry => entry.metadata?.appType === 0).length,
        discovered: 0, refreshed: 0, failures: 0, requests: 0, finalizedFromCheckpoint: true };
    } else {
      if (!steamClient) console.log(`Steam responses: archiving full JSON to ${rawArchiveDirectory}`);
      let client = steamClient ?? createSteamClient({ maxRequests: bootstrap ? 1000 : 100, spacingMs: Number(process.env.STEAM_REQUEST_SPACING_MS || 5000),
        recordResponse: createSteamResponseArchive({ directory: rawArchiveDirectory }) });
      if (steamData && !steamClient) {
        picsClient = createPicsClient({ spacingMs: Math.max(5000, Number(process.env.STEAM_REQUEST_SPACING_MS || 5000)) });
        client = withSteamData(client, picsClient, steamData);
      }
      const result = await refreshSteam({ games: normalizedGames, features, state: refreshState, client, now: importedAt, budget: steamLimit, bootstrap, checkpoint });
      refreshState = result.state;
      refreshSummary = result.summary;
    }
    const projections = steamData ? projectSteamData(steamData, refreshState, features, { imagePaths }) : undefined;
    if (finalizeSteam) {
      refreshSummary.lastRunAt = newestAttempt(refreshState) || null;
      refreshSummary.checkedGames = Object.values(refreshState.apps).filter(entry => entry.metadata?.appType === 0).length;
    }
    ({ games: normalizedGames, tagsByApp } = mergeSteamState(normalizedGames, tagsByApp, refreshState));
    if (projections) normalizedGames = mergeSteamEnrichment(normalizedGames, projections, features);
    refreshAudit = auditSteamCoverage(normalizedGames, refreshState);
    refreshSummary.unresolvedReleased = refreshAudit.unresolved.length;
    refreshSummary.deniedReleased = refreshAudit.denied.length;
    sources.steam = { endpoint: 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/', discoveryEndpoint: 'https://api.steampowered.com/IStoreQueryService/Query/v1/', country: 'US', language: 'english', reviews: 'All-language Steam-purchase reviews', refreshedAt: refreshSummary.lastRunAt };
    // Schema/network failures never become a supposedly completed first release.
    const blocking = refreshAudit.unresolved;
    if ((bootstrap || finalizeSteam) && blocking.length) {
      refreshState.bootstrapComplete = false;
      await checkpoint(refreshState);
      await writeFile(resolve(dirname(checkpointFile), 'steam-refresh-unresolved.json'), JSON.stringify(refreshAudit, null, 2));
      throw new Error(`Steam bootstrap has ${blocking.length} unresolved released games; checkpoint saved. Inspect .cache/steam-refresh-unresolved.json and resume before publishing.`);
    }
    if (bootstrap || finalizeSteam) {
      refreshState.bootstrapComplete = true;
      refreshSummary.bootstrapComplete = true;
      delete refreshState.bootstrapCursor;
      await checkpoint(refreshState);
      await writeFile(resolve(dirname(checkpointFile), 'steam-refresh-unresolved.json'), JSON.stringify(refreshAudit, null, 2));
    }
  }
  const { tags, games } = attachCommunityTags(normalizedGames, tagsByApp);
  const coverage = summarizeCoverage(games, { tagCount: tags.length, sourceApps, redirectAliases: sourceApps - records.size, reviewRows: reviewIndex.size, sourceShards: names.length });
  validateCoverage(coverage, previous?.manifest.coverage, { fixture });
  const tagIndex = encodeTagIndex(games, tags.length);
  // Postings reference this final, Steam-ID-sorted array's row indices, not app IDs.
  const encodedGames = games.map(({ tagIds, ...game }) => game);
  const catalog = { version: 1, importedAt, fixture, sources, coverage, ...(refreshSummary ? { refresh: refreshSummary } : {}), features, languages: LANGUAGES, tags, tagIndex, games: encodedGames };
  const bytes = Buffer.from(JSON.stringify(catalog));
  const compressed = gzipSync(bytes, { level: 9 });
  const hash = sha256(bytes);
  const filename = `catalog.${hash.slice(0, 16)}.json`;
  const current = { catalog: filename, compressedCatalog: `${filename}.gz`, sha256: hash, gzipSha256: sha256(compressed), bytes: bytes.length, gzipBytes: compressed.length, importedAt };
  const dataDirectory = resolve(output, 'data');
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(resolve(dataDirectory, filename), bytes);
  await writeFile(resolve(dataDirectory, `${filename}.gz`), compressed);
  current.binary = await writeBinaryCatalog(catalog, dataDirectory);
  current.progressive = await writeProgressiveCatalog(catalog, dataDirectory, current.binary.sha256);
  let stateDescriptor;
  if (refreshState) {
    const stateBytes = gzipSync(Buffer.from(JSON.stringify(refreshState)), { level: 9 });
    const stateHash = sha256(stateBytes);
    stateDescriptor = { file: `refresh.${stateHash.slice(0, 16)}.json.gz`, sha256: stateHash, bytes: stateBytes.length };
    await writeFile(resolve(dataDirectory, stateDescriptor.file), stateBytes);
    await writeFile(resolve(output, 'refresh-report.json'), JSON.stringify({ ...refreshSummary, ...refreshAudit }, null, 2));
  }
  const rawDescriptor = steamData ? await writeSteamDataArchive({
    records: (function* () { for (const row of steamData.rows()) yield archiveRecord(row); })(),
    tagDictionary: steamData.setting('tags') ?? [], outputDirectory: dataDirectory, generatedAt: importedAt
  }) : refresh ? (await buildSteamArchiveSnapshot({ directory: rawArchiveDirectory, previous: previousRawArchive, outputDirectory: dataDirectory })).descriptor : undefined;
  const retained = await retainPreviousCatalog(previous, dataDirectory, current);
  const gameImages = await writeGameImages(imagePaths, dataDirectory, new Set(games.map(game => game.id)));
  await retainGameImages(previous, dataDirectory, gameImages, { localPreviousDirectory });
  const manifest = { version: 1, importedAt, fixture, current, previous: retained, sources, coverage, ...(gameImages ? { gameImages } : {}), ...(stateDescriptor ? { refreshState: stateDescriptor, refresh: refreshSummary } : {}), ...(rawDescriptor ? { steamArchive: rawDescriptor } : {}) };
  await writeFile(resolve(dataDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await mkdir(resolve(output, 'licenses'), { recursive: true });
  await copyFile(resolve(blueboxDirectory, 'LICENSE'), resolve(output, 'licenses/BlueBoxWare-MIT.txt'));
  await copyFile(reviewLicenseFile, resolve(output, 'licenses/leinstay-GPL-3.0.txt'));
  await writeFile(resolve(output, 'licenses/NOTICE.txt'), 'Steam Feature Atlas uses BlueBoxWare/steamdb (MIT) and leinstay/steamdb (GPL-3.0).\nThe combined catalog is distributed under GPL-3.0. Upstream game names and other publisher material retain their owners\' rights.\nPinned source revisions and checksums: ../data/manifest.json\nTransformation source: https://github.com/peterth/steamfeatures/tree/main/online\nOriginal sources: https://github.com/BlueBoxWare/steamdb and https://github.com/leinstay/steamdb\n');
  const lock = { version: 1, importedAt, fixture, sources, coverage, catalog: current, ...(gameImages ? { gameImages } : {}), ...(stateDescriptor ? { refreshState: stateDescriptor, refresh: refreshSummary } : {}), ...(rawDescriptor ? { steamArchive: rawDescriptor } : {}) };
  await writeFile(resolve(output, 'provenance-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  console.log(JSON.stringify({ games: games.length, features: features.length,
    initialBrotliMB: +(current.progressive.priority.brotli.bytes / 1e6).toFixed(2),
    browserBrotliMB: +((current.progressive.priority.brotli.bytes + current.progressive.remainder.brotli.bytes) / 1e6).toFixed(2),
    browserGzipMB: +((current.progressive.priority.gzip.bytes + current.progressive.remainder.gzip.bytes) / 1e6).toFixed(2),
    ...(rawDescriptor ? { rawArchiveApps: rawDescriptor.apps, rawArchiveCompressedMB: +(rawDescriptor.bytes / 1048576).toFixed(2) } : {}), fixture, output }, null, 2));
  return { manifest, catalog };
  } finally { picsClient?.close(); steamData?.close(); }
}

async function fixtureSources() {
  const { createFixture } = await import('./fixture.mjs');
  return createFixture(resolve(ROOT, '.cache/fixture'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceIndex = process.argv.indexOf('--sources');
  const stateIndex = process.argv.indexOf('--steam-state');
  const limitIndex = process.argv.indexOf('--steam-limit');
  const dataIndex = process.argv.indexOf('--steam-data');
  importCatalog({ fixture: process.argv.includes('--fixture'), sourceFile: sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined,
    ...(process.argv.includes('--refresh-steam') || process.argv.includes('--bootstrap-steam') ? { refresh: true } : {}),
    bootstrap: process.argv.includes('--bootstrap-steam'), steamStateFile: stateIndex >= 0 ? process.argv[stateIndex + 1] : undefined,
    finalizeSteam: process.argv.includes('--finalize-steam'),
    localPreviousDirectory: resolve(ROOT, 'dist'),
    steamDataFile: dataIndex >= 0 ? process.argv[dataIndex + 1] : undefined,
    ...(limitIndex >= 0 ? { steamLimit: Number(process.argv[limitIndex + 1]) } : {})
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
