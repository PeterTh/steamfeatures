import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const MAX_BYTES = 64 * 1024 * 1024;
const ARCHIVE_NAME = /^(\d{8}T\d{9}Z)-([a-f0-9]{64})-([a-f0-9-]{36})\.json\.gz$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function childPath(directory, filename) {
  const path = resolve(directory, filename);
  if (dirname(path) !== directory) throw new Error('Steam archive path escapes its directory');
  return path;
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.version !== 1) {
    throw new Error('Unsupported Steam archive envelope');
  }
  const timestamp = Date.parse(envelope.fetchedAt);
  if (typeof envelope.fetchedAt !== 'string' || !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== envelope.fetchedAt) {
    throw new Error('Invalid Steam archive timestamp');
  }
  if (typeof envelope.method !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*\/[A-Za-z][A-Za-z0-9_]*$/.test(envelope.method)) {
    throw new Error('Invalid Steam archive method');
  }
  if (!envelope.input || typeof envelope.input !== 'object' || Array.isArray(envelope.input)) {
    throw new Error('Invalid Steam archive request input');
  }
  if (!Object.hasOwn(envelope, 'body') || envelope.body === undefined) throw new Error('Missing Steam archive response body');
  if (envelope.status !== undefined && (!Number.isInteger(envelope.status) || envelope.status < 100 || envelope.status > 599)) {
    throw new Error('Invalid Steam archive HTTP status');
  }
  if (envelope.resultCode !== undefined && envelope.resultCode !== null && typeof envelope.resultCode !== 'string' && !Number.isFinite(envelope.resultCode)) {
    throw new Error('Invalid Steam archive result code');
  }
  return envelope;
}

/** Retain complete parsed JSON responses independently of normalized site data.
 * Call before validating the response schema, and await before checkpointing.
 * Each record is compressed and atomically published under its own unique name.
 */
export function createSteamResponseArchive({ directory, now = Date.now } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Steam archive directory is required');
  if (typeof now !== 'function') throw new Error('Steam archive now must be a function');
  const root = resolve(directory);
  return async function record({ method, input, body, status, resultCode }) {
    const envelope = validateEnvelope({ version: 1, fetchedAt: new Date(now()).toISOString(), method, input, body,
      ...(status !== undefined ? { status } : {}), ...(resultCode !== undefined ? { resultCode } : {}) });
    // Serialize before the first await so later caller mutations cannot alter the snapshot.
    const json = Buffer.from(JSON.stringify(envelope));
    if (json.length > MAX_BYTES) throw new Error('Steam archive response exceeds 64 MiB');
    const stamp = envelope.fetchedAt.replace(/[-:.]/g, '');
    const name = `${stamp}-${hash(json)}-${randomUUID()}.json.gz`;
    const finalPath = childPath(root, name);
    const temporaryPath = childPath(root, `${name}.tmp`);
    const bytes = await compress(json, { level: 9 });
    await mkdir(root, { recursive: true });
    let file;
    let ownsTemporary = false;
    try {
      file = await open(temporaryPath, 'wx');
      ownsTemporary = true;
      await file.writeFile(bytes);
      await file.close();
      file = undefined;
      await rename(temporaryPath, finalPath);
      ownsTemporary = false;
      return finalPath;
    } finally {
      await file?.close();
      if (ownsTemporary) await rm(temporaryPath, { force: true });
    }
  };
}

/** Offline replay, oldest timestamp first (stable filename ordering for ties).
 * Incomplete temporary files are ignored; completed corrupt records fail loudly.
 */
export async function* readSteamResponseArchive(directory) {
  const root = resolve(directory);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const names = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json.gz')).map(entry => entry.name).sort();
  for (const name of names) {
    try {
      const match = ARCHIVE_NAME.exec(name);
      if (!match) throw new Error('Invalid archive filename');
      const path = childPath(root, name);
      if ((await stat(path)).size > MAX_BYTES) throw new Error('Compressed record exceeds 64 MiB');
      const json = await decompress(await readFile(path), { maxOutputLength: MAX_BYTES });
      if (hash(json) !== match[2]) throw new Error('SHA-256 mismatch');
      const envelope = validateEnvelope(JSON.parse(json));
      if (envelope.fetchedAt.replace(/[-:.]/g, '') !== match[1]) throw new Error('Filename timestamp does not match record');
      yield envelope;
    } catch (cause) {
      throw new Error(`Invalid Steam response archive ${name}: ${cause.message}`, { cause });
    }
  }
}
