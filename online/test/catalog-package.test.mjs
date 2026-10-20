import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { writeCatalogPackages } from '../scripts/catalog-package.mjs';

test('a failed credit package waits for catalog writes before allowing build cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'steam-catalog-packages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalog = { version: 1, features: [], tags: [], games: [
    { id: 1, name: 'Twenty', reviews: 20, featureIds: [] },
    { id: 2, name: 'Nineteen', reviews: 19, featureIds: [] },
  ] };
  const invalidCredits = new Map([[1, [['\ud800'], null]]]);
  await assert.rejects(writeCatalogPackages(catalog, directory, invalidCredits), /Invalid UTF-8 credit name/);

  // Full catalog and both partitions have finished writing all representations.
  const files = await readdir(directory);
  const binaries = files.filter(file => file.endsWith('.bin'));
  assert.equal(binaries.length, 3);
  assert.equal(files.length, 9);
  for (const file of binaries) {
    const bytes = await readFile(join(directory, file));
    assert.deepEqual(gunzipSync(await readFile(join(directory, file + '.gz'))), bytes);
    assert.deepEqual(brotliDecompressSync(await readFile(join(directory, file + '.br'))), bytes);
  }
});
