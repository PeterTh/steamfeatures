import { hardwareDevices } from './extra-features.mjs';

// Text is shared across devices; the selected target supplies the context.
const tests = {
  'audio-output-has-nonblocking-issues': ['warning', 'Audio may have minor issues.'],
  'aux-functionality-not-accessible-map-editor': ['warning', 'The map editor is not accessible on this device.'],
  'cloud-saves-not-enabled-by-default': ['warning', 'Cloud saves are not enabled by default.'],
  'controller-glyphs-do-not-match-deck-device': ['warning', 'The game may show controller icons that do not match this device.'],
  'controller-glyphs-do-not-match-device': ['warning', 'The game may show controller icons that do not match this device.'],
  'controller-glyphs-match-deck-device': ['pass', 'Controller icons match this device.'],
  'controller-glyphs-match-device': ['pass', 'Controller icons match this device.'],
  'cross-platform-cloud-saves-not-supported': ['warning', 'Cloud saves cannot be transferred between operating systems.'],
  'default-configuration-is-not-performant': ['warning', 'The default graphics settings do not perform well on this device.'],
  'default-configuration-is-performant': ['pass', 'The default graphics settings perform well on this device.'],
  'default-controller-config-fully-functional': ['pass', 'All functionality is accessible with the default controller configuration.'],
  'default-controller-config-not-fully-functional': ['warning', 'Some functionality is not accessible with the default controller configuration.'],
  'device-compatibility-warnings-shown': ['warning', 'The game displays compatibility warnings on this device.'],
  'display-output-has-nonblocking-issues': ['warning', 'The display may have minor issues.'],
  'display-output-not-correctly-scaled': ['warning', 'The game does not display at the correct scale.'],
  'external-controllers-not-supported-local-multiplayer': ['warning', 'External controllers are not supported for local multiplayer.'],
  'external-controllers-not-supported-primary-player': ['warning', 'External controllers are not supported for the primary player.'],
  'first-time-setup-requires-active-internet-connection': ['warning', 'An internet connection is required for first-time setup.'],
  'game-or-launcher-doesnt-exit-cleanly': ['warning', 'The game or its launcher may not close properly.'],
  'gamepad-not-enabled-by-default': ['warning', 'Controller support must be enabled in the game settings.'],
  'interface-text-is-legible': ['pass', 'Interface text is legible.'],
  'interface-text-is-not-legible': ['warning', 'Some interface text is too small to read comfortably.'],
  'launcher-interaction-issues': ['warning', 'The launcher may require the touchscreen or a mouse.'],
  'multi-window-app-automatically-sets-focus': ['warning', 'The game uses multiple windows and may switch focus between them.'],
  'native-resolution-not-default': ['warning', "The device's native resolution is not selected by default."],
  'native-resolution-not-supported': ['warning', "The device's native resolution is not supported."],
  'not-fully-functional-without-external-keyboard': ['warning', 'An external keyboard is needed for some functionality.'],
  'not-fully-functional-without-external-webcam': ['warning', 'An external webcam is needed for some functionality.'],
  'resume-from-sleep-not-functional': ['warning', 'The game does not resume correctly after sleep.'],
  'simultaneous-input-gyro-trackpad-friendly': ['pass', 'Simultaneous controller and mouse input supports gyro and trackpad controls.'],
  'singleplayer-gameplay-requires-active-internet-connection': ['warning', 'An internet connection is required for single-player gameplay.'],
  'steam-osdoes-not-support': ['warning', 'This game is not supported on SteamOS.'],
  'steam-osdoes-not-support-operating-system': ['warning', "This game's operating system requirements are not supported on SteamOS."],
  'steam-osdoes-not-support-retired': ['warning', 'This game is not supported on SteamOS.'],
  'steam-osdoes-not-support-software': ['warning', 'Software required by this game is not supported on SteamOS.'],
  'steam-osdoes-not-support-vr': ['warning', 'This VR game is not supported on this device.'],
  'text-input-does-not-automatically-invokes-keyboard': ['warning', 'Entering text requires manually opening the on-screen keyboard.'],
  'unsupported-anti-cheat-configuration': ['warning', "This game's anti-cheat configuration is not supported on SteamOS."],
  'unsupported-anti-cheat-other': ['warning', "This game's anti-cheat is not supported on SteamOS."],
  'unsupported-graphics-performance': ['warning', 'Graphics performance is not sufficient for this device.'],
  'vrstreaming-not-performant': ['warning', 'VR streaming does not perform well on this device.'],
  'game-startup-functional': ['pass', 'The game starts successfully.'],
};

// Reuse equivalent review notes so configuration flags do not repeat them.
const configuration = {
  'gamescope-frame-limiter-not-supported': ['warning', "The device's frame limiter is not supported."],
  'hdr-support': ['info', 'HDR is supported.'],
  'non-deck-display-glyphs': tests['controller-glyphs-do-not-match-device'],
  'primary-player-is-controller-slot-0': tests['external-controllers-not-supported-primary-player'],
  'requires-internet-for-setup': tests['first-time-setup-requires-active-internet-connection'],
  'requires-internet-for-singleplayer': tests['singleplayer-gameplay-requires-active-internet-connection'],
  'requires-manual-keyboard-invoke': tests['text-input-does-not-automatically-invokes-keyboard'],
  'requires-non-controller-launcher-nav': tests['launcher-interaction-issues'],
  'small-text': tests['interface-text-is-not-legible'],
};

export function isCompatibilityDetail(feature, target) {
  const targets = target ? [target] : hardwareDevices.map(device => device.key);
  return feature.hardware === true && targets.some(key => feature.knowledgeGroup === `${key}-tests`
    || feature.knowledgeGroup?.startsWith(`${key}-configuration-`));
}

/** Only explicitly listed facts appear; missing flags never become passed checks. */
export function compatibilityDetails(game, target, features) {
  const listed = new Set(game.featureIds), seen = new Set(), details = [];
  for (const feature of features) {
    if (!listed.has(feature.id) || !isCompatibilityDetail(feature, target)) continue;
    const test = feature.knowledgeGroup === `${target}-tests`;
    const key = feature.key.slice(target.length + (test ? '-test-'.length : 1));
    const labels = test ? tests : configuration;
    const note = Object.hasOwn(labels, key) ? labels[key] : undefined;
    // Future Steam checks still have a human-readable name, without guessing their severity.
    const [tone, text] = note ?? ['info', feature.name.replace(/^[^:]+:\s*/, '')];
    if (!text || seen.has(text)) continue;
    seen.add(text);
    details.push({ tone, text });
  }
  return details;
}
