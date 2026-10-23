import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { achievementSets, verifySupplement } from './steam-supplement.mjs';
import { AchievementRefreshStore, emptyAchievementState, decodeAchievementState, achievementStateIndex, ACHIEVEMENT_STATE_SEED } from './achievement-refresh.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Import only achievement observations. The completed source databases are
 * opened read-only; requirements and their frozen collection scope stay intact. */
export async function seedAchievementState({ directories = [resolve(ROOT, '.cache/steam-supplement')],
  output = ACHIEVEMENT_STATE_SEED, projection = resolve(ROOT, 'data/achievement-sets.json') } = {}) {
  const target = new AchievementRefreshStore(':memory:');
  try {
    try { target.merge(decodeAchievementState(await readFile(output))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const directory of directories) {
      const descriptor = JSON.parse(await readFile(resolve(directory, 'archive.json'), 'utf8'));
      await verifySupplement(resolve(directory, descriptor.file), descriptor);
      const db = new DatabaseSync(resolve(directory, 'supplement.sqlite'), { readOnly: true });
      try {
        const scope = db.prepare("SELECT COUNT(*) n FROM apps WHERE achievements=1").get().n;
        const checked = db.prepare("SELECT COUNT(*) n FROM observations WHERE source='achievements' AND outcome IN ('success','unavailable')").get().n;
        if (scope !== checked) throw new Error('Cannot seed an incomplete achievement collection');
        const state = emptyAchievementState();
        state.sourceArchives.push(descriptor.sha256);
        const minimum = db.prepare("SELECT value FROM settings WHERE key='minimumSpacingMs'").get()?.value;
        state.pacing.minimumSpacingMs = Math.max(1000, minimum ? JSON.parse(minimum) : 1000);
        for (const row of db.prepare(`SELECT o.*,r.body,r.checked_at successful_at FROM observations o LEFT JOIN responses r ON r.sequence=o.successful_response
          WHERE o.source='achievements' ORDER BY o.id`).iterate()) {
          const entry = { checkedAt: row.checked_at, outcome: row.outcome };
          if (row.error) entry.error = row.error;
          if (row.body) {
            const schema = JSON.parse(gunzipSync(row.body)).response;
            if (achievementSets(schema) !== Boolean(row.has_sets)) throw new Error('Source achievement flag mismatch');
            Object.assign(entry, { successfulAt: row.successful_at, hasSets: Boolean(row.has_sets),
              schemaVersion: schema.schema_version, schemaHash: schema.schema_hash });
          }
          if (row.outcome !== 'success') entry.retryAt = new Date(Date.parse(row.checked_at) + 30 * 86400000).toISOString();
          state.apps[row.id] = entry;
        }
        const last = db.prepare("SELECT MAX(checked_at) at FROM responses WHERE source='achievements'").get().at;
        if (last) state.pacing.lastResponseAt = last;
        target.merge(state);
      } finally { db.close(); }
    }
    const state = target.snapshot();
    // Offline seeding starts a fresh live-update allowance; it is not a daily API run.
    state.budget = emptyAchievementState().budget;
    const bytes = gzipSync(Buffer.from(JSON.stringify(state)), { level: 9 });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const index = achievementStateIndex(state);
    const entries = Object.values(state.apps), dates = entries.map(entry => entry.checkedAt).sort();
    const lookup = { version: 1, source: { sha256, checked: entries.length, checkedFrom: dates[0], checkedThrough: dates.at(-1) },
      known: [...index.keys()].sort((a, b) => a - b), supported: [...index].filter(([, value]) => value).map(([id]) => id).sort((a, b) => a - b) };
    await mkdir(dirname(output), { recursive: true }); await mkdir(dirname(projection), { recursive: true });
    await writeFile(output + '.tmp', bytes); await rename(output + '.tmp', output);
    await writeFile(projection + '.tmp', JSON.stringify(lookup) + '\n'); await rename(projection + '.tmp', projection);
    return { observed: entries.length, known: lookup.known.length, supported: lookup.supported.length, bytes: bytes.length, sha256, output };
  } finally { target.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directories = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] !== '--directory' || !process.argv[i + 1]) throw new Error('Use --directory <completed collection>');
    directories.push(resolve(process.argv[++i]));
  }
  seedAchievementState({ ...(directories.length ? { directories } : {}) })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
