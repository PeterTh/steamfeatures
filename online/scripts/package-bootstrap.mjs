import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySite } from './verify-site.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = resolve(root, 'dist');
const cache = resolve(root, '.cache');
const output = resolve(cache, 'steam-feature-atlas-bootstrap.tar.gz');
const temporary = resolve(cache, `bootstrap-${randomUUID()}.tar.gz`);
if (dirname(site) !== root || dirname(cache) !== root || dirname(output) !== cache || dirname(temporary) !== cache) throw new Error('Bootstrap package path escaped the project.');

async function rejectLinks(directory) {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new Error('Bootstrap packages cannot contain links: ' + directory);
  if (info.isDirectory()) for (const name of await readdir(directory)) await rejectLinks(resolve(directory, name));
  else if (!info.isFile()) throw new Error('Bootstrap packages require regular files: ' + directory);
}

try {
  const summary = await verifySite(site);
  await rejectLinks(site);
  await mkdir(cache, { recursive: true });
  const result = spawnSync('tar', ['-czf', temporary, '-C', site, '.'], { shell: false, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('tar failed to create the bootstrap package.');
  await rename(temporary, output);
  console.log(JSON.stringify({ ...summary, package: output, bytes: (await stat(output)).size }, null, 2));
} finally {
  await rm(temporary, { force: true });
}
