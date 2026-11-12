import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_QUERY, normalizeQuery, parseQuery, serializeQuery, runQuery, prepareCatalog } from '../src/query.mjs';
import { parseExpression, basicExpression, expressionToBasic, expressionCompletions } from '../src/query-expression.mjs';

// Median playtime (playtimeP50) is published in tenths of an hour.
const game = (id, median, extra = {}) => ({ id, name: 'Game ' + id, reviews: 100, positivePercent: 90, featureIds: [], featureDataKnown: true,
  earlyAccess: false, releaseStatus: 'released', ...(median === null ? {} : { playtimeP25: Math.floor(median / 2), playtimeP50: median, playtimeP75: median * 2 }), ...extra });
const catalog = { features: [], games: [game(1, 0), game(2, 25), game(3, 100), game(4, 400), game(5, 9000), game(6, null), game(7, 120, { reviews: 10 })] };
const ids = query => runQuery(catalog, query).rows.map(row => row.id).sort((a, b) => a - b);

test('median playtime bounds are inclusive hours and exclude unknown playtime only when constrained', () => {
  assert.deepEqual(ids({}), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ids({ minPlaytime: 10 }), [3, 4, 5]);
  assert.deepEqual(ids({ minPlaytime: 2.5, maxPlaytime: 10 }), [2, 3]);
  assert.deepEqual(ids({ maxPlaytime: 0 }), [1]);
  assert.deepEqual(ids({ minPlaytime: 900 }), [5], 'the cap is 900 h');
  assert.deepEqual(ids({ minPlaytime: 0 }), [1, 2, 3, 4, 5], 'an explicit zero minimum requires known playtime');
  assert.deepEqual(ids({ minPlaytime: 10, minReviews: 0 }), [3, 4, 5, 7], 'combines with review bounds');
});

test('playtime bounds validate, round trip through URLs and reject inverted ranges', () => {
  for (const input of [{ minPlaytime: -1 }, { maxPlaytime: 'x' }, { minPlaytime: Infinity }, { minPlaytime: 20, maxPlaytime: 10 }, { maxPlaytime: true }]) {
    assert.throws(() => normalizeQuery(input, []), /median playtime/i, JSON.stringify(input));
  }
  for (const input of [{ minPlaytime: 0 }, { minPlaytime: 2.5, maxPlaytime: 40 }, { maxPlaytime: 1000 }]) {
    const query = normalizeQuery(input, []);
    assert.deepEqual(parseQuery(serializeQuery(query, []), []), query);
  }
  assert.equal(serializeQuery({ minPlaytime: 5, maxPlaytime: 20 }, []), '?v=1&minPlaytime=5&maxPlaytime=20');
  assert.equal(normalizeQuery({ minPlaytime: '' }, []).minPlaytime, null);
  assert.equal(serializeQuery(DEFAULT_QUERY, []), '');
  assert.throws(() => parseQuery('?v=2&expr=playtime%20%3E%3D%201&minPlaytime=1', []), /basic filter parameters/);
});

test('sorting by median playtime puts unknown values last in both directions', () => {
  const order = sort => runQuery(catalog, { sort }).rows.map(row => row.id);
  assert.deepEqual(order('playtime-desc'), [5, 4, 3, 2, 1, 6]);
  assert.deepEqual(order('playtime-asc'), [1, 2, 3, 4, 5, 6]);
  assert.equal(prepareCatalog(catalog).games.find(row => row.game.id === 6).playtime, null);
});

test('advanced playtime comparisons use three-valued logic and convert to and from basic filters', () => {
  const expression = expr => runQuery(catalog, { expression: expr }).rows.map(row => row.id).sort((a, b) => a - b);
  assert.deepEqual(expression('playtime >= 10'), [3, 4, 5, 7]);
  assert.deepEqual(expression('NOT playtime >= 10'), [1, 2], 'unknown stays unknown under NOT');
  assert.deepEqual(expression('playtime < 1 OR reviews < 20'), [1, 7]);
  assert.deepEqual(expression('playtime = 2.5'), [2]);
  for (const bad of ['playtime >= -1', 'playtime:10', 'playtime >= /1/', 'playtime >= abc']) assert.throws(() => parseExpression(bad, catalog), Error, bad);
  const basic = normalizeQuery({ minPlaytime: 5, maxPlaytime: 40 }, []);
  assert.equal(basicExpression(basic, { features: [], tags: [], languages: [] }), 'reviews >= 20 AND playtime >= 5 AND playtime <= 40 AND release:released');
  const { filters, omitted } = expressionToBasic('playtime >= 5 AND playtime <= 40 AND NOT playtime > 30', { features: [], tags: [], languages: [] });
  assert.deepEqual([filters.minPlaytime, filters.maxPlaytime], [5, 30]);
  assert.deepEqual(omitted, []);
  assert.deepEqual(expressionToBasic('playtime > 5', { features: [], tags: [], languages: [] }).omitted, ['playtime > 5'], 'strict bounds on fractional hours are not representable');
  assert.ok(expressionCompletions('play', 4, { features: [], tags: [], languages: [] }).some(option => option.text === 'playtime >= '));
});
