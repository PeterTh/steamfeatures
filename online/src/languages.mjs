// Steam's language and additional-language IDs. IDs and URL keys remain stable.
// https://partner.steamgames.com/doc/store/localization/languages
// Numeric mappings checked against Steam's storefront language definitions.
const primary = [
  ['english', 'English'], ['german', 'German'], ['french', 'French'], ['italian', 'Italian'],
  ['koreana', 'Korean'], ['spanish', 'Spanish (Spain)'], ['schinese', 'Chinese (Simplified)'],
  ['tchinese', 'Chinese (Traditional)'], ['russian', 'Russian'], ['thai', 'Thai'], ['japanese', 'Japanese'],
  ['portuguese', 'Portuguese (Portugal)'], ['polish', 'Polish'], ['danish', 'Danish'], ['dutch', 'Dutch'],
  ['finnish', 'Finnish'], ['norwegian', 'Norwegian'], ['swedish', 'Swedish'], ['hungarian', 'Hungarian'],
  ['czech', 'Czech'], ['romanian', 'Romanian'], ['turkish', 'Turkish'], ['brazilian', 'Portuguese (Brazil)'],
  ['bulgarian', 'Bulgarian'], ['greek', 'Greek'], ['arabic', 'Arabic'], ['ukrainian', 'Ukrainian'],
  ['latam', 'Spanish (Latin America)'], ['vietnamese', 'Vietnamese'], ['schinese', 'Chinese (Simplified)'],
  ['indonesian', 'Indonesian'], ['malay', 'Malay'],
];
const additional = [
  ['afrikaans', 'Afrikaans'], ['albanian', 'Albanian'], ['amharic', 'Amharic'], ['armenian', 'Armenian'],
  ['assamese', 'Assamese'], ['azerbaijani', 'Azerbaijani'], ['bangla', 'Bangla'], ['basque', 'Basque'],
  ['belarusian', 'Belarusian'], ['bosnian', 'Bosnian'], ['catalan', 'Catalan'], ['cherokee', 'Cherokee'],
  ['croatian', 'Croatian'], ['dari', 'Dari'], ['estonian', 'Estonian'], ['filipino', 'Filipino'],
  ['galician', 'Galician'], ['georgian', 'Georgian'], ['gujarati', 'Gujarati'], ['gurmukhi', 'Punjabi (Gurmukhi)'],
  ['hausa', 'Hausa'], ['hebrew', 'Hebrew'], ['hindi', 'Hindi'], ['icelandic', 'Icelandic'], ['igbo', 'Igbo'],
  ['indonesian', 'Indonesian'], ['irish', 'Irish'], ['kannada', 'Kannada'], ['kazakh', 'Kazakh'],
  ['khmer', 'Khmer'], ['kiche', "K’iche’"], ['kinyarwanda', 'Kinyarwanda'], ['konkani', 'Konkani'],
  ['kyrgyz', 'Kyrgyz'], ['latvian', 'Latvian'], ['lithuanian', 'Lithuanian'], ['luxembourgish', 'Luxembourgish'],
  ['macedonian', 'Macedonian'], ['malay', 'Malay'], ['malayalam', 'Malayalam'], ['maltese', 'Maltese'],
  ['maori', 'Maori'], ['marathi', 'Marathi'], ['mongolian', 'Mongolian'], ['nepali', 'Nepali'], ['odia', 'Odia'],
  ['persian', 'Persian'], ['quechua', 'Quechua'], ['scots', 'Scots'], ['serbian', 'Serbian'],
  ['shahmukhi', 'Punjabi (Shahmukhi)'], ['sindhi', 'Sindhi'], ['sinhala', 'Sinhala'], ['slovak', 'Slovak'],
  ['slovenian', 'Slovenian'], ['sorani', 'Sorani'], ['sotho', 'Sotho'], ['swahili', 'Swahili'], ['tajik', 'Tajik'],
  ['tamil', 'Tamil'], ['tatar', 'Tatar'], ['telugu', 'Telugu'], ['tigrinya', 'Tigrinya'], ['tswana', 'Tswana'],
  ['turkmen', 'Turkmen'], ['urdu', 'Urdu'], ['uyghur', 'Uyghur'], ['uzbek', 'Uzbek'], ['valencian', 'Valencian'],
  ['welsh', 'Welsh'], ['wolof', 'Wolof'], ['xhosa', 'Xhosa'], ['yoruba', 'Yoruba'], ['zulu', 'Zulu'],
];
const registry = new Map();
for (const [id, [key, name]] of [...primary, ...additional].entries()) {
  if (!registry.has(key)) registry.set(key, Object.freeze({ id, key, name }));
}
export const LANGUAGES = Object.freeze([...registry.values()]);
export const LANGUAGE_KINDS = Object.freeze([
  Object.freeze({ key: 'interface', name: 'Interface', bit: 1 }),
  Object.freeze({ key: 'audio', name: 'Audio', bit: 2 }),
  Object.freeze({ key: 'subtitles', name: 'Subtitles', bit: 4 }),
]);
export const LANGUAGE_BYTES = Math.ceil((primary.length + additional.length) * 3 / 8);
const languageIds = new Set(LANGUAGES.map(language => language.id));
const unusedLanguageIds = Object.freeze(Array.from(
  { length: Math.ceil(LANGUAGE_BYTES * 8 / 3) }, (_, id) => id,
).filter(id => !languageIds.has(id)));
const aliases = new Map([['korean', 'koreana'], ['sc_schinese', 'schinese'], ['slovakian', 'slovak']]);
export const languageByKey = key => registry.get(aliases.get(key) ?? key);
export function storeLanguage(language, extra = -1) {
  const row = Number.isInteger(language) && language >= 0 ? primary[language]
    : language === -1 && Number.isInteger(extra) && extra >= 0 ? additional[extra] : undefined;
  return row ? registry.get(row[0]) : undefined;
}
export function languageFlags(bytes, id) {
  const bit = id * 3, byte = bit >> 3, shift = bit & 7;
  return ((bytes[byte] | ((bytes[byte + 1] ?? 0) << 8)) >> shift) & 7;
}
export function encodeLanguageFlags(entries) {
  const bytes = new Uint8Array(LANGUAGE_BYTES);
  for (const [id, flags] of entries) {
    if (!LANGUAGES.some(language => language.id === id) || !Number.isInteger(flags) || flags < 0 || flags > 7) throw new Error('Invalid language flags.');
    const bit = id * 3, byte = bit >> 3, shift = bit & 7;
    bytes[byte] |= flags << shift;
    if (shift > 5) bytes[byte + 1] |= flags >> (8 - shift);
  }
  return btoa(String.fromCharCode(...bytes));
}
export function decodeLanguageBits(value) {
  if (typeof value !== 'string' || value.length !== Math.ceil(LANGUAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid language support data.');
  let decoded;
  try { decoded = atob(value); } catch { throw new Error('Invalid language support data.'); }
  if (decoded.length !== LANGUAGE_BYTES || btoa(decoded) !== value) throw new Error('Invalid language support data.');
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  // Unused aliases and padding must not carry phantom support.
  for (const id of unusedLanguageIds) {
    if (languageFlags(bytes, id)) throw new Error('Invalid language support data.');
  }
  return bytes;
}
export function languageIndex(languages = []) {
  if (!Array.isArray(languages)) throw new Error('Invalid language dictionary.');
  const index = new Map(), ids = new Set();
  for (const language of languages) {
    const known = languageByKey(language?.key);
    if (!known || known.key !== language.key || known.id !== language.id || typeof language.name !== 'string' || !language.name.trim() || index.has(language.key) || ids.has(language.id)) throw new Error('Invalid language dictionary.');
    index.set(language.key, language); ids.add(language.id);
  }
  return index;
}
