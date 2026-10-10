/** Versioned, dependency-free decoder for the downloadable catalog. */
export const BINARY_FORMAT = 'steam-feature-atlas-binary-v1';

// These ceilings leave ample growth beyond the Steam catalog while bounding
// allocations before any untrusted counts reach Array/Uint32Array constructors.
export const BINARY_LIMITS = Object.freeze({
  bytes: 256 * 1024 * 1024, headerBytes: 4 * 1024 * 1024,
  stringBytes: 1024 * 1024, games: 1_000_000, fields: 128,
  cells: 32_000_000, features: 4096, tags: 16_384,
});
export const BINARY_MAGIC = Object.freeze([0x53, 0x46, 0x41, 0x42, 1]); // SFAB, version 1

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const types = new Set(['id', 'string', 'uint', 'features', 'dictionary']);
const UINT32_MAX = 0xffffffff;
const invalid = detail => new Error(`Invalid binary catalog: ${detail}.`);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.hasOwn(object, key);

class Reader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  byte() {
    if (this.offset >= this.bytes.length) throw invalid('truncated data');
    return this.bytes[this.offset++];
  }
  uint(maximum = Number.MAX_SAFE_INTEGER) {
    let value = 0, factor = 1;
    for (let position = 0; position < 8; position++) {
      const byte = this.byte(), digit = byte & 127;
      value += digit * factor;
      if (!Number.isSafeInteger(value) || value > maximum) throw invalid('integer out of range');
      if (!(byte & 128)) {
        if (position > 0 && digit === 0) throw invalid('noncanonical integer');
        return value;
      }
      factor *= 128;
    }
    throw invalid('integer overflow');
  }
  take(length) {
    if (length > this.bytes.length - this.offset) throw invalid('truncated data');
    const bytes = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }
  string(maximum = BINARY_LIMITS.stringBytes) {
    const bytes = this.take(this.uint(maximum));
    try { return utf8.decode(bytes); }
    catch { throw invalid('invalid UTF-8'); }
  }
  json(maximum) {
    try { return JSON.parse(this.string(maximum)); }
    catch (error) {
      if (error.message.startsWith('Invalid binary catalog:')) throw error;
      throw invalid('malformed JSON');
    }
  }
}

function validateHeader(header) {
  if (!record(header) || header.format !== BINARY_FORMAT) throw invalid('unsupported format');
  const { metadata, fields, featureIds, tagIndex } = header;
  if (!record(metadata) || own(metadata, 'games') || own(metadata, 'tagIndex') || Object.keys(metadata).some(key => forbiddenKeys.has(key))) {
    throw invalid('invalid metadata');
  }
  if (!Array.isArray(metadata.features) || metadata.features.length > BINARY_LIMITS.features) throw invalid('invalid feature metadata');
  const expectedIds = metadata.features.map(feature => {
    if (!record(feature) || !Number.isSafeInteger(feature.id) || feature.id < 0) throw invalid('invalid feature definition');
    return feature.id;
  }).sort((a, b) => a - b);
  if (!Array.isArray(featureIds) || featureIds.length !== expectedIds.length || featureIds.some((id, i) => id !== expectedIds[i] || (i > 0 && id <= featureIds[i - 1]))) {
    throw invalid('invalid feature dictionary');
  }
  if (own(metadata, 'tags') && (!Array.isArray(metadata.tags) || metadata.tags.length > BINARY_LIMITS.tags || metadata.tags.some(tag => typeof tag !== 'string' || !tag.trim()) || new Set(metadata.tags).size !== metadata.tags.length)) {
    throw invalid('invalid tag dictionary');
  }
  if (tagIndex !== null && (!record(tagIndex) || tagIndex.encoding !== 'delta-game-indices-v1' || own(tagIndex, 'lists') || Object.keys(tagIndex).some(key => forbiddenKeys.has(key)))) {
    throw invalid('unsupported tag index');
  }
  if (!Array.isArray(fields) || !fields.length || fields.length > BINARY_LIMITS.fields) throw invalid('invalid field definitions');
  const keys = new Set();
  for (const field of fields) {
    if (!record(field) || typeof field.key !== 'string' || !field.key || field.key.length > 128 || forbiddenKeys.has(field.key) || keys.has(field.key) || !types.has(field.type)) {
      throw invalid('invalid or duplicate field');
    }
    if ((field.type === 'id') !== (field.key === 'id') || (field.type === 'features' && field.key !== 'featureIds') || (tagIndex !== null && field.key === 'tagIds')) {
      throw invalid('invalid field type');
    }
    keys.add(field.key);
  }
  if (!keys.has('id')) throw invalid('missing game ID field');
  return header;
}

/**
 * Return ordinary catalog objects in their encoded row order. Tag postings use
 * that same order. Query results do not depend on the catalog's physical order.
 */
export function decodeBinaryCatalog(input) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes || bytes.length > BINARY_LIMITS.bytes) throw invalid('invalid input size');
  const reader = new Reader(bytes);
  for (const byte of BINARY_MAGIC) if (reader.byte() !== byte) throw invalid('unsupported magic or version');
  const { metadata, fields, featureIds, tagIndex } = validateHeader(reader.json(BINARY_LIMITS.headerBytes));
  const count = reader.uint(BINARY_LIMITS.games), stride = Math.ceil(featureIds.length / 8);
  const minimumRowBytes = fields.reduce((total, field) => total + (field.type === 'features' ? stride : 1), 0);
  if (count * fields.length > BINARY_LIMITS.cells || count * minimumRowBytes > bytes.length - reader.offset) throw invalid('impossible game count');
  const games = Array.from({ length: count }, () => ({}));
  for (const { key, type } of fields) {
    if (type === 'id') {
      let previous = 0;
      const seen = new Set();
      for (const game of games) {
        const delta = reader.uint(UINT32_MAX * 2);
        previous += delta % 2 ? -(delta + 1) / 2 : delta / 2;
        if (previous <= 0 || previous > UINT32_MAX || seen.has(previous)) throw invalid('invalid or duplicate game ID');
        game[key] = previous;
        seen.add(previous);
      }
    } else if (type === 'string') {
      for (const game of games) game[key] = reader.string();
    } else if (type === 'uint') {
      for (const game of games) {
        const value = reader.uint();
        if (value) game[key] = value === 1 ? null : value - 2;
      }
    } else if (type === 'features') {
      const paddingMask = featureIds.length % 8 ? (0xff << (featureIds.length % 8)) & 0xff : 0;
      for (const game of games) {
        const bits = reader.take(stride), ids = [];
        if (stride && (bits[stride - 1] & paddingMask)) throw invalid('nonzero feature padding bits');
        for (let i = 0; i < stride; i++) {
          const byte = bits[i];
          for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) ids.push(featureIds[i * 8 + bit]);
        }
        game[key] = ids;
      }
    } else {
      const length = reader.uint(count + 1);
      if (!length || length > bytes.length - reader.offset) throw invalid('invalid dictionary size');
      const dictionary = new Array(length);
      for (let i = 0; i < length; i++) {
        const token = reader.string();
        if (token === '') dictionary[i] = undefined;
        else {
          try { dictionary[i] = JSON.parse(token); }
          catch { throw invalid('malformed dictionary value'); }
        }
      }
      for (const game of games) {
        const value = dictionary[reader.uint(length - 1)];
        if (value !== undefined) game[key] = value;
      }
    }
  }
  const catalog = { ...metadata, games };
  if (tagIndex !== null) {
    const tagCount = reader.uint(BINARY_LIMITS.tags);
    if (tagCount !== (metadata.tags?.length ?? 0)) throw invalid('tag posting count differs from dictionary');
    const lists = new Array(tagCount);
    for (let tag = 0; tag < tagCount; tag++) {
      const length = reader.uint(count);
      if (length > bytes.length - reader.offset) throw invalid('impossible posting count');
      const deltas = new Array(length);
      let row = 0;
      for (let i = 0; i < length; i++) {
        const delta = reader.uint(count);
        row += delta;
        if ((i > 0 && !delta) || row >= count) throw invalid('invalid tag posting');
        deltas[i] = delta;
      }
      lists[tag] = deltas;
    }
    catalog.tagIndex = { ...tagIndex, lists };
  }
  if (reader.offset !== bytes.length) throw invalid('trailing data');
  return catalog;
}
