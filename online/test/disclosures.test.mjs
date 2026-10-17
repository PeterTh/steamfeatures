import test from 'node:test';
import assert from 'node:assert/strict';
import { features } from '../src/features.mjs';
import { columnState, disclosureDetails } from '../src/feature-presentation.mjs';
import { normalizeSteamDisclosures } from '../scripts/steam-enrichment.mjs';
import { runQuery } from '../src/query.mjs';
import { encodeBinaryCatalog } from '../scripts/catalog-binary.mjs';
import { decodeBinaryCatalog } from '../src/catalog-binary.mjs';

const source = extra_details => ({ store: { id: 1, success: 1, visible: true, extra_details } });
const project = extra => normalizeSteamDisclosures(source(extra));
const feature = id => features.find(value => value.id === id);

test('Features? follows Creation, Input replaces Controllers, and VAC is neutral independent of multiplayer', () => {
  const groups = [...new Set(features.map(value => value.group))];
  assert.deepEqual(groups.slice(groups.indexOf('Creation'), groups.indexOf('Remote Play') + 1), ['Creation', 'Features?', 'Remote Play']);
  assert.ok(groups.includes('Input'));
  assert.ok(!groups.includes('Controllers'));
  assert.deepEqual(features.filter(value => value.group === 'Features?').map(value => value.id), [35, 10003, 10004, 10005, 8]);
  assert.equal(feature(8).weight, 0);
  assert.equal(feature(8).multiplayer, false);
  for (const includeMultiplayer of [false, true]) {
    const result = runQuery({ features, games: [{ id: 1, name: 'Example', featureIds: [2, 8], featureDataKnown: true, reviews: 100, earlyAccess: false, releaseStatus: 'released' }] }, { includeMultiplayer });
    assert.ok(result.columns.includes(8));
    assert.equal(result.rows[0].score, 1);
  }
});

test('explicit no-DRM text stays inspectable without a penalty; meaningful DRM is negative', () => {
  for (const text of ['None', 'NONE', 'N/A', 'NA', 'DRM Free!', 'No, my game does not use any third-party DRM', 'This product does not incorporate third-party DRM.']) {
    const result = project({ drm_third_party_type: text });
    assert.ok(!result.featureIds.includes(10003), text);
    assert.ok(result.knownFeatureGroups.includes('third-party-drm'));
    assert.equal(disclosureDetails(result, feature(10003)).description, text);
  }
  const result = project({ drm_third_party_type: 'Denuvo Anti-Tamper' });
  assert.ok(result.featureIds.includes(10003));
  assert.equal(columnState(result, feature(10003)).mark, '−');
});

test('mode-specific account requirements count while wholly optional accounts do not', () => {
  const cases = [
    ['Ubisoft Account', true],
    ['Email/Password Pixel Starships Account (Optional)', false],
    ['Optional Google account for asynchronous multiplayer', false],
    ['Facebook accounts supported (not required)', false],
    ['Home Net Games service - optional for single player, required for multiplayer', true],
    ['Paradox Accounts (Requirement is for multiplayer only)', true],
    ['A free, optional OOTP account is required to enjoy Challenge Mode.', true],
    ['2K Account for Online Interactions (Not Required for Offline Play)', true],
    ['Online-Go.com accounts used for multiplayer. Not required for tutorials or AI.', true],
    ['Academy Account may be used for downloading content but is not required for play.', false],
    ['Not required. Account is automatically associated with SteamID. Optionally link an existing account.', false],
    ['Account required to access FanHub content but is not required for play.', true],
    ['Account requirement to be determined', null]
  ];
  for (const [account, required] of cases) {
    const result = project({ user_account_third_party: account, user_account_third_party_link_to_steam: true });
    assert.equal(result.featureIds.includes(10004), required === true, account);
    assert.equal(result.knownFeatureGroups.includes('third-party-account'), required !== null, account);
    const details = disclosureDetails(result, feature(10004));
    assert.equal(details.description, account);
    assert.deepEqual(details.facts, [['Steam account linking', 'Supported']]);
  }
});

test('TAC includes unnamed disclosures without VAC but leaves missing source sections unknown', () => {
  const unnamed = project({ anticheat: {} });
  assert.ok(unnamed.featureIds.includes(10005));
  assert.match(disclosureDetails(unnamed, feature(10005)).description, /not available in this snapshot/);
  const absent = project({});
  assert.ok(!absent.featureIds.includes(10005));
  assert.ok(absent.knownFeatureGroups.includes('third-party-anti-cheat'));
  const unknown = normalizeSteamDisclosures({});
  assert.ok(!unknown.knownFeatureGroups.includes('third-party-anti-cheat'));
  const vac = normalizeSteamDisclosures({ appinfo: { common: { category: { category_8: '1' } } } });
  assert.ok(!vac.featureIds.includes(10005));
  assert.equal(columnState(vac, feature(10005)).status, 'unknown');
  assert.equal(disclosureDetails(vac, feature(10005)), null);
});

test('TAC excludes VAC alone and lists another provider alongside VAC', () => {
  assert.equal(feature(10005).name, 'Third-party Anti-Cheat');
  assert.equal(feature(10005).short, 'TAC');
  const withVac = extra => ({ ...source(extra), appinfo: { common: { category: { category_8: '1' } } } });
  for (const name of ['VAC', 'Valve Anti-Cheat', 'VAC (Valve Anti-Cheat)', 'Valve Anti Cheat', 'VAC Live']) {
    for (const record of [source({ anticheat: { name } }), withVac({ anticheat: { name } })]) {
      const result = normalizeSteamDisclosures(record);
      assert.equal(columnState(result, feature(10005)).mark, '–', name);
      assert.match(disclosureDetails(result, feature(10005)).summary, /Only Valve Anti-Cheat/);
    }
  }
  for (const name of ['BattlEye', 'Easy Anti-Cheat', 'VAC + Easy Anti-Cheat', 'Valve Anti-Cheat / BattlEye']) {
    const result = normalizeSteamDisclosures(withVac({ anticheat: { name, kernel_mode: true } }));
    assert.equal(columnState(result, feature(10005)).mark, '−', name);
    assert.match(disclosureDetails(result, feature(10005)).summary, /Third-party anti-cheat disclosed/);
    assert.deepEqual(disclosureDetails(result, feature(10005)).facts, [
      ...(/VAC|Valve/.test(name) ? [] : [['Valve Anti-Cheat', 'Also advertised by Steam']]), ['Kernel mode', 'Yes']
    ]);
  }
  const ambiguous = normalizeSteamDisclosures(withVac({ anticheat: {} }));
  assert.equal(columnState(ambiguous, feature(10005)).status, 'unknown');
  assert.match(disclosureDetails(ambiguous, feature(10005)).summary, /Third-party anti-cheat unknown/);
  assert.equal(columnState(normalizeSteamDisclosures(withVac({})), feature(10005)).mark, '–');
});

test('only explicit kernel-mode TAC receives a penalty in scores, sorting and cell details', () => {
  const games = [true, false, undefined, 'true'].map((kernel_mode, index) => ({
    id: index + 1, name: `Example ${index + 1}`, reviews: 100, earlyAccess: false, releaseStatus: 'released', featureDataKnown: true,
    ...project({ anticheat: { name: 'Example anti-cheat', ...(kernel_mode !== undefined ? { kernel_mode } : {}) } }),
    featureIds: [2, 10005]
  }));
  for (const includeMultiplayer of [false, true]) {
    const result = runQuery({ features, games }, { includeMultiplayer });
    assert.deepEqual(result.rows.map(game => game.id), [2, 3, 4, 1]);
    assert.deepEqual(result.rows.map(game => game.score), [1, 1, 1, 0]);
    assert.equal(result.minScore, -5);
    assert.equal(result.rows[0].count, result.rows[3].count);
  }
  const kernel = columnState(games[0], feature(10005));
  assert.equal(kernel.mark, '−');
  assert.equal(kernel.className, 'check negative');
  assert.match(kernel.label, /−1 score point/);
  assert.match(disclosureDetails(games[0], feature(10005)).summary, /−1 score point/);
  for (const game of games.slice(1)) {
    assert.equal(columnState(game, feature(10005)).className, 'check neutral');
    assert.match(disclosureDetails(game, feature(10005)).summary, /0 score points/);
  }
  const vacOnly = { ...games[0], featureIds: [2, 8] };
  assert.equal(runQuery({ features, games: [vacOnly] }).rows[0].score, 1);
  assert.equal(columnState(vacOnly, feature(8)).className, 'check neutral');
});

test('ordinary zero-point badges are grey while hardware playable ratings retain their amber state', () => {
  for (const id of [8, 16, 54, 60, 10005]) assert.equal(columnState({ featureIds: [id], featureDataKnown: true }, feature(id)).className, 'check neutral');
  const column = { statuses: [{ id: 10012, status: 'playable', label: 'Playable' }] };
  assert.equal(columnState({ featureIds: [10012] }, column).className, 'check playable');
});

test('browser binary preserves disclosure text and supplied anti-cheat flags', () => {
  const result = project({ drm_third_party_type: '<publisher text>', anticheat: { name: 'Example anti-cheat', kernel_mode: true, uninstall_completely: false } });
  const decoded = decodeBinaryCatalog(encodeBinaryCatalog({ version: 1, features, games: [{ id: 1, name: 'Example', ...result }] }));
  assert.deepEqual(decoded.games[0].disclosures, result.disclosures);
  assert.deepEqual(disclosureDetails(decoded.games[0], feature(10005)).facts, [['Kernel mode', 'Yes'], ['Fully removed on uninstall', 'No']]);
});
