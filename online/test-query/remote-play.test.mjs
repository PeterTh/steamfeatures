import test from 'node:test';
import assert from 'node:assert/strict';
import { features } from '../src/features.mjs';
import { presentationFeatures, featureColumns } from '../src/feature-presentation.mjs';
import { DEFAULT_QUERY, normalizeQuery, parseQuery, serializeQuery, runQuery } from '../src/query.mjs';

const remoteIds = [41, 42, 43, 46, 44];
const legacyOrder = ['Play modes', 'Input', 'Steam features', 'Creation', 'Features?', 'Remote Play', 'Cloud streaming', 'Display & VR', 'Accessibility', 'Steam hardware'];
const legacyFeatures = features.map(feature => ({ ...feature, ...(feature.id === 44 ? { multiplayer: true } : {}),
  ...(feature.id === 46 ? { group: 'Cloud streaming' } : {}) }))
  .sort((a, b) => legacyOrder.indexOf(a.group) - legacyOrder.indexOf(b.group));
const game = (id, featureIds) => ({ id, name: 'Game ' + id, featureIds, reviews: 100, earlyAccess: false, releaseStatus: 'released',
  featureDataKnown: true, knownFeatureGroups: ['cloud-streaming', 'steam-deck-status'] });

test('Remote Play is off by default, opt-in through rp=1, and preserves canonical URL state', () => {
  assert.equal(DEFAULT_QUERY.includeRemotePlay, false);
  const query = normalizeQuery({ includeRemotePlay: true }, features);
  assert.equal(serializeQuery(query, features), '?v=1&rp=1');
  assert.deepEqual(parseQuery('?rp=1', features), query);
  assert.equal(serializeQuery(parseQuery('?rp=0', features), features), '');
  assert.throws(() => parseQuery('?rp=0&rp=1', features), /Conflicting/);
  assert.throws(() => normalizeQuery({ includeRemotePlay: 'maybe' }, features), /Remote Play/);
});

test('old and new catalogs share Compatibility, Remote Play, Accessibility ordering', () => {
  for (const registry of [features, legacyFeatures]) {
    const before = JSON.stringify(registry), shown = presentationFeatures(registry);
    assert.deepEqual([...new Set(shown.map(feature => feature.group))].slice(-3), ['Steam hardware', 'Remote Play', 'Accessibility']);
    assert.deepEqual([...new Set(featureColumns(registry).map(feature => feature.group))].slice(-3), ['Steam hardware', 'Remote Play', 'Accessibility']);
    assert.deepEqual(shown.filter(feature => feature.remotePlay).map(feature => feature.id), remoteIds);
    assert.equal(shown.find(feature => feature.id === 44).multiplayer, false);
    assert.deepEqual(presentationFeatures(shown), shown);
    assert.equal(JSON.stringify(registry), before);
  }
});

test('all sixteen counting combinations agree with visible columns for an older catalog', () => {
  const catalog = { features: legacyFeatures, games: [game(1, [2, 1, 64, 10013, ...remoteIds])] };
  for (let mask = 0; mask < 16; mask++) {
    const query = { includeAccessibility: !!(mask & 1), includeMultiplayer: !!(mask & 2), includeHardware: !!(mask & 4), includeRemotePlay: !!(mask & 8) };
    const result = runQuery(catalog, query);
    const expected = 1 + Number(query.includeAccessibility) + Number(query.includeMultiplayer) + Number(query.includeHardware) + 5 * Number(query.includeRemotePlay);
    assert.equal(result.rows[0].score, expected);
    assert.equal(result.rows[0].count, expected);
    for (const id of remoteIds) assert.equal(result.columns.includes(id), query.includeRemotePlay);
    const groups = featureColumns(legacyFeatures).filter(column => result.columns.includes(column.id)).map(column => column.group);
    if (query.includeAccessibility) assert.equal(groups.at(-1), 'Accessibility');
    if (query.includeRemotePlay && query.includeHardware) assert.ok(groups.lastIndexOf('Steam hardware') < groups.indexOf('Remote Play'));
  }
});

test('required and excluded Remote Play filters apply without enabling its score or columns', () => {
  const catalog = { features: legacyFeatures, games: [game(1, [2, ...remoteIds]), game(2, [2])] };
  const required = runQuery(catalog, { has: ['PH'] });
  assert.equal(required.rows[0].id, 1); assert.equal(required.total, 1);
  assert.equal(required.rows[0].score, 1); assert.equal(required.rows[0].count, 1);
  assert.ok(remoteIds.every(id => !required.columns.includes(id)));
  assert.deepEqual(runQuery(catalog, { not: ['PH'] }).rows.map(row => row.id), [2]);
  assert.equal(runQuery(catalog, { has: ['RPT'], includeMultiplayer: true }).rows[0].score, 1);
  assert.equal(runQuery(catalog, { includeRemotePlay: true }).rows.find(row => row.id === 1).score, 6);
});
