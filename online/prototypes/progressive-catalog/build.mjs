// Local prototype: reads the saved dist catalogue, writes only .cache/progressive-catalog.
// Build: node online/prototypes/progressive-catalog/build.mjs
// Preview: node online/prototypes/progressive-catalog/server.mjs
import { readFile, writeFile, mkdir, readdir, copyFile, cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBinaryCatalog } from '../../src/catalog-binary.mjs';
import { writeBinaryCatalog } from '../../scripts/catalog-package.mjs';
import { partitionCatalog } from './catalog.mjs';
import { prototypeApp, prototypeHTML } from './app-transform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const online = resolve(here, '../..');
const output = resolve(online, '.cache/progressive-catalog');
await mkdir(resolve(output, 'data'), { recursive: true });
const manifest = JSON.parse(await readFile(resolve(online, 'dist/data/manifest.json'), 'utf8'));
const catalog = decodeBinaryCatalog(await readFile(resolve(online, 'dist/data', manifest.current.binary.file)));
const parts = partitionCatalog(catalog);
const priority = await writeBinaryCatalog(parts.priority, resolve(output, 'data'));
const remainder = await writeBinaryCatalog(parts.remainder, resolve(output, 'data'));
const progressive = { version: 1, minReviews: 20, snapshot: manifest.current.binary.sha256, priority, remainder, statistics: parts.statistics };
await writeFile(resolve(output, 'data/manifest.json'), JSON.stringify({ ...manifest, progressive }, null, 2) + '\n');
for (const name of await readdir(resolve(online, 'src'))) {
  if (/\.(?:m?js|css|svg)$/.test(name)) await copyFile(resolve(online, 'src', name), resolve(output, name));
}
await cp(resolve(online, 'src/fonts'), resolve(output, 'fonts'), { recursive: true });
await cp(resolve(online, 'dist/licenses'), resolve(output, 'licenses'), { recursive: true });
await writeFile(resolve(output, 'app.js'), prototypeApp(await readFile(resolve(online, 'src/app.js'), 'utf8')));
await writeFile(resolve(output, 'index.html'), prototypeHTML(await readFile(resolve(online, 'src/template.html'), 'utf8')));
await copyFile(resolve(here, 'worker.js'), resolve(output, 'filter-worker.js'));
// The prototype reuses the existing verified loader, without its worker listener.
const original = await readFile(resolve(online, 'src/filter-worker.js'), 'utf8');
const marker = original.indexOf('\nlet prepared = null;');
if (marker < 0) throw new Error('Prototype loader anchor changed.');
const loader = original.slice(0, marker) + `
export async function readProgressivePlan(address) {
  const manifestAddress = new URL(address, location.href), expectedOrigin = location.origin;
  sameOriginURL(manifestAddress, manifestAddress, expectedOrigin);
  const response = await fetchResponse(manifestAddress, fetch, 'no-cache', manifestAddress);
  const manifest = JSON.parse(new TextDecoder().decode(await readBytes(response.body, undefined, MANIFEST_MAX_BYTES, 'manifest')));
  const plan = manifest.progressive;
  if (manifest.version !== 1 || plan?.version !== 1 || plan.minReviews !== 20 || plan.snapshot !== manifest.current.binary.sha256) throw new Error('Invalid progressive catalog manifest.');
  validateBinaryDescriptor(plan.priority); validateBinaryDescriptor(plan.remainder);
  return { ...plan, manifestURL: manifestAddress.href };
}
export async function loadPartition(plan, part) {
  if (!['priority', 'remainder'].includes(part)) throw new Error('Unknown catalog partition.');
  return binaryCatalog(plan[part], { manifestAddress: new URL(plan.manifestURL), expectedOrigin: location.origin, fetchImpl: fetch, cryptoImpl: crypto, DecompressionStreamImpl: DecompressionStream });
}
`;
await writeFile(resolve(output, 'prototype-loader.mjs'), loader);
// Publish only the browser-safe helpers; the offline partitioner imports build tools.
const helper = await readFile(resolve(here, 'catalog.mjs'), 'utf8');
await writeFile(resolve(output, 'progressive-catalog.mjs'), "import { normalizeQuery } from './query.mjs';\nexport const PRIORITY_MIN_REVIEWS = 20;\n" + helper.slice(helper.indexOf('/** Row-index')));
const summary = { output, games: catalog.games.length, priorityGames: parts.priority.games.length, remainderGames: parts.remainder.games.length,
  original: manifest.current.binary, priority, remainder, gzipOverheadBytes: priority.gzip.bytes + remainder.gzip.bytes - manifest.current.binary.gzip.bytes,
  brotliOverheadBytes: priority.brotli.bytes + remainder.brotli.bytes - manifest.current.binary.brotli.bytes };
await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
