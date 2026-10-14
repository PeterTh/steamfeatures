import { normalizeQuery } from './query.mjs';
import { validateBinaryDescriptor } from './catalog-descriptor.mjs';

export const PRIORITY_MIN_REVIEWS = 20;

/** Pin both partitions and the full-catalogue picker counts to one snapshot. */
export function validateProgressiveDescriptor(descriptor, snapshot) {
  if (descriptor?.version !== 1 || descriptor.minReviews !== PRIORITY_MIN_REVIEWS ||
      !/^[a-f0-9]{64}$/.test(descriptor.snapshot) || descriptor.snapshot !== snapshot) {
    throw new Error('Invalid progressive catalog snapshot or review threshold.');
  }
  validateBinaryDescriptor(descriptor.priority);
  validateBinaryDescriptor(descriptor.remainder);
  const stats = descriptor.statistics;
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= stats.gameCount;
  if (!stats || !Number.isSafeInteger(stats.gameCount) || stats.gameCount < 0 || !count(stats.knownTagCount) ||
      !Array.isArray(stats.tagCounts) || !stats.tagCounts.every(count) ||
      !stats.languageCounts || typeof stats.languageCounts !== 'object' || Array.isArray(stats.languageCounts) ||
      !Object.keys(stats.languageCounts).every(id => /^(0|[1-9]\d*)$/.test(id)) || !Object.values(stats.languageCounts).every(count)) {
    throw new Error('Invalid progressive catalog statistics.');
  }
  return descriptor;
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
