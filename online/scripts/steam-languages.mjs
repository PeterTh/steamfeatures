import { encodeLanguageFlags, languageByKey, storeLanguage } from '../src/languages.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const enabled = value => [true, 1, '1', 'true'].includes(value);
const flags = row => Number(enabled(row.supported)) | Number(enabled(row.full_audio)) << 1 | Number(enabled(row.subtitles)) << 2;

function fromStore(value) {
  if (!Array.isArray(value)) return undefined;
  return encodeLanguageFlags(value.map(row => {
    const language = storeLanguage(row.elanguage ?? -1, row.eadditionallanguage ?? -1);
    if (!language) throw new Error(`Unknown Steam language: ${row.elanguage}/${row.eadditionallanguage}. Update the language dictionary before publishing.`);
    return [language.id, flags(row)];
  }));
}
function fromPics(value) {
  if (!object(value)) return undefined;
  const entries = [];
  for (const [key, row] of Object.entries(value)) {
    const language = languageByKey(key);
    // Malformed legacy labels cannot establish complete language membership.
    if (!language || !object(row)) return undefined;
    entries.push([language.id, flags(row)]);
  }
  return encodeLanguageFlags(entries);
}

/** Complete language tables replace old values, including empty tables and false flags. */
export function normalizeSteamLanguages(record) {
  const store = record.store?.success === 1 ? record.store : undefined;
  const preferPics = record.store_result != null && record.store_result !== 1 || store?.visible === false;
  const sources = preferPics
    ? [() => fromPics(record.appinfo?.common?.supported_languages), () => fromStore(store?.supported_languages)]
    : [() => fromStore(store?.supported_languages), () => fromPics(record.appinfo?.common?.supported_languages)];
  for (const read of sources) {
    const languageBits = read();
    if (languageBits !== undefined) return { languageBits };
  }
  return {};
}
