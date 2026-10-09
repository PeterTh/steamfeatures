// Only Steam-specific appdetails determine features, app type and release status.
// Category 31 is the obsolete VR Support label, not an alias of newer VR flags.
export const OMITTED_CATEGORY_IDS = new Set([6, 7, 10, 19, 21, 31, 990]);
const MONTHS = new Map('Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ').map((name, i) => [name.toLowerCase(), i + 1]));

export function integerOrNull(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

export function releaseISO(value) {
  if (typeof value !== 'string') return null;
  let match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let year, month, day;
  if (match) [, year, month, day] = match.map(Number);
  else {
    match = value.match(/^(\d{1,2}) ([A-Za-z]{3}),? (\d{4})$/);
    if (match) { day = Number(match[1]); month = MONTHS.get(match[2].toLowerCase()); year = Number(match[3]); }
    else {
      match = value.match(/^([A-Za-z]{3}) (\d{1,2}),? (\d{4})$/);
      if (!match) return null;
      month = MONTHS.get(match[1].toLowerCase()); day = Number(match[2]); year = Number(match[3]);
    }
  }
  if (!month || year < 1900 || year > 2200) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function parseGenreDefinitions(text) {
  return new Map(text.trim().split(/\r?\n/).map(line => {
    const separator = line.indexOf('\t');
    if (separator < 1) throw new Error('Invalid upstream genre definitions');
    return [Number(line.slice(0, separator)), line.slice(separator + 1)];
  }));
}

export function readCategoryIds(record) {
  if (record.categories === undefined || record.categories === null) return [];
  if (!Array.isArray(record.categories)) throw new Error(`Invalid categories for ${record.steam_appid}`);
  return record.categories.map(value => {
    const id = typeof value === 'object' && value ? Number(value.id) : value;
    if (!Number.isSafeInteger(id) || id < 0) throw new Error(`Invalid category ID for ${record.steam_appid}`);
    return id;
  });
}

export function buildFeatureCatalog(baseFeatures, taxonomy, observedIds) {
  if (!Array.isArray(baseFeatures) || !Array.isArray(taxonomy)) throw new Error('Invalid feature definitions');
  const features = baseFeatures.map(feature => ({ ...feature, steamIds: [...feature.steamIds] }));
  const known = new Map();
  for (const feature of features) {
    if (!Number.isInteger(feature.id) || !feature.key || !feature.name) throw new Error('Invalid canonical feature');
    if (!Number.isFinite(feature.weight) || typeof feature.multiplayer !== 'boolean') throw new Error(`Invalid feature scoring metadata for ${feature.id}`);
    for (const id of feature.steamIds) {
      if (known.has(id)) throw new Error(`Duplicate Steam category alias ${id}`);
      known.set(id, feature.id);
    }
  }
  const definitions = new Map(taxonomy.map(item => [Number(item.categoryid), item]));
  const newFeatureIds = [];
  for (const id of [...observedIds].sort((a, b) => a - b)) {
    if (known.has(id) || OMITTED_CATEGORY_IDS.has(id)) continue;
    const source = definitions.get(id);
    if (!source) throw new Error(`Unrecognized Steam category ${id}; update src/features.mjs before publishing`);
    newFeatureIds.push(`${id} (${source.name}, type ${source.type})`);
  }
  // A new category might be accessibility: require an explicit classification.
  if (newFeatureIds.length) throw new Error(`New Steam features need classification in src/features.mjs: ${newFeatureIds.join(', ')}`);
  return { features, categoryMap: known };
}

export function indexReviews(rows) {
  if (!Array.isArray(rows)) throw new Error('The review source must be a JSON array');
  const reviews = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('Malformed review source row');
    const id = integerOrNull(row.steam_appid);
    if (!id || (row.kind && row.kind !== 'steam')) continue;
    if (reviews.has(id)) throw new Error(`Duplicate review source Steam ID ${id}`);
    reviews.set(id, {
      reviews: integerOrNull(row.steam_reviews_count),
      positivePercent: integerOrNull(row.steam_reviews_percent, 100)
    });
  }
  return reviews;
}

export function indexCommunityTags(rows) {
  if (!Array.isArray(rows)) throw new Error('The community-tag source must be a JSON array');
  const byApp = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('Malformed community-tag source row');
    const id = integerOrNull(row.steam_appid);
    if (!id || (row.kind && row.kind !== 'steam')) continue;
    if (byApp.has(id)) throw new Error(`Duplicate community-tag source Steam ID ${id}`);
    if (row.tags === undefined || row.tags === null) { byApp.set(id, null); continue; }
    if (!Array.isArray(row.tags) || row.tags.some(name => typeof name !== 'string' || !name.trim())) {
      throw new Error(`Invalid community tags for Steam app ${id}`);
    }
    const names = [...new Set(row.tags.map(name => name.trim()))].sort();
    byApp.set(id, names.length ? names : null);
  }
  return byApp;
}

export function attachCommunityTags(games, byApp) {
  // Only source-backed games contribute dictionary entries; DLC and unmatched IDs do not.
  const tags = [...new Set(games.flatMap(game => byApp.get(game.id) || []))].sort();
  const byName = new Map(tags.map((name, id) => [name, id]));
  return {
    tags,
    games: games.map(game => {
      const names = byApp.get(game.id);
      return names?.length ? { ...game, tagIds: names.map(name => byName.get(name)).sort((a, b) => a - b) } : game;
    })
  };
}

export function encodeTagIndex(games, tagCount) {
  if (!Number.isSafeInteger(tagCount) || tagCount < 0) throw new Error('Invalid tag dictionary size');
  const lists = Array.from({ length: tagCount }, () => []);
  const lastRows = Array(tagCount).fill(0);
  for (let row = 0; row < games.length; row++) {
    const ids = games[row].tagIds;
    if (ids === undefined) continue;
    if (!Array.isArray(ids)) throw new Error(`Invalid tag membership on game row ${row}`);
    let previous = -1;
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id < 0 || id >= tagCount || id <= previous) throw new Error(`Invalid or unsorted tag ID on game row ${row}`);
      lists[id].push(lists[id].length ? row - lastRows[id] : row);
      lastRows[id] = row;
      previous = id;
    }
  }
  return { encoding: 'delta-game-indices-v1', lists };
}

export function selectAppRecord(records, key, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`Malformed app ${key}`);
  const id = integerOrNull(record.steam_appid);
  if (!id) throw new Error(`Missing valid Steam app ID in app ${key}`);
  const canonical = Number(key) === id;
  const current = records.get(id);
  if (!current || (canonical && !current.canonical)) records.set(id, { record, canonical });
}

export function normalizeGame(record, reviews, categoryMap, genres) {
  if (record.type !== 'game') return null;
  if (record.name !== undefined && record.name !== null && typeof record.name !== 'string') throw new Error(`Invalid game name ${record.steam_appid}`);
  const ids = readCategoryIds(record);
  const featureIds = [...new Set(ids.filter(id => !OMITTED_CATEGORY_IDS.has(id)).map(id => {
    if (!categoryMap.has(id)) throw new Error(`Unmapped category ${id} on ${record.steam_appid}`);
    return categoryMap.get(id);
  }))].sort((a, b) => a - b);
  const genreIds = Array.isArray(record.genres) ? record.genres.map(value => Number(typeof value === 'object' ? value.id : value)) : null;
  if (genreIds?.some(id => !Number.isSafeInteger(id))) throw new Error(`Invalid genres on ${record.steam_appid}`);
  const release = record.release_date;
  const date = typeof release?.date === 'string' && release.date.trim() ? release.date.trim() : null;
  return {
    id: record.steam_appid, name: record.name?.trim() || `Steam app ${record.steam_appid}`, featureIds,
    featureDataKnown: ids.length > 0,
    reviews: reviews?.reviews ?? null,
    positivePercent: reviews?.positivePercent ?? null,
    releaseDate: date, releaseISO: releaseISO(date),
    releaseStatus: release?.coming_soon === true ? 'upcoming' : release?.coming_soon === false ? 'released' : 'unknown',
    earlyAccess: genreIds?.length ? genreIds.includes(70) : null,
    genres: genreIds ? [...new Set(genreIds.map(id => genres.get(id) ?? `Genre ${id}`))] : []
  };
}

export function summarizeCoverage(games, extra = {}) {
  return {
    games: games.length,
    released: games.filter(game => game.releaseStatus === 'released').length,
    upcoming: games.filter(game => game.releaseStatus === 'upcoming').length,
    unknownRelease: games.filter(game => game.releaseStatus === 'unknown').length,
    knownFeatures: games.filter(game => game.featureDataKnown).length,
    knownReviews: games.filter(game => game.reviews !== null).length,
    knownTags: games.filter(game => game.tagDataKnown === true || game.tagIds?.length > 0).length,
    unknownEarlyAccess: games.filter(game => game.earlyAccess === null).length,
    ...extra
  };
}

export function validateCoverage(coverage, previous, { fixture = false } = {}) {
  if (!fixture && coverage.games < 50000) throw new Error(`Suspiciously small catalog: ${coverage.games} games`);
  if (!fixture && (coverage.knownFeatures / coverage.games < 0.7 || coverage.knownReviews / coverage.games < 0.3)) {
    throw new Error('Feature or review coverage is unexpectedly incomplete');
  }
  if (previous) {
    for (const key of ['games', 'knownFeatures', 'knownReviews', 'knownTags']) {
      if (Number.isFinite(previous[key]) && coverage[key] < previous[key] * 0.9) {
        throw new Error(`Coverage collapse in ${key}: ${previous[key]} → ${coverage[key]}; keep previous deployment`);
      }
    }
  }
}
