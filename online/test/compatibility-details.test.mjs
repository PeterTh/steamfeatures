import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityDetails, isCompatibilityDetail } from '../src/compatibility-details.mjs';
import { normalizeSteamEnrichment } from '../scripts/steam-enrichment.mjs';

function report(deck = {}, frame = {}) {
  const registry = new Map();
  const game = normalizeSteamEnrichment({ id: 10, appinfo: { common: {
    steam_deck_compatibility: deck, steam_frame_compatibility: frame,
  } } }, registry);
  return { game, features: [...registry.values()] };
}
const check = (token, display = '1') => ({ token: '#SteamDeckVerified_TestResult_' + token, display });

test('review notes and equivalent configuration flags appear only once', () => {
  const { game, features } = report({ tests: [check('InterfaceTextIsNotLegible'),
    check('TextInputDoesNotAutomaticallyInvokesKeyboard'), check('ExternalControllersNotSupportedPrimaryPlayer')],
  configuration: { small_text: '1', requires_manual_keyboard_invoke: '1', primary_player_is_controller_slot_0: '1' } });
  assert.deepEqual(compatibilityDetails(game, 'steam-deck', features), [
    { tone: 'warning', text: 'Some interface text is too small to read comfortably.' },
    { tone: 'warning', text: 'Entering text requires manually opening the on-screen keyboard.' },
    { tone: 'warning', text: 'External controllers are not supported for the primary player.' },
  ]);
});

test('each hardware target shows only its own explicit notes, without turning absent flags into passes', () => {
  const { game, features } = report({ category: '3', tests: [check('InterfaceTextIsLegible', '4')],
    configuration: { small_text: '0', requires_internet_for_setup: '1' },
    steam_machine_tests: [check('ControllerGlyphsMatchDevice', '4')],
    steamos_tests: [check('GameStartupFunctional', '3')] },
  { tests: [check('UnsupportedAntiCheatOther', '2')], configuration: { hdr_support: '1' } });
  assert.deepEqual(compatibilityDetails(game, 'steam-deck', features), [
    { tone: 'pass', text: 'Interface text is legible.' },
    { tone: 'warning', text: 'An internet connection is required for first-time setup.' },
  ]);
  assert.deepEqual(compatibilityDetails(game, 'steam-machine', features), [{ tone: 'pass', text: 'Controller icons match this device.' }]);
  assert.deepEqual(compatibilityDetails(game, 'steam-os', features), [{ tone: 'pass', text: 'The game starts successfully.' }]);
  assert.deepEqual(compatibilityDetails(game, 'steam-frame', features), [
    { tone: 'warning', text: "This game's anti-cheat is not supported on SteamOS." },
    { tone: 'info', text: 'HDR is supported.' },
  ]);
  assert.deepEqual(compatibilityDetails({ featureIds: [], knownFeatureGroups: game.knownFeatureGroups }, 'steam-deck', features), []);
  assert.equal(isCompatibilityDetail({ hardware: true, knowledgeGroup: 'steam-deck-status' }), false);
  assert.equal(isCompatibilityDetail(features[0], 'steam-frame'), false);
});

test('note severity follows the meaning of the check, independently of score weights', () => {
  const { game, features } = report({ tests: [check('FirstTimeSetupRequiresActiveInternetConnection'), check('DefaultConfigurationIsPerformant', '4')],
    steamos_tests: [check('ResumeFromSleepNotFunctional')] });
  assert.equal(features[0].weight, 0);
  assert.equal(compatibilityDetails(game, 'steam-deck', features)[0].tone, 'warning');
  assert.equal(compatibilityDetails(game, 'steam-deck', features)[1].tone, 'pass');
  assert.equal(compatibilityDetails(game, 'steam-os', features)[0].tone, 'warning');
});

test('new review checks fall back to readable names without inventing a pass or warning', () => {
  const { game, features } = report({ tests: [check('NewCompatibilityCheck', '4'), check('Constructor', '4')] });
  assert.deepEqual(compatibilityDetails(game, 'steam-deck', features), [
    { tone: 'info', text: 'New Compatibility Check' },
    { tone: 'info', text: 'Constructor' },
  ]);
});
