/** Offline encoder for the browser's versioned columnar catalog format. */
import { BINARY_FORMAT, BINARY_MAGIC, BINARY_LIMITS, decodeBinaryCatalog } from '../src/catalog-binary.mjs';

const specialNumbers = new Set(['reviews', 'positivePercent', 'steamLookupResultCode']);
const invalid = detail => new Error(`Cannot encode binary catalog: ${detail}.`);
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const own = (object, key) => Object.hasOwn(object, key);

class Writer {
  constructor() { this.buffer = Buffer.allocUnsafe(1024 * 1024); this.offset = 0; }
  reserve(length) {
    const size = this.offset + length;
    if (size > BINARY_LIMITS.bytes) throw invalid('catalog exceeds size limit');
    if (size > this.buffer.length) {
      const next = Buffer.allocUnsafe(Math.min(BINARY_LIMITS.bytes, Math.max(size, this.buffer.length * 2)));
      this.buffer.copy(next, 0, 0, this.offset);
      this.buffer = next;
    }
  }
  byte(value) { this.reserve(1); this.buffer[this.offset++] = value; }
  uint(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid('invalid unsigned integer');
    while (value > 127) { this.byte((value % 128) | 128); value = Math.floor(value / 128); }
    this.byte(value);
  }
  signed(value) { this.uint(value < 0 ? -value * 2 - 1 : value * 2); }
  string(value, maximum = BINARY_LIMITS.stringBytes) {
    // UTF-8 cannot represent lone UTF-16 surrogates. JSON-encoded dictionary
    // strings escape them, so the caller uses that representation when needed.
    if (typeof value !== 'string' || !value.isWellFormed()) throw invalid('invalid UTF-8 string');
    const length = Buffer.byteLength(value);
    if (length > maximum) throw invalid('string exceeds size limit');
    this.uint(length);
    this.reserve(length);
    this.offset += this.buffer.write(value, this.offset, length, 'utf8');
  }
  finish() { return this.buffer.subarray(0, this.offset); }
}

function tokenFor(row, key) {
  if (!own(row, key)) return '';
  const token = JSON.stringify(row[key]);
  if (token === undefined) throw invalid(`field ${key} is not JSON data`);
  return token;
}

/**
 * Preserve every JSON field. Physical row order groups feature signatures to
 * improve compression; app ID breaks ties without locale-dependent sorting.
 */
export function encodeBinaryCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.games) || !Array.isArray(catalog.features) || catalog.games.length > BINARY_LIMITS.games) throw invalid('invalid catalog');
  const metadata = { ...catalog };
  delete metadata.games;
  delete metadata.tagIndex;
  const tagIndex = own(catalog, 'tagIndex') ? { ...catalog.tagIndex } : null;
  if (tagIndex !== null) delete tagIndex.lists;
  const featureIds = catalog.features.map(feature => feature.id).sort((a, b) => a - b);
  const featureIndex = new Map(featureIds.map((id, i) => [id, i]));
  const keys = [...new Set(catalog.games.flatMap(Object.keys))];
  // An empty catalog still needs its structural ID column.
  if (!keys.includes('id')) keys.push('id');
  keys.sort((a, b) => a === 'id' ? -1 : b === 'id' ? 1 : compareText(a, b));
  const fields = keys.map(key => {
    let type = 'dictionary';
    if (key === 'id') type = 'id';
    else if (key === 'name' && catalog.games.every(row => typeof row[key] === 'string' && row[key].isWellFormed())) type = 'string';
    else if (specialNumbers.has(key) && catalog.games.every(row => !own(row, key) || row[key] === null || (Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= Number.MAX_SAFE_INTEGER - 2))) type = 'uint';
    else if (key === 'featureIds' && catalog.games.every(row => Array.isArray(row[key]) && row[key].every((id, i, ids) => featureIndex.has(id) && (i === 0 || id > ids[i - 1])))) type = 'features';
    return { key, type };
  });
  if (fields.length > BINARY_LIMITS.fields || fields.length * catalog.games.length > BINARY_LIMITS.cells) throw invalid('too many fields');
  const signatures = catalog.games.map(game => JSON.stringify(game.featureIds ?? null));
  const order = catalog.games.map((_, i) => i).sort((a, b) => compareText(signatures[a], signatures[b]) || catalog.games[a].id - catalog.games[b].id);
  const rows = order.map(i => catalog.games[i]);
  const oldToNew = new Uint32Array(order.length);
  order.forEach((old, current) => { oldToNew[old] = current; });
  const writer = new Writer();
  for (const byte of BINARY_MAGIC) writer.byte(byte);
  writer.string(JSON.stringify({ format: BINARY_FORMAT, metadata, fields, featureIds, tagIndex }), BINARY_LIMITS.headerBytes);
  writer.uint(rows.length);
  for (const { key, type } of fields) {
    if (type === 'id') {
      let previous = 0;
      for (const row of rows) {
        if (!Number.isInteger(row.id) || row.id <= 0 || row.id > 0xffffffff) throw invalid('invalid app ID');
        writer.signed(row.id - previous);
        previous = row.id;
      }
    } else if (type === 'string') {
      for (const row of rows) writer.string(row[key]);
    } else if (type === 'uint') {
      for (const row of rows) writer.uint(!own(row, key) ? 0 : row[key] === null ? 1 : row[key] + 2);
    } else if (type === 'features') {
      const bits = new Uint8Array(Math.ceil(featureIds.length / 8));
      for (const row of rows) {
        bits.fill(0);
        for (const id of row[key]) { const i = featureIndex.get(id); bits[i >> 3] |= 1 << (i % 8); }
        for (const byte of bits) writer.byte(byte);
      }
    } else {
      const counts = new Map();
      for (const row of rows) { const token = tokenFor(row, key); counts.set(token, (counts.get(token) ?? 0) + 1); }
      const dictionary = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || compareText(a, b));
      const indices = new Map(dictionary.map((token, i) => [token, i]));
      writer.uint(dictionary.length);
      for (const token of dictionary) writer.string(token);
      for (const row of rows) writer.uint(indices.get(tokenFor(row, key)));
    }
  }
  if (tagIndex !== null) {
    if (!Array.isArray(catalog.tagIndex.lists) || catalog.tagIndex.lists.length !== (catalog.tags?.length ?? 0)) throw invalid('invalid tag index');
    writer.uint(catalog.tagIndex.lists.length);
    for (const deltas of catalog.tagIndex.lists) {
      if (!Array.isArray(deltas) || deltas.length > rows.length) throw invalid('invalid tag postings');
      let oldRow = 0;
      const indices = deltas.map((delta, position) => {
        if (!Number.isSafeInteger(delta) || delta < 0 || (position > 0 && delta === 0)) throw invalid('invalid tag delta');
        oldRow += delta;
        if (oldRow >= rows.length) throw invalid('tag row out of range');
        return oldToNew[oldRow];
      }).sort((a, b) => a - b);
      writer.uint(indices.length);
      let previous = 0;
      for (const index of indices) { writer.uint(index - previous); previous = index; }
    }
  }
  const result = writer.finish();
  // Validate the actual wire representation before it can become a published
  // artifact. This also enforces the same bounds on encoding and decoding.
  decodeBinaryCatalog(result);
  return result;
}
