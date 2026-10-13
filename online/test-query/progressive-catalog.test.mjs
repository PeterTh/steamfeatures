import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionCatalog, mergeCatalogPartitions, queryUsesPriority } from '../prototypes/progressive-catalog/catalog.mjs';
import { prepareCatalog, runQuery } from '../src/query.mjs';
import { encodeTagIndex } from '../scripts/normalize.mjs';
import { encodeBinaryCatalog } from '../scripts/catalog-binary.mjs';
import { decodeBinaryCatalog } from '../src/catalog-binary.mjs';
import { LANGUAGES, encodeLanguageFlags, languageByKey } from '../src/languages.mjs';

const features = [{ id: 2, key: 'single-player', name: 'Single-player', weight: 1 },
  { id: 23, key: 'steam-cloud', name: 'Steam Cloud', weight: 3 },
  { id: 64, key: 'adjustable-text-size', name: 'Adjustable Text Size', accessibility: true, weight: 5 }];
const languageBits = encodeLanguageFlags([[languageByKey('english').id, 7], [languageByKey('german').id, 5]]);
const game = (id, reviews, patch = {}) => ({ id, name: 'Game ' + id, ...(reviews === undefined ? {} : { reviews }), featureIds: [2, 23], featureDataKnown: true,
  earlyAccess: false, releaseStatus: 'released', releaseISO: '2020-01-01', positivePercent: 90, tagIds: [0, 1], languageBits, ...patch });
const rows = [game(1, 20), game(2, 19, { tagIds: [2] }), game(3, null, { tagIds: [], tagDataKnown: true }),
  game(4, undefined, { tagIds: [] }), game(5, 100, { earlyAccess: true }), game(6, 22, { releaseStatus: 'upcoming' }),
  game(7, 25, { featureIds: [2, 64] }), game(8, -3), game(9, '20')];
const catalog = { version: 1, importedAt: '2026-10-13T00:00:00Z', features, tags: ['RPG', 'Action', 'Puzzle'], languages: LANGUAGES,
  tagIndex: encodeTagIndex(rows, 3), games: rows.map(({ tagIds, ...game }) => game) };
const wire = value => decodeBinaryCatalog(encodeBinaryCatalog(value));

test('priority partition includes all valid 20+ review games, including Early Access and upcoming titles', () => {
  const parts = partitionCatalog(catalog);
  assert.deepEqual(parts.priority.games.map(game => game.id), [1, 5, 6, 7]);
  assert.deepEqual(parts.remainder.games.map(game => game.id), [2, 3, 4, 8, 9]);
  const original = prepareCatalog(catalog);
  assert.deepEqual(parts.statistics, { gameCount: 9, tagCounts: original.tagCounts, knownTagCount: original.knownTagCount, languageCounts: original.languageCounts });
  assert.equal(catalog.games.some(game => Object.hasOwn(game, 'tagIds')), false);
});

test('20+ queries have exactly the full-catalogue rows, totals, ranks and columns in either archive order', () => {
  const { priority } = partitionCatalog(catalog);
  for (const sort of ['score-desc', 'score-asc', 'features-desc', 'title-asc', 'reviews-desc', 'rating-asc', 'release-desc']) {
    for (const filters of [{}, { minReviews: 21 }, { includeEarlyAccess: true, release: 'all' },
      { hasTags: ['Action'], includeAccessibility: true }, { not: ['steam-cloud'] },
      { hasLanguages: ['german:interface'], notLanguages: ['german:audio'] }, { q: 'Game', page: 99 }]) {
      const query = { ...filters, sort };
      assert.deepEqual(runQuery(wire(priority), query), runQuery(catalog, query));
    }
  }
  assert(queryUsesPriority({}, catalog));
  assert(queryUsesPriority({ minReviews: '20' }, catalog));
  assert.equal(queryUsesPriority({ minReviews: 19 }, catalog), false);
  assert.equal(queryUsesPriority({ minReviews: 0 }, catalog), false);
  assert.throws(() => queryUsesPriority({ minReviews: -1 }, catalog), /whole number/);
});

test('merging encoded partitions preserves low/unknown review queries and row-local tag postings', () => {
  const parts = partitionCatalog(catalog);
  const merged = mergeCatalogPartitions(wire(parts.priority), wire(parts.remainder));
  const actual = prepareCatalog(merged), expected = prepareCatalog(catalog);
  assert.deepEqual(actual.tagCounts, expected.tagCounts);
  assert.deepEqual(actual.languageCounts, expected.languageCounts);
  for (const query of [{ minReviews: 0 }, { minReviews: 19 }, { minReviews: 0, hasTags: ['Puzzle'] },
    { minReviews: 0, notTags: ['RPG'] }, { minReviews: 0, includeEarlyAccess: true, release: 'all' }]) {
    assert.deepEqual(runQuery(merged, query), runQuery(catalog, query));
  }
  assert.throws(() => mergeCatalogPartitions(parts.priority, { ...parts.remainder, importedAt: 'different' }), /different snapshots/);
  assert.throws(() => prepareCatalog(mergeCatalogPartitions(parts.priority, parts.priority)), /duplicate game IDs/);
});

test('either partition can be empty without losing dictionaries or tag membership', () => {
  for (const games of [rows.slice(0, 1), rows.slice(1, 2), []]) {
    const source = { ...catalog, games: games.map(({ tagIds, ...game }) => game), tagIndex: encodeTagIndex(games, 3) };
    const parts = partitionCatalog(source);
    assert.deepEqual(runQuery(mergeCatalogPartitions(wire(parts.priority), wire(parts.remainder)), { minReviews: 0 }), runQuery(source, { minReviews: 0 }));
  }
});
