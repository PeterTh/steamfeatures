(async function (page, { baseURL = 'http://127.0.0.1:4179/', expected, screenshotDirectory }) {
  const checks = [], errors = [], requests = [];
  const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
  const state = () => page.evaluate(() => window.steamFeatureAtlas.getView());
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page &&
    !document.getElementById('results').hidden && !document.getElementById('results').hasAttribute('aria-busy'));
  const select = async value => page.locator('#library-file').setInputFiles({ name: 'library.json', mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
  const set = async patch => { await page.evaluate(patch => window.steamFeatureAtlas.setFilters(patch), patch); await settled(); };
  const rule = async (kind, action) => { await page.locator(`#library-${kind}-${action}`).click(); await settled(); };
  const openLibrary = async (tab = page) => {
    if (await tab.locator('#filter-category').isVisible()) await tab.locator('#filter-category').selectOption('library');
    else await tab.locator('#library-toggle').click();
  };
  const appIds = view => view.games.map(game => game.id).sort((a, b) => a - b);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.addInitScript(() => {
    window.libraryDataWrites = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'steam-feature-atlas.user-library.v1') window.libraryDataWrites++;
      return setItem.call(this, key, value);
    };
  });
  await page.context().route(url => expected.remainderFiles.includes(url.pathname.split('/').at(-1)), async route => {
    await gate; await route.continue();
  });
  await page.goto(baseURL); await settled();
  check('A new browser starts without a library restriction', !(await state()).library.loaded && (await state()).matching > 2);
  await openLibrary();
  check('The new tab opens and links to the Steam library export',
    await page.locator('#library-picker').isVisible() &&
    await page.locator('#library-help a').getAttribute('href') === 'https://store.steampowered.com/dynamicstore/userdata/');
  await select({ rgOwnedApps: [620, expected.lowId, 620, 987654321], rgWishlist: [570, expected.lowId, 570], steamid: 'PRIVATE-ACCOUNT-CANARY' });
  await page.waitForFunction(() => window.steamFeatureAtlas.getView().library.active); await settled();
  check('Import deduplicates IDs and immediately filters the initial catalog',
    (await state()).library.appCount === 3 && appIds(await state()).join() === '620' && await page.locator('#active-library-count').textContent() === '1');
  check('The full catalog is still held during import', !await page.evaluate(() => window.steamFeatureAtlas.getLoadState().fullReady));
  await select({ rgOwnedApps: [440, expected.lowId, 987654321], rgWishlist: [570, expected.lowId, 570], steamid: 'PRIVATE-ACCOUNT-CANARY' });
  await page.waitForFunction(() => window.steamFeatureAtlas.getView().games.some(game => game.id === 440)); await settled();
  check('Replacing a library also updates the loading background worker', appIds(await state()).join() === '440');
  await page.evaluate(() => window.steamFeatureAtlas.setFilters({ minReviews: 0, release: 'all' }));
  await page.waitForFunction(() => window.steamFeatureAtlas.getLoadState().pendingFullQuery);
  release();
  await settled();
  check('The complete-catalog handover retains the latest library, including low-review games',
    appIds(await state()).join() === [440, expected.lowId].sort((a, b) => a - b).join());
  check('Library filtering keeps feature scores unchanged', (await state()).games.find(game => game.id === 440).score === expected.highScore);
  check('Wishlist IDs are independently deduplicated', (await state()).library.wishlistCount === 2);
  const writesBeforeRules = await page.evaluate(() => window.libraryDataWrites);
  await rule('wishlist', 'has');
  check('Require owned and wishlisted games finds their intersection', appIds(await state()).join() === String(expected.lowId) && await page.locator('#active-library-count').textContent() === '2');
  await rule('owned', 'not');
  check('Require wishlisted and exclude owned games finds unowned wishlist entries', appIds(await state()).join() === '570' && await page.locator('#library-owned-not').getAttribute('aria-pressed') === 'true');
  await rule('wishlist', 'not');
  check('Both exclusions omit owned and wishlisted games', (await state()).matching === expected.allGames - 3 && !(await state()).games.some(game => [440, 570, expected.lowId].includes(game.id)));
  await rule('owned', 'has');
  check('Require owned and exclude wishlisted games finds owned games outside the wishlist', appIds(await state()).join() === '440');
  await rule('wishlist', 'not');
  check('Clicking an active choice clears that rule independently', (await state()).matching === 2 && await page.locator('#library-wishlist-not').getAttribute('aria-pressed') === 'false');
  check('Changing library rules never rewrites the saved app IDs', await page.evaluate(() => window.libraryDataWrites) === writesBeforeRules);
  await select({ rgOwnedApps: [440, expected.lowId, 987654321], rgWishlist: [] }); await settled();
  await rule('wishlist', 'has');
  check('Requiring an explicitly empty wishlist matches no games', (await state()).matching === 0);
  await rule('wishlist', 'not');
  check('Excluding an explicitly empty wishlist preserves other matches', (await state()).matching === 2);
  await rule('wishlist', 'not');
  await select({ rgOwnedApps: [440, expected.lowId, 987654321] }); await settled();
  check('Missing wishlist data disables both controls instead of treating it as empty', (await state()).library.wishlistCount === null && await page.locator('#library-wishlist-has').isDisabled() && await page.locator('#library-wishlist-not').isDisabled());
  await select({ rgOwnedApps: [440, expected.lowId, 987654321], rgWishlist: [570, expected.lowId] }); await settled();
  await rule('wishlist', 'has');
  await select({ rgOwnedApps: [620] });
  await page.waitForFunction(() => /Wishlist data is missing/.test(document.getElementById('library-error').textContent));
  check('A missing wishlist cannot overwrite an active wishlist filter', (await state()).library.appCount === 3 && appIds(await state()).join() === String(expected.lowId));
  await rule('wishlist', 'has');
  await set({ q: 'Portal 2' });
  check('Title and library filters apply together', (await state()).matching === 0);
  await set({ q: '' });
  for (const value of ['not json', {}, { rgOwnedApps: [] }, { rgOwnedApps: ['440'] }]) {
    await select(value);
    await page.waitForFunction(() => !document.getElementById('library-error').hidden);
    check('Invalid import preserves the previous library: ' + JSON.stringify(value), (await state()).library.active && (await state()).matching === 2);
  }
  await select(' '.repeat(16 * 1024 * 1024 + 1));
  await page.waitForFunction(() => document.getElementById('library-error').textContent.includes('too large'));
  check('Oversized files are rejected without changing the current filter', (await state()).matching === 2);
  const saved = await page.evaluate(() => localStorage.getItem('steam-feature-atlas.user-library.v1'));
  const preferences = JSON.parse(await page.evaluate(() => localStorage.getItem('steam-feature-atlas.user-library-filters.v1')));
  check('Persistence keeps only app IDs, with choices stored separately',
    Object.keys(JSON.parse(saved)).sort().join() === 'appIds,version,wishlistIds' && !saved.includes('CANARY') && !saved.includes('rgWishlist') &&
    Object.keys(preferences).sort().join() === 'owned,version,wishlist');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedLibraryLink = text; } } }));
  const filterTop = await page.locator('#filters').evaluate(node => node.getBoundingClientRect().top);
  await page.locator('#share').click();
  const shared = await page.evaluate(() => window.copiedLibraryLink);
  check('Copied links retain ordinary filters and omit all library data',
    new URL(shared).searchParams.get('minReviews') === '0' && !/library|440|987654321|CANARY/i.test(shared));
  check('An active library adds a warning icon and explanatory tooltip to Copy link',
    await page.locator('#share-library-warning').isVisible() && /User Library.*not included/.test(await page.locator('#share').getAttribute('title')));
  check('Copy confirmation does not move the page',
    await page.locator('#share-status').evaluate(node => node.classList.contains('sr-only')) &&
    await page.locator('#filters').evaluate(node => node.getBoundingClientRect().top) === filterTop);
  const other = await page.context().browser().newContext();
  try {
    const recipient = await other.newPage(); await recipient.goto(shared);
    await recipient.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.getElementById('results').hasAttribute('aria-busy'));
    const recipientView = await recipient.evaluate(() => window.steamFeatureAtlas.getView());
    check('A link recipient sees ordinary filters without inheriting a private library', !recipientView.library.loaded && recipientView.matching > 2 && recipientView.filters.minReviews === 0);
  } finally { await other.close(); }
  await page.reload(); await settled();
  check('Reload restores the library locally', (await state()).library.active && (await state()).matching === 2);
  await page.getByRole('button', { name: 'Remove required owned games filter', exact: true }).click(); await settled();
  check('The removable chip disables filtering while retaining the imported IDs', !(await state()).library.active && (await state()).library.loaded && (await state()).matching > 2);
  check('The share warning disappears when library filtering is disabled', await page.locator('#share-library-warning').isHidden());
  await openLibrary();
  await rule('owned', 'has');
  await page.locator('#reset').click(); await settled();
  check('Reset filters disables the local restriction without erasing the library', !(await state()).library.active && (await state()).library.loaded);
  await page.waitForFunction(() => window.steamFeatureAtlas.getLoadState().creditsStatus === 'ready');
  await page.evaluate(() => {
    const text = File.prototype.text;
    File.prototype.text = async function () {
      if (this.name === 'slow.json') await new Promise(resolve => setTimeout(resolve, 1000));
      return text.call(this);
    };
  });
  await page.locator('#library-file').setInputFiles({ name: 'slow.json', mimeType: 'application/json', buffer: Buffer.from('{"rgOwnedApps":[440]}') });
  await select({ rgOwnedApps: [620] });
  await page.waitForFunction(() => window.steamFeatureAtlas.getView().games.length === 1 && window.steamFeatureAtlas.getView().games[0].id === 620);
  await page.waitForTimeout(1100);
  check('A slower earlier file cannot replace the newest import', appIds(await state()).join() === '620');
  await page.context().setOffline(true);
  const requestsBefore = requests.length;
  await select({ rgOwnedApps: [620] }); await page.waitForFunction(() => window.steamFeatureAtlas.getView().library.active); await settled();
  check('File import and filtering work offline without network requests', appIds(await state()).join() === '620' && requests.length === requestsBefore);
  await page.context().setOffline(false);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    check('The library panel fits a ' + width + 'px viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (screenshotDirectory) await page.screenshot({ path: screenshotDirectory + '/' + width + '.png' });
  }
  await page.locator('#library-forget').click(); await settled();
  check('Forget removes the saved IDs and restores unrestricted results', !(await state()).library.loaded && (await state()).matching > 2 &&
    await page.evaluate(() => localStorage.getItem('steam-feature-atlas.user-library.v1')) === null);
  await page.reload(); await settled();
  check('Forgotten data stays absent after reload', !(await state()).library.loaded);
  await openLibrary();
  await select({ rgOwnedApps: [620], rgWishlist: [570] });
  await page.waitForFunction(() => window.steamFeatureAtlas.getView().library.active); await settled();
  const companion = await page.context().newPage(), stale = await page.context().newPage();
  try {
    await stale.addInitScript(() => window.addEventListener('storage', e => { if (window.delayLibraryStorageEvents) e.stopImmediatePropagation(); }));
    for (const tab of [companion, stale]) {
      await tab.goto(baseURL);
      await tab.waitForFunction(() => window.steamFeatureAtlas?.getView().library.loaded && !document.getElementById('results').hasAttribute('aria-busy'));
      await openLibrary(tab);
    }
    // A delayed event simulates an open tab that has not observed Forget yet.
    await stale.evaluate(() => { window.delayLibraryStorageEvents = true; });
    await companion.evaluate(() => {
      const text = File.prototype.text;
      File.prototype.text = async function () { await new Promise(resolve => setTimeout(resolve, 1000)); return text.call(this); };
    });
    await companion.locator('#library-file').setInputFiles({ name: 'pending.json', mimeType: 'application/json', buffer: Buffer.from('{"rgOwnedApps":[440]}') });
    await page.locator('#library-forget').click(); await settled();
    await companion.waitForFunction(() => !window.steamFeatureAtlas.getView().library.loaded && !document.getElementById('results').hasAttribute('aria-busy'));
    check('Forget clears another open tab and its active rules', await companion.locator('#library-owned-has').isDisabled() &&
      !(await companion.evaluate(() => window.steamFeatureAtlas.getView())).library.active);
    if (!(await stale.evaluate(() => window.steamFeatureAtlas.getView())).library.loaded) throw new Error('The regression tab must retain its stale in-memory copy');
    await stale.locator('#library-owned-has').click();
    await stale.locator('#reset').click();
    check('A stale tab cannot restore forgotten IDs by changing or resetting filters', await stale.evaluate(() => localStorage.getItem('steam-feature-atlas.user-library.v1')) === null);
    await companion.waitForTimeout(1100);
    check('Forget cancels a file read pending in another tab', !(await companion.evaluate(() => window.steamFeatureAtlas.getView())).library.loaded &&
      await companion.evaluate(() => localStorage.getItem('steam-feature-atlas.user-library.v1')) === null);
  } finally { await companion.close(); await stale.close(); }
  await select({ rgOwnedApps: [], rgWishlist: [570] }); await page.waitForFunction(() => window.steamFeatureAtlas.getView().library.active); await settled();
  check('An account with only wishlist entries can use wishlist filtering', (await state()).library.filters.wishlist === 'has' && appIds(await state()).join() === '570');
  await page.locator('#library-forget').click(); await settled();
  check('Library import and filtering make no uploads or account requests', requests.every(request => new URL(request.url).origin === new URL(baseURL).origin && request.method === 'GET' && request.body === null && !request.url.includes('CANARY')));
  check('No browser script errors', errors.length === 0);
  return { checks, errors };
})
