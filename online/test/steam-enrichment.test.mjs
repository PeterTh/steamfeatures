import test from 'node:test';
import assert from 'node:assert/strict';
import { features } from '../src/features.mjs';
import { normalizeSteamEnrichment, archiveRecord } from '../scripts/steam-enrichment.mjs';
import { mergeSteamEnrichment } from '../scripts/steam-data-import.mjs';
import { DEFAULT_QUERY, normalizeQuery, runQuery, parseQuery, serializeQuery } from '../src/query.mjs';
import { encodeBinaryCatalog } from '../scripts/catalog-binary.mjs';
import { decodeBinaryCatalog } from '../src/catalog-binary.mjs';
import { compatibilityTargets, featureColumns, presentationFeatures, columnState } from '../src/feature-presentation.mjs';

const game = id => ({ id, name: `Game ${id}`, featureIds: [2], featureDataKnown: true, reviews: 20, positivePercent: 90,
  earlyAccess: false, releaseStatus: 'released', releaseISO: '2020-01-01' });

test('cloud flags accept VDF booleans; keyboard penalty and Dynamic Cloud Sync are independent', () => {
  const result = normalizeSteamEnrichment({ id: 10, store: { success: 1, extra_details: { no_mouse_keyboard_support: true, links_and_info: { achievement_count: 0 } } },
    appinfo: { appid: '10', common: { category: { category_45: 'true', category_46: '1' } }, ufs: { sync_while_suspended: '1' } } });
  assert.deepEqual(result.featureIds, [45, 46, 10000, 10001]);
  assert.equal(result.achievementCount, 0);
  assert.equal(features.find(feature => feature.id === 10000).weight, -1);
});

test('inaccessible private UFS stays unknown while full appinfo with no UFS means no dynamic sync', () => {
  const partial = normalizeSteamEnrichment({ id: 10, appinfo: { appid: '10', public_only: '1', common: {} } });
  assert.equal(partial.knownFeatureGroups.includes('dynamic-cloud-sync'), false);
  const full = normalizeSteamEnrichment({ id: 10, appinfo: { appid: '10', common: {} } });
  assert.equal(full.knownFeatureGroups.includes('dynamic-cloud-sync'), true);
  assert.equal(full.featureIds.includes(10001), false);
});

test('all four hardware ratings, test outcomes and explicit configuration values are projected with stable IDs', () => {
  const registry = new Map(features.map(feature => [feature.id, feature]));
  const record = { id: 10, appinfo: { appid: '10', common: {
    steam_deck_compatibility: { category: '3', steamos_compatibility: '2', steam_machine_compatibility: '2',
      tests: { 0: { display: '4', token: '#SteamDeckVerified_TestResult_InterfaceTextIsLegible' } },
      steamos_tests: { 0: { display: '3', token: '#SteamOS_TestResult_GameStartupFunctional' } },
      steam_machine_tests: { 0: { display: '3', token: '#SteamMachine_TestResult_ControllerGlyphsDoNotMatchDevice' } },
      configuration: { small_text: '0', requires_manual_keyboard_invoke: '1' } },
    steam_frame_compatibility: { category: '1', tests: { 0: { display: '2', token: '#SteamFrame_TestResult_DeviceUnsupported' } } }
  } } };
  const result = normalizeSteamEnrichment(record, registry);
  for (const id of [10013, 10022, 10031, 10042]) assert.ok(result.featureIds.includes(id));
  const startup = [...registry.values()].find(feature => feature.key === 'steam-os-test-game-startup-functional');
  assert.equal(startup.weight, 1);
  const text = [...registry.values()].find(feature => feature.key === 'steam-deck-small-text');
  assert.ok(result.knownFeatureGroups.includes(text.knowledgeGroup));
  assert.equal(result.featureIds.includes(text.id), false);
  const second = new Map();
  normalizeSteamEnrichment(record, second);
  assert.equal([...second.values()].find(feature => feature.key === startup.key).id, startup.id);
});

test('hardware is opt-in for scores and columns, and unknown new fields cannot satisfy exclusions', () => {
  const known = { ...game(10), featureIds: [2, 10000, 10013], knownFeatureGroups: ['keyboard-mouse', 'steam-deck-status'] };
  const catalog = { features, games: [known, game(20)] };
  const hidden = runQuery(catalog, { sort: 'title-asc' });
  assert.ok(hidden.columns.every(id => !features.find(feature => feature.id === id).hardware));
  const visible = runQuery(catalog, { includeHardware: true, sort: 'title-asc' });
  assert.deepEqual(visible.columns.filter(id => featureColumns(features).find(feature => feature.id === id).hardware), [10019, 10029, 10039, 10049]);
  assert.equal(visible.rows[0].score, hidden.rows[0].score + 1);
  assert.deepEqual(runQuery(catalog, { compatibility: { 'steam-deck': 'verified' } }).rows.map(row => row.id), [10]);
  assert.deepEqual(runQuery(catalog, { not: ['no-keyboard-mouse'] }).rows.map(row => row.id), []);
  assert.equal(parseQuery(serializeQuery({ includeHardware: true }, features), features).includeHardware, true);
  assert.deepEqual(runQuery(decodeBinaryCatalog(encodeBinaryCatalog(catalog)), { includeHardware: true }), runQuery(catalog, { includeHardware: true }));
});

test('compatibility filters select exact ratings on every target, independently of column visibility', () => {
  for (const target of compatibilityTargets) {
    const rated = target.ratings.map((rating, index) => ({ ...game(index + 1), featureIds: [2, rating.id] }));
    const catalog = { features, games: [...rated, game(20), { ...game(21), knownFeatureGroups: [`${target.key}-status`] }] };
    for (const rating of target.ratings) {
      for (const includeHardware of [true, false]) {
        const result = runQuery(catalog, { includeHardware, compatibility: { [target.key]: rating.value } });
        assert.deepEqual(result.rows.map(row => row.id), [rated.find(row => row.featureIds.includes(rating.id)).id]);
      }
    }
    assert.equal(runQuery(catalog, { compatibility: { [target.key]: 'ignore' } }).total, rated.length + 2);
  }
});

test('compatibility combines targets and ordinary feature, tag, date and search filters', () => {
  const catalog = { features, tags: ['Puzzle'], games: [
    { ...game(1), featureIds: [2, 23, 10013, 10042], tagIds: [0] },
    { ...game(2), featureIds: [2, 10013, 10042], tagIds: [0] },
    { ...game(3), featureIds: [2, 23, 10013, 10041], tagIds: [0] },
    { ...game(4), featureIds: [2, 23, 10012, 10042], tagIds: [0] },
  ] };
  const input = { compatibility: { 'steam-deck': 'verified', 'steam-os': 'supported' }, has: ['steam-cloud'], hasTags: ['Puzzle'], releaseFrom: '2020', q: 'Game' };
  assert.deepEqual(runQuery(catalog, input).rows.map(row => row.id), [1]);
  assert.equal(runQuery(catalog, { ...input, releaseFrom: '2021' }).total, 0);
  assert.equal(runQuery(catalog, { ...input, q: 'absent' }).total, 0);
});

test('compatibility URLs round-trip, omit ignored targets and reject invalid or conflicting ratings', () => {
  const input = { compatibility: { 'steam-deck': 'playable', 'steam-machine': 'verified', 'steam-frame': 'unsupported', 'steam-os': 'supported' } };
  const search = serializeQuery(input, features);
  assert.equal(search, '?v=1&deck=playable&machine=verified&frame=unsupported&os=supported');
  assert.deepEqual(parseQuery(search, features), normalizeQuery(input, features));
  assert.equal(serializeQuery(DEFAULT_QUERY, features), '');
  assert.deepEqual(parseQuery('?deck=ignore', features), DEFAULT_QUERY);
  assert.deepEqual(parseQuery('?deck=untested&deck=untested', features).compatibility['steam-deck'], 'untested');
  for (const search of ['?deck=verified&deck=playable', '?deck=', '?deck=unknown', '?os=playable', '?os=verified', '?machine=supported']) {
    assert.throws(() => parseQuery(search, features));
  }
  for (const compatibility of [[], false, 'verified', { unknown: 'verified' }, { 'steam-deck': null }]) {
    assert.throws(() => normalizeQuery({ compatibility }, features));
  }
  for (const kind of ['has', 'not']) assert.throws(() => normalizeQuery({ [kind]: ['steam-deck-verified'] }, features), /compatibility filter/);
});

test('cloud presentation groups Dynamic Cloud Sync beside saves and GeForce NOW fourth in Remote Play', () => {
  const shown = presentationFeatures(features);
  assert.equal(shown[shown.findIndex(feature => feature.id === 23) + 1].id, 10001);
  assert.deepEqual(shown.filter(feature => feature.group === 'Remote Play').map(feature => feature.id), [41, 42, 43, 46, 44]);
  assert.ok(!shown.some(feature => feature.id === 45));
});

test('hidden cloud and hardware details contribute neither count nor score', () => {
  const details = { id: 9000000, key: 'steam-deck-test-sample', name: 'Sample test', hardware: true, weight: 1 };
  const registry = [...features, details];
  const catalog = { features: registry, games: [{ ...game(10), featureIds: [2, 45, 46, 10012, details.id] }] };
  const ordinary = runQuery(catalog);
  const hardware = runQuery(catalog, { includeHardware: true });
  assert.equal(ordinary.rows[0].score, 1);
  assert.equal(ordinary.rows[0].count, 1);
  assert.equal(hardware.rows[0].score, 1);
  assert.equal(hardware.rows[0].count, 2);
  assert.equal(hardware.columns.length, ordinary.columns.length + 4);
  assert.equal(hardware.maxScore, ordinary.maxScore + 4);
  assert.equal(hardware.minScore, ordinary.minScore - 4);
  assert.throws(() => runQuery(catalog, { has: [details.id] }), /Unknown/);
  assert.throws(() => runQuery(catalog, { has: ['cloud-streaming'] }), /Unknown/);
});

test('hardware cells distinguish all ratings and penalties use a minus instead of a green check', () => {
  const deck = featureColumns(features).find(column => column.key === 'steam-deck');
  assert.deepEqual([10010, 10011, 10012, 10013].map(id => {
    const status = columnState({ featureIds: [id] }, deck);
    return [status.status, status.mark, status.className];
  }), [['untested', '?', 'dash'], ['unsupported', '−', 'check negative'], ['playable', '✓', 'check playable'], ['verified', '✓', 'check']]);
  assert.equal(columnState({ featureIds: [] }, deck).status, 'unknown');
  for (const id of [35, 10000]) {
    const status = columnState({ featureIds: [id], featureDataKnown: true }, features.find(feature => feature.id === id));
    assert.equal(status.mark, '−');
    assert.equal(status.className, 'check negative');
  }
});

test('fresh negative observations clear cached extras and redundant fallback is omitted from the archive', () => {
  const old = { ...game(10), featureIds: [2, 45, 46, 10000, 10001, 10013] };
  const record = { id: 10, store: { id: 10, success: 1, extra_details: {}, platforms: { steam_deck_compat_category: 0 }, name: 'Steam title' },
    appinfo: { appid: '10', common: { category: {} }, ufs: {} }, fallback: { name: 'Old title', achievementCount: 8 } };
  const extra = normalizeSteamEnrichment(record);
  assert.deepEqual(mergeSteamEnrichment([old], new Map([[10, extra]]), features)[0].featureIds, [2, 10010]);
  assert.deepEqual(archiveRecord(record).fallback, { achievementCount: 8 });
});

test('when the storefront is unavailable, fresh public appinfo supersedes cached compatibility and keyboard flags', () => {
  const result = normalizeSteamEnrichment({ id: 10, store_result: 15,
    store: { id: 10, success: 1, extra_details: {}, platforms: { steam_deck_compat_category: 3 } },
    appinfo: { appid: '10', public_only: '1', common: { nokeyboardmouse: '1', steam_deck_compatibility: { category: '1' } } } });
  assert.ok(result.featureIds.includes(10000));
  assert.ok(result.featureIds.includes(10011));
  assert.equal(result.featureIds.includes(10013), false);
});
