import { prepareCatalog } from '../src/query.mjs';
import { PRIORITY_MIN_REVIEWS } from '../src/progressive-catalog.mjs';
import { encodeTagIndex } from './normalize.mjs';

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
