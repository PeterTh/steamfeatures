import { prepareCatalog, normalizeQuery } from '../../src/query.mjs';
import { encodeTagIndex } from '../../scripts/normalize.mjs';

export const PRIORITY_MIN_REVIEWS = 20;

/** Keep the original dictionaries and fields; rebuild postings for each partition. */
export function partitionCatalog(catalog) {
  const prepared = prepareCatalog(catalog);
  const { games, tagIndex, ...metadata } = catalog;
  const rows = games.map((game, i) => ({ ...game, tagIds: prepared.games[i].game.tagIds }));
  const partition = selected => ({ ...metadata, tagIndex: encodeTagIndex(selected, prepared.tags.length),
    games: selected.map(({ tagIds, ...game }) => game) });
  return {
    priority: partition(rows.filter((_, i) => prepared.games[i].reviews !== null && prepared.games[i].reviews >= PRIORITY_MIN_REVIEWS)),
    remainder: partition(rows.filter((_, i) => prepared.games[i].reviews === null || prepared.games[i].reviews < PRIORITY_MIN_REVIEWS)),
    statistics: { gameCount: games.length, tagCounts: prepared.tagCounts, knownTagCount: prepared.knownTagCount, languageCounts: prepared.languageCounts },
  };
}

/** Row-index postings remain local to each file, so offset the second file's first delta. */
export function mergeCatalogPartitions(priority, remainder) {
  const metadata = catalog => { const { games, tagIndex, ...rest } = catalog; return rest; };
  if (JSON.stringify(metadata(priority)) !== JSON.stringify(metadata(remainder))) throw new Error('Catalog partitions belong to different snapshots.');
  if (priority.tagIndex?.encoding !== 'delta-game-indices-v1' || remainder.tagIndex?.encoding !== 'delta-game-indices-v1' ||
      priority.tagIndex.lists.length !== remainder.tagIndex.lists.length) throw new Error('Invalid partition tag dictionaries.');
  const lists = priority.tagIndex.lists.map((left, id) => {
    const right = remainder.tagIndex.lists[id];
    if (!right.length) return [...left];
    const last = left.reduce((row, delta) => row + delta, 0);
    return [...left, priority.games.length + right[0] - last, ...right.slice(1)];
  });
  return { ...priority, games: [...priority.games, ...remainder.games], tagIndex: { ...priority.tagIndex, lists } };
}

export function queryUsesPriority(input, catalog) {
  return normalizeQuery(input, catalog.features, catalog.tags, catalog.languages).minReviews >= PRIORITY_MIN_REVIEWS;
}
