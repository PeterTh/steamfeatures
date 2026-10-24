/** Only app IDs leave the file reader; Steam's other account data is discarded. */
export const LIBRARY_STORAGE_KEY = 'steam-feature-atlas.user-library.v1';
export const LIBRARY_FILTER_STORAGE_KEY = 'steam-feature-atlas.user-library-filters.v1';
export const LIBRARY_MAX_BYTES = 16 * 1024 * 1024;
const MAX_APPS = 1000000;

export function libraryAppIds(value) {
  if (!Array.isArray(value) || value.length > MAX_APPS) {
    throw new Error('The library must contain a list of valid Steam app IDs.');
  }
  for (const id of value) {
    if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff) throw new Error('The library must contain a list of valid Steam app IDs.');
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

export function parseUserLibrary(text) {
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('This is not a valid JSON file. Save the Steam library JSON and select that file.'); }
  if (!value || !Array.isArray(value.rgOwnedApps)) {
    throw new Error('No Steam library was found in this file. Use the Steam library JSON link above.');
  }
  const appIds = libraryAppIds(value.rgOwnedApps);
  const wishlistIds = value.rgWishlist === undefined ? null : libraryAppIds(value.rgWishlist);
  if (!appIds.length && !wishlistIds?.length) throw new Error('This file lists no owned or wishlisted apps. Make sure you are signed into Steam in this browser, then save the JSON again.');
  return { appIds, wishlistIds };
}
