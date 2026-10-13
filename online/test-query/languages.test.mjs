import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, languageByKey, encodeLanguageFlags } from '../src/languages.mjs';
import { normalizeQuery, parseQuery, serializeQuery, prepareCatalog, runQuery } from '../src/query.mjs';
import { parseView, serializeView } from '../src/view-state.mjs';
import { encodeBinaryCatalog } from '../scripts/catalog-binary.mjs';
import { decodeBinaryCatalog } from '../src/catalog-binary.mjs';

const features = [{ id: 2, key: 'single-player', name: 'Single-player', weight: 1 }];
const bits = values => encodeLanguageFlags(Object.entries(values).map(([key, value]) => [languageByKey(key).id, value]));
const game = (id, values, patch = {}) => ({ id, name: `Game ${id}`, featureIds: [2], featureDataKnown: true, reviews: 100,
  earlyAccess: false, releaseStatus: 'released', releaseISO: '2020-01-01', tagIds: [0], ...(values ? { languageBits: bits(values) } : {}), ...patch });
const catalog = { version: 1, features, tags: ['Puzzle'], languages: LANGUAGES, games: [
  game(1, { english: 7, german: 5, japanese: 2 }), game(2, { english: 1, german: 7 }),
  game(3, { english: 4, german: 1 }), game(4), game(5, {}), game(6, { zulu: 7 }),
] };
const ids = input => runQuery(catalog, input).rows.map(row => row.id).sort((a, b) => a - b);

test('language picker counts reflect interface support, excluding audio-only and subtitle-only games', () => {
  const { languageCounts } = prepareCatalog(catalog);
  assert.equal(languageCounts[languageByKey('english').id], 2);
  assert.equal(languageCounts[languageByKey('german').id], 3);
  assert.equal(languageCounts[languageByKey('japanese').id], 0);
  assert.equal(languageCounts[languageByKey('zulu').id], 1);
});

test('picker counts include every game sharing a profile and keep empty and unknown support distinct', () => {
  const local = { ...catalog, games: [
    game(1, { english: 7, german: 5 }), game(2, { english: 7, german: 5 }),
    game(3, { english: 5 }), game(4, { english: 2 }), game(5, {}), game(6),
  ] };
  const prepared = prepareCatalog(local);
  assert.equal(prepared.languageCounts[languageByKey('english').id], 3);
  assert.equal(prepared.languageCounts[languageByKey('german').id], 2);
  assert.equal(prepared.languageCounts[languageByKey('japanese').id], 0);
  assert.equal(runQuery(prepared, { hasLanguages: ['english:interface'] }).total, 3);
  assert.deepEqual(runQuery(prepared, { notLanguages: ['english:interface'] }).rows.map(row => row.id), [4, 5]);
});

test('each language category is independently required or excluded; unknown data matches neither', () => {
  assert.deepEqual(ids({ hasLanguages: ['german:interface'] }), [1, 2, 3]);
  assert.deepEqual(ids({ hasLanguages: ['german:audio'] }), [2]);
  assert.deepEqual(ids({ hasLanguages: ['german:subtitles'] }), [1, 2]);
  assert.deepEqual(ids({ notLanguages: ['german:audio'] }), [1, 3, 5, 6]);
  assert.deepEqual(ids({ hasLanguages: ['german:interface', 'german:subtitles'], notLanguages: ['german:audio'] }), [1]);
  assert.deepEqual(ids({ hasLanguages: ['german:interface', 'english:subtitles'], notLanguages: ['japanese:audio'] }), [3]);
  assert.deepEqual(ids({ hasLanguages: ['zulu:subtitles'] }), [6]);
});

test('language filters combine with existing constraints without changing columns, scores or ranks', () => {
  const baseline = runQuery(catalog);
  const input = { hasLanguages: ['german:interface'], notLanguages: ['german:audio'], has: ['single-player'], hasTags: ['Puzzle'], releaseFrom: '2020', q: 'Game 1' };
  const filtered = runQuery(catalog, input);
  assert.deepEqual(filtered.rows.map(row => row.id), [1]);
  assert.deepEqual(filtered.columns, baseline.columns);
  assert.equal(filtered.rows[0].score, baseline.rows[0].score);
  assert.equal(filtered.rows[0].count, baseline.rows[0].count);
  assert.equal(runQuery(catalog, { ...input, releaseFrom: '2021' }).total, 0);
  assert.equal(runQuery(catalog, { ...input, minReviews: 101 }).total, 0);
});

test('language URLs survive canonicalization, highlighting and repeated values', () => {
  const input = { hasLanguages: ['german:interface', 'english:subtitles', 'german:interface'], notLanguages: ['german:audio'], hasTags: ['Puzzle'], page: 2 };
  const url = serializeView(input, 'single-player', features, catalog.tags, LANGUAGES);
  const parsed = parseView(url, features, catalog.tags, LANGUAGES);
  assert.deepEqual(parsed.query, normalizeQuery(input, features, catalog.tags, LANGUAGES));
  assert.equal(parsed.highlight, 'single-player');
  assert.equal(serializeView(parsed.query, parsed.highlight, features, catalog.tags, LANGUAGES), url);
  assert.deepEqual(parseQuery('?lang=german:audio&lang=german:audio', features, [], LANGUAGES).hasLanguages, ['german:audio']);
  assert.equal(serializeQuery({}, features, [], LANGUAGES), '');
});

test('invalid language rules and conflicting requirements are rejected without broadening results', () => {
  for (const value of ['german', 'unknown:audio', 'german:voice', 'german:audio:extra', 'constructor:audio', 1]) {
    assert.throws(() => runQuery(catalog, { hasLanguages: [value] }), /Unknown language filter/);
  }
  assert.throws(() => runQuery(catalog, { hasLanguages: ['german:audio'], notLanguages: ['german:audio'] }), /both required and excluded/);
  assert.throws(() => parseQuery('?notLang=bad:audio', features, [], LANGUAGES), /Unknown language filter/);
});

test('binary and JSON queries agree, complete empty support survives, and old catalogs remain usable', () => {
  const wire = decodeBinaryCatalog(encodeBinaryCatalog(catalog));
  assert.deepEqual(runQuery(wire, { hasLanguages: ['german:interface'], notLanguages: ['german:audio'] }), runQuery(catalog, { hasLanguages: ['german:interface'], notLanguages: ['german:audio'] }));
  const old = { features, games: [game(4, undefined, { tagIds: [] })] };
  assert.equal(runQuery(old).total, 1);
  assert.throws(() => runQuery(old, { notLanguages: ['english:audio'] }), /Unknown language filter/);
  assert.throws(() => prepareCatalog({ ...catalog, games: [game(1, {}, { languageBits: 'broken' })] }), /Invalid language support/);
  assert.throws(() => prepareCatalog({ ...catalog, languages: [LANGUAGES[0], LANGUAGES[0]] }), /Invalid language dictionary/);
});
