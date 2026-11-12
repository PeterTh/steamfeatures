import { DatabaseSync } from 'node:sqlite';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { gzipSync, gunzipSync, createGzip, createGunzip } from 'node:zlib';

export const PLAYTIME_FORMAT = 'steam-feature-atlas-playtime-v1';
/** Cumulative "playtime at review <= edge" counts. Doubling edges give
 * ~2/5/10/20/40/80/150/300/600/1000+ hour buckets after projection. */
export const PLAYTIME_EDGES_HOURS = Object.freeze([3, 7, 14, 28, 56, 112, 225, 450, 900]);
export const PAGE_SIZE = 100;
/** A maximum no real playtime reaches: counts every review with known playtime. */
export const KNOWN_PLAYTIME_MAX_HOURS = 100000;
/** Up to this many reviews, paging through every review is no more expensive
 * than band counts and also yields lifetime playtime for each reviewer. */
export const FULL_PAGING_MAX_REVIEWS = 500;
export const PURCHASE_TYPE = Object.freeze({ steam: 0, all: 1 });
export const MIN_REVIEWS = 20;
const METHOD = 'IUserReviewsService/GetAppReviews';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const pack = value => gzipSync(Buffer.from(JSON.stringify(value)));
const unpack = value => JSON.parse(gunzipSync(value, { maxOutputLength: 32 * 1024 * 1024 }));

/** Steam's displayed review summary counts Steam purchases for paid games, but
 * every player for free-to-play games (whose reviews are not "purchases"). Using
 * all reviews for paid games would admit key and giveaway activations. The genre
 * is only the initial guess: Steam also counts every review for free games
 * without the genre (Poppy Playtime, Life is Strange - Episode 1) and for games
 * no longer sold on Steam (Fall Guys, Forza Horizon 4). measurePlaytime picks
 * whichever population matches the catalog's summary count. */
export function purchaseTypeFor(game) {
  return Array.isArray(game.genres) && game.genres.includes('Free To Play') ? PURCHASE_TYPE.all : PURCHASE_TYPE.steam;
}

export function reviewQuery(appid, purchaseType, { cursor = '*', numPerPage = PAGE_SIZE, maxHours } = {}) {
  return { appid, filter: 1, languages: ['all'], purchase_type: purchaseType, num_per_page: numPerPage,
    ...(maxHours === undefined ? { cursor } : { playtime_max_hours: maxHours }) };
}

/** Keep non-text review metadata only: no review text, developer responses,
 * hardware strings or author identity. Unknown numeric/boolean fields survive. */
export function retainedReview(review) {
  if (!object(review)) return review;
  const kept = {};
  for (const [key, value] of Object.entries(review)) {
    if (key === 'author' && object(value)) {
      kept.author = Object.fromEntries(Object.entries(value).filter(([field, v]) => field !== 'steamid' && typeof v === 'number'));
    } else if (['recommendationid', 'language'].includes(key) || ['number', 'boolean'].includes(typeof value)) kept[key] = value;
  }
  return kept;
}

export function retainedBody(body) {
  if (!object(body?.response) || !Array.isArray(body.response.reviews)) return body;
  return { ...body, response: { ...body.response, reviews: body.response.reviews.map(retainedReview) } };
}

function validTotal(response) {
  if (!object(response) || !count(response.total_matching)) throw new Error('Steam GetAppReviews: missing total_matching');
  return response.total_matching;
}

function validReviews(response) {
  const reviews = response.reviews ?? [];
  if (!Array.isArray(reviews)) throw new Error('Steam GetAppReviews: malformed reviews');
  for (const review of reviews) {
    if (!object(review) || typeof review.recommendationid !== 'string' || !/^\d+$/.test(review.recommendationid) ||
        !object(review.author) || !count(review.author.playtime_forever) ||
        !(review.author.playtime_at_review === undefined || count(review.author.playtime_at_review)) ||
        !count(review.timestamp_created) || typeof review.voted_up !== 'boolean') throw new Error('Steam GetAppReviews: malformed review');
  }
  return reviews;
}

const FLAGS = ['voted_up', 'steam_purchase', 'received_for_free', 'written_during_early_access', 'primarily_steam_deck', 'refunded'];
/** Compact archive row: [recommendationid, created, flags, minutes at review
 * (null if absent), lifetime minutes, last two weeks, last played, language]. */
export function compactReview(review) {
  const flags = FLAGS.reduce((bits, key, i) => bits | (review[key] === true ? 1 << i : 0), 0);
  const a = review.author;
  return [review.recommendationid, review.timestamp_created, flags, a.playtime_at_review ?? null, a.playtime_forever,
    a.playtime_last_two_weeks ?? 0, a.last_played ?? 0, review.language ?? null];
}

/** Cumulative counts from complete review data, using the API's inclusive
 * "at most N hours" semantics. Reviews without playtime_at_review are excluded. */
export function cumulativeFromReviews(rows) {
  return PLAYTIME_EDGES_HOURS.map(hours => rows.filter(row => row[3] !== null && row[3] <= hours * 60).length);
}

export class StopCollection extends Error {
  constructor() { super('Playtime collection stopped by limit or signal'); this.name = 'StopCollection'; }
}

/** One app: a 100-review first page gives the total. Small apps are paged
 * completely; larger ones (or incomplete paging) use cumulative band counts,
 * stopping once a band contains every review with known playtime at review.
 * Total minus the 900h count minus unknownAtReview is the 900h+ tail.
 * `take` gates each request. */
export async function measurePlaytime(client, { id, purchase_type: seededPurchaseType, reviews: catalogReviews }, take = () => {}) {
  let purchaseType = seededPurchaseType, requests = 1;
  const request = async (options, type = purchaseType) => { take(); return client.getAppReviews(reviewQuery(id, type, options)); };
  let first = await request({});
  let total = validTotal(first);
  // The genre only guesses whether Steam's summary counts every review (free
  // or delisted games) or Steam purchases. A mismatch with the catalog's
  // summary count checks the other population once and keeps the closer one.
  if (populationMismatch(total, catalogReviews)) {
    const other = purchaseType === PURCHASE_TYPE.all ? PURCHASE_TYPE.steam : PURCHASE_TYPE.all;
    const alternative = await request({}, other); requests++;
    const alternativeTotal = validTotal(alternative);
    if (populationDistance(alternativeTotal, catalogReviews) < populationDistance(total, catalogReviews)) {
      purchaseType = other; first = alternative; total = alternativeTotal;
    }
  }
  const byId = new Map(validReviews(first).map(review => [review.recommendationid, compactReview(review)]));
  const measured = result => ({ ...result, purchaseType, requests });
  if (total <= FULL_PAGING_MAX_REVIEWS) {
    let cursor = first.cursor;
    // Recent order eventually returns an empty page; bound the walk regardless.
    while (byId.size < total && typeof cursor === 'string' && requests < Math.ceil(total / PAGE_SIZE) + 2) {
      const page = await request({ cursor }); requests++;
      const reviews = validReviews(page);
      if (!reviews.length || page.cursor === cursor) break;
      for (const review of reviews) byId.set(review.recommendationid, compactReview(review));
      cursor = page.cursor;
    }
    if (byId.size >= total) {
      const rows = [...byId.values()];
      return measured({ method: 'pages', total: rows.length, cumulative: cumulativeFromReviews(rows), measuredEdges: PLAYTIME_EDGES_HOURS.length,
        unknownAtReview: rows.filter(row => row[3] === null).length });
    }
  }
  // Band filters skip reviews without playtime_at_review (mostly old reviews).
  // Counting those with any known playtime keeps them out of the top band and
  // lets the ascending bands stop once every known review is covered.
  const known = validTotal(await request({ numPerPage: 1, maxHours: KNOWN_PLAYTIME_MAX_HOURS })); requests++;
  const cumulative = [];
  for (const hours of PLAYTIME_EDGES_HOURS) {
    if ((cumulative.at(-1) ?? 0) >= known) break;
    cumulative.push(validTotal(await request({ numPerPage: 1, maxHours: hours }))); requests++;
  }
  const measuredEdges = cumulative.length;
  while (cumulative.length < PLAYTIME_EDGES_HOURS.length) cumulative.push(cumulative.at(-1) ?? 0);
  return measured({ method: 'bands', total, cumulative, measuredEdges, unknownAtReview: Math.max(0, total - known) });
}

/** The matching population lands within ~2% of the catalog's summary count;
 * check the other one beyond 5% and at least 20 reviews (small counts drift). */
export function populationMismatch(total, catalogReviews) {
  if (!Number.isSafeInteger(catalogReviews) || catalogReviews <= 0) return false;
  return Math.abs(total - catalogReviews) >= 20 && (total < catalogReviews * 0.95 || total > catalogReviews * 1.05);
}
const populationDistance = (total, catalogReviews) => Math.abs(Math.log((total + 1) / (catalogReviews + 1)));

/** Separate checkpoint: compressed response journal plus one observation per
 * app. Observations reference the journal range that produced them. */
export class SteamPlaytimeStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS apps (id INTEGER PRIMARY KEY, reviews INTEGER NOT NULL, purchase_type INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS app_priority ON apps(reviews DESC, id);
      CREATE TABLE IF NOT EXISTS responses (sequence INTEGER PRIMARY KEY, id INTEGER NOT NULL, kind TEXT NOT NULL,
        parameter TEXT, checked_at TEXT NOT NULL, status INTEGER NOT NULL, result_code TEXT, body BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS response_app ON responses(id, sequence);
      CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL, outcome TEXT NOT NULL,
        method TEXT, total INTEGER, cumulative TEXT, measured_edges INTEGER, unknown_at_review INTEGER,
        first_response INTEGER, last_response INTEGER, error TEXT);`);
    // Population per response/observation; NULL in older checkpoints means the
    // app's seeded population, which was the only one requested before.
    for (const table of ['responses', 'observations']) {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'purchase_type')) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN purchase_type INTEGER`);
      }
    }
    this.counts = this.readCounts();
  }

  /** Make completed apps pending again, keeping their journaled responses. */
  remeasure(ids, reason, at = new Date().toISOString()) {
    if (!Array.isArray(ids) || !ids.length || typeof reason !== 'string' || !reason) throw new Error('Remeasuring requires app IDs and a reason');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = [];
      for (const id of ids) {
        const row = this.db.prepare("SELECT * FROM observations WHERE id=? AND outcome IN ('success','unavailable')").get(id);
        if (!row) throw new Error(`App ${id} has no completed playtime observation`);
        this.db.prepare('DELETE FROM observations WHERE id=?').run(id);
        removed.push({ ...row });
      }
      this.setting('remeasured', [...(this.setting('remeasured') ?? []), { at, reason, observations: removed }]);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.counts = this.readCounts();
  }

  close() { this.db.close(); }
  setting(key, value) {
    if (value !== undefined) this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, JSON.stringify(value));
    return JSON.parse(this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? 'null');
  }

  /** The scope is frozen at seeding: apps with at least `minReviews` reviews and
   * the review population matching Steam's displayed summary. */
  seed(games, provenance, { minReviews = MIN_REVIEWS } = {}) {
    if (this.setting('seed')) return;
    if (!Array.isArray(games) || !Number.isSafeInteger(minReviews) || minReviews < 1) throw new Error('Invalid playtime seed');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare('INSERT INTO apps VALUES (?, ?, ?)');
      let apps = 0;
      for (const game of games) {
        if (!Number.isSafeInteger(game.id) || game.id <= 0 || game.id > 0xffffffff) throw new Error('Invalid playtime seed');
        if (!(Number.isSafeInteger(game.reviews) && game.reviews >= minReviews)) continue;
        insert.run(game.id, game.reviews, purchaseTypeFor(game)); apps++;
      }
      if (!apps) throw new Error('Cannot seed an empty playtime collection');
      this.setting('seed', { ...provenance, minReviews, apps, edgesHours: PLAYTIME_EDGES_HOURS,
        fullPagingMaxReviews: FULL_PAGING_MAX_REVIEWS, query: reviewQuery(0, 'per-app') });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.counts = this.readCounts();
  }

  readCounts() {
    const result = { apps: this.db.prepare('SELECT COUNT(*) AS n FROM apps').get().n, successful: 0, unavailable: 0, failed: 0,
      methods: { pages: 0, bands: 0 } };
    for (const row of this.db.prepare('SELECT outcome,method,COUNT(*) AS n FROM observations GROUP BY outcome,method').all()) {
      result[row.outcome === 'success' ? 'successful' : row.outcome === 'error' ? 'failed' : 'unavailable'] += row.n;
      if (row.outcome === 'success') result.methods[row.method] += row.n;
    }
    return result;
  }

  progress() {
    const result = structuredClone(this.counts);
    result.checked = result.successful + result.unavailable;
    result.complete = result.apps > 0 && result.checked === result.apps;
    return result;
  }

  pending() {
    return this.db.prepare(`SELECT a.* FROM apps a LEFT JOIN observations o ON o.id=a.id
      WHERE o.outcome IS NULL OR o.outcome='error' ORDER BY a.reviews DESC, a.id`).all();
  }

  lastSequence() { return this.db.prepare('SELECT MAX(sequence) AS n FROM responses').get().n ?? 0; }

  recordResponse({ method, input, body, status, resultCode }, checkedAt = new Date().toISOString()) {
    if (method !== METHOD || !this.db.prepare('SELECT id FROM apps WHERE id=?').get(input.appid)) throw new Error('Response outside playtime collection scope');
    const band = input.playtime_max_hours !== undefined;
    this.db.prepare('INSERT INTO responses(id,kind,parameter,checked_at,status,result_code,body,purchase_type) VALUES (?,?,?,?,?,?,?,?)')
      .run(input.appid, band ? 'band' : 'page', String(band ? input.playtime_max_hours : input.cursor), checkedAt, status, resultCode,
        pack(retainedBody(body)), input.purchase_type ?? null);
  }

  finish(id, { outcome, checkedAt = new Date().toISOString(), firstResponse = null, result = null, error = null }) {
    if (!['success', 'unavailable', 'error'].includes(outcome)) throw new Error('Invalid playtime observation');
    const old = this.db.prepare('SELECT outcome,method FROM observations WHERE id=?').get(id);
    if (old && old.outcome !== 'error') throw new Error('Playtime observation already completed');
    const last = this.db.prepare('SELECT MAX(sequence) AS n FROM responses WHERE id=? AND sequence>=?').get(id, firstResponse ?? 0).n;
    if (outcome !== 'error' && (!firstResponse || !last)) throw new Error('Cannot checkpoint an unarchived playtime response');
    this.db.prepare(`INSERT OR REPLACE INTO observations(id,checked_at,outcome,method,total,cumulative,measured_edges,
      unknown_at_review,first_response,last_response,error,purchase_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, checkedAt, outcome,
      result?.method ?? null, result?.total ?? null, result ? JSON.stringify(result.cumulative) : null, result?.measuredEdges ?? null,
      result?.unknownAtReview ?? null, firstResponse, last ?? null, error, result?.purchaseType ?? null);
    const key = value => value === 'success' ? 'successful' : value === 'error' ? 'failed' : 'unavailable';
    if (old) this.counts[key(old.outcome)]--;
    this.counts[key(outcome)]++;
    if (outcome === 'success') this.counts.methods[result.method]++;
  }

  *records() {
    yield { format: PLAYTIME_FORMAT, seed: this.setting('seed'), edgesHours: PLAYTIME_EDGES_HOURS,
      review: ['recommendationid', 'created', `flags:${FLAGS.join('|')}`, 'minutesAtReview', 'minutesForever', 'minutesLastTwoWeeks', 'lastPlayed', 'language'],
      ...this.progress() };
    const observation = this.db.prepare('SELECT * FROM observations WHERE id=?');
    const pages = this.db.prepare(`SELECT body FROM responses WHERE id=? AND kind='page' AND status=200 AND sequence BETWEEN ? AND ?
      AND COALESCE(purchase_type, ?)=? ORDER BY sequence`);
    for (const app of this.db.prepare('SELECT * FROM apps ORDER BY id').iterate()) {
      const row = observation.get(app.id);
      const record = { id: app.id, reviews: app.reviews, purchaseType: app.purchase_type };
      if (row) {
        record.checkedAt = row.checked_at; record.outcome = row.outcome;
        if (row.error) record.error = row.error;
        if (row.outcome === 'success') {
          const used = row.purchase_type ?? app.purchase_type;
          if (used !== app.purchase_type) Object.assign(record, { purchaseType: used, seededPurchaseType: app.purchase_type });
          const byId = new Map();
          for (const { body } of pages.all(app.id, row.first_response, row.last_response, app.purchase_type, used)) {
            for (const review of unpack(body).response.reviews ?? []) byId.set(review.recommendationid, compactReview(review));
          }
          Object.assign(record, { method: row.method, total: row.total, cumulative: JSON.parse(row.cumulative),
            measuredEdges: row.measured_edges, unknownAtReview: row.unknown_at_review,
            reviewRows: [...byId.values()] });
        }
      }
      yield record;
    }
  }
}

export async function exportPlaytime(store, directory) {
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, 'playtime.jsonl.gz.tmp');
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    await rm(temporary, { force: true });
    await pipeline(Readable.from((function* () { for (const row of store.records()) yield JSON.stringify(row) + '\n'; })()),
      createGzip({ level: 9 }), new Transform({ transform(chunk, encoding, callback) {
        digest.update(chunk); bytes += chunk.length; callback(null, chunk);
      } }), createWriteStream(temporary, { flags: 'wx' }));
    const sha256 = digest.digest('hex');
    const descriptor = { format: PLAYTIME_FORMAT, file: `steam-playtime.${sha256.slice(0, 16)}.jsonl.gz`, sha256, bytes, apps: store.progress().apps };
    await verifyPlaytime(temporary, descriptor);
    await rename(temporary, resolve(directory, descriptor.file));
    return descriptor;
  } finally { await rm(temporary, { force: true }); }
}

export async function verifyPlaytime(filename, descriptor) {
  if (descriptor.format !== PLAYTIME_FORMAT || (await stat(filename)).size !== descriptor.bytes) throw new Error('Playtime archive size/format mismatch');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  if (digest.digest('hex') !== descriptor.sha256) throw new Error('Playtime archive checksum mismatch');
  const input = createReadStream(filename).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header, apps = 0, previous = 0;
  const observed = { successful: 0, unavailable: 0, failed: 0, methods: { pages: 0, bands: 0 } };
  try {
    for await (const line of lines) {
      const row = JSON.parse(line);
      if (!header) {
        if (row.format !== PLAYTIME_FORMAT || row.apps !== descriptor.apps || JSON.stringify(row.edgesHours) !== JSON.stringify(PLAYTIME_EDGES_HOURS)) throw new Error('Invalid playtime header');
        header = row; continue;
      }
      if (!Number.isSafeInteger(row.id) || row.id <= previous) throw new Error('Invalid playtime app order');
      previous = row.id; apps++;
      if (!row.outcome) { if (header.complete) throw new Error('Unchecked app in completed playtime archive'); continue; }
      if (!['success', 'unavailable', 'error'].includes(row.outcome) || !Number.isFinite(Date.parse(row.checkedAt))) throw new Error('Invalid playtime observation');
      observed[row.outcome === 'success' ? 'successful' : row.outcome === 'error' ? 'failed' : 'unavailable']++;
      if (row.outcome !== 'success') continue;
      observed.methods[row.method]++;
      if (!['pages', 'bands'].includes(row.method) || !count(row.total) || !Array.isArray(row.cumulative) ||
          row.cumulative.length !== PLAYTIME_EDGES_HOURS.length || !row.cumulative.every(count) ||
          !Number.isSafeInteger(row.measuredEdges) || row.measuredEdges < 0 || row.measuredEdges > PLAYTIME_EDGES_HOURS.length ||
          !count(row.unknownAtReview) || row.unknownAtReview > row.total || !Array.isArray(row.reviewRows)) throw new Error('Invalid playtime measurement');
      if (row.method === 'pages' && (row.reviewRows.length !== row.total ||
          row.reviewRows.filter(review => review[3] === null).length !== row.unknownAtReview ||
          JSON.stringify(cumulativeFromReviews(row.reviewRows)) !== JSON.stringify(row.cumulative))) throw new Error('Playtime page histogram mismatch');
    }
  } finally { lines.close(); input.destroy(); }
  if (!header || apps !== descriptor.apps) throw new Error('Playtime app count mismatch');
  for (const key of ['successful', 'unavailable', 'failed']) if (observed[key] !== header[key]) throw new Error('Playtime count mismatch');
  for (const key of ['pages', 'bands']) if (observed.methods[key] !== header.methods[key]) throw new Error('Playtime method count mismatch');
  return { apps, sha256: descriptor.sha256 };
}
