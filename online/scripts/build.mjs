import { copyFile, cp, mkdir, mkdtemp, readdir, rm, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCatalog } from './import-catalog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const liveOutput = resolve(root, 'dist');
const cache = resolve(root, '.cache');
await mkdir(cache, { recursive: true });
const output = await mkdtemp(resolve(cache, 'build-'));
const predecessor = `${output}.previous`;
// Check every directory before any recursive cleanup or rename on Windows.
if (dirname(liveOutput) !== root || dirname(output) !== cache || dirname(predecessor) !== cache) throw new Error('Build artifact path escaped the workspace');
const sourceIndex = process.argv.indexOf('--sources');
const stateIndex = process.argv.indexOf('--steam-state');
const limitIndex = process.argv.indexOf('--steam-limit');
const dataIndex = process.argv.indexOf('--steam-data');
try {
await importCatalog({ output, fixture: process.argv.includes('--fixture'), sourceFile: sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined,
  ...(process.argv.includes('--refresh-steam') || process.argv.includes('--bootstrap-steam') ? { refresh: true } : {}),
  bootstrap: process.argv.includes('--bootstrap-steam'), steamStateFile: stateIndex >= 0 ? process.argv[stateIndex + 1] : undefined,
  finalizeSteam: process.argv.includes('--finalize-steam'),
  localPreviousDirectory: liveOutput,
  steamDataFile: dataIndex >= 0 ? process.argv[dataIndex + 1] : undefined,
  ...(limitIndex >= 0 ? { steamLimit: Number(process.argv[limitIndex + 1]) } : {})
});
await copyFile(resolve(root, 'src/template.html'), resolve(output, 'index.html'));
for (const name of await readdir(resolve(root, 'src'))) {
  if (/\.(?:js|mjs|css|svg)$/.test(name)) await copyFile(resolve(root, 'src', name), resolve(output, name));
}
await cp(resolve(root, 'src/fonts'), resolve(output, 'fonts'), { recursive: true });
await copyFile(resolve(root, '../LICENSE'), resolve(output, 'licenses/Steam-Feature-Atlas-MIT.txt'));
await copyFile(resolve(root, '../THIRD_PARTY_NOTICES.md'), resolve(output, 'licenses/THIRD_PARTY_NOTICES.md'));
await writeFile(resolve(output, '.nojekyll'), '');
let movedPrevious = false;
try { await rename(liveOutput, predecessor); movedPrevious = true; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
try { await rename(output, liveOutput); }
catch (error) { if (movedPrevious) await rename(predecessor, liveOutput); throw error; }
if (movedPrevious) await rm(predecessor, { recursive: true, force: true });
console.log('Static site built. Serve online/dist over HTTP for local development.');
} finally {
  await rm(output, { recursive: true, force: true });
}
