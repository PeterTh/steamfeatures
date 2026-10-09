import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { readSteamResponseArchive } from './steam-archive.mjs';

const compress = promisify(gzip);
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const appId = item => {
  const id = item?.id ?? item?.appid;
  return Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff ? id : null;
};
const success = (observation, requests) => {
  const request = requests[observation.request];
  return observation.item.success === 1 &&
    (request.status === undefined || (request.status >= 200 && request.status < 300)) &&
    (request.resultCode === undefined || request.resultCode === null || String(request.resultCode) === '1');
};

function validateRequest(request) {
  if (!object(request) || typeof request.fetchedAt !== 'string' || !Number.isFinite(Date.parse(request.fetchedAt)) ||
    new Date(request.fetchedAt).toISOString() !== request.fetchedAt ||
    typeof request.method !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*\/[A-Za-z][A-Za-z0-9_]*$/.test(request.method) || !object(request.input)) {
    throw new Error('Invalid Steam raw snapshot request');
  }
  if (request.status !== undefined && (!Number.isInteger(request.status) || request.status < 100 || request.status > 599)) throw new Error('Invalid Steam raw snapshot HTTP status');
  if (request.resultCode !== undefined && request.resultCode !== null && typeof request.resultCode !== 'string' && !Number.isFinite(request.resultCode)) throw new Error('Invalid Steam raw snapshot result code');
}

/** Validate durable raw data without applying the site's narrower schema. */
export function validateSteamArchiveSnapshot(value) {
  if (!object(value) || value.version !== 1 || !object(value.requests) || !object(value.apps)) throw new Error('Unsupported Steam raw snapshot');
  for (const [key, request] of Object.entries(value.requests)) {
    validateRequest(request);
    if (!/^[a-f0-9]{64}$/.test(key) || hash(JSON.stringify(request)) !== key) throw new Error('Invalid Steam raw snapshot request checksum');
  }
  const validateObservation = (observation, id) => {
    if (!object(observation) || !Object.hasOwn(value.requests, observation.request) || !object(observation.item) || appId(observation.item) !== id) {
      throw new Error('Invalid Steam raw snapshot item or request reference');
    }
  };
  for (const [key, entry] of Object.entries(value.apps)) {
    const id = Number(key);
    if (!/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(id) || id > 0xffffffff || !object(entry)) throw new Error('Invalid Steam raw snapshot app ID');
    validateObservation(entry.latest, id);
    if (entry.successful !== undefined) {
      validateObservation(entry.successful, id);
      if (!success(entry.successful, value.requests)) throw new Error('Invalid Steam raw snapshot successful observation');
    }
  }
  if (value.tagDictionary !== undefined && (!object(value.tagDictionary) || !Object.hasOwn(value.requests, value.tagDictionary.request) ||
    !Array.isArray(value.tagDictionary.body?.response?.tags))) throw new Error('Invalid Steam raw snapshot tag dictionary');
  return value;
}

// Timestamp first; stable content ordering handles replayed records with the
// same millisecond without allowing an older journal to replace newer data.
function compare(a, b, requests) {
  if (!b) return 1;
  const time = requests[a.request].fetchedAt.localeCompare(requests[b.request].fetchedAt);
  return time || hash(JSON.stringify(a)).localeCompare(hash(JSON.stringify(b)));
}

/** Keep the latest complete raw item and the last successful item per app.
 * Exact request inputs are shared by hash, so a 100-ID batch is stored once.
 * The browser catalog never loads this independently downloadable snapshot.
 */
export async function buildSteamArchiveSnapshot({ directory, previous, outputDirectory } = {}) {
  if (typeof directory !== 'string' || !directory.trim() || typeof outputDirectory !== 'string' || !outputDirectory.trim()) {
    throw new Error('Steam archive and output directories are required');
  }
  const snapshot = previous ? structuredClone(validateSteamArchiveSnapshot(previous)) : { version: 1, requests: {}, apps: {} };
  for await (const envelope of readSteamResponseArchive(directory)) {
    const { fetchedAt, method, input, status, resultCode, body } = envelope;
    const request = { fetchedAt, method, input, ...(status !== undefined ? { status } : {}), ...(resultCode !== undefined ? { resultCode } : {}) };
    const key = hash(JSON.stringify(request));
    snapshot.requests[key] = request;
    const responseOK = (status === undefined || (status >= 200 && status < 300)) && (resultCode === undefined || resultCode === null || String(resultCode) === '1');
    if (method === 'IStoreService/GetTagList' && responseOK && Array.isArray(body?.response?.tags)) {
      const dictionary = { request: key, body };
      if (compare(dictionary, snapshot.tagDictionary, snapshot.requests) > 0) snapshot.tagDictionary = dictionary;
    }
    if (!['IStoreBrowseService/GetItems', 'IStoreQueryService/Query'].includes(method) || !Array.isArray(body?.response?.store_items)) continue;
    for (const item of body.response.store_items) {
      const id = appId(item);
      // Malformed records remain in the complete journal but have no app key.
      if (!object(item) || !id) continue;
      const observation = { request: key, item };
      const entry = snapshot.apps[id];
      let latest = entry?.latest;
      let successful = entry && (success(entry.latest, snapshot.requests) ? entry.latest : entry.successful);
      if (compare(observation, latest, snapshot.requests) > 0) latest = observation;
      if (success(observation, snapshot.requests) && compare(observation, successful, snapshot.requests) > 0) successful = observation;
      snapshot.apps[id] = { latest, ...(successful && !success(latest, snapshot.requests) ? { successful } : {}) };
    }
  }
  const used = new Set(Object.values(snapshot.apps).flatMap(entry => [entry.latest.request, ...(entry.successful ? [entry.successful.request] : [])]));
  if (snapshot.tagDictionary) used.add(snapshot.tagDictionary.request);
  snapshot.requests = Object.fromEntries([...used].sort().map(key => [key, snapshot.requests[key]]));
  validateSteamArchiveSnapshot(snapshot);
  const bytes = await compress(Buffer.from(JSON.stringify(snapshot)), { level: 9 });
  const sha256 = hash(bytes);
  const file = `steam-raw.${sha256.slice(0, 16)}.json.gz`;
  const directoryPath = resolve(outputDirectory);
  await mkdir(directoryPath, { recursive: true });
  const temporary = resolve(directoryPath, `${file}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, resolve(directoryPath, file));
  } finally { await rm(temporary, { force: true }); }
  const entries = Object.values(snapshot.apps);
  return { snapshot, descriptor: { file, sha256, bytes: bytes.length, apps: entries.length,
    successfulApps: entries.filter(entry => success(entry.latest, snapshot.requests) || entry.successful).length } };
}
