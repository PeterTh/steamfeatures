import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture } from '../scripts/fixture.mjs';
import { importCatalog } from '../scripts/import-catalog.mjs';
import { createRefreshState } from '../scripts/refresh-state.mjs';
import { SteamDataStore, STEAM_DATA_FORMAT, readSteamDataArchive } from '../scripts/steam-data.mjs';
import { STEAM_DATA_REQUEST } from '../scripts/steam-client.mjs';
import { runQuery } from '../src/query.mjs';
import { decodeBinaryCatalog } from '../src/catalog-binary.mjs';
import { createSteamResponseArchive } from '../scripts/steam-archive.mjs';
import { gameImageBucket, gameImageFile } from '../src/game-images.mjs';

test('offline finalization consumes enriched checkpoints, publishes streaming raw data, and keeps browser projections equivalent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'steam-enriched-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sources = await createFixture(join(directory, 'sources'));
  const sourceFile = join(directory, 'sources.json');
  await writeFile(sourceFile, JSON.stringify(sources));
  const checkpointFile = join(directory, 'state.json');
  const state = createRefreshState(); state.bootstrapComplete = true;
  await writeFile(checkpointFile, JSON.stringify(state));
  const steamDataFile = join(directory, 'steam.sqlite');
  const store = new SteamDataStore(steamDataFile);
  const now = '2026-10-10T12:00:00.000Z';
  try {
    store.setting('tags', [{ tagid: 19, name: 'Action' }]);
    for (const id of [10, 20, 30, 40]) {
      store.seed(id);
      store.putStore(id, { id, appid: id, success: 1, visible: true, name: `Steam ${id}`, categories: { feature_categoryids: [2] },
        reviews: { summary_filtered: { review_count: 30, percent_positive: 90 } }, tagids: [19],
        release: { is_coming_soon: id === 40, steam_release_date: 1577836800 },
        platforms: { steam_deck_compat_category: 3 }, assets_without_overrides: { header: `${id}/header.jpg` },
        extra_details: { no_mouse_keyboard_support: id === 20, links_and_info: { achievement_count: 12 } }
      }, { checkedAt: now, request: STEAM_DATA_REQUEST });
      store.putAppInfo(id, { appid: String(id), common: { category: { category_45: '1', category_46: '1' },
        steam_deck_compatibility: { category: '3', tests: { 0: { display: '4', token: '#SteamDeckVerified_TestResult_InterfaceTextIsLegible' } } } },
        ufs: { sync_while_suspended: id === 10 ? '1' : '0' } }, { checkedAt: now });
    }
  } finally { store.close(); }
  const archive = createSteamResponseArchive({ directory: join(directory, 'steam-responses'), now: () => Date.parse(now) + 1000 });
  const journal = await archive({ method: 'IStoreBrowseService/GetItems', input: {}, body: { response: { store_items: [
    { id: 50, appid: 50, success: 1, type: 6, name: 'Unrelated legacy software' },
    { id: 10, appid: 10, success: 1, name: 'Replayed title' }
  ] } }, status: 200, resultCode: 1 });
  const { manifest, catalog } = await importCatalog({ sourceFile, checkpointFile, steamDataFile, fixture: true, finalizeSteam: true,
    now: '2026-10-10T13:00:00.000Z', output: join(directory, 'site') });
  assert.equal(manifest.steamArchive.format, STEAM_DATA_FORMAT);
  assert.equal(manifest.steamArchive.apps, 4);
  assert.equal(manifest.refresh.lastRunAt, now);
  const imageShard = JSON.parse(await readFile(join(directory, 'site/data', manifest.gameImages.directory, gameImageFile(gameImageBucket(10))), 'utf8'));
  assert.equal(imageShard[10], '10/header.jpg');
  assert.ok(catalog.games.every(game => !Object.hasOwn(game, 'headerImage')));
  const finalized = new SteamDataStore(steamDataFile);
  try {
    assert.equal(finalized.progress().apps, 4);
    assert.equal(finalized.get(10).store.name, 'Steam 10');
    assert.equal(finalized.get(10).store_checked, now);
  } finally { finalized.close(); }
  assert.ok(catalog.features.some(feature => feature.key === 'steam-deck-test-interface-text-is-legible'));
  assert.deepEqual(runQuery(catalog, { has: ['dynamic-cloud-sync'] }).rows.map(row => row.id), [10]);
  assert.deepEqual(runQuery(catalog, { has: ['no-keyboard-mouse'] }).rows.map(row => row.id), [20]);
  assert.equal(catalog.games.find(game => game.id === 10).achievementCount, 12);
  assert.equal(catalog.games.find(game => game.id === 40).releaseStatus, 'upcoming');
  const binary = decodeBinaryCatalog(await readFile(join(directory, 'site/data', manifest.current.binary.file)));
  assert.deepEqual(runQuery(binary, { includeHardware: true }), runQuery(catalog, { includeHardware: true }));
  const rows = [];
  for await (const row of readSteamDataArchive(join(directory, 'site/data', manifest.steamArchive.file), manifest.steamArchive)) rows.push(row);
  assert.equal(rows.length, 5);
  assert.equal(rows[1].appinfo.ufs.sync_while_suspended, '1');
  await rm(journal);
  // Reload the exported artifact and rebuild without access to the original DB.
  const rebuilt = await importCatalog({ sourceFile, checkpointFile, fixture: true, finalizeSteam: true,
    localPreviousDirectory: join(directory, 'site'), now: '2026-10-10T14:00:00.000Z', output: join(directory, 'restored-site') });
  assert.deepEqual(runQuery(rebuilt.catalog, { includeHardware: true }), runQuery(catalog, { includeHardware: true }));
  assert.deepEqual(rebuilt.manifest.gameImages, manifest.gameImages);
});
