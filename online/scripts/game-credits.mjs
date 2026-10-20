import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompress, brotliDecompressSync, gzip, gunzipSync, constants } from 'node:zlib';
import { promisify } from 'node:util';
import { CREDITS_FORMAT, CREDITS_MAGIC, CREDITS_MAX_BYTES, decodeGameCredits, validateCreditsDescriptor } from '../src/game-credits.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const compressGzip = promisify(gzip), compressBrotli = promisify(brotliCompress);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function normalizeGameCredits(record) {
  const role = (plural, singular) => {
    const basic = record.store?.basic_info?.[plural];
    const fallback = record.fallback?.[plural];
    const pics = record.appinfo?.extended?.[singular];
    const names = Array.isArray(basic) ? basic.map(item => item?.name)
      : Array.isArray(fallback) ? fallback : typeof pics === 'string' && pics.trim() ? [pics] : null;
    return names === null ? null : [...new Set(names.filter(name => typeof name === 'string' && name.trim()))];
  };
  return [role('developers', 'developer'), role('publishers', 'publisher')];
}

export function encodeGameCredits(games, credits, snapshot) {
  let bytes = Buffer.allocUnsafe(1024 * 1024), offset = 0;
  const reserve = count => {
    if (offset + count > CREDITS_MAX_BYTES) throw new Error('Developer/publisher data exceeds its size limit');
    if (offset + count > bytes.length) {
      const next = Buffer.allocUnsafe(Math.min(CREDITS_MAX_BYTES, Math.max(offset + count, bytes.length * 2)));
      bytes.copy(next, 0, 0, offset); bytes = next;
    }
  };
  const byte = value => { reserve(1); bytes[offset++] = value; };
  const uint = value => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Invalid credit index');
    while (value > 127) { byte((value % 128) | 128); value = Math.floor(value / 128); }
    byte(value);
  };
  const string = value => {
    if (!value.isWellFormed()) throw new Error('Invalid UTF-8 credit name');
    const length = Buffer.byteLength(value); uint(length); reserve(length); offset += bytes.write(value, offset, length, 'utf8');
  };
  const rows = [...games].sort((a, b) => a.id - b.id).map(game => ({ id: game.id, pair: credits.get(game.id) ?? [null, null] }));
  const names = [...new Set(rows.flatMap(row => row.pair.flatMap(list => list ?? [])))].sort(compare);
  const nameIds = new Map(names.map((name, i) => [name, i]));
  const tokens = rows.map(row => JSON.stringify(row.pair));
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const pairs = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || compare(a, b));
  const pairIds = new Map(pairs.map((pair, i) => [pair, i]));
  CREDITS_MAGIC.forEach(byte); string(snapshot); uint(rows.length);
  let previous = 0;
  for (const row of rows) { uint(row.id - previous); previous = row.id; }
  uint(names.length); names.forEach(string); uint(pairs.length);
  for (const token of pairs) {
    const [developers, publishers] = JSON.parse(token);
    uint(developers === null ? 0 : developers.length + 1);
    for (const name of developers ?? []) uint(nameIds.get(name));
    if (JSON.stringify(developers) === JSON.stringify(publishers)) uint(0);
    else { uint(publishers === null ? 1 : publishers.length + 2); for (const name of publishers ?? []) uint(nameIds.get(name)); }
  }
  for (const token of tokens) uint(pairIds.get(token));
  const result = bytes.subarray(0, offset);
  decodeGameCredits(result, snapshot);
  return result;
}

export async function writeGameCredits(games, credits, directory, snapshot) {
  const bytes = encodeGameCredits(games, credits, snapshot), digest = hash(bytes);
  const file = `game-credits.${digest.slice(0, 16)}.bin`;
  const [gzip, brotli] = await Promise.all([
    compressGzip(bytes, { level: 9 }),
    compressBrotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }),
  ]);
  const descriptor = validateCreditsDescriptor({ format: CREDITS_FORMAT, snapshot, file, sha256: digest, bytes: bytes.length,
    gzip: { file: file + '.gz', sha256: hash(gzip), bytes: gzip.length }, brotli: { file: file + '.br', sha256: hash(brotli), bytes: brotli.length } }, snapshot);
  await mkdir(directory, { recursive: true });
  for (const [name, payload] of [[file, bytes], [file + '.gz', gzip], [file + '.br', brotli]]) await writeFile(resolve(directory, name), payload);
  return descriptor;
}

export async function verifyGameCredits(directory, descriptor, games, snapshot) {
  validateCreditsDescriptor(descriptor, snapshot);
  const bytes = await readFile(resolve(directory, descriptor.file));
  if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256) throw new Error('Developer/publisher file checksum or size mismatch');
  for (const [type, decompress] of [['gzip', gunzipSync], ['brotli', brotliDecompressSync]]) {
    const packed = await readFile(resolve(directory, descriptor[type].file));
    if (packed.length !== descriptor[type].bytes || hash(packed) !== descriptor[type].sha256 || !decompress(packed, { maxOutputLength: CREDITS_MAX_BYTES }).equals(bytes)) throw new Error('Compressed developer/publisher data mismatch');
  }
  const decoded = decodeGameCredits(bytes, snapshot), ids = games.map(game => game.id).sort((a, b) => a - b);
  if (ids.length !== decoded.appIds.length || ids.some((id, i) => id !== decoded.appIds[i])) throw new Error('Developer/publisher app IDs do not match the catalog');
  return decoded;
}
