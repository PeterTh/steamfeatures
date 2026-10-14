const assert = require('node:assert/strict');
const { readFile, mkdir, writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { chromium, firefox } = require(process.env.PROTOTYPE_PLAYWRIGHT || 'playwright-core');
const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2; };

async function main() {
  const { createPrototypeServer } = await import('./server.mjs');
  const server = await createPrototypeServer({ instrument: true });
  const summary = JSON.parse(await readFile(resolve(__dirname, '../../.cache/progressive-catalog/summary.json'), 'utf8'));
  const out = resolve(__dirname, '../../test-results/benchmarks', process.env.PROTOTYPE_BENCHMARK_REPORT || 'progressive-catalog-2026-10-13.json');
  await mkdir(resolve(out, '..'), { recursive: true });
  const localRepetitions = Number(process.env.PROTOTYPE_LOCAL_REPS || 6), slowRepetitions = Number(process.env.PROTOTYPE_SLOW_REPS || 3);
  const report = { measuredAt: new Date().toISOString(), dataset: summary, methodology: { freshContexts: true, alternatingOrder: true, localRepetitions,
    slowRepetitions, slow: '10 Mbps per catalogue response, 150 ms per uncached HTTP request', initialPaint: 'Two animation frames after result visibility and required fonts', full: 'Prototype complete background worker ready' }, runs: [], summaries: [] };
  let expectedView, expectedCounts;
  async function sample(browser, name, profile, variant, repetition, record = true) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    try {
      const page = await context.newPage();
      const errors = [], start = server.requests.length;
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
      await page.addInitScript(() => {
        window.__initialPerf = { workers: [], longTasks: [] };
        if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => window.__initialPerf.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true });
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          constructor(...args) {
            super(...args); const index = window.__initialPerf.workers.length;
            const record = this.record = { createdMs: performance.now() }; window.__initialPerf.workers.push(record);
            this.addEventListener('message', ({ data }) => {
              if (data.type === 'ready') {
                record.readyMs = performance.now(); Object.assign(record, data.benchmark);
                record.payloadBytes = data.catalogBytes; record.compression = data.catalogCompression;
                if (index === 0) { window.__initialPerf.languageCounts = data.languageCounts; window.__initialPerf.tagCounts = data.tagCounts; }
              }
              if (data.type === 'result' && window.__initialPerf.firstResultMs === undefined) window.__initialPerf.firstResultMs = performance.now();
            });
          }
          terminate() { this.record.terminatedMs = performance.now(); super.terminate(); }
        };
        new MutationObserver(() => {
          if (document.getElementById('results')?.hidden !== false || window.__initialPerf.domVisibleMs !== undefined) return;
          window.__initialPerf.domVisibleMs = performance.now();
          document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => { window.__initialPerf.paintedMs = performance.now(); })));
        }).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
      });
      await page.goto(`${server.baseURL}/${profile}/${variant}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__initialPerf.paintedMs || !document.getElementById('error').hidden, null, { timeout: 60000 });
      const initial = await page.evaluate(() => ({ view: window.steamFeatureAtlas.getView(), perf: window.__initialPerf, error: document.getElementById('error').hidden ? null : document.getElementById('error-message').textContent }));
      assert.equal(initial.error, null); assert.equal(initial.view.displayed, 50);
      if (!expectedView) { expectedView = initial.view; expectedCounts = { tags: initial.perf.tagCounts, languages: initial.perf.languageCounts }; }
      else { assert.deepEqual(initial.view, expectedView); assert.deepEqual(initial.perf.tagCounts, expectedCounts.tags); assert.deepEqual(initial.perf.languageCounts, expectedCounts.languages); }
      if (variant === 'prototype') await page.waitForFunction(() => window.steamFeatureAtlas.getLoadState().fullReady || window.steamFeatureAtlas.getLoadState().backgroundError, null, { timeout: 60000 });
      const completed = await page.evaluate(() => ({ perf: window.__initialPerf, load: window.steamFeatureAtlas.getLoadState?.(), view: window.steamFeatureAtlas.getView() }));
      assert.deepEqual(completed.view, initial.view, 'Background readiness must not change, rerender or reset the active query');
      assert.equal(completed.load?.backgroundError ?? null, null); assert.deepEqual(errors, []);
      const activeWorkerCount = completed.perf.workers.filter(worker => worker.terminatedMs === undefined).length;
      assert.equal(activeWorkerCount, 1, 'Only one catalogue index should remain after full readiness');
      if (variant === 'prototype') assert.notEqual(completed.perf.workers[0].terminatedMs, undefined, 'The priority worker should be terminated during handover');
      const requests = server.requests.slice(start).filter(request => /\.bin\.(?:gz|br)$/.test(request.name));
      assert.equal(requests.length, variant === 'prototype' ? 2 : 1, 'The first partition should be reused from browser cache by the background worker');
      const first = initial.perf.workers[0];
      const run = { browser: name, version: browser.version(), profile, variant, repetition, paintedMs: initial.perf.paintedMs, readyMs: first.readyMs,
        prepareMs: first.prepareMs, compression: first.compression, initialPayloadBytes: first.payloadBytes,
        fullReadyMs: completed.load?.fullReadyAt ?? first.readyMs, workers: completed.perf.workers, activeWorkerCount,
        payloadNetworkBytes: requests.reduce((sum, request) => sum + request.bytes, 0), payloadRequests: requests.map(request => ({ name: request.name, bytes: request.bytes })) };
      if (record) { report.runs.push(run); await writeFile(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ browser: name, profile, variant, repetition, paintedMs: +run.paintedMs.toFixed(1), fullReadyMs: +run.fullReadyMs.toFixed(1), prepareMs: +run.prepareMs.toFixed(1) })); }
    } finally { await context.close(); }
  }
  try {
    for (const name of (process.env.PROTOTYPE_BROWSERS || 'edge,firefox').split(',')) {
      const browser = name === 'edge' ? await chromium.launch({ channel: 'msedge', headless: true }) : await firefox.launch({ headless: true });
      try {
        await sample(browser, name, 'local', 'baseline', -1, false); await sample(browser, name, 'local', 'prototype', -1, false);
        for (const [profile, count] of [['local', localRepetitions], ['slow', slowRepetitions]]) {
          for (let repetition = 0; repetition < count; repetition++) for (const variant of repetition % 2 ? ['prototype', 'baseline'] : ['baseline', 'prototype']) await sample(browser, name, profile, variant, repetition);
          const medians = Object.fromEntries(['baseline', 'prototype'].map(variant => { const runs = report.runs.filter(run => run.browser === name && run.profile === profile && run.variant === variant); return [variant, Object.fromEntries(['paintedMs', 'readyMs', 'prepareMs', 'fullReadyMs', 'payloadNetworkBytes'].map(key => [key, median(runs.map(run => run[key]))]))]; }));
          report.summaries.push({ browser: name, profile, repetitions: count, medians, initialSavedMs: medians.baseline.paintedMs - medians.prototype.paintedMs,
            initialSavedPercent: 100 * (1 - medians.prototype.paintedMs / medians.baseline.paintedMs) });
          await writeFile(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report.summaries.at(-1)));
        }
      } finally { await browser.close(); }
    }
  } finally { await server.close(); }
  console.log('Saved benchmark to ' + out);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
