import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headerImagePath, writeGameImages, retainGameImages, verifyGameImages } from '../scripts/game-images.mjs';
import { createGameImageLoader, gameImageBucket, gameImageFile, parseGameImageShard, steamHeaderURL, GAME_IMAGE_MAX_BYTES } from '../src/game-images.mjs';

const descriptor = { version: 1, directory: 'game-images.1234567890abcdef/', shardCount: 256 };
const manifestURL = 'https://example.com/atlas/data/manifest.json';
async function temporary(t) {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../.cache');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, 'test-game-images-'));
  assert.equal(dirname(directory), parent);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('permanent header artwork precedes overrides and PICS supplies missing English paths', () => {
  assert.equal(headerImagePath({ store: { assets_without_overrides: { header: 'permanent/header.jpg' }, assets: { header: 'sale/header.jpg' } } }), 'permanent/header.jpg');
  assert.equal(headerImagePath({ appinfo: { common: { header_image: { english: 'english/header.jpg' } } } }), 'english/header.jpg');
  assert.equal(headerImagePath({ store: { assets: { header: 'header.jpg' } } }), 'header.jpg');
  for (const header of ['https://other.test/header.jpg', '../header.jpg', 'a/../../header.jpg', 'bad?query/header.jpg']) {
    assert.equal(headerImagePath({ store: { assets: { header } } }), undefined);
  }
});

test('256 deterministic lookup files contain only allowed nonstandard paths', async t => {
  const directory = await temporary(t);
  const paths = new Map([[1203620, '731368301f231d622bd0b1e34afd2afcd86a1dcf/header.jpg'], [620, 'portal/header.jpg'], [570, 'header.jpg'], [42, 'ignored/header.jpg']]);
  const allowed = new Set([1203620, 620, 570]);
  const first = await writeGameImages(paths, directory, allowed);
  const second = await writeGameImages(new Map([...paths].reverse()), directory, allowed);
  assert.deepEqual(first, second);
  assert.equal((await readdir(resolve(directory, first.directory))).length, 256);
  assert.equal(gameImageFile(gameImageBucket(1203620)), '11.json');
  const shard = JSON.parse(await readFile(resolve(directory, first.directory, '11.json'), 'utf8'));
  assert.equal(shard[1203620], paths.get(1203620));
  assert.ok(!Object.values(shard).includes('header.jpg'));
  await verifyGameImages(directory, first);
  await writeFile(resolve(directory, first.directory, '11.json'), '{}');
  await assert.rejects(verifyGameImages(directory, first), /checksum/);
});

test('lookup starts immediately on demand and shares pending and completed bucket requests', async () => {
  let calls = 0, finish;
  const load = createGameImageLoader(descriptor, { manifestURL, fetchImpl: url => {
    calls++; assert.equal(url, 'https://example.com/atlas/data/' + descriptor.directory + '11.json');
    return new Promise(resolve => { finish = resolve; });
  } });
  assert.equal(calls, 0);
  const first = load(1203620), second = load(1203620);
  assert.equal(calls, 1);
  finish(new Response(JSON.stringify({ 1203620: 'hash/header.jpg' })));
  assert.equal(await first, steamHeaderURL(1203620, 'hash/header.jpg'));
  assert.equal(await second, await load(1203620));
  const sameBucket = Array.from({ length: 10000 }, (_, i) => i + 1).find(id => gameImageBucket(id) === gameImageBucket(1203620));
  assert.equal(await load(sameBucket), steamHeaderURL(sameBucket));
  assert.equal(calls, 1);
});

test('missing, invalid, unavailable or oversized lookups fall back without affecting the catalog', async () => {
  const withoutLookup = createGameImageLoader(null, { fetchImpl: () => { throw new Error('Unexpected request'); } });
  assert.equal(await withoutLookup(570), steamHeaderURL(570));
  assert.equal(await createGameImageLoader({ ...descriptor, directory: '../wrong/' })(570), steamHeaderURL(570));
  for (const response of [new Response('', { status: 404 }), new Response('not json'), new Response('[]'),
    new Response(JSON.stringify({ 1203620: '../escape.jpg' })), new Response(' '.repeat(GAME_IMAGE_MAX_BYTES + 1))]) {
    const load = createGameImageLoader(descriptor, { manifestURL, fetchImpl: async () => response });
    assert.equal(await load(1203620), steamHeaderURL(1203620));
  }
  assert.throws(() => parseGameImageShard('{"620":"hash/header.jpg"}', gameImageBucket(1203620)), /Invalid game image entry/);
});

test('failed lookups can retry on a later card opening', async () => {
  let calls = 0;
  const load = createGameImageLoader(descriptor, { manifestURL, fetchImpl: async () => {
    calls++; if (calls === 1) throw new Error('Offline');
    return new Response('{"1203620":"hash/header.jpg"}');
  } });
  assert.equal(await load(1203620), steamHeaderURL(1203620));
  assert.equal(await load(1203620), steamHeaderURL(1203620, 'hash/header.jpg'));
  assert.equal(calls, 2);
});

test('the previous lookup directory is retained locally and verifies independently', async t => {
  const directory = await temporary(t), oldSite = resolve(directory, 'old'), next = resolve(directory, 'next');
  const previous = await writeGameImages(new Map([[620, 'older/header.jpg']]), resolve(oldSite, 'data'));
  const current = await writeGameImages(new Map([[620, 'newer/header.jpg']]), next);
  await retainGameImages({ manifest: { gameImages: previous } }, next, current, { localPreviousDirectory: oldSite, fetchImpl: () => { throw new Error('Unexpected network'); } });
  await verifyGameImages(next, previous);
  await verifyGameImages(next, current);
});
