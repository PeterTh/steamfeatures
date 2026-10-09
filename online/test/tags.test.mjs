import test from 'node:test';
import assert from 'node:assert/strict';
import { attachCommunityTags, encodeTagIndex, indexCommunityTags, summarizeCoverage, validateCoverage } from '../scripts/normalize.mjs';

test('community tags join by Steam ID, deduplicate and have a deterministic dictionary', () => {
  const rows = [
    { steam_appid: 22, tags: ['Puzzle', ' Adventure ', 'Puzzle', 'Action'] },
    { steam_appid: 11, tags: ['Action', 'Co-op'] },
    { steam_appid: 99, tags: ['Unmatched tag'] },
    { steam_appid: 88, kind: 'gog_exclusive', tags: ['GOG tag'] }
  ];
  const games = [{ id: 11, name: 'First', genres: ['Action'] }, { id: 22, name: 'Second', genres: ['Strategy'] }];
  const packed = attachCommunityTags(games, indexCommunityTags(rows));
  const reordered = attachCommunityTags(games, indexCommunityTags([...rows].reverse()));
  assert.deepEqual(packed, reordered);
  assert.deepEqual(packed.tags, ['Action', 'Adventure', 'Co-op', 'Puzzle']);
  assert.deepEqual(packed.games.map(game => game.tagIds), [[0, 2], [0, 1, 3]]);
  assert.deepEqual(games.map(game => game.tagIds), [undefined, undefined]);
  assert.deepEqual(packed.games.map(game => game.genres), [['Action'], ['Strategy']]);
});

test('missing, null, empty and unmatched tag data stay unknown by omitting tagIds', () => {
  const rows = [{ steam_appid: 1 }, { steam_appid: 2, tags: null }, { steam_appid: 3, tags: [] }];
  const games = [1, 2, 3, 4].map(id => ({ id }));
  const packed = attachCommunityTags(games, indexCommunityTags(rows));
  assert.deepEqual(packed.tags, []);
  assert.ok(packed.games.every(game => !Object.hasOwn(game, 'tagIds')));
});

test('inverted tag index round-trips exact memberships using row deltas, including a first zero', () => {
  const games = [{ id: 900, tagIds: [0, 2] }, { id: 12000 }, { id: 5, tagIds: [1, 2] }, { id: 67, tagIds: [0] }];
  const before = structuredClone(games);
  const packed = encodeTagIndex(games, 4);
  assert.deepEqual(packed, { encoding: 'delta-game-indices-v1', lists: [[0, 3], [2], [0, 2], []] });
  const memberships = games.map(() => []);
  packed.lists.forEach((deltas, tagId) => {
    let row = 0;
    deltas.forEach((delta, position) => {
      assert.ok(Number.isSafeInteger(delta) && delta >= (position ? 1 : 0));
      row += delta;
      assert.ok(row < games.length);
      memberships[row].push(tagId);
    });
  });
  assert.deepEqual(memberships, games.map(game => game.tagIds || []));
  assert.equal(packed.lists.reduce((count, list) => count + list.length, 0), 5);
  assert.deepEqual(games, before);
  assert.deepEqual(encodeTagIndex([{ id: 1 }], 0), { encoding: 'delta-game-indices-v1', lists: [] });
});

test('tag packing rejects invalid and unsorted canonical memberships', () => {
  for (const tagIds of [[2], [-1], [0, 0], [1, 0], [0.1], '0']) {
    assert.throws(() => encodeTagIndex([{ id: 1, tagIds }], 2), /Invalid/);
  }
  assert.throws(() => encodeTagIndex([], -1), /dictionary/);
});

test('malformed tags and duplicate Steam IDs fail instead of weakening filters', () => {
  for (const tags of ['Action', {}, [3], [null], [''], ['  ']]) {
    assert.throws(() => indexCommunityTags([{ steam_appid: 1, tags }]), /Invalid community tags/);
  }
  assert.throws(() => indexCommunityTags([{ steam_appid: 1 }, { steam_appid: 1 }]), /Duplicate community-tag/);
  assert.throws(() => indexCommunityTags([null]), /Malformed/);
  assert.throws(() => indexCommunityTags({}), /JSON array/);
});

test('tag coverage counts known games and guards regressions only after a prior tag-aware import', () => {
  const coverage = summarizeCoverage([{ tagIds: [0], reviews: null }, { reviews: null }, { tagIds: [], reviews: null }]);
  assert.equal(coverage.knownTags, 1);
  const full = { games: 100000, knownFeatures: 95000, knownReviews: 60000, knownTags: 40000 };
  assert.doesNotThrow(() => validateCoverage(full, { games: 100000, knownFeatures: 95000, knownReviews: 60000 }));
  assert.doesNotThrow(() => validateCoverage({ ...full, knownTags: 36000 }, full));
  assert.throws(() => validateCoverage({ ...full, knownTags: 35999 }, full), /knownTags/);
});
