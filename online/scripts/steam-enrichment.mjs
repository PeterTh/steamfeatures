import { createHash } from 'node:crypto';
import { hardwareDevices } from '../src/extra-features.mjs';
import { normalizeSteamLanguages } from './steam-languages.mjs';

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

const disclosureText = value => typeof value === 'string' ? value.trim() : '';
const noDisclosure = value => /^(?:none|no|n\/?a|null|not applicable|not required|no (?:third[- ]party )?(?:drm|account)(?: required)?)[.!\s]*$/i.test(value);
function hasThirdPartyDRM(value) {
  return Boolean(value) && !noDisclosure(value) && !/\bdrm[- ]free\b/i.test(value)
    && !/\bdoes(?:n't| not)\s+(?:use|incorporate|include|require|have)\s+(?:(?:any|a|additional|third[- ]party)\s+)*drm\b/i.test(value);
}

/** Steam's account label is free text. Explicit requirements for a mode still
 * count when other modes are optional; merely optional accounts do not. */
function requiresThirdPartyAccount(value) {
  if (!value || noDisclosure(value)) return false;
  if (/\b(?:unknown|to be confirmed|to be determined|tbd)\b/i.test(value)) return null;
  const affirmative = value.replace(/\bnot\s+(?:required|needed|necessary)\b/gi, '')
    .replace(/\bno\s+(?:additional\s+)?(?:software|personal information)[^.]*?(?:required|needed)\b/gi, '');
  if (/\b(?:requir(?:e[ds]?|ing|ement)|needed|must|have to)\b/i.test(affirmative)) return true;
  if (/\bnot required for (?:offline|single[- ]player|tutorials|ai)\b/i.test(value)
      && /\b(?:online|multiplayer)\b/i.test(affirmative)) return true;
  if (/\boptional(?:ly)?\b|\bnot (?:required|needed|necessary)\b|\bno account\b/i.test(value)) return false;
  return true;
}

function hasThirdPartyAntiCheat(value, vac) {
  if (!object(value)) return value == null ? false : null;
  const name = disclosureText(value.name);
  // An unnamed message alongside VAC does not establish another provider.
  if (!name) return vac ? null : true;
  const other = name.replace(/\b(?:valve\s+anti[-\s]?cheat|vac(?:\s+live)?)\b/gi, '')
    .replace(/[\s()[\],;:/+&.\-–—™®]/g, '');
  return Boolean(other);
}

export function normalizeSteamDisclosures(record) {
  const store = record.store?.success === 1 ? record.store : undefined;
  const preferAppInfo = record.store_result != null && record.store_result !== 1 || store?.visible === false;
  const extra = object(store?.extra_details) ? store.extra_details : undefined;
  const common = record.appinfo?.common;
  const storeCategories = object(store?.categories) ? Object.values(store.categories).flatMap(value => Array.isArray(value) ? value : []) : null;
  const vac = preferAppInfo && object(common?.category) ? enabled(common.category.category_8)
    : storeCategories ? storeCategories.includes(8)
      : enabled(common?.category?.category_8) || record.fallback?.categories?.includes(8) === true;
  const featureIds = [], knownFeatureGroups = [], details = {};
  const observe = (key, id, value) => {
    if (value === null) return;
    knownFeatureGroups.push(key); if (value) featureIds.push(id);
  };
  if (extra) {
    const drm = disclosureText(extra.drm_third_party_type), account = disclosureText(extra.user_account_third_party);
    observe('third-party-drm', 10003, extra.drm_third_party_type == null || typeof extra.drm_third_party_type === 'string' ? hasThirdPartyDRM(drm) : null);
    const required = requiresThirdPartyAccount(account);
    observe('third-party-account', 10004, extra.user_account_third_party == null || typeof extra.user_account_third_party === 'string' ? required : null);
    if (drm) details.drm = drm;
    if (disclosureText(extra.drm_activation_limit)) details.drmActivationLimit = extra.drm_activation_limit.trim();
    if (account) { details.account = account; details.accountRequired = required; }
    if (typeof extra.user_account_third_party_link_to_steam === 'boolean') details.accountLinking = extra.user_account_third_party_link_to_steam;
    const antiCheat = object(extra.anticheat);
    observe('third-party-anti-cheat', 10005, hasThirdPartyAntiCheat(extra.anticheat, vac));
    if (antiCheat) {
      details.antiCheat = {};
      if (disclosureText(extra.anticheat.name)) details.antiCheat.name = extra.anticheat.name.trim();
      for (const [source, target] of [['kernel_mode', 'kernelMode'], ['uninstall_completely', 'uninstallsCompletely'], ['boot_protection', 'bootProtection']]) {
        if (typeof extra.anticheat[source] === 'boolean') details.antiCheat[target] = extra.anticheat[source];
      }
      if (disclosureText(extra.anticheat.boot_protection_name)) details.antiCheat.bootProtectionName = extra.anticheat.boot_protection_name.trim();
    }
  }
  if (vac) details.vac = true;
  return { featureIds, knownFeatureGroups, disclosures: Object.keys(details).length ? details : undefined };
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
  const disclosure = normalizeSteamDisclosures(record);
  for (const id of disclosure.featureIds) ids.add(id);
  for (const group of disclosure.knownFeatureGroups) known.add(group);
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
  return { featureIds: [...ids].sort((a, b) => a - b), knownFeatureGroups: [...known].sort(), disclosures: disclosure.disclosures,
    ...(achievementCount !== undefined ? { achievementCount } : {}), ...normalizeSteamLanguages(record) };
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
