import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_QUERY, PRESETS, normalizeQuery, parseQuery, serializeQuery, runQuery } from '../src/query.mjs';

const features = [
  { id: 2, key: 'single-player', name: 'Single-player' },
  { id: 20, key: 'mmo', name: 'MMO' },
  { id: 23, key: 'steam-cloud', name: 'Steam Cloud', weight: 3 },
];
const tags = ['Metroidvania', 'MMORPG'];
const game = (id, releaseISO, extra = {}) => ({
  id, name: `Game ${id}`, releaseISO, releaseStatus: 'released', earlyAccess: false,
  reviews: 100, featureIds: [2], featureDataKnown: true, tagIds: [0], tagDataKnown: true,
  ...extra,
});
const catalog = { features, tags, games: [
  game(1, '2019-12-31'), game(2, '2020-01-01'), game(3, '2020-02-29'),
  game(4, '2020-12-31'), game(5, '2021-01-01'), game(6, null),
] };
const ids = query => runQuery(catalog, { sort: 'title-asc', ...query }).rows.map(row => row.id);

test('release bounds are independently optional and inclusive', () => {
  assert.deepEqual(ids({ releaseFrom: '2020-01-01' }), [2, 3, 4, 5]);
  assert.deepEqual(ids({ releaseTo: '2020-12-31' }), [1, 2, 3, 4]);
  assert.deepEqual(ids({ releaseFrom: '2020-01-01', releaseTo: '2020-12-31' }), [2, 3, 4]);
  assert.deepEqual(ids({ releaseFrom: '2020-02-29', releaseTo: '2020-02-29' }), [3]);
  assert.deepEqual(ids({ releaseFrom: '2020-03-01', releaseTo: '2020-03-01' }), []);
});

test('year and month precision is preserved while matching inclusive calendar boundaries', () => {
  for (const [value, from, to] of [
    ['2020', '2020-01-01', '2020-12-31'],
    ['0001', '0001-01-01', '0001-12-31'],
    ['0099', '0099-01-01', '0099-12-31'],
    ['9999', '9999-01-01', '9999-12-31'],
    ['2020-01', '2020-01-01', '2020-01-31'],
    ['2020-04', '2020-04-01', '2020-04-30'],
    ['2020-02', '2020-02-01', '2020-02-29'],
    ['2021-02', '2021-02-01', '2021-02-28'],
    ['1900-02', '1900-02-01', '1900-02-28'],
    ['2000-02', '2000-02-01', '2000-02-29'],
    ['9999-12', '9999-12-01', '9999-12-31'],
  ]) {
    const query = normalizeQuery({ releaseFrom: value, releaseTo: value }, features);
    assert.equal(query.releaseFrom, value);
    assert.equal(query.releaseTo, value);
    const local = { features, tags, games: [game(1, from), game(2, to)] };
    const result = runQuery(local, query);
    assert.equal(result.total, 2, value);
    assert.deepEqual(result.query, query, value);
  }
  assert.deepEqual(ids({ releaseFrom: '2020', releaseTo: '2020' }), [2, 3, 4]);
  assert.deepEqual(ids({ releaseFrom: '2020-02', releaseTo: '2020-02' }), [3]);
  assert.deepEqual(ids({ releaseFrom: '2020' }), [2, 3, 4, 5]);
  assert.deepEqual(ids({ releaseTo: '2020' }), [1, 2, 3, 4]);
});

test('shared URLs preserve entered date precision and compare resolved bounds', () => {
  const year = parseQuery('?releaseFrom=2020&releaseTo=2020', features);
  assert.equal(serializeQuery(year, features), '?v=1&releaseFrom=2020&releaseTo=2020');
  const month = parseQuery('?releaseFrom=2020-02&releaseTo=2020-02', features);
  assert.equal(serializeQuery(month, features), '?v=1&releaseFrom=2020-02&releaseTo=2020-02');
  assert.deepEqual(parseQuery(serializeQuery(month, features), features), month);
  for (const query of [
    { releaseFrom: '2020-12-31', releaseTo: '2020' },
    { releaseFrom: '2020-02-29', releaseTo: '2020-02' },
    { releaseFrom: '2020', releaseTo: '2020-01-01' },
    { releaseFrom: '2024-12-31', releaseTo: '2024' },
    { releaseFrom: '2024-02-29', releaseTo: '2024-02' },
  ]) {
    const normalized = normalizeQuery(query, features);
    assert.equal(normalized.releaseFrom, query.releaseFrom);
    assert.equal(normalized.releaseTo, query.releaseTo);
    assert.deepEqual(parseQuery(serializeQuery(query, features), features), normalized);
  }
  for (const query of [
    { releaseFrom: '2021', releaseTo: '2020' },
    { releaseFrom: '2020-03', releaseTo: '2020-02' },
    { releaseFrom: '2020-02', releaseTo: '2020-01-31' },
    { releaseFrom: '2024-03-01', releaseTo: '2024-02' },
  ]) {
    assert.throws(() => normalizeQuery(query, features), /start date must be on or before the end date/);
    assert.throws(() => parseQuery(`?${new URLSearchParams(query)}`, features), /start date must be on or before the end date/);
  }
});

test('clearing one date leaves the other active; clearing both restores undated games', () => {
  const range = normalizeQuery({ releaseFrom: '2020-01-01', releaseTo: '2020-12-31' }, features);
  assert.deepEqual(ids({ ...range, releaseFrom: '' }), [1, 2, 3, 4]);
  assert.deepEqual(ids({ ...range, releaseTo: '' }), [2, 3, 4, 5]);
  assert.deepEqual(ids({ ...range, releaseFrom: '', releaseTo: '' }), [1, 2, 3, 4, 5, 6]);
});

test('date ranges combine with feature, tag, text, review, and Early Access filters', () => {
  const local = { features, tags, games: [
    game(1, '2020-01-01', { name: 'Wanted game' }),
    game(2, '2020-01-01', { name: 'Other title' }),
    game(3, '2020-01-01', { name: 'Wanted cloud', featureIds: [2, 23] }),
    game(4, '2020-01-01', { name: 'Wanted MMO', tagIds: [0, 1] }),
    game(5, '2020-01-01', { name: 'Wanted obscure', reviews: 1 }),
    game(6, '2020-01-01', { name: 'Wanted early access', earlyAccess: true }),
    game(7, '2021-01-01', { name: 'Wanted newer game' }),
  ] };
  const result = runQuery(local, {
    q: 'Wanted', has: ['single-player'], not: ['steam-cloud'], hasTags: ['Metroidvania'],
    notTags: ['MMORPG'], releaseTo: '2020-12-31',
  });
  assert.deepEqual(result.rows.map(row => row.id), [1]);
});

test('release date bounds stay separate from release status', () => {
  const local = { features, tags, games: [
    game(1, '2020-01-01'),
    game(2, '2027-01-01', { releaseStatus: 'upcoming' }),
    game(3, '2020-01-01', { releaseStatus: 'unknown' }),
    game(4, null, { releaseStatus: 'upcoming' }),
  ] };
  const rows = query => runQuery(local, { sort: 'title-asc', ...query }).rows.map(row => row.id);
  assert.deepEqual(rows({ releaseFrom: '2020-01-01' }), [1]);
  assert.deepEqual(rows({ release: 'upcoming', releaseFrom: '2020-01-01' }), [2]);
  assert.deepEqual(rows({ release: 'all', releaseFrom: '2020-01-01' }), [1, 2, 3]);
});

test('unknown and malformed catalog dates only exclude games when a bound is active', () => {
  const invalid = [undefined, null, '', 'Coming soon', '2020', '2020-02', '2020-2-01', '2020-02-30', '1900-02-29', '0000-01-01', 20200101];
  const local = { features, tags, games: [game(1, '2020-02-29'), ...invalid.map((releaseISO, index) => game(index + 2, releaseISO))] };
  assert.equal(runQuery(local).total, invalid.length + 1);
  for (const query of [{ releaseFrom: '0001-01-01' }, { releaseTo: '9999-12-31' }]) {
    assert.deepEqual(runQuery(local, query).rows.map(row => row.id), [1]);
  }
  for (const sort of ['release-asc', 'release-desc']) {
    const result = runQuery(local, { sort });
    assert.equal(result.rows[0].id, 1);
    assert.equal(result.total, invalid.length + 1);
  }
});

test('date validation follows Gregorian leap years without timezone or Date year coercion', () => {
  for (const date of ['0001-01-01', '0099-12-31', '1600-02-29', '2000-02-29', '2004-02-29', '2400-02-29', '9999-12-31']) {
    const query = normalizeQuery({ releaseFrom: date, releaseTo: date }, features);
    assert.equal(query.releaseFrom, date);
    assert.equal(query.releaseTo, date);
    assert.deepEqual(parseQuery(serializeQuery(query, features), features), query);
  }
});

test('malformed and impossible bounds reject query and URL input without broadening it', () => {
  const invalid = [
    '0000-01-01', '10000-01-01', '2020-00-01', '2020-13-01', '2020-01-00', '2020-01-32',
    '2020-04-31', '2020-02-30', '1900-02-29', '2100-02-29', '2021-02-29',
    '20-01-01', '2020-1-01', '2020-01-1', '2020/01/01', '2020-01-01T00:00:00Z',
    ' 2020-01-01', '2020-01-01 ', 'yesterday',
    '0000', '10000', '020', '2020-0', '2020-00', '2020-13', '2020-2', '2020-',
    '2020-02-', '0000-02', '2020/02', ' 2020', '2020 ', ' 2020-02', '2020-02 ',
  ];
  for (const key of ['releaseFrom', 'releaseTo']) {
    for (const date of invalid) {
      assert.throws(() => normalizeQuery({ [key]: date }, features), /valid date in YYYY, YYYY-MM, or YYYY-MM-DD format/, `${key}: ${date}`);
      assert.throws(() => parseQuery(`?${new URLSearchParams({ [key]: date })}`, features), /valid date in YYYY, YYYY-MM, or YYYY-MM-DD format/, `${key} URL: ${date}`);
    }
    for (const value of [false, true, 20200101, ['2020-01-01'], {}, new Date('2020-01-01')]) {
      assert.throws(() => normalizeQuery({ [key]: value }, features), /valid date in YYYY, YYYY-MM, or YYYY-MM-DD format/);
    }
  }
});

test('an inverted range is rejected for queries, serialization, and shared URLs', () => {
  const query = { releaseFrom: '2021-01-01', releaseTo: '2020-12-31' };
  assert.throws(() => normalizeQuery(query, features), /start date must be on or before the end date/);
  assert.throws(() => runQuery(catalog, query), /start date must be on or before the end date/);
  assert.throws(() => serializeQuery(query, features), /start date must be on or before the end date/);
  assert.throws(() => parseQuery('?releaseFrom=2021-01-01&releaseTo=2020-12-31', features), /start date must be on or before the end date/);
});

test('date URL state round-trips alongside other filters, sorting, and pagination', () => {
  const query = normalizeQuery({
    q: 'Date + title', has: ['single-player'], notTags: ['MMORPG'],
    release: 'all', releaseFrom: '2020-01-01', releaseTo: '2021-12-31',
    sort: 'release-desc', page: 3, minReviews: 0, includeEarlyAccess: true,
  }, features, tags);
  const search = serializeQuery(query, features, tags);
  assert.match(search, /releaseFrom=2020-01-01&releaseTo=2021-12-31/);
  assert.deepEqual(parseQuery(search, features, tags), query);
  for (const [key, other] of [['releaseFrom', 'releaseTo'], ['releaseTo', 'releaseFrom']]) {
    const single = normalizeQuery({ [key]: '2020-01-01' }, features);
    const params = new URLSearchParams(serializeQuery(single, features));
    assert.equal(params.get(key), '2020-01-01');
    assert.equal(params.has(other), false);
    assert.deepEqual(parseQuery(params, features), single);
  }
});

test('default and older URLs retain unrestricted release dates', () => {
  assert.deepEqual(parseQuery('', features), DEFAULT_QUERY);
  assert.equal(serializeQuery(DEFAULT_QUERY, features), '');
  assert.equal(serializeQuery({ releaseFrom: '', releaseTo: '' }, features), '');
  assert.equal(serializeQuery({ releaseFrom: null, releaseTo: undefined }, features), '');
  const older = parseQuery('?v=1&has=single-player&minReviews=1000', features);
  assert.equal(older.releaseFrom, '');
  assert.equal(older.releaseTo, '');
  assert.deepEqual(parseQuery('?releaseFrom=&releaseTo=', features), DEFAULT_QUERY);
  for (const preset of PRESETS) {
    const query = normalizeQuery(preset.query, features, tags);
    assert.equal(query.releaseFrom, '');
    assert.equal(query.releaseTo, '');
  }
});

test('duplicate date parameters follow strict single-value URL handling', () => {
  for (const key of ['releaseFrom', 'releaseTo']) {
    const matching = parseQuery(`?${key}=2020-01-01&${key}=2020-01-01`, features);
    assert.equal(new URLSearchParams(serializeQuery(matching, features)).getAll(key).length, 1);
    for (const other of ['', '2021-01-01']) {
      assert.throws(() => parseQuery(`?${key}=2020-01-01&${key}=${other}`, features), /Conflicting values for URL parameter/);
    }
  }
});
