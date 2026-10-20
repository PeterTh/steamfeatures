import { DatabaseSync } from 'node:sqlite';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress, constants } from 'node:zlib';
import { availableParallelism } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

export const STEAM_DATA_FORMAT = 'steam-feature-atlas-raw-v2';
export const STEAM_DATA_LIMITS = Object.freeze({ compressed: 1024 ** 3, expanded: 8 * 1024 ** 3, line: 32 * 1024 ** 2 });
const archiveWorkers = Math.min(3, Math.max(0, availableParallelism() - 1));
const zstdProbe = archiveWorkers ? spawnSync('zstd', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }) : null;
export const STEAM_ARCHIVE_COMPRESSION_BACKEND = zstdProbe?.status === 0 ? 'zstd-cli' : 'node-zlib';
export const STEAM_ARCHIVE_COMPRESSION_WORKERS = zstdProbe?.status === 0 ? archiveWorkers : 0;
export const STEAM_ARCHIVE_ZSTD_VERSION = zstdProbe?.status === 0 ? zstdProbe.stdout.trim() : null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = id => Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff;
const encode = value => value === undefined ? null : JSON.stringify(value);
const decode = value => value === null ? undefined : JSON.parse(value);

export function validateSteamDataDescriptor(value) {
  if (!value || value.format !== STEAM_DATA_FORMAT || !/^steam-raw\.[a-f0-9]{16}\.jsonl\.zst$/.test(value.file) ||
      !/^[a-f0-9]{64}$/.test(value.sha256) || !value.file.includes(value.sha256.slice(0, 16)) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > STEAM_DATA_LIMITS.compressed ||
      !Number.isSafeInteger(value.apps) || value.apps < 0) throw new Error('Invalid Steam JSONL archive descriptor');
  return value;
}

function validateRecord(row) {
  if (!object(row) || !validId(row.id) || Object.keys(row).some(key => !['id', 'store', 'appinfo', 'fallback'].includes(key))) throw new Error('Invalid Steam data record');
  if (row.store !== undefined && (!object(row.store) || (row.store.id ?? row.store.appid) !== row.id || row.store.success !== 1)) throw new Error('Invalid Steam data store item');
  if (row.appinfo !== undefined && (!object(row.appinfo) || Number(row.appinfo.appid) !== row.id)) throw new Error('Invalid Steam data appinfo');
  if (row.fallback !== undefined && !object(row.fallback)) throw new Error('Invalid Steam fallback data');
  return row;
}

/** A public-only PICS response cannot clear private sections it cannot see.
 * Complete sections (categories, tests, UFS) replace their predecessors, never union.
 */
export function mergeAppInfo(previous, incoming) {
  if (!previous || !['1', 'true', 1, true].includes(incoming.public_only)) return incoming;
  return { ...previous, ...incoming };
}

/** Expand requested protobuf defaults, but never invent defaults for older profiles. */
export function mergeStoreData(previous, incoming, request = {}) {
  const complete = incoming.visible === true;
  const next = { ...(complete ? {} : previous), ...incoming };
  if (complete) for (const [flag, field] of Object.entries({
    include_release: 'release', include_basic_info: 'basic_info', include_reviews: 'reviews',
    include_platforms: 'platforms', include_extra_details: 'extra_details', include_supported_languages: 'supported_languages',
    include_links: 'links', include_ratings: 'game_rating', include_assets: 'assets', include_full_description: 'full_description_bbcode',
    include_screenshots: 'screenshots', include_trailers: 'trailers', include_assets_without_overrides: 'assets_without_overrides'
  })) if (!request[flag] && incoming[field] === undefined && previous?.[field] !== undefined) next[field] = previous[field];
  if (complete) for (const [flag, field, empty] of [
    ['include_platforms', 'platforms', {}], ['include_extra_details', 'extra_details', {}],
    ['include_supported_languages', 'supported_languages', []], ['include_basic_info', 'basic_info', {}]
  ]) if (request[flag] && next[field] === undefined) next[field] = empty;
  return next;
}

/** Disk-backed working state. Only the source payloads and useful fallback facts
 * are exported; attempts, timestamps and failures stay in this local checkpoint.
 */
export class SteamDataStore {
  constructor(filename) {
    this.filename = resolve(filename);
    this.db = new DatabaseSync(this.filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS apps (
        id INTEGER PRIMARY KEY, store TEXT, appinfo TEXT, fallback TEXT,
        store_checked TEXT, pics_checked TEXT, store_result INTEGER, pics_result INTEGER);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS collection_progress ON apps(store_checked,store_result,pics_checked,pics_result);`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setting(key, value) {
    if (value !== undefined) this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    return decode(this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null);
  }
  seed(id, fallback = {}) {
    if (!validId(id)) throw new Error('Invalid Steam seed ID');
    this.db.prepare('INSERT INTO apps(id,fallback) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET fallback=excluded.fallback').run(id, encode(fallback));
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM apps WHERE id=?').get(id);
    return row && { ...row, store: decode(row.store), appinfo: decode(row.appinfo), fallback: decode(row.fallback) };
  }
  putStore(id, item, { checkedAt = new Date().toISOString(), request = {}, seed = false } = {}) {
    if (!validId(id) || (item?.id ?? item?.appid) !== id || !Number.isSafeInteger(item.success) || item.success < 1 || item.success > 0xffffffff) throw new Error('Invalid StoreBrowse result');
    const previous = this.get(id);
    const value = item.success === 1 ? mergeStoreData(previous?.store, item, request) : previous?.store;
    this.db.prepare(`INSERT INTO apps(id,store,store_checked,store_result) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET store=excluded.store, store_checked=COALESCE(excluded.store_checked,apps.store_checked),
      store_result=COALESCE(excluded.store_result,apps.store_result)`).run(id, encode(value), seed ? null : checkedAt, seed ? null : item.success);
  }
  putAppInfo(id, value, { checkedAt = new Date().toISOString(), result = 1, seed = false } = {}) {
    if (!validId(id) || (value !== undefined && (!object(value) || Number(value.appid) !== id))) throw new Error('Invalid PICS result');
    const previous = this.get(id)?.appinfo;
    const next = value ? mergeAppInfo(previous, value) : previous;
    this.db.prepare(`INSERT INTO apps(id,appinfo,pics_checked,pics_result) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET appinfo=excluded.appinfo, pics_checked=COALESCE(excluded.pics_checked,apps.pics_checked),
      pics_result=COALESCE(excluded.pics_result,apps.pics_result)`).run(id, encode(next), seed ? null : checkedAt, seed ? null : result);
  }
  pending(source, { retryFailed = false, limit = 1000000 } = {}) {
    if (!['store', 'pics'].includes(source) || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid collection selection');
    return this.db.prepare(`SELECT id FROM apps WHERE ${source}_checked IS NULL${retryFailed ? ` OR ${source}_result NOT IN (1,15)` : ''} ORDER BY id LIMIT ?`).all(limit).map(row => row.id);
  }
  progress() {
    return { ...this.db.prepare(`SELECT COUNT(*) AS apps,
      COUNT(store_checked) AS storeChecked, SUM(store_result=1) AS storeOK, SUM(store_result=15) AS storeUnavailable, SUM(store_result NOT IN (1,15)) AS storeFailed,
      COUNT(pics_checked) AS picsChecked, SUM(pics_result=1) AS picsOK, SUM(pics_result=15) AS picsUnavailable, SUM(pics_result=2) AS picsFailed
      FROM apps`).get() };
  }
  *rows() {
    for (const row of this.db.prepare('SELECT * FROM apps ORDER BY id').iterate()) yield {
      ...row, store: decode(row.store), appinfo: decode(row.appinfo), fallback: decode(row.fallback)
    };
  }
  *records() {
    for (const { id, store, appinfo, fallback } of this.rows()) yield { id, ...(store ? { store } : {}), ...(appinfo ? { appinfo } : {}), ...(fallback && Object.keys(fallback).length ? { fallback } : {}) };
  }
}

function meter({ maximum, hash, onSize }) {
  let size = 0;
  return new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > maximum) return callback(new Error('Steam archive exceeds size limit'));
    hash?.update(chunk); onSize?.(size); callback(null, chunk);
  } });
}

// JSON strings may contain literal U+2028/U+2029. Generic readline treats those
// as separators in newer Node versions; JSONL records are separated by LF only.
async function* jsonLines(stream) {
  let parts = [], size = 0;
  for await (const chunk of stream) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      size += part.length;
      if (size > STEAM_DATA_LIMITS.line) throw new Error('Steam JSONL line exceeds limit');
      parts.push(part);
      if (end < 0) break;
      yield Buffer.concat(parts, size).toString('utf8');
      parts = []; size = 0; start = end + 1;
    }
  }
  if (size) yield Buffer.concat(parts, size).toString('utf8');
}

async function compressArchive(source, expandedMeter, compressedMeter, output) {
  if (!STEAM_ARCHIVE_COMPRESSION_WORKERS) {
    return pipeline(source, expandedMeter,
      createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 19, [constants.ZSTD_c_checksumFlag]: 1 } }),
      compressedMeter, output);
  }
  // Node's streaming Zstd binding can signal EOF prematurely with nbWorkers.
  // The CLI provides bounded streaming and native parallelism without buffering
  // the full archive. Hosts without it retain the existing Node encoder.
  const child = spawn('zstd', ['-19', `-T${STEAM_ARCHIVE_COMPRESSION_WORKERS}`, '--check', '-c', '-q'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { if (stderr.length < 65536) stderr += chunk.toString(); });
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolveExit()
      : reject(new Error(`zstd exited with ${signal || code}: ${stderr.trim()}`)));
  });
  const work = [pipeline(source, expandedMeter, child.stdin), pipeline(child.stdout, compressedMeter, output), exited];
  for (const operation of work) operation.catch(() => child.kill());
  const results = await Promise.allSettled(work);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

/** One JSONL stream, one latest usable payload per API/app, no trained dictionary. */
export async function writeSteamDataArchive({ records, tagDictionary = [], outputDirectory, generatedAt = new Date().toISOString() }) {
  await mkdir(outputDirectory, { recursive: true });
  const temporary = resolve(outputDirectory, `.steam-data-${randomUUID()}.tmp`);
  const digest = createHash('sha256');
  let apps = 0, successfulApps = 0, picsApps = 0, bytes = 0, uncompressedBytes = 0, previousId = 0;
  async function* lines() {
    yield JSON.stringify({ format: STEAM_DATA_FORMAT, generatedAt, tagDictionary }) + '\n';
    for await (const record of records) {
      validateRecord(record);
      if (record.id <= previousId) throw new Error('Steam JSONL records must have unique increasing app IDs');
      previousId = record.id; apps++; successfulApps += Number(Boolean(record.store)); picsApps += Number(Boolean(record.appinfo));
      const line = JSON.stringify(record) + '\n';
      if (Buffer.byteLength(line) > STEAM_DATA_LIMITS.line) throw new Error('Steam record exceeds line limit');
      yield line;
    }
  }
  try {
    await compressArchive(Readable.from(lines()), meter({ maximum: STEAM_DATA_LIMITS.expanded, onSize: size => { uncompressedBytes = size; } }),
      meter({ maximum: STEAM_DATA_LIMITS.compressed, hash: digest, onSize: size => { bytes = size; } }), createWriteStream(temporary, { flags: 'wx' }));
    const sha256 = digest.digest('hex');
    const descriptor = { format: STEAM_DATA_FORMAT, file: `steam-raw.${sha256.slice(0, 16)}.jsonl.zst`, sha256, bytes, uncompressedBytes, apps, successfulApps, picsApps };
    await rename(temporary, resolve(outputDirectory, descriptor.file));
    return descriptor;
  } finally { await rm(temporary, { force: true }); }
}

/** Hash and validate while streaming; no multi-gigabyte Buffer or JSON.parse. */
export async function* readSteamDataArchive(filename, descriptor) {
  validateSteamDataDescriptor(descriptor);
  const info = await stat(filename);
  if (info.size !== descriptor.bytes) throw new Error('Steam JSONL archive size mismatch');
  const hash = createHash('sha256');
  const output = new Transform({ transform(chunk, encoding, callback) { callback(null, chunk); } });
  const transfer = pipeline(createReadStream(filename), meter({ maximum: STEAM_DATA_LIMITS.compressed, hash }), createZstdDecompress(),
    meter({ maximum: STEAM_DATA_LIMITS.expanded }), output);
  // Attach immediately so a corrupt stream cannot cause an unhandled rejection.
  transfer.catch(() => {});
  let header = false, count = 0, previousId = 0;
  try {
    for await (const line of jsonLines(output)) {
      const value = JSON.parse(line);
      if (!header) {
        if (value?.format !== STEAM_DATA_FORMAT || !Array.isArray(value.tagDictionary) || !Number.isFinite(Date.parse(value.generatedAt))) throw new Error('Invalid Steam JSONL header');
        header = true; yield value; continue;
      }
      validateRecord(value);
      if (value.id <= previousId) throw new Error('Unsorted or duplicate Steam JSONL app');
      previousId = value.id; count++; yield value;
    }
    await transfer;
    if (!header || count !== descriptor.apps || hash.digest('hex') !== descriptor.sha256) throw new Error('Steam JSONL archive checksum or app count mismatch');
  } finally { output.destroy(); await transfer.catch(() => {}); }
}

export async function restoreSteamData(store, filename, descriptor, { state } = {}) {
  let generatedAt;
  store.db.exec('BEGIN IMMEDIATE');
  try {
  for await (const record of readSteamDataArchive(filename, descriptor)) {
    if (record.format) { generatedAt = record.generatedAt; store.setting('tags', record.tagDictionary); continue; }
    const current = store.get(record.id);
    if (!current) store.seed(record.id, record.fallback);
    // Exporting an archive does not make its individual observations newer.
    const entry = state?.apps[record.id];
    const checkedAt = entry?.lastAttemptAt ?? generatedAt;
    if (!current?.store_checked || current.store_checked < checkedAt) {
      // Restoring a usable payload is not a new successful Steam lookup.
      if (record.store) store.putStore(record.id, record.store, { checkedAt });
      if (entry && entry.status !== 'ok') store.putStore(record.id, { id: record.id, success: entry.resultCode ?? 2 }, { checkedAt });
    }
    if (record.appinfo && (!current?.pics_checked || current.pics_checked < generatedAt)) store.putAppInfo(record.id, record.appinfo, { checkedAt: generatedAt });
  }
  store.setting('restoredArchive', descriptor.sha256);
  store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
