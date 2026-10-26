(async (page, { baseURL = 'http://127.0.0.1:4179/', screenshotDirectory } = {}) => {
  const checks = [], errors = [], layouts = [];
  const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
  const view = () => page.evaluate(() => window.steamFeatureAtlas.getView());
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.querySelector('#results').hasAttribute('aria-busy'));
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  const choose = kind => page.locator('#filter-category').selectOption(kind);
  const reset = async () => { await page.locator('#reset').click(); await settled(); };
  const screenshot = async name => { if (screenshotDirectory) await page.screenshot({ path: screenshotDirectory + '/' + name + '.png', fullPage: true }); };
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(baseURL); await settled();
  await page.evaluate(() => document.fonts.ready);
  const baseline = await view(), initialURL = page.url();
  check('Desktop keeps direct header actions and counting controls', await page.locator('#news').isVisible() && await page.locator('#multiplayer').isVisible() && await page.locator('#filter-category').isHidden());
  check('Desktop fields use accessible names and inline labels', await page.getByRole('searchbox', { name: 'Game title', exact: true }).count() === 1 && await page.getByRole('combobox', { name: 'Release status', exact: true }).count() === 1 && await page.locator('.release-control').innerText() !== 'Release status');
  for (const width of [320, 390, 500, 768, 800, 801, 1100, 1101, 1440, 3440]) {
    await page.setViewportSize({ width, height: 1000 }); await frames();
    const layout = await page.evaluate(() => {
      const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width }; };
      return { width: innerWidth, clientWidth: document.documentElement.clientWidth, pageWidth: document.documentElement.scrollWidth,
        table: box('#matrix-region'), title: box('.game-name'), header: box('.masthead') };
    });
    layouts.push(layout);
    check(width + 'px has no page-level horizontal overflow', layout.pageWidth <= layout.clientWidth + 1);
    check(width + 'px exposes the appropriate controls', width <= 800
      ? await page.locator('#menu-toggle').isVisible() && await page.locator('#news').isHidden() && await page.locator('#feature-toggle').isHidden() && await page.locator('#count-options').isHidden() && await page.locator('#filter-category').isVisible()
      : await page.locator('#menu-toggle').isHidden() && await page.locator('#news').isVisible() && await page.locator('#feature-toggle').isVisible() && await page.locator('#count-options').isVisible());
    check(width + 'px uses the appropriate summary and legend', width <= 1100
      ? await page.locator('#result-metrics').isHidden() && await page.locator('#legend-toggle').isVisible() && await page.locator('#legend-body').isHidden()
      : await page.locator('#result-metrics').isVisible() && await page.locator('#legend-toggle').isHidden() && await page.locator('#legend-body').isVisible());
    check(width + 'px shows row links only when space permits', await page.locator('.game-links').first().isVisible() === (width > 800));
    if (width <= 800) {
      check(width + 'px matrix reaches both viewport edges', Math.abs(layout.table.left) <= 1 && Math.abs(layout.table.right - layout.clientWidth) <= 1);
      check(width + 'px keeps Status and Sort on one row', await page.evaluate(() =>
        Math.abs(document.querySelector('#release').getBoundingClientRect().top - document.querySelector('#sort').getBoundingClientRect().top) <= 1));
    }
    if (width === 320) check('The default 320px table starts above 400px', layout.table.top <= 400);
    if (width === 390) check('The 390px layout recovers height and title space', layout.table.top <= 340 && layout.title.width >= 105);
    if ([320, 390, 1440].includes(width)) await screenshot('responsive-' + width);
  }
  check('Resizing changes neither filters nor the shared URL', JSON.stringify((await view()).filters) === JSON.stringify(baseline.filters) && page.url() === initialURL);
  await page.setViewportSize({ width: 390, height: 844 }); await frames();
  const top = await page.locator('#matrix-region').evaluate(node => node.getBoundingClientRect().top);
  await page.locator('#menu-toggle').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
  check('Keyboard users can open the menu and reach its first action', await page.locator('#menu-toggle').getAttribute('aria-expanded') === 'true' && await page.locator('#presets button').first().evaluate(node => node === document.activeElement));
  check('All five secondary actions fit inside the compact menu', await page.locator('#header-menu button:visible').count() === 5 && await page.locator('#header-menu').evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth; }));
  await page.keyboard.press('Escape');
  check('Escape closes the menu and restores its trigger focus', await page.locator('#news').isHidden() && await page.locator('#menu-toggle').evaluate(node => node === document.activeElement));
  for (const id of ['news', 'about']) {
    await page.locator('#menu-toggle').click(); await page.locator('#' + id).click();
    check(id + ' opens its existing dialog and closes the menu', await page.locator('#' + id + '-dialog').isVisible() && await page.locator('#header-menu').isHidden());
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.id === 'menu-toggle');
    check(id + ' restores menu-trigger focus after dismissal', await page.locator('#' + id + '-dialog').isHidden());
  }
  await page.locator('#menu-toggle').click(); await page.locator('[data-preset="missing-cloud"]').click(); await settled();
  check('Compact presets apply their existing query and dismiss the menu', await page.locator('[data-preset="missing-cloud"]').getAttribute('aria-pressed') === 'true' && await page.locator('#header-menu').isHidden());
  await reset();
  for (const kind of ['feature', 'tag', 'review', 'date', 'compatibility', 'language', 'developer', 'library']) {
    await choose(kind); await frames();
    check(kind + ' opens exactly one editor without changing filters', await page.locator('.picker-panel:visible').count() === 1 && await page.locator('#' + kind + '-picker').isVisible() && JSON.stringify((await view()).filters) === JSON.stringify(baseline.filters));
  }
  await page.locator('#library-picker .picker-close').click();
  check('Closing an editor returns focus to the selector', await page.locator('.picker-panel:visible').count() === 0 && await page.locator('#filter-category').inputValue() === '' && await page.locator('#filter-category').evaluate(node => node === document.activeElement));
  await choose('feature'); await page.locator('#feature-search').fill('Cloud'); await page.locator('#feature-search').focus();
  await page.setViewportSize({ width: 1440, height: 1000 }); await frames();
  check('An open editor and its focused search survive widening', await page.locator('#feature-picker').isVisible() && await page.locator('#feature-search').inputValue() === 'Cloud' && await page.locator('#feature-search').evaluate(node => node === document.activeElement));
  await page.setViewportSize({ width: 390, height: 844 }); await frames();
  check('Narrowing restores the selected category and same search control', await page.locator('#filter-category').inputValue() === 'feature' && await page.locator('#feature-search').inputValue() === 'Cloud' && await page.locator('#feature-search').evaluate(node => node === document.activeElement));
  await page.locator('#feature-search').fill('');
  await page.locator('#feature-options .feature-action[data-action="has"]').first().click(); await settled();
  check('Mobile feature choices update counts and chips', (await view()).filters.has.length === 1 && await page.locator('#filter-category option[value="feature"]').textContent() === 'Features (1)' && await page.locator('#active-filters .filter-chip').count() === 2);
  await page.locator('#feature-picker .picker-close').click();
  check('Closing the editor retains its active rules', (await view()).filters.has.length === 1);
  await reset(); await choose('date'); await page.locator('#release-from').fill('2024-0');
  const draftURL = page.url();
  await page.setViewportSize({ width: 1440, height: 1000 }); await frames();
  await page.setViewportSize({ width: 390, height: 844 }); await frames();
  check('Resizing preserves incomplete date drafts without submitting them', await page.locator('#release-from').inputValue() === '2024-0' && (await view()).filters.releaseFrom === '' && page.url() === draftURL && await page.locator('#filter-category').inputValue() === 'date');
  await page.locator('#release-from').fill(''); await page.locator('#release-from').blur(); await reset();
  await choose('review'); await page.locator('#max-reviews').fill('-1'); await page.locator('#max-reviews').blur();
  await page.locator('#review-error').waitFor({ state: 'visible' });
  await page.locator('#review-picker .picker-close').click(); await page.locator('#count-toggle').click();
  await page.evaluate(() => document.querySelector('#max-reviews').reportValidity());
  check('Validation opens the correct editor and synchronizes the selector', await page.locator('#review-picker').isVisible() && await page.locator('#filter-category').inputValue() === 'review' && await page.locator('#count-options').isHidden() && (await view()).filters.maxReviews === null);
  await page.locator('#max-reviews').fill('100'); await page.locator('#max-reviews').blur(); await settled();
  check('Review bounds update the mobile active count', (await view()).filters.maxReviews === 100 && await page.locator('#filter-category option[value="review"]').textContent() === 'Reviews (2)');
  await reset(); await page.locator('#review-picker .picker-close').click();
  await page.locator('#count-toggle').click();
  check('Count opens its four existing controls in table order', await page.locator('#count-options').isVisible() && await page.locator('#count-options input').evaluateAll(nodes => nodes.map(node => node.id).join()) === 'multiplayer,hardware,remote-play,accessibility');
  for (const id of ['multiplayer', 'hardware', 'remote-play', 'accessibility']) { await page.locator('#' + id).check(); await settled(); }
  check('Optional counting remains independent of matching and is reflected in the disclosure', (await view()).matching === baseline.matching && (await view()).featureColumns > baseline.featureColumns && await page.locator('#count-active').textContent() === '4');
  await screenshot('count-open');
  await page.locator('#legend-toggle').click();
  check('The compact legend reflects enabled compatibility ratings', await page.locator('#legend-body').isVisible() && await page.locator('#legend-body').innerText().then(text => /Listed \/ Verified/.test(text) && /Playable/.test(text) && /Untested \/ Unknown/.test(text)));
  await screenshot('legend-open'); await page.keyboard.press('Escape');
  check('Escape closes the legend and restores focus', await page.locator('#legend-body').isHidden() && await page.locator('#legend-toggle').evaluate(node => node === document.activeElement));
  await page.locator('#legend-toggle').click(); await page.locator('#search').click();
  check('Clicking outside dismisses the legend', await page.locator('#legend-body').isHidden());
  await choose('library');
  check('Opening an editor closes Count without resetting its choices', await page.locator('#count-options').isHidden() && await page.locator('#count-active').textContent() === '4');
  await page.locator('#library-file').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from('{"rgOwnedApps":[620],"rgWishlist":[570],"privateCanary":"DO-NOT-SHARE"}') });
  await page.waitForFunction(() => window.steamFeatureAtlas.getView().library.active); await settled();
  check('Library filtering updates the native category count', (await view()).matching === 1 && await page.locator('#filter-category option[value="library"]').textContent() === 'User Library (1)');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.responsiveCopiedURL = text; } } }));
  await page.locator('#menu-toggle').click();
  check('Copy link retains the library warning inside the compact menu', await page.locator('#share-library-warning').isVisible() && /User Library/.test(await page.locator('#share').getAttribute('title')));
  const beforeCopy = await page.locator('#matrix-region').evaluate(node => node.getBoundingClientRect().top);
  await page.locator('#share').click();
  await page.waitForFunction(() => !!window.responsiveCopiedURL);
  check('Copy feedback stays in the menu and omits library data without moving the page', await page.locator('#header-menu').isVisible() && await page.locator('#share-label').textContent() === 'Copied!' && !/library|620|570|DO-NOT-SHARE/i.test(await page.evaluate(() => window.responsiveCopiedURL)) && await page.locator('#matrix-region').evaluate(node => node.getBoundingClientRect().top) === beforeCopy);
  await screenshot('menu-open'); await page.locator('.brand').click();
  check('Clicking outside dismisses the menu', await page.locator('#header-menu').isHidden());
  await page.locator('#library-forget').click(); await settled(); await reset();
  await page.locator('#library-picker .picker-close').click();
  await page.mouse.move(0, 0); await page.keyboard.press('Escape');
  await page.locator('tr[data-game-id="620"] .game-name').tap();
  check('Phone title activation still opens all three service links on the card', await page.locator('#tooltip').isVisible() && await page.locator('#tooltip .tip-game-links a').allTextContents().then(text => text.join() === 'Steam page,SteamDB,Steamograph'));
  await page.keyboard.press('Escape');
  await page.locator('#menu-toggle').focus(); await page.setViewportSize({ width: 1440, height: 1000 }); await frames();
  check('Widening never leaves focus on the hidden menu button', await page.evaluate(() => document.activeElement.id !== 'menu-toggle' && document.activeElement.getClientRects().length > 0));
  await page.locator('#feature-toggle').focus(); await page.setViewportSize({ width: 390, height: 844 }); await frames();
  check('Narrowing moves focused desktop tabs to the visible selector', await page.locator('#filter-category').evaluate(node => node === document.activeElement));
  check('Compact overlays do not affect the default table position', Math.abs(await page.locator('#matrix-region').evaluate(node => node.getBoundingClientRect().top) - top) < 2);
  check('No browser script errors', errors.length === 0);
  return { checks, errors, layouts };
})
