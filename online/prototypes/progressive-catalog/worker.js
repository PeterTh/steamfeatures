import { prepareCatalog, runQuery } from './query.mjs';
import { readProgressivePlan, loadPartition } from './prototype-loader.mjs';
import { mergeCatalogPartitions, queryUsesPriority } from './progressive-catalog.mjs';
import { isCompatibilityDetail } from './compatibility-details.mjs';
// Discover decoder assets alongside the loader rather than one request round later.
import './catalog-binary.mjs';
import './catalog-descriptor.mjs';

let prepared, plan, partial = false, token = 0;
const phases = {};
const timed = (name, fn) => { const start = performance.now(); const value = fn(); phases[name] = performance.now() - start; return value; };

self.addEventListener('message', async ({ data: message }) => {
  const current = message.type === 'init' ? ++token : token;
  try {
    if (message.type === 'init') {
      prepared = null;
      plan = message.plan ?? await readProgressivePlan(message.manifestURL);
      partial = message.mode !== 'full' && Number(message.minReviews ?? 20) >= 20;
      let loaded, catalog;
      if (partial) {
        loaded = await loadPartition(plan, 'priority');
        catalog = loaded.catalog;
      } else {
        const parts = await Promise.all(['priority', 'remainder'].map(part => loadPartition(plan, part)));
        catalog = timed('mergeMs', () => mergeCatalogPartitions(parts[0].catalog, parts[1].catalog));
        loaded = { bytes: parts.reduce((total, part) => total + part.bytes, 0), compression: parts[0].compression };
      }
      if (token !== current) return;
      prepared = timed('prepareMs', () => prepareCatalog(catalog));
      if (!partial && prepared.games.length !== plan.statistics.gameCount) throw new Error('The complete catalog has the wrong game count.');
      self.postMessage({ type: 'ready', gameCount: plan.statistics.gameCount, features: prepared.features,
        compatibilityDetails: catalog.features.filter(feature => isCompatibilityDetail(feature)), tags: prepared.tags,
        tagCounts: plan.statistics.tagCounts, knownTagCount: plan.statistics.knownTagCount,
        languages: prepared.languages, languageCounts: plan.statistics.languageCounts,
        importedAt: catalog.importedAt, sources: catalog.sources, coverage: catalog.coverage, refresh: catalog.refresh,
        fixture: catalog.fixture === true, catalogHash: plan.snapshot, catalogCompression: loaded.compression,
        catalogBytes: loaded.bytes, progressive: { partial, plan }, benchmark: { ...phases } });
    } else if (message.type === 'query') {
      if (!prepared) throw new Error('The game catalog has not loaded yet.');
      if (partial && !queryUsesPriority(message.query, prepared)) throw new Error('This filter needs the complete catalog.');
      const result = timed('queryMs', () => runQuery(prepared, message.query));
      self.postMessage({ type: 'result', requestId: message.requestId, result, benchmark: { ...phases } });
    } else throw new Error('Unknown prototype worker message.');
  } catch (error) {
    if (token === current) self.postMessage({ type: 'error', phase: message.type, requestId: message.requestId, message: error.message });
  }
});
