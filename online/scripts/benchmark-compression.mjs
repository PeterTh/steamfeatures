import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliDecompressSync, createZstdDecompress, gunzipSync } from 'node:zlib';
import { decodeGameCredits, gameCreditNames } from '../src/game-credits.mjs';

// Each measured case runs in a fresh process. Inputs are frozen once; no Steam
// requests, database updates, catalog refreshes or deployments happen here.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), mode = args[0];
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const directory = resolve(option('--output') || '.cache/compression-benchmark');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async name => JSON.parse(await readFile(resolve(directory, name), 'utf8'));
const save = async (name, value) => writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + '\n');
const loadModule = (source, name) => import(pathToFileURL(resolve(source, 'scripts', name)).href);
await mkdir(resolve(directory, 'inputs'), { recursive: true });
await mkdir(resolve(directory, 'results'), { recursive: true });

async function inspectRaw(filename, descriptor) {
  let compressedBytes = 0, expandedBytes = 0, header, headerBytes = 0;
  const compressedHash = createHash('sha256'), expandedHash = createHash('sha256'), headerParts = [];
  await pipeline(createReadStream(filename), new Transform({ transform(chunk, encoding, callback) {
    compressedBytes += chunk.length; compressedHash.update(chunk); callback(null, chunk);
  } }), createZstdDecompress(), new Writable({ write(chunk, encoding, callback) {
    try {
      expandedBytes += chunk.length; expandedHash.update(chunk);
      assert.ok(expandedBytes <= descriptor.uncompressedBytes, 'Raw archive expanded size limit');
      if (!header) {
        const newline = chunk.indexOf(10), part = newline < 0 ? chunk : chunk.subarray(0, newline);
        headerBytes += part.length; assert.ok(headerBytes <= 32 * 1024 ** 2, 'Raw header size limit');
        headerParts.push(Buffer.from(part));
        if (newline >= 0) header = JSON.parse(Buffer.concat(headerParts).toString('utf8'));
      }
      callback();
    } catch (error) { callback(error); }
  } }));
  assert.equal(compressedBytes, descriptor.bytes); assert.equal(compressedHash.digest('hex'), descriptor.sha256);
  assert.equal(expandedBytes, descriptor.uncompressedBytes); assert.ok(Array.isArray(header?.tagDictionary));
  return { header, bytes: expandedBytes, sha256: expandedHash.digest('hex') };
}

if (mode === 'prepare') {
  const baseline = resolve(option('--baseline') || process.env.COMPRESSION_BASELINE);
  await stat(resolve(baseline, 'scripts/catalog-package.mjs'));
  await stat(resolve(baseline, 'scripts/steam-data.mjs'));
  const local = option('--site-directory'), base = process.env.COMPRESSION_BASE_URL || 'https://steamfeatures.org/';
  const download = async (name, expectedBytes) => {
    assert.equal(basename(name), name, 'Input filename must stay within the data directory');
    const target = resolve(directory, 'inputs', name);
    if (local) await copyFile(resolve(local, 'data', name), target);
    else {
      const response = await fetch(new URL('data/' + name, base), { cache: 'no-store', signal: AbortSignal.timeout(300000) });
      assert.ok(response.ok, name + ': HTTP ' + response.status);
      let received = 0;
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) {
        received += chunk.length;
        callback(received > expectedBytes ? new Error('Download exceeded descriptor size') : null, chunk);
      } }), createWriteStream(target));
      assert.equal(received, expectedBytes);
    }
    return target;
  };
  let manifest;
  if (local) manifest = JSON.parse(await readFile(resolve(local, 'data/manifest.json'), 'utf8'));
  else {
    const response = await fetch(new URL('data/manifest.json', base), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    assert.ok(response.ok, 'Manifest HTTP status'); manifest = await response.json();
  }
  assert.equal(manifest.fixture, false); assert.equal(manifest.refresh.bootstrapComplete, true);
  if (process.env.EXPECTED_CATALOG_SNAPSHOT) assert.equal(manifest.current.binary.sha256, process.env.EXPECTED_CATALOG_SNAPSHOT);
  const catalogFile = await download(manifest.current.compressedCatalog, manifest.current.gzipBytes);
  const compressed = await readFile(catalogFile); assert.equal(hash(compressed), manifest.current.gzipSha256);
  const expanded = gunzipSync(compressed, { maxOutputLength: manifest.current.bytes });
  assert.equal(expanded.length, manifest.current.bytes); assert.equal(hash(expanded), manifest.current.sha256);
  await writeFile(resolve(directory, 'inputs/catalog.json'), expanded);
  const creditsFile = await download(manifest.gameCredits.file, manifest.gameCredits.bytes);
  assert.equal(hash(await readFile(creditsFile)), manifest.gameCredits.sha256);
  const rawFile = await download(manifest.steamArchive.file, manifest.steamArchive.bytes);
  const raw = await inspectRaw(rawFile, manifest.steamArchive);
  const info = { base: local || base, baseline,
    snapshot: manifest.current.binary.sha256, importedAt: manifest.importedAt, games: manifest.coverage.games,
    creditsFile, rawFile, raw, environment: { node: process.version, platform: process.platform, arch: process.arch,
      cpus: availableParallelism(), cpuModel: cpus()[0]?.model, memoryBytes: totalmem(), threadpoolSize: process.env.UV_THREADPOOL_SIZE || 'default (4)',
      candidateCommit: process.env.GITHUB_SHA || null } };
  await save('manifest.json', manifest); await save('input-info.json', info);
  console.log(JSON.stringify({ prepared: info.snapshot, games: info.games, rawBytes: manifest.steamArchive.bytes, environment: info.environment }));
} else if (['baseline-browser', 'parallel-browser', 'baseline-archive', 'parallel-archive'].includes(mode)) {
  const [info, manifest] = await Promise.all([json('input-info.json'), json('manifest.json')]);
  const source = mode.startsWith('baseline-') ? info.baseline : root;
  const output = resolve(directory, mode); await mkdir(output, { recursive: true });
  let operation, verify, workers = 0, processedApps = 0;
  if (mode.endsWith('browser')) {
    const catalog = JSON.parse(await readFile(resolve(directory, 'inputs/catalog.json'), 'utf8'));
    const decoded = decodeGameCredits(await readFile(info.creditsFile), info.snapshot);
    const credits = new Map(Array.from(decoded.appIds, (id, index) => {
      const names = gameCreditNames(decoded, decoded.pairs[decoded.pairIds[index]]);
      return [id, [names.developerNames, names.publisherNames]];
    }));
    const packages = await loadModule(source, 'catalog-package.mjs');
    const creditWriter = await loadModule(source, 'game-credits.mjs');
    operation = async () => {
      if (mode.startsWith('parallel-')) return packages.writeCatalogPackages(catalog, output, credits);
      const binary = await packages.writeBinaryCatalog(catalog, output);
      const progressive = await packages.writeProgressiveCatalog(catalog, output, binary.sha256);
      const gameCredits = await creditWriter.writeGameCredits(catalog.games, credits, output, binary.sha256);
      return { binary, progressive, gameCredits };
    };
    verify = async value => {
      assert.equal(value.binary.sha256, info.snapshot); assert.equal(value.gameCredits.sha256, manifest.gameCredits.sha256);
      for (const descriptor of [value.binary, value.progressive.priority, value.progressive.remainder, value.gameCredits]) {
        const raw = await readFile(resolve(output, descriptor.file));
        assert.equal(raw.length, descriptor.bytes); assert.equal(hash(raw), descriptor.sha256);
        for (const [key, unpack] of [['gzip', gunzipSync], ['brotli', brotliDecompressSync]]) {
          const packed = await readFile(resolve(output, descriptor[key].file));
          assert.equal(packed.length, descriptor[key].bytes); assert.equal(hash(packed), descriptor[key].sha256);
          assert.ok(unpack(packed, { maxOutputLength: raw.length }).equals(raw), key + ' round trip');
        }
      }
    };
  } else {
    const archive = await loadModule(source, 'steam-data.mjs'); workers = archive.STEAM_ARCHIVE_COMPRESSION_WORKERS ?? 0;
    async function* records() {
      for await (const record of archive.readSteamDataArchive(info.rawFile, manifest.steamArchive)) {
        if (record.format) { assert.deepEqual(record, info.raw.header); continue; }
        processedApps++; yield record;
      }
    }
    operation = () => archive.writeSteamDataArchive({ records: records(), tagDictionary: info.raw.header.tagDictionary,
      generatedAt: info.raw.header.generatedAt, outputDirectory: output });
    verify = async descriptor => {
      assert.equal(processedApps, manifest.steamArchive.apps);
      for (const key of ['apps', 'successfulApps', 'picsApps', 'uncompressedBytes']) assert.equal(descriptor[key], manifest.steamArchive[key]);
      const expanded = await inspectRaw(resolve(output, descriptor.file), descriptor);
      assert.deepEqual(expanded, info.raw, 'Every expanded raw byte must remain identical');
    };
  }
  const cpu = process.cpuUsage(), started = performance.now();
  console.log(JSON.stringify({ mode, startedAt: new Date().toISOString(), workers }));
  const heartbeat = setInterval(() => console.log(JSON.stringify({ mode, seconds: (performance.now() - started) / 1000, processedApps })), 30000);
  let result;
  try { result = await operation(); } finally { clearInterval(heartbeat); }
  const seconds = (performance.now() - started) / 1000, used = process.cpuUsage(cpu), peakRSSKiB = process.resourceUsage().maxRSS;
  const verificationStarted = performance.now(); await verify(result);
  const measured = { mode, snapshot: info.snapshot, seconds, cpuSeconds: (used.user + used.system) / 1e6,
    peakRSSMiB: peakRSSKiB / 1024, workers, verifySeconds: (performance.now() - verificationStarted) / 1000, verified: true, output: result };
  await save('results/' + mode + '.json', measured);
  console.log(JSON.stringify({ ...measured, output: undefined }));
} else if (mode === 'summarize') {
  const info = await json('input-info.json');
  const results = await Promise.all(['baseline-browser', 'parallel-browser', 'baseline-archive', 'parallel-archive'].map(name => json('results/' + name + '.json')));
  const [oldBrowser, newBrowser, oldArchive, newArchive] = results;
  assert.deepEqual(oldBrowser.output, newBrowser.output, 'All browser bytes and descriptors must remain identical');
  const comparison = (before, after) => ({ baselineSeconds: before.seconds, parallelSeconds: after.seconds,
    speedup: before.seconds / after.seconds, savedSeconds: before.seconds - after.seconds,
    baselinePeakRSSMiB: before.peakRSSMiB, parallelPeakRSSMiB: after.peakRSSMiB });
  const summary = { snapshot: info.snapshot, games: info.games, environment: info.environment,
    browser: { ...comparison(oldBrowser, newBrowser), identicalBytes: true },
    archive: { ...comparison(oldArchive, newArchive), baselineBytes: oldArchive.output.bytes, parallelBytes: newArchive.output.bytes,
      sizeChangePercent: (newArchive.output.bytes / oldArchive.output.bytes - 1) * 100, identicalExpandedBytes: true },
    combined: { baselineSeconds: oldBrowser.seconds + oldArchive.seconds, parallelSeconds: newBrowser.seconds + newArchive.seconds },
    scope: 'Packaging comparison on one frozen completed snapshot. Raw input is decoded and reserialized in both cases. Fetching, source projection, deployment and post-compression verification are excluded from measured times.' };
  await save('results/summary.json', summary); console.log(JSON.stringify({ summary }));
} else throw new Error('Use prepare --baseline <online-directory>, baseline-browser, parallel-browser, baseline-archive, parallel-archive, or summarize.');
