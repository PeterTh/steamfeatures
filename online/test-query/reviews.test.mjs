import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_QUERY, normalizeQuery, parseQuery, serializeQuery, runQuery } from '../src/query.mjs';

const game = (id, reviews, positivePercent, extra = {}) => ({ id, name: 'Game ' + id, reviews, positivePercent,
  featureIds: [], featureDataKnown: true, earlyAccess: false, releaseStatus: 'released', ...extra });
const catalog = { features: [], games: [game(1, 0, 0), game(2, 19, 0), game(3, 20, 79.5), game(4, 25, 80),
  game(5, 100, 90), game(6, 1000, 100), game(7, null, null), game(8, 50, null), game(9, null, 95)] };
const ids = query => runQuery(catalog, query).rows.map(row => row.id).sort((a,b) => a-b);

test('review-count bounds are inclusive, combine, and exclude unknown counts only when constrained', () => {
  assert.deepEqual(ids({ minReviews: 20, maxReviews: 25 }), [3, 4]);
  assert.deepEqual(ids({ minReviews: 0, maxReviews: 19 }), [1, 2]);
  assert.deepEqual(ids({ minReviews: 0, maxReviews: 0 }), [1]);
  assert.deepEqual(ids({ minReviews: 0 }), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(ids({}), [3, 4, 5, 6, 8]);
});

test('rating bounds include zero, 100 and fractional endpoints while preserving unknown ratings', () => {
  assert.deepEqual(ids({ minReviews: 0, minRating: 0, maxRating: 0 }), [2]);
  assert.deepEqual(ids({ minRating: 100, maxRating: 100 }), [6]);
  assert.deepEqual(ids({ minRating: 79.5, maxRating: 80 }), [3, 4]);
  assert.deepEqual(ids({ minReviews: 0, minRating: 0, maxRating: 100 }), [2, 3, 4, 5, 6, 9]);
  assert.deepEqual(ids({ minReviews: 0, minRating: 90, maxRating: 95 }), [5, 9], 'a known percentage does not require a known count');
});

test('all four review bounds and other game filters apply together', () => {
  const query = { minReviews: 20, maxReviews: 100, minRating: 80, maxRating: 90 };
  assert.deepEqual(ids(query), [4, 5]);
  assert.deepEqual(ids({ ...query, q: 'Game 5' }), [5]);
  assert.deepEqual(ids({ ...query, release: 'upcoming' }), []);
});

test('invalid, unsafe and inverted review ranges are rejected', () => {
  for (const input of [{ minReviews: -1 }, { maxReviews: 1.5 }, { maxReviews: Number.MAX_SAFE_INTEGER + 1 },
    { minReviews: 20, maxReviews: 19 }, { minRating: -1 }, { maxRating: 100.1 }, { minRating: Infinity },
    { maxRating: true }, { minRating: '0x10' }, { minRating: 90, maxRating: 80 }]) {
    assert.throws(() => normalizeQuery(input, []), /review (count|rating)/i, JSON.stringify(input));
  }
});

test('review URLs retain explicit zero bounds, omit empty bounds and round trip percentages', () => {
  for (const input of [{ minReviews: 0, maxReviews: 0, minRating: 0, maxRating: 100 },
    { minReviews: 20, maxReviews: 10000, minRating: 79.5, maxRating: 99.9 }, { minRating: 1e-7 }]) {
    const query = normalizeQuery(input, []);
    assert.deepEqual(parseQuery(serializeQuery(query, []), []), query);
  }
  assert.equal(serializeQuery(DEFAULT_QUERY, []), '');
  assert.equal(normalizeQuery({ maxReviews: '', minRating: '', maxRating: '' }, []).maxReviews, null);
  assert.throws(() => parseQuery('?maxReviews=100&maxReviews=200', []), /Conflicting/);
  assert.throws(() => parseQuery('?minReviews=100&maxReviews=20', []), /Minimum review count/);
});

test('release choices distinguish finished releases, Early Access, upcoming and unknown data', () => {
  const games = ['released', 'upcoming', 'unknown'].flatMap((releaseStatus, status) =>
    [false, true, null].map((earlyAccess, access) => game(status * 3 + access + 1, 100, 90, { releaseStatus, earlyAccess })));
  const releaseIds = input => runQuery({ features: [], games }, input).rows.map(row => row.id).sort((a,b) => a-b);
  assert.deepEqual(releaseIds({}), [1]);
  assert.deepEqual(releaseIds({ release: 'released-ea' }), [1, 2, 3]);
  assert.deepEqual(releaseIds({ release: 'early-access' }), [2]);
  assert.deepEqual(releaseIds({ release: 'upcoming' }), [4, 5, 6]);
  assert.deepEqual(releaseIds({ release: 'all' }), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(releaseIds(parseQuery('?ea=1', [])), [1, 2, 3]);
  for (const release of ['released', 'released-ea', 'early-access', 'upcoming', 'all']) {
    assert.equal(parseQuery(serializeQuery({ release }, []), []).release, release);
  }
});
