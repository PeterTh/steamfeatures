import { readFile, writeFile, mkdir, readdir, rename, open, rm, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SteamDataStore, writeSteamDataArchive, readSteamDataArchive } from './steam-data.mjs';
import { createSteamClient, STEAM_DATA_REQUEST } from './steam-client.mjs';
import { createPicsClient } from './steam-pics.mjs';
import { archiveRecord, fallbackFromAppDetails } from './steam-enrichment.mjs';
import { readLocalSteamArchive } from './sources.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));

async function atomicJSON(filename, value) {
  await writeFile(`${filename}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await rename(`${filename}.tmp`, filename);
}

export async function seedSteamData(store, { sourceFile, catalogDirectory = resolve(ROOT, 'dist') }) {
  if (store.setting('seedComplete')) return;
  const sources = await json(sourceFile);
  const manifest = await json(resolve(catalogDirectory, 'data/manifest.json'));
  if (!/^catalog\.[a-f0-9]{16}\.json$/.test(manifest.current?.catalog)) throw new Error('A prepared local catalog is required for collection');
  const catalog = await json(resolve(catalogDirectory, 'data', manifest.current.catalog));
  const ids = new Set(catalog.games.map(game => game.id));
  store.transaction(() => {
    for (const game of catalog.games) {
      const fallback = Object.fromEntries(['name', 'genres', 'reviews', 'positivePercent', 'releaseDate', 'releaseISO', 'releaseStatus', 'earlyAccess', 'featureIds', 'featureDataKnown']
        .filter(key => game[key] !== undefined && game[key] !== null).map(key => [key, game[key]]));
      store.seed(game.id, fallback);
    }
  });
  const directory = resolve(sources.blueboxDirectory, 'data');
  for (const name of (await readdir(directory)).filter(name => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b))) {
    const shard = await json(resolve(directory, name));
    store.transaction(() => {
      for (const [key, record] of Object.entries(shard)) {
        if (!ids.has(record.steam_appid) || Number(key) !== record.steam_appid) continue;
        store.seed(record.steam_appid, { ...store.get(record.steam_appid)?.fallback, ...fallbackFromAppDetails(record) });
      }
    });
  }
  const previous = await readLocalSteamArchive(catalogDirectory);
  if (previous?.version === 1) {
    store.transaction(() => {
      for (const [key, entry] of Object.entries(previous.apps)) {
        const observation = entry.latest.item.success === 1 ? entry.latest : entry.successful;
        if (observation && ids.has(Number(key))) store.putStore(Number(key), observation.item, { seed: true, request: previous.requests[observation.request]?.input?.data_request });
      }
    });
    if (previous.tagDictionary) store.setting('tags', previous.tagDictionary.body.response.tags);
  } else if (previous?.sourcePath) {
    store.db.exec('BEGIN IMMEDIATE');
    try {
      for await (const record of readSteamDataArchive(previous.sourcePath, previous.descriptor)) {
        if (record.format) { store.setting('tags', record.tagDictionary); continue; }
        if (!ids.has(record.id)) continue;
        store.seed(record.id, { ...record.fallback, ...store.get(record.id)?.fallback });
        if (record.store) store.putStore(record.id, record.store, { seed: true });
        if (record.appinfo) store.putAppInfo(record.id, record.appinfo, { seed: true });
      }
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  }
  store.setting('seedComplete', { apps: ids.size, sourceFile: resolve(sourceFile), catalogDirectory: resolve(catalogDirectory) });
}

/** Each committed batch survives interruption. A whole-request failure stops the
 * run; individual inaccessible apps preserve older payloads and explicit facts.
 */
export async function collectSteamData({ store, storeClient, picsClient, retryFailed = false, limit = 1000000,
  now = () => new Date().toISOString(), progress = async () => {} }) {
  const tags = await storeClient.getTagList();
  store.setting('tags', tags);
  for (const source of ['store', 'pics']) {
    const ids = store.pending(source, { retryFailed, limit });
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      if (source === 'store') {
        const items = await storeClient.getItems(batch);
        const byId = new Map(items.map(item => [item.id ?? item.appid, item]));
        if (byId.size !== items.length || [...byId.keys()].some(id => !batch.includes(id))) throw new Error('Unexpected StoreBrowse batch results');
        const checkedAt = now();
        store.transaction(() => { for (const id of batch) store.putStore(id, byId.get(id) ?? { id, success: 2 }, { checkedAt, request: STEAM_DATA_REQUEST }); });
      } else {
        const response = await picsClient.getItems(batch);
        const checkedAt = now();
        store.transaction(() => {
          for (const id of batch) store.putAppInfo(id, response.apps[id]?.appinfo,
            { checkedAt, result: response.apps[id]?.appinfo ? 1 : response.unknownApps?.includes(id) ? 15 : 2 });
        });
      }
      await progress({ phase: source, ...store.progress(), batchCompleted: Math.min(offset + 100, ids.length), batchTotal: ids.length });
    }
  }
  const totals = store.progress();
  return { ...totals, complete: totals.apps === totals.storeChecked && totals.apps === totals.picsChecked };
}

async function acquireLock(filename) {
  try {
    const existing = await json(filename);
    let running = true;
    try { process.kill(existing.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; else throw error; }
    if (running) throw new Error(`Steam collection is already running (PID ${existing.pid})`);
    await rm(filename);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const handle = await open(filename, 'wx');
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
  finally { await handle.close(); }
}

export async function main(args = process.argv.slice(2)) {
  const option = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${name}`); return args[i + 1]; };
  const sourceFile = resolve(option('--sources', resolve(ROOT, '.cache/prepared-sources.json')));
  const directory = resolve(option('--directory', resolve(ROOT, '.cache/steam-data')));
  const limit = Number(option('--limit', '1000000'));
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive app count per source');
  const spacingMs = Number(process.env.STEAM_REQUEST_SPACING_MS || 5000);
  if (!Number.isSafeInteger(spacingMs) || spacingMs < 5000 || spacingMs > 60000) throw new Error('Collection spacing must be between 5000 and 60000 ms');
  await mkdir(directory, { recursive: true });
  const lock = resolve(directory, 'collection.lock');
  await acquireLock(lock);
  const store = new SteamDataStore(resolve(directory, 'steam.sqlite'));
  const startedAt = new Date().toISOString();
  const progressFile = resolve(directory, 'progress.json');
  let picsClient;
  const report = async value => {
    const status = { pid: process.pid, startedAt, updatedAt: new Date().toISOString(), ...value };
    await atomicJSON(progressFile, status);
    console.log(JSON.stringify(status));
  };
  try {
    await report({ phase: 'seeding', ...store.progress() });
    await seedSteamData(store, { sourceFile, catalogDirectory: resolve(option('--catalog-directory', resolve(ROOT, 'dist'))) });
    let result;
    if (!args.includes('--export-only')) {
      const storeClient = createSteamClient({ spacingMs, maxRequests: 10000 });
      picsClient = createPicsClient({ spacingMs });
      result = await collectSteamData({ store, storeClient, picsClient, retryFailed: args.includes('--retry-failed'), limit, progress: report });
    } else {
      const totals = store.progress();
      result = { ...totals, complete: totals.apps === totals.storeChecked && totals.apps === totals.picsChecked };
    }
    if (!result.complete) { await report({ phase: 'partial', ...result }); return; }
    let descriptor;
    if (args.includes('--build')) {
      // The build already exports the same checkpoint. Compress once, then keep
      // a local copy of that artifact instead of spending another full pass.
      await report({ phase: 'building', ...result });
      const output = await run(process.execPath, ['--max-old-space-size=4096', resolve(ROOT, 'scripts/build.mjs'), '--sources', sourceFile,
        '--finalize-steam', '--steam-data', store.filename], { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 });
      process.stdout.write(output.stdout); process.stderr.write(output.stderr);
      descriptor = (await json(resolve(ROOT, 'dist/data/manifest.json'))).steamArchive;
      await copyFile(resolve(ROOT, 'dist/data', descriptor.file), resolve(directory, descriptor.file));
      await atomicJSON(resolve(directory, 'archive.json'), descriptor);
      await report({ phase: 'verifying', ...result, archive: descriptor });
      const verified = await run(process.execPath, ['--max-old-space-size=4096', resolve(ROOT, 'scripts/verify-site.mjs')], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
      process.stdout.write(verified.stdout); process.stderr.write(verified.stderr);
    } else {
      await report({ phase: 'compressing', ...result });
      const records = (function* () { for (const row of store.rows()) yield archiveRecord(row); })();
      descriptor = await writeSteamDataArchive({ records, tagDictionary: store.setting('tags') ?? [], outputDirectory: directory });
      await atomicJSON(resolve(directory, 'archive.json'), descriptor);
    }
    await report({ phase: 'complete', ...result, archive: descriptor, built: args.includes('--build') });
  } catch (error) {
    await report({ phase: 'stopped', ...store.progress(), error: error.message });
    throw error;
  } finally { picsClient?.close(); store.close(); await rm(lock, { force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
