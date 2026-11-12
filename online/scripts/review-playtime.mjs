import { PLAYTIME_EDGES_HOURS } from './steam-playtime.mjs';

/** Percentiles are published in tenths of an hour, capped at the highest measured edge. */
export const PLAYTIME_CAP_TENTHS = PLAYTIME_EDGES_HOURS.at(-1) * 10;
/** A summary needs enough reviews with recorded playtime, and they must be most of the
 * reviews: titles whose playtime Steam tracks under another app (e.g. Call of Duty
 * launchers) otherwise describe a small, unrepresentative minority. */
export const MIN_KNOWN_REVIEWS = 20;
export const MIN_KNOWN_SHARE = 0.5;
/** Browser fields. The known-review count stays in the maintenance state: it compresses
 * poorly and the catalog's review total already signals small samples. */
export const PLAYTIME_FIELDS = Object.freeze(['playtimeP25', 'playtimeP50', 'playtimeP75']);

/** Two significant digits from 10 h upward keep the browser columns compressible;
 * the inputs are themselves interpolated estimates or small samples. */
export function roundTenths(tenths) {
  const value = Math.min(PLAYTIME_CAP_TENTHS, Math.max(0, tenths));
  if (value < 100) return Math.round(value);
  const scale = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Math.min(PLAYTIME_CAP_TENTHS, Math.round(value / scale) * scale);
}

/** Exact below 100; two significant digits above. */
export function roundCount(count) {
  if (count < 100) return count;
  const scale = 10 ** (Math.floor(Math.log10(count)) - 1);
  return Math.round(count / scale) * scale;
}

/** Linear interpolation between order statistics of exact minutes. */
function exactPercentile(sortedMinutes, p) {
  const position = (sortedMinutes.length - 1) * p, low = Math.floor(position), high = Math.ceil(position);
  const minutes = sortedMinutes[low] + (sortedMinutes[high] - sortedMinutes[low]) * (position - low);
  return minutes / 6;
}

/** Band counts are cumulative at inclusive edges (minutes <= hours * 60). Within a
 * band, playtime is spread geometrically (uniformly in the first, 0–3 h band); a
 * percentile beyond the last edge reports the cap. */
function bandPercentile(cumulative, known, p) {
  const target = p * known;
  for (let i = 0; i < PLAYTIME_EDGES_HOURS.length; i++) {
    if (cumulative[i] < target) continue;
    const lowerCount = i ? cumulative[i - 1] : 0, upper = PLAYTIME_EDGES_HOURS[i], lower = i ? PLAYTIME_EDGES_HOURS[i - 1] : 0;
    const fraction = cumulative[i] === lowerCount ? 1 : (target - lowerCount) / (cumulative[i] - lowerCount);
    return 10 * (i ? lower * (upper / lower) ** fraction : upper * fraction);
  }
  return PLAYTIME_CAP_TENTHS;
}

/** Exact number of reviews with recorded playtime at review in one measurement. */
export function knownPlaytimeReviews(record) {
  if (record.method === 'pages') return record.reviewRows.filter(review => review[3] !== null).length;
  // The known count and bands come from separate queries; never let a band exceed it.
  if (record.method === 'bands') return Math.max(record.total - record.unknownAtReview, record.cumulative.at(-1));
  throw new Error(`Unknown playtime method for app ${record.id}`);
}

/** One measurement -> [approximate known count, p25, p50, p75 (tenths of an hour)], or null. */
export function summarizePlaytime(record) {
  if (record?.outcome !== 'success') return null;
  const known = knownPlaytimeReviews(record);
  let percentile;
  if (record.method === 'pages') {
    const minutes = record.reviewRows.map(review => review[3]).filter(value => value !== null).sort((a, b) => a - b);
    percentile = p => exactPercentile(minutes, p);
  } else percentile = p => bandPercentile(record.cumulative, known, p);
  if (known < MIN_KNOWN_REVIEWS || known < MIN_KNOWN_SHARE * record.total) return null;
  return [roundCount(known), ...[0.25, 0.5, 0.75].map(p => roundTenths(percentile(p)))];
}

/** Replace any earlier summary; games without one keep unknown playtime. */
export function applyReviewPlaytime(games, index) {
  return games.map(game => {
    const summary = index.get(game.id);
    if (!summary && !PLAYTIME_FIELDS.some(key => Object.hasOwn(game, key))) return game;
    const result = { ...game };
    for (const key of PLAYTIME_FIELDS) delete result[key];
    return summary ? Object.assign(result, summary) : result;
  });
}
