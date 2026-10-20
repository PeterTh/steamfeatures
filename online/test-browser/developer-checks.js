(async function (page, { baseURL, screenshotDirectory, expectedValveCount }) {
  const checks = [], errors = [], requests = [];
  const check = (name, pass) => { if (!pass) throw new Error(name); checks.push(name); };
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.getElementById('results').hidden && !document.getElementById('results').hasAttribute('aria-busy'));
  const state = () => page.evaluate(() => window.steamFeatureAtlas.getView());
  const waitRole = (role, value) => page.waitForFunction(({ role, value }) => {
    const app = window.steamFeatureAtlas;
    return app?.getView().filters[role] === value && new URLSearchParams(location.search).get(role === 'developer' ? 'dev' : 'pub') === (value || null)
      && !document.getElementById('results').hasAttribute('aria-busy');
  }, { role, value });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  let release, fail = false;
  let gate = new Promise(resolve => { release = resolve; });
  await page.route(/\/game-credits\.[a-f0-9]{16}\.bin(?:\.gz|\.br)?$/, async route => {
    await gate;
    if (fail) await route.fulfill({ status: 503, body: 'Test metadata failure' });
    else await route.continue();
  });
  await page.goto(baseURL);
  await settled();
  const initial = await state();
  await page.waitForFunction(() => window.steamFeatureAtlas.getLoadState().creditsStatus === 'loading');
  check('Table is usable while the deferred file is held', initial.matching > 0 && await page.locator('#catalog-progress').isHidden());
  check('Metadata starts after full catalog preparation', await page.evaluate(() => window.steamFeatureAtlas.getLoadState().fullReady));
  check('Filter row has seven short labels', JSON.stringify(await page.locator('.picker-toggle').allTextContents().then(labels => labels.map(label => label.trim().replace(/\s+\d+$/, '')))) === JSON.stringify(['Features', 'Tags', 'Reviews', 'Release date', 'Compatibility', 'Languages', 'Developers']));
  await page.locator('#developer-toggle').click();
  check('Developers panel explains its two roles and waits locally', await page.locator('#developer-picker').isVisible() && await page.locator('#developer-filter').isDisabled() && await page.locator('#publisher-filter').isDisabled() && await page.locator('#credits-status').isVisible());
  await page.evaluate(() => window.steamFeatureAtlas.setFilters({ q: 'Portal 2' })); await settled();
  const title = page.locator('tr[data-game-id="620"] .game-name');
  await title.click();
  await page.locator('tr[data-game-id="620"]').evaluate(row => { row.dataset.retained = 'yes'; });
  await page.locator('#tooltip img').evaluate(image => { image.dataset.retained = 'yes'; });
  release();
  await page.waitForFunction(() => window.steamFeatureAtlas.getLoadState().creditsStatus === 'ready'); await settled();
  check('Loaded names update a locked card without replacing its image', await page.locator('#tooltip').evaluate(tip => tip.classList.contains('pinned') && tip.querySelector('img').dataset.retained === 'yes') && (await page.locator('#tooltip .card-credits').allTextContents()).join('|') === 'Valve|Valve');
  check('Late metadata preserves the existing table rows', await page.locator('tr[data-game-id="620"]').getAttribute('data-retained') === 'yes');
  await page.screenshot({ path: screenshotDirectory + '/developers-card.png', fullPage: true });
  check('Metadata completion enables both fields and adds file information', await page.locator('#developer-filter').isEnabled() && await page.locator('#publisher-filter').isEnabled() && (await page.locator('#method-dates').textContent()).includes('Developer/publisher data file:'));
  check('Successful metadata uses one transport request', requests.filter(url => /\/game-credits\..*\.bin(?:\.gz|\.br)?$/.test(url)).length === 1);
  await page.keyboard.press('Escape');
  await page.locator('#reset').click(); await settled();
  await page.locator('#developer-filter').fill('valVE'); await waitRole('developer', 'valVE');
  await page.locator('#publisher-filter').fill('Valve'); await waitRole('publisher', 'Valve');
  const filtered = await state(), sharedURL = page.url();
  check('Separate role fields combine and preserve scores/columns', filtered.matching === expectedValveCount && filtered.maxScore === initial.maxScore && filtered.featureColumns === initial.featureColumns);
  check('Both fields have chips and a count', await page.locator('.developer-chip').count() === 2 && await page.locator('#active-developer-count').innerText() === '2');
  await page.screenshot({ path: screenshotDirectory + '/developers-desktop.png', fullPage: true });
  await page.locator('#publisher-filter').fill('Devolver'); await waitRole('publisher', 'Devolver');
  check('A different publisher further restricts developer matches', (await state()).matching === 0);
  await page.goBack(); await settled();
  check('Back restores both fields, URL and results', page.url() === sharedURL && (await state()).matching === expectedValveCount && await page.locator('#publisher-filter').inputValue() === 'Valve');
  await page.reload(); await settled();
  check('A cold shared link waits for credits and applies both fields', (await state()).matching === expectedValveCount && await page.evaluate(() => window.steamFeatureAtlas.getLoadState().creditsStatus === 'ready'));
  await page.locator('#developer-toggle').click();
  await page.locator('.developer-chip[data-filter-key="publisher"]').click(); await settled();
  check('Removing one chip preserves the other role', (await state()).filters.developer === 'valVE' && (await state()).filters.publisher === '');
  await page.locator('#developer-filter').fill('CD PROJEKT '); await waitRole('developer', 'CD PROJEKT');
  check('Debounced filtering preserves typed trailing spaces and caret', await page.locator('#developer-filter').inputValue() === 'CD PROJEKT ' && await page.locator('#developer-filter').evaluate(input => input.selectionStart === input.value.length));
  await page.setViewportSize({ width: 390, height: 844 });
  check('Mobile filter row and fields fit the page', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.credit-fields input')].every(input => input.getBoundingClientRect().right <= innerWidth)));
  await page.screenshot({ path: screenshotDirectory + '/developers-mobile.png', fullPage: true });
  await page.locator('#reset').click(); await settled();
  check('Reset clears names, chips and URL', !(await state()).filters.developer && !(await state()).filters.publisher && await page.locator('.developer-chip').count() === 0 && !new URL(page.url()).search);

  // No first result is possible here until credits load: this catches scheduling deadlocks.
  fail = true; gate = new Promise(resolve => { release = resolve; });
  await page.goto(baseURL + '?v=1&dev=Valve&pub=Valve');
  await page.waitForFunction(() => window.steamFeatureAtlas?.getLoadState().creditsStatus === 'loading');
  check('A pending shared filter keeps its loading explanation visible', await page.locator('#results').isHidden() && await page.locator('#catalog-progress').isVisible() && (await page.locator('#catalog-status').textContent()).includes('developer and publisher'));
  release();
  await page.waitForFunction(() => window.steamFeatureAtlas?.getLoadState().creditsStatus === 'error');
  check('Failed metadata never displays unfiltered or false empty results', await page.locator('#results').isHidden() && await page.locator('#catalog-retry').isVisible() && await page.locator('#error').isHidden());
  fail = false;
  await page.locator('#catalog-retry').click(); await settled();
  check('Metadata retry recovers the pending shared filter', (await state()).matching === expectedValveCount && await page.evaluate(() => window.steamFeatureAtlas.getLoadState().creditsStatus === 'ready'));
  check('No runtime errors', errors.length === 0);
  return { passed: checks.length, checks };
})
