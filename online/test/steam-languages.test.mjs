import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, languageByKey, storeLanguage, encodeLanguageFlags, decodeLanguageBits, languageFlags } from '../src/languages.mjs';
import { normalizeSteamLanguages } from '../scripts/steam-languages.mjs';
import { normalizeSteamEnrichment } from '../scripts/steam-enrichment.mjs';
import { mergeSteamEnrichment } from '../scripts/steam-data-import.mjs';

const read = (value, key) => languageFlags(decodeLanguageBits(value.languageBits), languageByKey(key).id);
const store = supported_languages => ({ store: { success: 1, supported_languages } });
const pics = supported_languages => ({ appinfo: { common: { supported_languages } } });

test('Steam IDs preserve regional variants and unify migrated additional-language aliases', () => {
  assert.equal(storeLanguage(22).key, 'brazilian');
  assert.equal(storeLanguage(11).key, 'portuguese');
  assert.equal(storeLanguage(27).key, 'latam');
  assert.equal(storeLanguage(5).key, 'spanish');
  assert.equal(storeLanguage(25).key, 'arabic');
  assert.equal(storeLanguage(29).id, storeLanguage(6).id);
  assert.equal(storeLanguage(30).id, storeLanguage(-1, 25).id);
  assert.equal(storeLanguage(31).id, storeLanguage(-1, 38).id);
  assert.equal(storeLanguage(-1, 73).key, 'zulu');
  assert.equal(storeLanguage(-1, 19).key, 'gurmukhi');
  assert.equal(storeLanguage(-1, 50).key, 'shahmukhi');
});

test('all language flags round-trip across byte boundaries without changing other languages', () => {
  for (const language of LANGUAGES) for (let flags = 0; flags < 8; flags++) {
    const decoded = decodeLanguageBits(encodeLanguageFlags([[language.id, flags]]));
    for (const candidate of LANGUAGES) assert.equal(languageFlags(decoded, candidate.id), candidate.id === language.id ? flags : 0);
  }
  for (const value of ['', null, 'A'.repeat(56), '!'.repeat(56), encodeLanguageFlags([]).slice(0, -1)]) assert.throws(() => decodeLanguageBits(value));
});

test('store language support includes independent interface, audio and subtitle flags', () => {
  const value = normalizeSteamLanguages(store([
    { elanguage: 1, supported: true, full_audio: false, subtitles: true },
    { elanguage: -1, eadditionallanguage: 73, supported: false, full_audio: true },
    { elanguage: 6, supported: true }, { elanguage: 29, full_audio: true },
  ]));
  assert.equal(read(value, 'german'), 5);
  assert.equal(read(value, 'zulu'), 2);
  assert.equal(read(value, 'schinese'), 3);
  assert.equal(read(value, 'english'), 0);
});

test('complete store tables replace PICS values, while unavailable stores use complete PICS tables', () => {
  const record = { ...store([{ elanguage: 1, supported: true }]), ...pics({ german: { supported: '1', full_audio: 'true', subtitles: 'true' } }) };
  assert.equal(read(normalizeSteamLanguages(record), 'german'), 1);
  assert.equal(read(normalizeSteamLanguages({ ...record, store_result: 15 }), 'german'), 7);
  assert.equal(read(normalizeSteamLanguages({ ...record, store: { ...record.store, visible: false } }), 'german'), 7);
  assert.equal(read(normalizeSteamLanguages({ ...record, store: { success: 1, supported_languages: [] } }), 'german'), 0);
  assert.equal(read(normalizeSteamLanguages({ ...record, appinfo: {}, store_result: 15 }), 'german'), 1);
});

test('PICS aliases are normalized and incomplete or malformed language data stays unknown', () => {
  const value = normalizeSteamLanguages(pics({ korean: { supported: 'true' }, sc_schinese: { subtitles: '1' }, slovakian: { full_audio: '1' } }));
  assert.equal(read(value, 'koreana'), 1);
  assert.equal(read(value, 'schinese'), 4);
  assert.equal(read(value, 'slovak'), 2);
  assert.deepEqual(normalizeSteamLanguages({ appinfo: { common: { languages: { english: '1' } } } }), {});
  assert.deepEqual(normalizeSteamLanguages(pics({ 'english (full audio)': { supported: 'true' } })), {});
  assert.deepEqual(normalizeSteamLanguages({ fallback: { supported_languages: 'English<strong>*</strong>' } }), {});
  assert.throws(() => normalizeSteamLanguages(store([{ elanguage: 300, supported: true }])), /Unknown Steam language/);
});

test('language data passes through enrichment without becoming features or affecting counts', () => {
  const projection = normalizeSteamEnrichment({ id: 1, ...store([{ elanguage: 0, supported: true }]) });
  assert.deepEqual(projection.featureIds, []);
  const [game] = mergeSteamEnrichment([{ id: 1, featureIds: [2] }], new Map([[1, projection]]), []);
  assert.equal(read(game, 'english'), 1);
  assert.deepEqual(game.featureIds, [2]);
});
