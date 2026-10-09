// Compare complete-catalog wire formats using existing local bulk data only.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { indexCommunityTags, summarizeCoverage } from './normalize.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputs = JSON.parse(await readFile(resolve(root, '.cache/prepared-sources.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(root, 'dist/data/manifest.json'), 'utf8'));
const original = JSON.parse(await readFile(resolve(root, 'dist/data', manifest.current.catalog), 'utf8'));
const reviews = JSON.parse(gunzipSync(await readFile(inputs.reviewsFile)));
const sourceTags = indexCommunityTags(reviews);
const { tags: oldTags, tagIndex: oldTagIndex, ...baseline } = original;
baseline.games = baseline.games.map(({ tagIds, tags, ...game }) => game);
const { knownTags: oldKnownTags, tagCount: oldTagCount, ...coverage } = baseline.coverage;
baseline.coverage = coverage;
const tags = [...new Set(baseline.games.flatMap(game => sourceTags.get(game.id) || []))].sort();
const byName = new Map(tags.map((name, id) => [name, id]));
const indexed = baseline.games.map(game => sourceTags.get(game.id)?.map(name => byName.get(name)).sort((a, b) => a - b));
const knownTags = indexed.filter(Boolean).length;
const tagMemberships = indexed.reduce((sum, ids) => sum + (ids?.length || 0), 0);
const taggedCoverage = summarizeCoverage(baseline.games.map((game, i) => indexed[i] ? { ...game, tagIds: indexed[i] } : game), {
  tagCount: tags.length, sourceApps: coverage.sourceApps, redirectAliases: coverage.redirectAliases,
  reviewRows: coverage.reviewRows, sourceShards: coverage.sourceShards
});
const results = [];
function measure(name, value) {
  const json = Buffer.from(JSON.stringify(value));
  const gzip = gzipSync(json, { level: 9 });
  results.push({ name, jsonBytes: json.length, gzipBytes: gzip.length, gzipOverheadBytes: results.length ? gzip.length - results[0].gzipBytes : 0 });
}
function packed(values) {
  const bytes = [];
  for (const original of values) {
    let value = original;
    while (value >= 128) { bytes.push((value & 127) | 128); value >>>= 7; }
    bytes.push(value);
  }
  return Buffer.from(bytes).toString('base64');
}
function deltas(values) { return values.map((value, i) => i ? value - values[i - 1] : value); }
const { games: baselineGames, ...baselineHeader } = baseline;
const taggedHeader = { ...baselineHeader, coverage: taggedCoverage, tags };
function withGames(key, encode) {
  return { ...taggedHeader, games: baselineGames.map((game, i) => indexed[i] ? { ...game, [key]: encode(indexed[i], i) } : game) };
}
measure('baseline-no-tags', baseline);
measure('labels-per-game', { ...baseline, coverage: taggedCoverage, games: baseline.games.map((game, i) => indexed[i] ? { ...game, tags: indexed[i].map(id => tags[id]) } : game) });
measure('dictionary-sorted-ids', withGames('tagIds', ids => ids));
measure('dictionary-delta-ids', withGames('tagDeltas', ids => deltas(ids)));
measure('dictionary-varint-base64', withGames('tagBits', ids => packed(deltas(ids))));
measure('dictionary-bitset-base64', withGames('tagBits', ids => {
  const bytes = Buffer.alloc(Math.ceil(tags.length / 8));
  for (const id of ids) bytes[id >> 3] |= 1 << (id & 7);
  return bytes.toString('base64');
}));
const postings = tags.map(() => []);
for (let gameIndex = 0; gameIndex < indexed.length; gameIndex++) for (const tagId of indexed[gameIndex] || []) postings[tagId].push(gameIndex);
measure('inverted-delta-json', { ...taggedHeader, tagIndex: { encoding: 'delta-game-indices-v1', lists: postings.map(deltas) }, games: baselineGames });
measure('inverted-varint-base64', { ...taggedHeader, tagIndex: { encoding: 'varint-base64-game-indices-v1', lists: postings.map(indices => packed(deltas(indices))) }, games: baselineGames });
const report = { generatedAt: new Date().toISOString(), catalogSHA256: manifest.current.sha256, reviewsSHA256: inputs.sources.reviews.sha256, games: baseline.games.length, knownTags, tagCount: tags.length, tagMemberships, gzipLevel: 9, selected: 'inverted-delta-json', wireEncoding: 'delta-game-indices-v1', decision: 'Readable delta JSON saves about 7% of the whole gzip catalog versus per-game IDs; base64 adds decoding complexity for less than 1% further savings.', results };
const reportDirectory = resolve(root, 'test-results/benchmarks');
await mkdir(reportDirectory, { recursive: true });
await writeFile(resolve(reportDirectory, 'tag-packing.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
