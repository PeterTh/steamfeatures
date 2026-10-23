import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { achievementSetIndex, applyAchievementSets, readAchievementSets, projectAchievementSets } from '../scripts/achievement-sets.mjs';
import { SteamSupplementStore, exportSupplement } from '../scripts/steam-supplement.mjs';
import { features } from '../src/features.mjs';
import { columnState, featureColumns } from '../src/feature-presentation.mjs';
import { runQuery, parseQuery, serializeQuery } from '../src/query.mjs';
import { encodeBinaryCatalog } from '../scripts/catalog-binary.mjs';
import { decodeBinaryCatalog } from '../src/catalog-binary.mjs';
import { importCatalog } from '../scripts/import-catalog.mjs';

const feature = features.find(feature => feature.key === 'achievement-sets');
const source = { sha256: 'a'.repeat(64), checked: 3, checkedFrom: '2026-10-16T15:20:00Z', checkedThrough: '2026-10-23T06:00:00Z' };
const input = () => ({ version: 1, source, known: [10, 20], supported: [10] });
const game = id => ({ id, name: `Game ${id}`, featureIds: [2, 22], featureDataKnown: true,
  reviews: 100, releaseStatus: 'released', earlyAccess: false });

test('sets sit beside achievements and add one point, with compact URL filtering and unknown-safe exclusions', () => {
  const games = applyAchievementSets([game(10), game(20), game(30)], achievementSetIndex(input()));
  const catalog = { features, games };
  const columns = featureColumns(features);
  assert.equal(columns[columns.findIndex(column => column.id === 22) + 1].id, feature.id);
  assert.equal(feature.weight, 1);
  assert.equal(feature.short, 'SET');
  for (const toggles of [{}, { includeAccessibility: true, includeMultiplayer: true, includeHardware: true }]) {
    const rows = new Map(runQuery(catalog, toggles).rows.map(row => [row.id, row]));
    assert.equal(rows.get(10).score, rows.get(20).score + 1);
    assert.equal(rows.get(10).count, rows.get(20).count + 1);
  }
  assert.deepEqual(runQuery(catalog, { has: ['SET'] }).rows.map(row => row.id), [10]);
  assert.deepEqual(runQuery(catalog, { not: ['SET'] }).rows.map(row => row.id), [20]);
  assert.equal(columnState(games[0], feature).mark, '✓');
  assert.equal(columnState(games[1], feature).supported, 'false');
  assert.equal(columnState(games[2], feature).supported, 'unknown');
  assert.equal(serializeQuery({ has: [feature.id] }, features), '?v=1&has=SET');
  assert.deepEqual(parseQuery('?has=achievement-sets', features).has, [feature.id]);
  const decoded = decodeBinaryCatalog(encodeBinaryCatalog(catalog));
  assert.deepEqual(runQuery(decoded, { not: ['SET'] }), runQuery(catalog, { not: ['SET'] }));
});

test('the checked index updates flags without changing unrelated features or mutating input games', () => {
  const original = [{ ...game(10), knownFeatureGroups: ['third-party-drm'] },
    { ...game(20), featureIds: [2, 22, feature.id], knownFeatureGroups: ['achievement-sets'] }, game(30)];
  const before = structuredClone(original);
  const games = applyAchievementSets(original, achievementSetIndex(input()));
  assert.deepEqual(original, before);
  assert.deepEqual(games[0].featureIds, [2, 22, feature.id]);
  assert.deepEqual(games[0].knownFeatureGroups, ['achievement-sets', 'third-party-drm']);
  assert.deepEqual(games[1].featureIds, [2, 22]);
  assert.deepEqual(games[1].knownFeatureGroups, ['achievement-sets']);
  assert.equal(games[2], original[2]);
});

test('invalid or contradictory checked indices fail instead of silently changing exclusion matches', () => {
  for (const change of [{ version: 2 }, { source: { ...source, sha256: 'bad' } },
    { source: { ...source, checkedThrough: 'unknown' } }, { source: { ...source, checked: 1 } },
    { known: [20, 10] }, { known: [10, 10] }, { known: [0, 10] }, { supported: [30] }, { supported: [10, 10] }]) {
    assert.throws(() => achievementSetIndex({ ...input(), ...change }), /Invalid achievement-set/);
  }
});

test('offline projection verifies complete archives and retains usable schemas across unavailable attempts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'achievement-set-projection-'));
  const store = new SteamSupplementStore(join(directory, 'supplement.sqlite'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const group = id => ({ groupid: id, ispublic: true, developeronly: false, archived: false, total_achievements: 1 });
  store.seed([1, 2, 3, 4].map(id => ({ id, reviews: 10, featureIds: [22] })), { seededAt: source.checkedFrom });
  const save = (id, body, resultCode = 1) => {
    store.recordResponse({ method: 'IPlayerService/GetGameAchievements', input: { appid: id }, status: 200, resultCode: String(resultCode), body });
    store.finish(id, 'achievements', { outcome: resultCode === 1 ? 'success' : 'unavailable', hasSets: [1, 4].includes(id) });
  };
  for (const id of [1, 2, 4]) save(id, { response: { schema_version: 1, schema_hash: 1, achievements: [], groups: [group(0), ...([1, 4].includes(id) ? [group(1)] : [])] } });
  save(3, { response: {} }, 42);
  save(4, { response: {} }, 42);
  for (const id of [1, 2, 3, 4]) {
    store.recordResponse({ method: 'Store/AppDetails', input: { appids: id }, status: 200, resultCode: null, body: { [id]: { success: false } } });
    store.finish(id, 'requirements', { outcome: 'unavailable' });
  }
  const descriptor = await exportSupplement(store, directory);
  await writeFile(join(directory, 'archive.json'), JSON.stringify(descriptor));
  const output = join(directory, 'sets.json');
  const result = await projectAchievementSets({ directory, output });
  assert.equal(result.knownGames, 3);
  assert.equal(result.supportedGames, 2);
  const data = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(data.known, [1, 2, 4]);
  assert.deepEqual(data.supported, [1, 4]);
  assert.equal(data.source.sha256, descriptor.sha256);
  assert.deepEqual([...(await readAchievementSets(output)).index], [[1, true], [2, false], [4, true]]);
  // A checksummed partial export still must not replace the completed index.
  store.db.prepare("UPDATE observations SET outcome='error' WHERE id=3 AND source='achievements'").run();
  store.counts = store.readCounts();
  const partial = await exportSupplement(store, directory);
  await writeFile(join(directory, 'archive.json'), JSON.stringify(partial));
  await assert.rejects(projectAchievementSets({ directory, output }), /completed supplement/);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), data);
});

test('normal imports merge the bundled projection and pin its provenance in every catalog transport', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'achievement-set-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'sets.json');
  await writeFile(filename, JSON.stringify(input()));
  const { catalog, manifest } = await importCatalog({ output: join(directory, 'site'), fixture: true, achievementSetsFile: filename });
  assert.equal(catalog.games.find(game => game.id === 10).featureIds.includes(feature.id), true);
  assert.equal(catalog.games.find(game => game.id === 20).knownFeatureGroups.includes('achievement-sets'), true);
  assert.equal(catalog.games.find(game => game.id === 30).knownFeatureGroups, undefined);
  assert.equal(manifest.sources.achievementSets.archiveSha256, source.sha256);
  assert.deepEqual(catalog.sources.achievementSets, manifest.sources.achievementSets);
  const binary = decodeBinaryCatalog(await readFile(join(directory, 'site/data', manifest.current.binary.file)));
  assert.deepEqual(runQuery(binary, { not: ['SET'] }).rows.map(row => row.id), [20]);
  const lock = JSON.parse(await readFile(join(directory, 'site/provenance-lock.json'), 'utf8'));
  assert.deepEqual(lock.sources.achievementSets, manifest.sources.achievementSets);
});
