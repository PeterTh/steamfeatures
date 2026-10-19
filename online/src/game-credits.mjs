export const CREDITS_FORMAT = 'steam-feature-atlas-credits-v1';
export const CREDITS_MAGIC = [83, 70, 65, 67, 1];
export const CREDITS_MAX_BYTES = 32 * 1024 * 1024;
export const CREDITS_COMPRESSED_MAX_BYTES = 16 * 1024 * 1024;
const invalid = detail => new Error(`Invalid developer/publisher data: ${detail}.`);

export function validateCreditsDescriptor(value, snapshot) {
  if (value?.format !== CREDITS_FORMAT || !/^[a-f0-9]{64}$/.test(value.snapshot) || value.snapshot !== snapshot) throw invalid('catalog snapshot mismatch');
  const file = `game-credits.${String(value.sha256).slice(0, 16)}.bin`;
  for (const [payload, filename, limit] of [[value, file, CREDITS_MAX_BYTES], [value.gzip, file + '.gz', CREDITS_COMPRESSED_MAX_BYTES], [value.brotli, file + '.br', CREDITS_COMPRESSED_MAX_BYTES]]) {
    if (!payload || payload.file !== filename || !/^[a-f0-9]{64}$/.test(payload.sha256) || !Number.isSafeInteger(payload.bytes) || payload.bytes < 1 || payload.bytes > limit) throw invalid('file descriptor');
  }
  return value;
}

/** One dictionary of names, shared developer/publisher combinations, and exact app IDs. */
export function decodeGameCredits(bytes, snapshot) {
  if (!(bytes instanceof Uint8Array) || bytes.length > CREDITS_MAX_BYTES) throw invalid('file size');
  let offset = 0;
  const byte = () => { if (offset >= bytes.length) throw invalid('truncated file'); return bytes[offset++]; };
  const uint = (maximum = 0xffffffff) => {
    let value = 0, factor = 1;
    for (let i = 0; i < 5; i++) {
      const part = byte(); value += (part & 127) * factor;
      if (value > maximum) throw invalid('integer out of range');
      if (!(part & 128)) { if (i && part === 0) throw invalid('noncanonical integer'); return value; }
      factor *= 128;
    }
    throw invalid('integer overflow');
  };
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const string = maximum => {
    const length = uint(maximum);
    if (length > bytes.length - offset) throw invalid('truncated string');
    let value;
    try { value = decoder.decode(bytes.subarray(offset, offset + length)); } catch { throw invalid('invalid UTF-8'); }
    offset += length; return value;
  };
  if (CREDITS_MAGIC.some(expected => byte() !== expected)) throw invalid('unsupported format');
  const storedSnapshot = string(64);
  if (!/^[a-f0-9]{64}$/.test(storedSnapshot) || storedSnapshot !== snapshot) throw invalid('catalog snapshot mismatch');
  const count = uint(1_000_000), appIds = new Uint32Array(count);
  let appid = 0;
  for (let i = 0; i < count; i++) {
    const delta = uint(); appid += delta;
    if (!delta || appid > 0xffffffff) throw invalid('app ID ordering');
    appIds[i] = appid;
  }
  const names = Array.from({ length: uint(2_000_000) }, () => string(1024 * 1024));
  for (let i = 0; i < names.length; i++) if (!names[i].trim() || (i && names[i - 1] >= names[i])) throw invalid('name dictionary');
  const readNames = length => Array.from({ length }, () => uint(names.length - 1));
  const pairs = Array.from({ length: uint(count) }, () => {
    const developerCount = uint(4097);
    const developers = developerCount === 0 ? null : readNames(developerCount - 1);
    const publisherCount = uint(4098);
    const publishers = publisherCount === 0 ? developers : publisherCount === 1 ? null : readNames(publisherCount - 2);
    return [developers, publishers];
  });
  const pairIds = Uint32Array.from({ length: count }, () => uint(pairs.length - 1));
  if (offset !== bytes.length) throw invalid('trailing bytes');
  return { snapshot: storedSnapshot, names, pairs, appIds, pairIds };
}

export const normalizeCreditSearch = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('en');

export function gameCreditNames(index, pair) {
  return { developerNames: pair[0]?.map(id => index.names[id]) ?? null, publisherNames: pair[1]?.map(id => index.names[id]) ?? null };
}
