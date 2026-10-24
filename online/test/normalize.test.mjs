import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeatureCatalog, indexReviews, normalizeGame, releaseISO, selectAppRecord, summarizeCoverage, validateCoverage } from '../scripts/normalize.mjs';
import { validateCatalogDescriptor } from '../scripts/sources.mjs';
import { features } from '../src/features.mjs';

const { categoryMap } = buildFeatureCatalog(features, [], new Set([2, 22, 23, 55, 56, 64]));
const genreNames = new Map([[1, 'Action'], [70, 'Early Access']]);
const app = overrides => ({ steam_appid: 123, type: 'game', name: 'Example', categories: [2, 22, 23], genres: [1], release_date: { coming_soon: false, date: '8 Oct, 2026' }, ...overrides });

test('distinct aliases collapse and Early Access uses current Steam genre only', () => {
  const game = normalizeGame(app({ categories: [2, 55, 56, 55], early_access_date: '2020-01-01' }), { reviews: 20, positivePercent: 90 }, categoryMap, genreNames);
  assert.equal(game.featureIds.length, 2);
  assert.equal(game.earlyAccess, false);
  assert.equal(game.reviews, 20);
  assert.equal(game.releaseISO, '2026-10-08');
});

test('missing and empty categories remain unknown, not confirmed absent', () => {
  for (const categories of [undefined, null, []]) {
    const game = normalizeGame(app({ categories, genres: undefined, release_date: undefined }), undefined, categoryMap, genreNames);
    assert.equal(game.featureDataKnown, false);
    assert.equal(game.reviews, null);
    assert.equal(game.earlyAccess, null);
    assert.equal(game.releaseStatus, 'unknown');
  }
});

test('source game types and upcoming status are retained faithfully', () => {
  assert.equal(normalizeGame(app({ type: 'dlc' }), null, categoryMap, genreNames), null);
  const game = normalizeGame(app({ genres: [70], release_date: { coming_soon: true, date: 'Q1 2027' } }), null, categoryMap, genreNames);
  assert.equal(game.earlyAccess, true);
  assert.equal(game.releaseStatus, 'upcoming');
  assert.equal(game.releaseDate, 'Q1 2027');
  assert.equal(game.releaseISO, null);
});

test('review source contributes only its review fields and preserves null', () => {
  const indexed = indexReviews([{ steam_appid: 123, steam_reviews_count: null, steam_reviews_percent: 101, categories: ['bogus'], genres: ['Early Access'] }, { steam_appid: 124, steam_reviews_count: 0, steam_reviews_percent: 0 }]);
  assert.deepEqual(indexed.get(123), { reviews: null, positivePercent: null });
  assert.deepEqual(indexed.get(124), { reviews: 0, positivePercent: 0 });
  assert.throws(() => indexReviews([{ steam_appid: 1 }, { steam_appid: 1 }]), /Duplicate/);
});

test('redirect aliases prefer the canonical source key regardless of iteration order', () => {
  for (const canonicalFirst of [true, false]) {
    const records = new Map();
    const inputs = [['123', app({ name: 'canonical' })], ['124', app({ name: 'alias' })]];
    for (const [key, value] of canonicalFirst ? inputs : inputs.reverse()) selectAppRecord(records, key, value);
    assert.equal(records.size, 1);
    assert.equal(records.get(123).record.name, 'canonical');
  }
});

test('new or malformed feature data blocks publication rather than silently dropping it', () => {
  assert.throws(() => buildFeatureCatalog(features, [], new Set([999])), /Unrecognized/);
  assert.throws(() => buildFeatureCatalog(features, [{ categoryid: 83, type: 1, name: 'New feature' }], new Set([83])), /classification/);
  assert.throws(() => normalizeGame(app({ categories: ['22'] }), null, categoryMap, genreNames), /Invalid category/);
});

test('legacy VR Support is omitted without inventing another VR feature', () => {
  const { categoryMap: mapping } = buildFeatureCatalog(features, [], new Set([2, 31, 53, 54]));
  assert.equal(mapping.has(31), false);
  const legacy = normalizeGame(app({ categories: [2, 31] }), null, mapping, genreNames);
  assert.deepEqual(legacy.featureIds, [2]);
  assert.equal(legacy.featureDataKnown, true);
  const distinct = normalizeGame(app({ categories: [2, 31, 53, 54] }), null, mapping, genreNames);
  assert.deepEqual(distinct.featureIds, [2, 53, 54]);
});

test('feature registry preserves weighting and multiplayer classification through import', () => {
  const { features: all } = buildFeatureCatalog(features, [], new Set());
  assert.equal(all.length, features.length);
  assert.equal(all.find(feature => feature.key === 'no-keyboard-mouse').weight, -1);
  assert.equal(all.filter(feature => feature.hardware).length, 15);
  const copied = all.filter(feature => !feature.knowledgeGroup);
  assert.equal(copied.length, 62);
  assert.equal(copied.filter(feature => !feature.accessibility).length, 42);
  assert.deepEqual(copied.filter(feature => feature.multiplayer).map(feature => feature.id).sort((a, b) => a - b), [1, 9, 20, 24, 27, 32, 36, 37, 38, 39, 47, 48, 49, 72, 73]);
  assert.deepEqual(copied.filter(feature => feature.weight === 0).map(feature => feature.id).sort((a, b) => a - b), [8, 16, 54, 60]);
  assert.deepEqual(copied.filter(feature => feature.weight < 0).map(feature => feature.id), [35]);
  for (const feature of copied) {
    assert.equal(feature.weight, feature.id === 23 ? 3 : feature.id === 22 ? 2 : feature.id === 35 ? -1 : [8, 16, 54, 60].includes(feature.id) ? 0 : 1);
    assert.equal(typeof feature.multiplayer, 'boolean');
  }
  const defaults = copied.filter(feature => !feature.accessibility && !feature.multiplayer && feature.group !== 'Remote Play');
  assert.equal(defaults.length, 25);
  assert.equal(defaults.reduce((score, feature) => score + Math.max(0, feature.weight), 0), 23);
  assert.equal(defaults.reduce((score, feature) => score + feature.weight, 0), 22);
  assert.equal(copied.some(feature => feature.key === 'vr-support'), false);
});

test('scoring metadata permits finite negative weights but rejects non-finite values', () => {
  assert.doesNotThrow(() => buildFeatureCatalog(features, [], new Set()));
  for (const weight of [NaN, Infinity, -Infinity, '1']) {
    const invalid = features.map(feature => feature.id === 35 ? { ...feature, weight } : feature);
    assert.throws(() => buildFeatureCatalog(invalid, [], new Set()), /scoring metadata/);
  }
});

test('date conversion keeps only precise valid calendar dates', () => {
  assert.equal(releaseISO('Oct 8, 2026'), '2026-10-08');
  assert.equal(releaseISO('2024-02-29'), '2024-02-29');
  for (const value of ['2025-02-29', '31 Feb, 2026', '2026', 'Oct 2026', 'Coming soon', null]) assert.equal(releaseISO(value), null);
});

test('coverage guard rejects empty and substantially degraded imports', () => {
  assert.throws(() => validateCoverage({ games: 0, knownFeatures: 0, knownReviews: 0 }), /small/);
  const good = { games: 100000, knownFeatures: 90000, knownReviews: 60000 };
  assert.doesNotThrow(() => validateCoverage(good));
  assert.throws(() => validateCoverage({ ...good, games: 89999 }, good), /collapse/);
  assert.throws(() => validateCoverage({ ...good, knownReviews: 50000 }, good), /collapse/);
  const coverage = summarizeCoverage([normalizeGame(app(), null, categoryMap, genreNames)]);
  assert.equal(coverage.knownReviews, 0);
  assert.equal(coverage.knownFeatures, 1);
});

test('previous catalog descriptors cannot contain origins or path traversal', () => {
  const descriptor = { catalog: 'catalog.0123456789abcdef.json', compressedCatalog: 'catalog.0123456789abcdef.json.gz', sha256: 'a'.repeat(64), gzipSha256: 'b'.repeat(64) };
  assert.equal(validateCatalogDescriptor(descriptor), descriptor);
  for (const catalog of ['../catalog.0123456789abcdef.json', 'https://example.com/data.json', '/data.json']) assert.throws(() => validateCatalogDescriptor({ ...descriptor, catalog }), /Untrusted/);
});
