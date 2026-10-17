const feature = (id, key, name, group, icon, short, description, knowledgeGroup, weight = 1, hardware = false, steamIds = []) =>
  ({ id, key, name, group, icon, short, description, knowledgeGroup, weight, hardware, steamIds, accessibility: false, multiplayer: false });

export const hardwareDevices = [
  { key: 'steam-deck', name: 'Steam Deck', short: 'DCK', base: 10010, storeField: 'steam_deck_compat_category', section: 'steam_deck_compatibility', category: 'category', tests: 'tests' },
  { key: 'steam-machine', name: 'Steam Machine', short: 'MCH', base: 10020, storeField: 'steam_machine_compat_category', section: 'steam_deck_compatibility', category: 'steam_machine_compatibility', tests: 'steam_machine_tests' },
  { key: 'steam-frame', name: 'Steam Frame standalone', short: 'FRM', base: 10030, storeField: 'steam_frame_compat_category', section: 'steam_frame_compatibility', category: 'category', tests: 'tests' },
  { key: 'steam-os', name: 'SteamOS', short: 'OS', base: 10040, storeField: 'steam_os_compat_category', section: 'steam_deck_compatibility', category: 'steamos_compatibility', tests: 'steamos_tests' }
];

export const extraFeatures = [
  feature(45, 'cloud-streaming', 'Cloud streaming', 'Cloud streaming', 'cloud', 'STR', 'Supports cloud streaming.', 'cloud-streaming', 1, false, [45]),
  feature(46, 'geforce-now', 'NVIDIA GeForce NOW', 'Cloud streaming', 'cloud', 'GFN', 'Supports cloud streaming through NVIDIA GeForce NOW.', 'cloud-streaming', 1, false, [46]),
  feature(10000, 'no-keyboard-mouse', 'No keyboard/mouse support', 'Input', 'keyboard', 'NKM', 'This game cannot be played with a keyboard and mouse.', 'keyboard-mouse', -1),
  feature(10001, 'dynamic-cloud-sync', 'Dynamic Cloud Sync', 'Steam features', 'cloud', 'DYN', 'Syncs Steam Cloud saves when the game is suspended, so you can continue on another device.', 'dynamic-cloud-sync'),
  feature(10003, 'third-party-drm', 'Third-party DRM', 'Features?', 'lock', 'DRM', 'Steam discloses third-party copy protection or activation requirements. Click a game’s entry for details.', 'third-party-drm', -1),
  feature(10004, 'third-party-account', 'Third-party account required', 'Features?', 'person', 'ACC', 'A third-party account is required for the game or some of its features. Wholly optional accounts do not count. Click a game’s entry for details.', 'third-party-account', -1),
  { ...feature(10005, 'third-party-anti-cheat', 'Third-party Anti-Cheat', 'Features?', 'shield', 'TAC', 'Steam discloses anti-cheat software beyond Valve Anti-Cheat. Kernel-mode anti-cheat scores −1; other anti-cheat scores 0. VAC alone does not count. Click a game’s entry for details.', 'third-party-anti-cheat', 0), minWeight: -1 },
  ...hardwareDevices.flatMap(device => (device.key === 'steam-os' ? ['Untested', 'Unsupported', 'Supported'] : ['Untested', 'Unsupported', 'Playable', 'Verified']).map((status, category) =>
    feature(device.base + category, `${device.key}-${status.toLowerCase()}`, `${device.name}: ${status}`, 'Steam hardware', device.key === 'steam-frame' ? 'vr' : 'gamepad', device.short,
      `Steam's overall ${device.name} compatibility rating is ${status.toLowerCase()}.`, `${device.key}-status`, category === 1 ? -1 : category === 0 || status === 'Playable' ? 0 : 1, true)))
];

/** TAC is neutral unless Steam explicitly discloses kernel-mode operation. */
export function featureWeight(game, feature) {
  return feature.id === 10005 && game.disclosures?.antiCheat?.kernelMode === true ? -1 : feature.weight ?? 1;
}

/** New fields stay unknown on old catalogs and partially accessible apps. */
export function isFeatureKnown(game, feature) {
  return feature.knowledgeGroup
    ? game.featureIds?.includes(feature.id) || game.knownFeatureGroups?.includes(feature.knowledgeGroup) === true
    : game.featureDataKnown === true;
}
