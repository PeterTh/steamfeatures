import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { verifySupplement } from './steam-supplement.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ACHIEVEMENT_SETS_FILE = resolve(ROOT, 'data/achievement-sets.json');
export const ACHIEVEMENT_SETS_ID = 10002;
const knowledgeGroup = 'achievement-sets';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** This build input contains only observed flags, never full achievement schemas. */
export function achievementSetIndex(data) {
  if (data?.version !== 1 || !/^[a-f0-9]{64}$/.test(data.source?.sha256) ||
      !Number.isSafeInteger(data.source.checked) || data.source.checked < 1 ||
      !Number.isFinite(Date.parse(data.source.checkedFrom)) || !Number.isFinite(Date.parse(data.source.checkedThrough))) {
    throw new Error('Invalid achievement-set source');
  }
  for (const key of ['known', 'supported']) {
    if (!Array.isArray(data[key]) || data[key].some((id, i, ids) =>
      !Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff || (i > 0 && id <= ids[i - 1]))) {
      throw new Error('Invalid achievement-set app IDs');
    }
  }
  const index = new Map(data.known.map(id => [id, false]));
  if (index.size > data.source.checked || data.supported.some(id => !index.has(id))) throw new Error('Invalid achievement-set coverage');
  for (const id of data.supported) index.set(id, true);
  return index;
}

export async function readAchievementSets(filename = ACHIEVEMENT_SETS_FILE) {
  const bytes = await readFile(filename);
  const data = JSON.parse(bytes);
  return { index: achievementSetIndex(data), source: { sha256: sha256(bytes), archiveSha256: data.source.sha256,
    checkedFrom: data.source.checkedFrom, checkedThrough: data.source.checkedThrough,
    knownGames: data.known.length, supportedGames: data.supported.length } };
}

/** Apply after ordinary Steam enrichment so its category refresh cannot erase sets. */
export function applyAchievementSets(games, index) {
  return games.map(game => {
    if (!index.has(game.id)) return game;
    const featureIds = game.featureIds.filter(id => id !== ACHIEVEMENT_SETS_ID);
    if (index.get(game.id)) featureIds.push(ACHIEVEMENT_SETS_ID);
    return { ...game, featureIds: featureIds.sort((a, b) => a - b),
      knownFeatureGroups: [...new Set([...(game.knownFeatureGroups ?? []), knowledgeGroup])].sort() };
  });
}

/** Explicit offline projection; normal builds do not open or modify the checkpoint. */
export async function projectAchievementSets({ directory = resolve(ROOT, '.cache/steam-supplement'), output = ACHIEVEMENT_SETS_FILE } = {}) {
  const descriptor = JSON.parse(await readFile(resolve(directory, 'archive.json'), 'utf8'));
  const filename = resolve(directory, descriptor.file);
  await verifySupplement(filename, descriptor);
  const data = { version: 1, source: { sha256: descriptor.sha256 }, known: [], supported: [] };
  const input = createReadStream(filename).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header;
  try {
    for await (const line of lines) {
      const row = JSON.parse(line);
      if (!header) {
        header = row;
        if (!header.complete) throw new Error('Achievement sets require a completed supplement');
        data.source.checked = header.achievements.checked;
        continue;
      }
      const value = row.achievements;
      if (!value) continue;
      if (!data.source.checkedFrom || value.checkedAt < data.source.checkedFrom) data.source.checkedFrom = value.checkedAt;
      if (!data.source.checkedThrough || value.checkedAt > data.source.checkedThrough) data.source.checkedThrough = value.checkedAt;
      // An unavailable attempt cannot erase an earlier validated payload. A
      // missing catalog without a usable payload supplies no negative flag.
      if (!value.data) continue;
      data.known.push(row.id);
      if (value.hasPublicSets) data.supported.push(row.id);
    }
  } finally { lines.close(); input.destroy(); }
  if (data.supported.length !== header.publicAchievementSets) throw new Error('Achievement-set positive count mismatch');
  achievementSetIndex(data);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(data) + '\n');
  return { knownGames: data.known.length, supportedGames: data.supported.length, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : resolve(process.argv[i + 1]); };
  projectAchievementSets({ directory: option('--directory'), output: option('--output') })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
