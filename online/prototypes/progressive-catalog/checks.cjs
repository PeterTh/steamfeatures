const assert = require('node:assert/strict');
const { readFile, mkdir, writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { chromium, firefox } = require(process.env.PROTOTYPE_PLAYWRIGHT || 'playwright-core');
const online = resolve(__dirname, '../..');

async function main() {
  const { createPrototypeServer } = await import('./server.mjs');
  const server = await createPrototypeServer();
  const manifest = JSON.parse(await readFile(resolve(online, '.cache/progressive-catalog/data/manifest.json'), 'utf8'));
  const reportPath = resolve(online, 'test-results/benchmarks/progressive-catalog-checks-2026-10-13.json');
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  const report = { verifiedAt: new Date().toISOString(), browsers: [] }, activeBrowsers = [];
  const settled = page => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.getElementById('results').hidden && !document.getElementById('results').hasAttribute('aria-busy'));
  const getView = page => page.evaluate(() => window.steamFeatureAtlas.getView());
  try {
    for (const name of (process.env.PROTOTYPE_BROWSERS || 'edge,firefox').split(',')) {
      const browser = name === 'edge' ? await chromium.launch({ channel: 'msedge', headless: true }) : await firefox.launch({ headless: true });
      activeBrowsers.push(browser);
      const result = { browser: name, version: browser.version(), progressive: [], suites: [] }; report.browsers.push(result);
      const checked = (label, condition) => { assert(condition, label); result.progressive.push(label); };
      const baseline = await browser.newContext(), gated = await browser.newContext();
      let release;
      const gate = new Promise(done => { release = done; });
      try {
        const reference = await baseline.newPage();
        await reference.goto(server.baseURL + '/local/baseline/'); await settled(reference);
        const initial = await getView(reference);
        const page = await gated.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await gated.route('**/' + manifest.progressive.remainder.file + '*', async route => { await gate; await route.continue(); });
        await page.goto(server.baseURL + '/local/prototype/'); await settled(page);
        assert.deepEqual(await getView(page), initial);
        checked('Default results are complete while the remainder is unavailable', !(await page.evaluate(() => window.steamFeatureAtlas.getLoadState().fullReady)));
        await page.evaluate(() => window.steamFeatureAtlas.setFilters({ minReviews: 0 }));
        await page.waitForFunction(() => window.steamFeatureAtlas.getLoadState().pendingFullQuery);
        checked('Lower review thresholds wait rather than presenting incomplete results', await page.evaluate(() => document.getElementById('results').hasAttribute('aria-busy') && window.steamFeatureAtlas.getView().matching > 0));
        const started = Date.now();
        const high = { minReviews: 20, sort: 'reviews-desc', hasTags: ['RPG'], includeAccessibility: true };
        await reference.evaluate(query => window.steamFeatureAtlas.setFilters(query), high); await settled(reference);
        await page.evaluate(query => window.steamFeatureAtlas.setFilters(query), high); await settled(page);
        assert.deepEqual(await getView(page), await getView(reference));
        checked('20+ filters keep working without the remainder', !(await page.evaluate(() => window.steamFeatureAtlas.getLoadState().fullReady)));
        result.highFilterWhileBlockedMs = Date.now() - started;
        const waiting = { minReviews: 19, sort: 'score-desc', hasTags: [], hasLanguages: ['german:interface'], includeAccessibility: false };
        await page.evaluate(query => window.steamFeatureAtlas.setFilters(query), waiting);
        await page.waitForFunction(() => window.steamFeatureAtlas.getLoadState().pendingFullQuery);
        await reference.evaluate(query => window.steamFeatureAtlas.setFilters(query), waiting); await settled(reference);
        release(); await settled(page);
        assert.deepEqual(await getView(page), await getView(reference));
        checked('Finishing the background load applies the latest waiting query exactly once', await page.evaluate(() => window.steamFeatureAtlas.getLoadState().fullReady && !window.steamFeatureAtlas.getLoadState().pendingFullQuery));
        await page.goto(server.baseURL + '/local/prototype/?minReviews=0&ea=1&release=all&highlight=steam-cloud'); await settled(page);
        await reference.goto(server.baseURL + '/local/baseline/?minReviews=0&ea=1&release=all&highlight=steam-cloud'); await settled(reference);
        assert.deepEqual(await getView(page), await getView(reference));
        checked('Cold shared links below 20 reviews use both partitions before showing results', !(await page.evaluate(() => window.steamFeatureAtlas.getLoadState().partial)));
        checked('Progressive transitions produce no page errors', errors.length === 0);
      } finally { release(); await gated.close(); await baseline.close(); }

      const typingContext = await browser.newContext();
      try {
        const page = await typingContext.newPage();
        await page.addInitScript(() => {
          const NativeWorker = window.Worker;
          let index = 0;
          window.Worker = class extends NativeWorker {
            constructor(...args) { super(...args); this.index = index++; }
            addEventListener(type, listener, ...rest) {
              if (this.index !== 1 || type !== 'message') return super.addEventListener(type, listener, ...rest);
              return super.addEventListener(type, event => {
                if (event.data.type === 'ready') { window.releaseFullReady = () => listener(event); window.fullReadyHeld = true; }
                else listener(event);
              }, ...rest);
            }
          };
        });
        await page.goto(server.baseURL + '/local/prototype/'); await settled(page);
        await page.evaluate(() => window.steamFeatureAtlas.setFilters({ minReviews: 0 }));
        await page.waitForFunction(() => window.fullReadyHeld, null, { timeout: 60000 });
        await page.locator('#search').fill('Portal  ');
        await page.evaluate(() => window.releaseFullReady());
        await settled(page);
        checked('Background readiness preserves spaces and cursor position while a title search is being debounced',
          await page.locator('#search').inputValue() === 'Portal  ' && await page.locator('#search').evaluate(input => input.selectionStart === 8));
      } finally { await typingContext.close(); }

      const failureContext = await browser.newContext();
      try {
        const page = await failureContext.newPage();
        const block = '**/' + manifest.progressive.remainder.file + '*';
        await failureContext.route(block, route => route.fulfill({ status: 503, body: 'Unavailable remainder for failure check' }));
        await page.goto(server.baseURL + '/local/prototype/'); await settled(page);
        const initial = await getView(page);
        await page.waitForFunction(() => window.steamFeatureAtlas.getLoadState().backgroundError, null, { timeout: 60000 });
        assert.deepEqual(await getView(page), initial);
        checked('Background failures retain correct default results', await page.locator('#results').isVisible() && await page.locator('#catalog-retry').isVisible());
        await page.evaluate(() => window.steamFeatureAtlas.setFilters({ minReviews: 0 }));
        checked('Unavailable low-review data never reports a completed partial query', await page.evaluate(() => window.steamFeatureAtlas.getLoadState().pendingFullQuery && document.getElementById('results').hasAttribute('aria-busy')));
        await failureContext.unroute(block); await page.locator('#catalog-retry').click(); await settled(page);
        checked('Retry completes a queued low-review query', await page.evaluate(() => window.steamFeatureAtlas.getLoadState().fullReady && window.steamFeatureAtlas.getView().filters.minReviews === 0));
      } finally { await failureContext.close(); }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ browser: name, progressiveChecks: result.progressive.length }));
      try {
        for (const harness of ['checks', 'highlight-checks', 'layout-checks', 'release-date-checks', 'steam-enrichment-checks', 'compatibility-details-checks', 'language-checks', 'search-tag-checks']) {
          const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, hasTouch: harness === 'search-tag-checks' });
          try {
            const page = await context.newPage();
            const check = (0, eval)(await readFile(resolve(online, 'test-browser', harness + '.js'), 'utf8'));
            const checked = await check(page, { baseURL: server.baseURL + '/local/prototype/' });
            result.suites.push({ harness, ...checked });
            await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
            console.log(JSON.stringify({ browser: name, harness, passed: checked.passed }));
          } finally { await context.close(); }
        }
      } finally { await browser.close(); }
    }
  } finally { await Promise.allSettled(activeBrowsers.map(browser => browser.close())); await server.close(); }
  console.log('Saved checks to ' + reportPath);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
