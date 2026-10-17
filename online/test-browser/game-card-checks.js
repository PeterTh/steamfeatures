async (page, options = {}) => {
  const base = String(options.baseURL ?? 'http://127.0.0.1:4178/').replace(/\/+$/, '') + '/';
  const checks = [], errors = [], requests = [];
  const check = (name, value) => { if (!value) throw new Error(name); checks.push(name); };
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.getElementById('results').hidden && !document.getElementById('results').hasAttribute('aria-busy'));
  const card = page.locator('#tooltip'), portal = page.locator('tr[data-game-id="620"] .game-name');
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/game-images\.[a-f0-9]{16}\/|steamstatic\.com/.test(request.url())) requests.push(request.url()); });
  const manifest = await (await page.request.get(base + 'data/manifest.json')).json();
  const remainderPattern = base + 'data/' + manifest.current.progressive.remainder.file + '*';
  let releaseCatalog;
  const catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
  await page.route(remainderPattern, async route => { await catalogGate; await route.continue(); });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.mouse.move(0, 0); await page.goto(base); await settled();
  check('Initial loading fetches neither artwork lookups nor images', requests.length === 0);
  check('The old information button is absent', await page.locator('.info-button').count() === 0);
  for (const [service, url] of [['steam', 'https://store.steampowered.com/app/620/'], ['steamdb', 'https://steamdb.info/app/620/'], ['steamograph', 'https://steamograph.com/games/620']]) {
    const item = page.locator(`tr[data-game-id="620"] [data-service="${service}"]`);
    check(`${service} row icon links directly to its page`, await item.getAttribute('href') === url && await item.getAttribute('target') === '_blank');
  }
  const originalURL = page.url();
  await portal.hover(); await card.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#tooltip .game-card-header img')?.naturalWidth > 0);
  check('Hover immediately requests a lookup and Steam artwork', requests.some(url => /game-images\./.test(url)) && requests.some(url => /steamstatic\.com/.test(url)));
  await card.locator('img').evaluate(image => { image.dataset.retained = 'yes'; });
  const requestCount = requests.length;
  await portal.click();
  check('Clicking a title pins its card without navigation or rebuilding its image', page.url() === originalURL && await card.evaluate(node => node.classList.contains('pinned') && document.activeElement === node) && await card.locator('img').getAttribute('data-retained') === 'yes' && requests.length === requestCount);
  releaseCatalog();
  await page.waitForFunction(() => window.steamFeatureAtlas.getLoadState().fullReady && !document.getElementById('results').hasAttribute('aria-busy'));
  check('A locked card survives the atomic background catalog handover', await card.isVisible() && await card.evaluate(node => node.classList.contains('pinned')) && await card.locator('img').getAttribute('data-retained') === 'yes');
  await page.unroute(remainderPattern);
  check('Three bold text links follow the statistics', await card.locator('dl + .tip-game-links').innerText() === 'Steam page · SteamDB · Steamograph' && await card.locator('.tip-game-links a').evaluateAll(links => links.length === 3 && links.every(link => getComputedStyle(link).fontWeight === '700')));
  check('The static genre line is removed while clickable tags remain', await card.locator('.tip-fine').allTextContents().then(lines => lines.every(line => line.startsWith('Steam app ') || line.startsWith('Steam metadata unavailable'))) && await card.locator('.tip-tag').count() > 0);
  const before = await card.boundingBox();
  await page.locator('#matrix-region').evaluate(node => { node.scrollTop = 120; });
  await page.locator('tr[data-game-id="550"] .game-name').hover();
  check('A locked card survives scrolling and hovering another game', await card.isVisible() && await card.locator('h3').innerText() === 'Portal 2' && Math.abs((await card.boundingBox()).y - before.y) < 1);
  await page.keyboard.press('Escape');
  check('Escape closes the card and restores title-button focus', await card.isHidden() && await portal.evaluate(node => node === document.activeElement));

  await portal.focus(); await page.keyboard.press('Enter');
  check('Keyboard activation locks the card', await card.evaluate(node => node.classList.contains('pinned')));
  await page.locator('tr[data-game-id="550"] .game-name').click();
  check('Clicking another title replaces the locked card', await card.locator('h3').innerText() === 'Left 4 Dead 2' && await card.evaluate(node => node.classList.contains('pinned')));
  await page.locator('tr[data-game-id="550"] .game-name').click();
  check('Clicking the same title again closes its card', await card.isHidden());

  await page.setViewportSize({ width: 390, height: 844 });
  await portal.click();
  check('A mobile card stays inside the viewport', await card.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 11 && rect.right <= innerWidth - 11 && rect.top >= 11 && rect.bottom <= innerHeight - 11 && node.scrollWidth <= node.clientWidth; }));
  await page.setViewportSize({ width: 320, height: 760 });
  check('A locked card reclamps on resize without closing', await card.isVisible() && await card.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 11 && rect.right <= innerWidth - 11 && rect.bottom <= innerHeight - 11 && node.scrollWidth <= node.clientWidth; }));
  if (options.screenshotDirectory) await page.screenshot({ path: options.screenshotDirectory + '/game-card-mobile.png' });
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1050 });

  // Hold Portal's lookup while another preview opens; a late response must not
  // attach Portal's artwork to the newer card.
  const portalLookup = requests.find(url => /game-images\./.test(url));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(portalLookup, async route => { await gate; await route.continue(); });
  await page.goto(base); await settled();
  const pending = page.waitForRequest(portalLookup); await portal.hover(); await pending;
  await page.locator('tr[data-game-id="550"] .game-name').hover();
  const finished = page.waitForResponse(portalLookup); release(); await finished;
  await page.waitForFunction(() => document.querySelector('#tooltip img')?.src.includes('/550/'));
  check('A late lookup cannot replace a different game card image', await card.locator('h3').innerText() === 'Left 4 Dead 2');
  await page.unroute(portalLookup);

  const failed = [];
  await page.route('https://shared.akamai.steamstatic.com/**', route => { failed.push(route.request().url()); return route.fulfill({ status: 404, body: '' }); });
  await page.goto(base); await settled(); await portal.click();
  await page.waitForFunction(() => document.getElementById('tooltip').classList.contains('no-header'));
  check('Missing artwork tries the default header once and leaves card contents usable', failed.length === 2 && failed.at(-1).endsWith('/620/header.jpg') && await card.locator('h3').innerText() === 'Portal 2' && await card.locator('.tip-game-links a').count() === 3);
  await page.unroute('https://shared.akamai.steamstatic.com/**');
  await page.keyboard.press('Escape');
  await portal.click();
  await page.waitForFunction(() => document.querySelector('#tooltip img')?.naturalWidth > 0);
  if (options.screenshotDirectory) await page.screenshot({ path: options.screenshotDirectory + '/game-card-desktop.png' });
  check('No browser runtime errors', errors.length === 0);
  return { passed: checks.length, checks, errors };
}
