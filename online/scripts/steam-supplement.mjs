import { DatabaseSync } from 'node:sqlite';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { gzipSync, gunzipSync, createGzip, createGunzip } from 'node:zlib';

export const SUPPLEMENT_FORMAT = 'steam-feature-atlas-supplement-v1';
const sources = ['achievements', 'requirements'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pack = value => gzipSync(Buffer.from(JSON.stringify(value)));
const unpack = value => value == null ? undefined : JSON.parse(gunzipSync(value, { maxOutputLength: 32 * 1024 * 1024 }));

/** The default group exists automatically. Only additional, active public sets
 * establish support. Unknown/malformed schemas must not become a negative. */
export function achievementSets(schema) {
  if (!object(schema) || !Number.isInteger(schema.schema_version) || !Number.isInteger(schema.schema_hash) ||
      !Array.isArray(schema.groups) || !schema.groups.length ||
      (schema.achievements !== undefined && !Array.isArray(schema.achievements))) {
    throw new Error('Incomplete achievement schema');
  }
  const ids = new Set();
  for (const group of schema.groups) {
    if (!object(group) || !Number.isInteger(group.groupid) || group.groupid < 0 || ids.has(group.groupid) ||
        !['ispublic', 'developeronly', 'archived'].every(key => typeof group[key] === 'boolean') ||
        !Number.isInteger(group.total_achievements) || group.total_achievements < 0) throw new Error('Malformed achievement group');
    ids.add(group.groupid);
  }
  // Steam omits the repeated achievements field for empty schemas (e.g.
  // Grapple). Explicit zero counts in every group establish emptiness; a
  // missing list alongside populated groups is still an incomplete response.
  if (schema.achievements === undefined && schema.groups.some(group => group.total_achievements > 0)) {
    throw new Error('Incomplete achievement schema');
  }
  return schema.groups.some(group => group.groupid > 0 && group.ispublic && !group.developeronly &&
    !group.archived && group.total_achievements > 0);
}

export function validateRequirements(body, id) {
  const entry = body?.[id];
  if (!object(entry) || typeof entry.success !== 'boolean') throw new Error('Malformed requirements response');
  if (!entry.success) return false;
  if (!object(entry.data)) throw new Error('Malformed requirements data');
  for (const [key, block] of Object.entries(entry.data)) {
    if (!['pc_requirements', 'mac_requirements', 'linux_requirements'].includes(key) ||
        !(object(block) || (Array.isArray(block) && !block.length)) ||
        Object.values(block).some(value => typeof value !== 'string')) throw new Error('Malformed requirements block');
  }
  // A visible listing can omit requirements altogether. That is unavailable,
  // unlike explicit empty platform blocks, which are successfully observed.
  return Object.keys(entry.data).length > 0;
}

/** Separate from the StoreBrowse/PICS database: source responses are compressed
 * once in a journal, with latest attempts and last usable responses referenced
 * independently. FULL synchronous commits precede progress/checkpoint success. */
export class SteamSupplementStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS apps (id INTEGER PRIMARY KEY, reviews INTEGER NOT NULL, achievements INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS app_priority ON apps(reviews DESC, id);
      CREATE TABLE IF NOT EXISTS responses (sequence INTEGER PRIMARY KEY, id INTEGER NOT NULL, source TEXT NOT NULL,
        checked_at TEXT NOT NULL, status INTEGER NOT NULL, result_code TEXT, body BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS response_app ON responses(id, source, sequence DESC);
      CREATE TABLE IF NOT EXISTS observations (id INTEGER NOT NULL, source TEXT NOT NULL, checked_at TEXT NOT NULL,
        outcome TEXT NOT NULL, latest_response INTEGER, successful_response INTEGER, has_sets INTEGER, error TEXT,
        PRIMARY KEY(id, source));`);
    this.counts = this.readCounts();
  }

  close() { this.db.close(); }
  setting(key, value) {
    if (value !== undefined) this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, JSON.stringify(value));
    return JSON.parse(this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? 'null');
  }

  seed(games, provenance) {
    if (this.setting('seed')) return;
    if (!Array.isArray(games) || !games.length) throw new Error('Cannot seed an empty collection');
    if (provenance.sources && (!Array.isArray(provenance.sources) || !provenance.sources.length ||
      new Set(provenance.sources).size !== provenance.sources.length || provenance.sources.some(source => !sources.includes(source)))) throw new Error('Invalid collection sources');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare('INSERT INTO apps VALUES (?, ?, ?)');
      for (const game of games) {
        if (!Number.isSafeInteger(game.id) || game.id <= 0 || game.id > 0xffffffff || !Array.isArray(game.featureIds)) throw new Error('Invalid collection seed');
        insert.run(game.id, Number.isSafeInteger(game.reviews) && game.reviews >= 0 ? game.reviews : 0, Number(game.featureIds.includes(22)));
      }
      this.setting('seed', { ...provenance, apps: games.length });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.counts = this.readCounts();
  }

  readCounts() {
    const planned = this.db.prepare('SELECT COUNT(*) AS apps, COALESCE(SUM(achievements),0) AS achievements FROM apps').get();
    const result = { apps: planned.apps, achievements: { planned: this.setting('seed')?.sources?.includes('achievements') === false ? 0 : planned.achievements,
      successful: 0, unavailable: 0, failed: 0 },
      requirements: { planned: this.setting('seed')?.sources?.includes('requirements') === false ? 0 : planned.apps,
        successful: 0, unavailable: 0, failed: 0 }, publicAchievementSets: 0 };
    for (const row of this.db.prepare('SELECT source,outcome,COUNT(*) AS n FROM observations GROUP BY source,outcome').all()) {
      result[row.source][row.outcome === 'success' ? 'successful' : row.outcome === 'error' ? 'failed' : 'unavailable'] = row.n;
    }
    result.publicAchievementSets = this.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE has_sets=1').get().n;
    return result;
  }

  progress() {
    const result = structuredClone(this.counts);
    for (const source of sources) result[source].checked = result[source].successful + result[source].unavailable;
    result.complete = sources.every(source => result[source].checked === result[source].planned);
    return result;
  }

  pending() {
    return this.db.prepare(`SELECT a.*, x.outcome AS achievement_outcome, r.outcome AS requirements_outcome FROM apps a
      LEFT JOIN observations x ON x.id=a.id AND x.source='achievements'
      LEFT JOIN observations r ON r.id=a.id AND r.source='requirements'
      WHERE (? AND a.achievements=1 AND (x.outcome IS NULL OR x.outcome='error')) OR (? AND (r.outcome IS NULL OR r.outcome='error'))
      ORDER BY a.reviews DESC,a.id`).all(Number(this.counts.achievements.planned > 0), Number(this.counts.requirements.planned > 0));
  }

  recordResponse({ method, input, body, status, resultCode }, checkedAt = new Date().toISOString()) {
    const source = method === 'IPlayerService/GetGameAchievements' ? 'achievements' : method === 'Store/AppDetails' ? 'requirements' : null;
    const id = input.appid ?? input.appids;
    if (!source || !this.db.prepare('SELECT id FROM apps WHERE id=?').get(id)) throw new Error('Response outside supplemental collection scope');
    this.db.prepare('INSERT INTO responses(id,source,checked_at,status,result_code,body) VALUES (?,?,?,?,?,?)')
      .run(id, source, checkedAt, status, resultCode, pack(body));
  }

  finish(id, source, { outcome, checkedAt = new Date().toISOString(), hasSets = null, error = null }) {
    if (!sources.includes(source) || !['success', 'unavailable', 'error'].includes(outcome)) throw new Error('Invalid observation');
    const old = this.db.prepare('SELECT * FROM observations WHERE id=? AND source=?').get(id, source);
    const latest = this.db.prepare('SELECT * FROM responses WHERE id=? AND source=? ORDER BY sequence DESC LIMIT 1').get(id, source);
    if (outcome !== 'error' && !latest) throw new Error('Cannot checkpoint an unarchived response');
    const successful = outcome === 'success' ? latest.sequence : old?.successful_response ?? null;
    const sets = outcome === 'success' && source === 'achievements' ? Number(hasSets) : old?.has_sets ?? null;
    this.db.prepare('INSERT OR REPLACE INTO observations VALUES (?,?,?,?,?,?,?,?)')
      .run(id, source, checkedAt, outcome, latest?.sequence ?? null, successful, sets, error);
    const key = value => value === 'success' ? 'successful' : value === 'error' ? 'failed' : 'unavailable';
    if (old) this.counts[source][key(old.outcome)]--;
    this.counts[source][key(outcome)]++;
    this.counts.publicAchievementSets += Number(sets === 1) - Number(old?.has_sets === 1);
  }

  *records() {
    yield { format: SUPPLEMENT_FORMAT, context: { language: 'english', countryCode: 'US' }, seed: this.setting('seed'), ...this.progress() };
    const observation = this.db.prepare(`SELECT o.*,good.checked_at AS successful_at,good.body AS data,last.status,last.result_code
      FROM observations o LEFT JOIN responses good ON good.sequence=o.successful_response
      LEFT JOIN responses last ON last.sequence=o.latest_response WHERE o.id=? ORDER BY o.source`);
    for (const { id } of this.db.prepare('SELECT id FROM apps ORDER BY id').iterate()) {
      const record = { id };
      for (const row of observation.all(id)) {
        const data = unpack(row.data);
        record[row.source] = { checkedAt: row.checked_at, outcome: row.outcome, status: row.status, resultCode: row.result_code,
          ...(row.error ? { error: row.error } : {}), ...(data ? { successfulAt: row.successful_at,
            data: row.source === 'achievements' ? data.response : data[id].data } : {}),
          ...(row.has_sets === null ? {} : { hasPublicSets: Boolean(row.has_sets) }) };
      }
      yield record;
    }
  }
}

export async function exportSupplement(store, directory) {
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, 'supplement.jsonl.gz.tmp');
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    // An interrupted export is safe to repeat under the collector's PID lock.
    await rm(temporary, { force: true });
    // Node's line reader also splits on Unicode line/paragraph separators.
    // JSON escapes keep one record per line without altering decoded text.
    await pipeline(Readable.from((function* () {
      for (const row of store.records()) yield JSON.stringify(row).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029') + '\n';
    })()),
      createGzip({ level: 9 }), new Transform({ transform(chunk, encoding, callback) {
        digest.update(chunk); bytes += chunk.length; callback(null, chunk);
      } }), createWriteStream(temporary, { flags: 'wx' }));
    const sha256 = digest.digest('hex');
    const descriptor = { format: SUPPLEMENT_FORMAT, file: `steam-supplement.${sha256.slice(0, 16)}.jsonl.gz`, sha256, bytes, apps: store.progress().apps };
    await verifySupplement(temporary, descriptor);
    await rename(temporary, resolve(directory, descriptor.file));
    return descriptor;
  } finally { await rm(temporary, { force: true }); }
}

export async function verifySupplement(filename, descriptor) {
  if (descriptor.format !== SUPPLEMENT_FORMAT || (await stat(filename)).size !== descriptor.bytes) throw new Error('Supplement size/format mismatch');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  if (digest.digest('hex') !== descriptor.sha256) throw new Error('Supplement checksum mismatch');
  const input = createReadStream(filename).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  let count = 0, previous = 0, header;
  const observed = { achievements: { successful: 0, unavailable: 0, failed: 0 }, requirements: { successful: 0, unavailable: 0, failed: 0 } };
  let positives = 0;
  try {
    for await (const line of lines) {
      const row = JSON.parse(line);
      if (!header) {
        if (row.format !== SUPPLEMENT_FORMAT || row.apps !== descriptor.apps) throw new Error('Invalid supplement header');
        header = row; continue;
      }
      if (!Number.isSafeInteger(row.id) || row.id <= previous) throw new Error('Invalid supplement app order');
      previous = row.id; count++;
      for (const source of sources) {
        const value = row[source];
        if (!value) continue;
        if (!['success', 'unavailable', 'error'].includes(value.outcome) || !Number.isFinite(Date.parse(value.checkedAt)) ||
            (value.outcome === 'success' && !value.data)) throw new Error('Invalid supplement observation');
        observed[source][value.outcome === 'success' ? 'successful' : value.outcome === 'error' ? 'failed' : 'unavailable']++;
      }
      if (row.achievements?.hasPublicSets) positives++;
      if (row.achievements?.data && achievementSets(row.achievements.data) !== row.achievements.hasPublicSets) throw new Error('Supplement achievement flag mismatch');
      if (row.requirements?.data) validateRequirements({ [row.id]: { success: true, data: row.requirements.data } }, row.id);
      if (header.complete && header.requirements.planned > 0 && (!row.requirements || !['success', 'unavailable'].includes(row.requirements.outcome))) throw new Error('Incomplete requirements in completed supplement');
    }
  } finally { lines.close(); input.destroy(); }
  if (!header || count !== descriptor.apps) throw new Error('Supplement app count mismatch');
  for (const source of sources) {
    for (const key of ['successful', 'unavailable', 'failed']) if (observed[source][key] !== header[source]?.[key]) throw new Error('Supplement source count mismatch');
    const checked = observed[source].successful + observed[source].unavailable;
    if (checked !== header[source].checked || (header.complete && checked !== header[source].planned)) throw new Error('Supplement source coverage mismatch');
  }
  if (positives !== header.publicAchievementSets) throw new Error('Supplement positive count mismatch');
  return { apps: count, sha256: descriptor.sha256 };
}
