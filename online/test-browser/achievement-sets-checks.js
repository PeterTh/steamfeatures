(async function (page, { baseURL = 'http://127.0.0.1:4178/', screenshotDirectory, expected }) {
  const checks = [], errors = [], requests = [];
  const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
  const state = () => page.evaluate(() => window.steamFeatureAtlas.getView());
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page &&
    !document.getElementById('results').hidden && !document.getElementById('results').hasAttribute('aria-busy'));
  const set = async patch => { await page.evaluate(patch => window.steamFeatureAtlas.setFilters(patch), patch); await settled(); };
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.goto(baseURL + '?has=SET');
  await settled();
  check('Shared SET link filters the initial catalog', (await state()).matching === expected.initial);
  check('SET is immediately beside ACH', await page.locator('#feature-22 + #feature-10002').count() === 1);
  check('New column uses its short label', (await page.locator('#feature-10002 .header-short').textContent()) === 'SET');
  await set({ minReviews: 0, release: 'all', q: '' });
  check('Full catalog includes all observed positives', (await state()).matching === expected.all);
  check('Background handover retains the active feature filter', (await state()).filters.has.includes(10002));
  await page.reload(); await settled();
  check('Compact URL survives reload with all-catalog filters', (await state()).matching === expected.all &&
    new URL(page.url()).searchParams.get('has') === 'SET');
  await set({ q: 'Portal 2' });
  const portal = (await state()).games.find(game => game.id === 620);
  check('Portal 2 receives exactly one extra score point', portal?.score === expected.portalScore);
  check('Set-supporting games display a green check', await page.locator('tr[data-game-id="620"] td[data-feature="10002"] .check:not(.neutral):not(.negative)').count() === 1);
  await page.locator('#feature-toggle').click();
  const require = page.getByRole('button', { name: 'Require Achievement Sets', exact: true });
  const exclude = page.getByRole('button', { name: 'Exclude Achievement Sets', exact: true });
  check('Picker reflects the active requirement', await require.getAttribute('aria-pressed') === 'true');
  await exclude.click(); await settled();
  check('Exclude replaces require and removes a supporting game', (await state()).matching === 0 &&
    (await state()).filters.not.includes(10002) && new URL(page.url()).searchParams.get('not') === 'SET');
  await set({ q: 'Terraria', has: [], not: [] });
  check('A valid default-only schema has a known absence', await page.locator('tr[data-game-id="105600"] td[data-feature="10002"][data-supported="false"]').count() === 1);
  await exclude.click(); await settled();
  check('Known negatives satisfy exclusion', (await state()).games.some(game => game.id === 105600));
  await set({ q: 'Faceless', has: [], not: [] });
  check('An unavailable catalog remains unknown', await page.locator('tr[data-game-id="243240"] td[data-feature="10002"][data-supported="unknown"]').count() === 1);
  await exclude.click(); await settled();
  check('Unavailable schemas cannot satisfy exclusion', !(await state()).games.some(game => game.id === 243240));
  await set({ q: '', has: [], not: [10002] });
  check('All-catalog exclusion matches only validated negatives', (await state()).matching === expected.negatives);
  await set({ minReviews: 20, release: 'released', has: [10002], not: [] });
  await page.locator('#feature-toggle').click();
  await page.locator('#feature-10002').scrollIntoViewIfNeeded();
  if (screenshotDirectory) await page.screenshot({ path: screenshotDirectory + '/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#feature-10002').scrollIntoViewIfNeeded();
  check('Mobile layout retains the new column and filters', await page.locator('#feature-22 + #feature-10002').count() === 1 && (await state()).matching === expected.initial);
  if (screenshotDirectory) await page.screenshot({ path: screenshotDirectory + '/mobile.png' });
  check('The feature adds no visitor-side Steam API requests', !requests.some(url => /api\.steampowered\.com|store\.steampowered\.com\/api\//.test(url)));
  check('No browser script errors', errors.length === 0);
  return { checks, errors };
})
