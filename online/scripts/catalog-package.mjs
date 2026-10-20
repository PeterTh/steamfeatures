import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { BINARY_FORMAT } from '../src/catalog-binary.mjs';
import { validateBinaryDescriptor } from '../src/catalog-descriptor.mjs';
import { validateProgressiveDescriptor, PRIORITY_MIN_REVIEWS } from '../src/progressive-catalog.mjs';
import { encodeBinaryCatalog } from './catalog-binary.mjs';
import { partitionCatalog } from './catalog-partitions.mjs';
import { writeGameCredits } from './game-credits.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const compressGzip = promisify(gzip), compressBrotli = promisify(brotliCompress);

// A failed job must not leave sibling writes racing the build's cleanup.
async function finishPackages(jobs) {
  const results = await Promise.allSettled(jobs);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map(result => result.value);
}

/** Publish the same complete catalog in each browser transport representation. */
export async function writeBinaryCatalog(catalog, dataDirectory) {
  return writeBinaryBytes(Buffer.from(encodeBinaryCatalog(catalog)), dataDirectory);
}

async function writeBinaryBytes(bytes, dataDirectory) {
  const hash = sha256(bytes);
  const file = `catalog.${hash.slice(0, 16)}.bin`;
  const [gzip, brotli] = await Promise.all([
    compressGzip(bytes, { level: 9 }),
    compressBrotli(bytes, { params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    } }),
  ]);
  const descriptor = validateBinaryDescriptor({
    format: BINARY_FORMAT, file, sha256: hash, bytes: bytes.length,
    gzip: { file: `${file}.gz`, sha256: sha256(gzip), bytes: gzip.length },
    brotli: { file: `${file}.br`, sha256: sha256(brotli), bytes: brotli.length },
  });
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(resolve(dataDirectory, file), bytes);
  await writeFile(resolve(dataDirectory, descriptor.gzip.file), gzip);
  await writeFile(resolve(dataDirectory, descriptor.brotli.file), brotli);
  return descriptor;
}

/** Publish the early-results archive and the remaining games with global counts. */
export async function writeProgressiveCatalog(catalog, dataDirectory, snapshot) {
  const { priority, remainder, statistics } = partitionCatalog(catalog);
  const [priorityDescriptor, remainderDescriptor] = await finishPackages([
    writeBinaryCatalog(priority, dataDirectory), writeBinaryCatalog(remainder, dataDirectory),
  ]);
  return validateProgressiveDescriptor({ version: 1, minReviews: PRIORITY_MIN_REVIEWS, snapshot,
    priority: priorityDescriptor, remainder: remainderDescriptor, statistics }, snapshot);
}

/** Independent compression jobs share Node's bounded native thread pool. */
export async function writeCatalogPackages(catalog, dataDirectory, credits) {
  const bytes = Buffer.from(encodeBinaryCatalog(catalog));
  const snapshot = sha256(bytes);
  const [binary, progressive, gameCredits] = await finishPackages([
    writeBinaryBytes(bytes, dataDirectory),
    writeProgressiveCatalog(catalog, dataDirectory, snapshot),
    writeGameCredits(catalog.games, credits, dataDirectory, snapshot),
  ]);
  return { binary, progressive, gameCredits };
}
