import { createHash } from 'node:crypto';
import { hardwareDevices } from '../src/extra-features.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const enabled = value => value === true || value === 1 || value === '1' || value === 'true';
const number = value => (typeof value === 'number' || typeof value === 'string') && /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
const slug = value => value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const human = value => value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/\bDoes Not Automatically Invokes\b/g, 'does not automatically invoke');

const configLabels = {
  requires_manual_keyboard_invoke: ['Manual keyboard invocation required', -1],
  requires_non_controller_launcher_nav: ['Launcher needs mouse or touch', -1],
  primary_player_is_controller_slot_0: ['External primary controller restricted', -1],
  non_deck_display_glyphs: ['Controller prompts do not match device', -1],
  small_text: ['Small interface text', -1],
  requires_internet_for_setup: ['Internet required for setup', -1],
  requires_internet_for_singleplayer: ['Internet required for single-player', -1],
  gamescope_frame_limiter_not_supported: ['Frame limiter unsupported', -1],
  hdr_support: ['HDR support in tested configuration', 1]
};

function register(registry, { key, name, description, knowledgeGroup, short, weight }) {
  // A reserved range keeps IDs stable across changing catalog membership.
  const id = 1000000 + (createHash('sha256').update(key).digest().readUInt32BE(0) & 0x3fffffff);
  const previous = registry.get(id);
  if (previous && previous.key !== key) throw new Error(`Hardware feature ID collision: ${key}`);
  if (!previous) registry.set(id, { id, key, name, description, knowledgeGroup, short, weight, group: 'Steam hardware', hardware: true,
    icon: 'gamepad', steamIds: [], accessibility: false, multiplayer: false });
  return id;
}

/** Small browser projection; every unprojected field remains in the raw archive. */
export function normalizeSteamEnrichment(record, registry = new Map()) {
  const store = record.store?.success === 1 ? record.store : undefined;
  const appinfo = record.appinfo;
  const common = appinfo?.common;
  const fallback = record.fallback ?? {};
  const preferAppInfo = record.store_result != null && record.store_result !== 1 || store?.visible === false;
  const ids = new Set(), known = new Set();
  const set = (id, value, group) => { known.add(group); if (value) ids.add(id); };
  if (object(common?.category)) for (const id of [45, 46]) set(id, enabled(common.category[`category_${id}`]), 'cloud-streaming');
  else for (const id of [45, 46]) if (fallback.categories?.includes(id) ||
    Object.values(store?.categories ?? {}).some(list => Array.isArray(list) && list.includes(id))) ids.add(id);
  if (!preferAppInfo && object(store?.extra_details)) set(10000, enabled(store.extra_details.no_mouse_keyboard_support), 'keyboard-mouse');
  else if (common && (Object.hasOwn(common, 'nokeyboardmouse') || !enabled(appinfo.public_only))) set(10000, enabled(common.nokeyboardmouse), 'keyboard-mouse');
  else if (object(store?.extra_details)) set(10000, enabled(store.extra_details.no_mouse_keyboard_support), 'keyboard-mouse');
  if (appinfo && (object(appinfo.ufs) || !enabled(appinfo.public_only))) set(10001, enabled(appinfo.ufs?.sync_while_suspended), 'dynamic-cloud-sync');
  for (const device of hardwareDevices) {
    const report = common?.[device.section];
    const category = number(preferAppInfo ? report?.[device.category] ?? store?.platforms?.[device.storeField] : store?.platforms?.[device.storeField] ?? report?.[device.category]);
    const maximum = device.key === 'steam-os' ? 2 : 3;
    if (category !== undefined && category <= maximum) {
      known.add(`${device.key}-status`); ids.add(device.base + category);
    }
    const tests = report?.[device.tests];
    if (object(tests) || Array.isArray(tests)) {
      const group = `${device.key}-tests`; known.add(group);
      for (const test of Object.values(tests)) {
        if (typeof test?.token !== 'string' || !/^#[A-Za-z0-9_]+$/.test(test.token)) continue;
        const label = test.token.replace(/^#.*?_TestResult_/, '');
        const display = number(test.display) ?? 0;
        if (display === 0) continue; // Invisible Steam diagnostics are retained only in raw data.
        const weight = display === 4 || (device.key === 'steam-os' && display === 3) ? 1 : display === 2 || display === 3 ? -1 : 0;
        ids.add(register(registry, { key: `${device.key}-test-${slug(label)}`, name: `${device.name}: ${human(label)}`, short: 'TST', weight,
          knowledgeGroup: group, description: `Valve's ${device.name} compatibility report lists: ${human(label)}.` }));
      }
    }
    // SteamOS and Machine share the Deck report container, not its configuration.
    if (!['steam-deck', 'steam-frame'].includes(device.key) || !object(report?.configuration)) continue;
    const group = `${device.key}-configuration`;
    for (const [key, [label, weight]] of Object.entries(configLabels)) {
      if (!Object.hasOwn(report.configuration, key)) continue;
      // Knowledge is per configuration field: report revisions can add new keys.
      const knowledgeGroup = `${group}-${key}`; known.add(knowledgeGroup);
      const id = register(registry, { key: `${device.key}-${slug(key)}`, name: `${device.name}: ${label}`, short: 'CFG', weight, knowledgeGroup,
        description: `${label} in Valve's tested ${device.name} configuration.` });
      if (enabled(report.configuration[key])) ids.add(id);
    }
  }
  const achievementCount = number(store?.extra_details?.links_and_info?.achievement_count) ?? number(fallback.achievementCount);
  return { featureIds: [...ids].sort((a, b) => a - b), knownFeatureGroups: [...known].sort(), ...(achievementCount !== undefined ? { achievementCount } : {}) };
}

/** Explicit equivalent facts only. Requirements and achievement schemas are excluded. */
export function fallbackFromAppDetails(record) {
  const result = {};
  for (const key of ['name', 'type', 'developers', 'publishers', 'platforms', 'supported_languages', 'controller_support', 'website', 'short_description', 'required_age', 'is_free', 'dlc', 'release_date']) {
    if (record[key] !== undefined && record[key] !== null) result[key] = record[key];
  }
  if (Array.isArray(record.categories)) result.categories = [...new Set(record.categories.map(value => number(object(value) ? value.id : value)).filter(id => id !== undefined))];
  if (Array.isArray(record.genres)) result.genres = record.genres;
  const count = number(record.achievements?.total);
  if (count !== undefined) result.achievementCount = count;
  return result;
}

export function archiveRecord(row) {
  const { id, store, appinfo } = row;
  const fallback = { ...row.fallback };
  // Drop redundant fallback sections when their Steam equivalent was returned.
  if (store) {
    for (const field of ['name', 'type', 'is_free']) if (store[field] !== undefined) delete fallback[field];
    if (store.categories !== undefined) delete fallback.categories;
    if (store.categories !== undefined || store.visible === true) { delete fallback.featureIds; delete fallback.featureDataKnown; }
    if (store.release !== undefined) delete fallback.release_date;
    if (store.release !== undefined) for (const field of ['releaseDate', 'releaseISO', 'releaseStatus', 'earlyAccess']) delete fallback[field];
    if (store.reviews?.summary_filtered !== undefined) { delete fallback.reviews; delete fallback.positivePercent; }
    if (store.platforms !== undefined) delete fallback.platforms;
    if (store.supported_languages !== undefined) delete fallback.supported_languages;
    for (const field of ['developers', 'publishers', 'short_description']) if (store.basic_info?.[field] !== undefined) delete fallback[field];
    const links = store.extra_details?.links_and_info;
    if (links?.achievement_count !== undefined) delete fallback.achievementCount;
    if (links?.genreids !== undefined) delete fallback.genres;
    if (links?.website !== undefined) delete fallback.website;
  }
  return { id, ...(store ? { store } : {}), ...(appinfo ? { appinfo } : {}), ...(Object.keys(fallback).length ? { fallback } : {}) };
}
