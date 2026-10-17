import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GAME_IMAGE_SHARDS, GAME_IMAGE_MAX_BYTES, gameImageBucket, gameImageFile, validGameImages, validHeaderPath, parseGameImageShard, readGameImageResponse } from '../src/game-images.mjs';

export function headerImagePath(record) {
  return [record.store?.assets_without_overrides?.header, record.appinfo?.common?.header_image?.english, record.store?.assets?.header]
    .find(validHeaderPath);
}

function imageDigest(buffers) {
  const hash = createHash('sha256');
  for (const [bucket, bytes] of buffers.entries()) hash.update(gameImageFile(bucket) + '\0').update(bytes);
  return hash.digest('hex').slice(0, 16);
}

async function writeShards(buffers, outputDirectory, descriptor) {
  const directory = resolve(outputDirectory, descriptor.directory);
  await mkdir(directory, { recursive: true });
  for (let offset = 0; offset < GAME_IMAGE_SHARDS; offset += 8) {
    await Promise.all(buffers.slice(offset, offset + 8).map((bytes, index) => writeFile(resolve(directory, gameImageFile(offset + index)), bytes)));
  }
}

export async function writeGameImages(paths, outputDirectory, allowedIds) {
  const shards = Array.from({ length: GAME_IMAGE_SHARDS }, () => ({}));
  let count = 0;
  for (const [id, path] of paths) {
    if (allowedIds && !allowedIds.has(id) || path === 'header.jpg' || !validHeaderPath(path)) continue;
    if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff) throw new Error('Invalid game image app ID');
    shards[gameImageBucket(id)][id] = path; count++;
  }
  if (!count) return undefined;
  const buffers = shards.map(shard => Buffer.from(JSON.stringify(shard)));
  if (buffers.some(bytes => bytes.length > GAME_IMAGE_MAX_BYTES)) throw new Error('Game image bucket exceeds its browser limit');
  const descriptor = { version: 1, directory: `game-images.${imageDigest(buffers)}/`, shardCount: GAME_IMAGE_SHARDS };
  await writeShards(buffers, outputDirectory, descriptor);
  return descriptor;
}

export async function verifyGameImages(outputDirectory, descriptor) {
  if (!validGameImages(descriptor)) throw new Error('Invalid game image descriptor');
  const buffers = [];
  for (let bucket = 0; bucket < GAME_IMAGE_SHARDS; bucket++) {
    const bytes = await readFile(resolve(outputDirectory, descriptor.directory, gameImageFile(bucket)));
    if (bytes.length > GAME_IMAGE_MAX_BYTES) throw new Error('Game image bucket too large');
    parseGameImageShard(bytes.toString('utf8'), bucket); buffers.push(bytes);
  }
  if (`game-images.${imageDigest(buffers)}/` !== descriptor.directory) throw new Error('Game image checksum mismatch');
}

/** Retain one older image directory for clients still using the prior manifest. */
export async function retainGameImages(previous, outputDirectory, current, { localPreviousDirectory, fetchImpl = globalThis.fetch } = {}) {
  const descriptor = previous?.manifest?.gameImages;
  if (!validGameImages(descriptor) || descriptor.directory === current?.directory) return;
  try {
    const buffers = [];
    for (let offset = 0; offset < GAME_IMAGE_SHARDS; offset += 8) {
      buffers.push(...await Promise.all(Array.from({ length: 8 }, async (_, index) => {
        const bucket = offset + index, file = descriptor.directory + gameImageFile(bucket);
        if (localPreviousDirectory) {
          try {
            const bytes = await readFile(resolve(localPreviousDirectory, 'data', file));
            if (bytes.length > GAME_IMAGE_MAX_BYTES) throw new Error('Game image bucket too large');
            parseGameImageShard(bytes.toString('utf8'), bucket);
            return bytes;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const url = new URL(file, previous.manifestURL);
        const response = await fetchImpl(url.href, { signal: AbortSignal.timeout(15000) });
        if (response.url && new URL(response.url).origin !== url.origin) throw new Error('Game image lookup redirected off-site');
        return Buffer.from(JSON.stringify(await readGameImageResponse(response, bucket)));
      })));
    }
    if (`game-images.${imageDigest(buffers)}/` !== descriptor.directory) throw new Error('Previous game image checksum mismatch');
    await writeShards(buffers, outputDirectory, descriptor);
  } catch (error) { console.warn(`Previous game artwork lookup unavailable; older clients can use default headers: ${error.message}`); }
}
