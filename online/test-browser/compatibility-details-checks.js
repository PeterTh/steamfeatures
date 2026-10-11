async (page, options = {}) => {
  const base = String(options.baseURL ?? 'http://127.0.0.1:4178/').replace(/\/+$/, '') + '/';
  const checks = [], errors = [];
  const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.querySelector('#results').hidden && !document.querySelector('#results').hasAttribute('aria-busy'));
  const screenshot = async name => {
    if (options.screenshotDirectory) await page.screenshot({ path: String(options.screenshotDirectory).replace(/[\\/]+$/, '') + `/${name}.png`, fullPage: true });
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '?hw=1'); await settled();
  const examples = await page.evaluate(async () => {
    const manifest = await fetch('./data/manifest.json').then(response => response.json());
    const { decodeBinaryCatalog } = await import('./catalog-binary.mjs');
    const catalog = decodeBinaryCatalog(await fetch('./data/' + manifest.current.binary.file).then(response => response.arrayBuffer()));
    return Object.fromEntries([620, 219150, 1240440, 578080].map(id => [id, catalog.games.find(game => game.id === id)]));
  });
  check('Real examples include verified, playable and unsupported games', examples[620]?.featureIds.includes(10013) && examples[1240440]?.featureIds.includes(10012) && examples[578080]?.featureIds.includes(10011));
  const openGame = async (id, target = 'steam-deck') => {
    await page.goto(base + '?q=' + encodeURIComponent(examples[id].name) + '&hw=1&minReviews=0&release=all&ea=1&highlight=' + target); await settled();
    return page.locator(`tr[data-game-id="${id}"] button[data-compatibility="${{ 'steam-deck': 10019, 'steam-machine': 10029, 'steam-frame': 10039, 'steam-os': 10049 }[target]}"]`);
  };
  const dialog = page.getByRole('dialog', { name: /compatibility$/ });
  const close = page.getByRole('button', { name: 'Close compatibility details' });
  let trigger = await openGame(620);
  const original = await page.evaluate(() => ({ url: location.href, view: window.steamFeatureAtlas.getView() }));
  await trigger.focus(); await page.keyboard.press('Enter');
  check('Enter opens a labelled modal with the selected game and rating', await dialog.isVisible() && await page.locator('#compatibility-title').innerText() === 'Steam Deck compatibility' && await page.locator('.compatibility-game').innerText() === examples[620].name && (await page.locator('.compatibility-rating').innerText()).includes('Verified'));
  check('Verified review displays its four passed checks', await page.locator('.compatibility-section.pass li').count() === 4 && await page.locator('.compatibility-section.warning').count() === 0);
  check('Opening the dialog focuses Close and hides the tooltip', await close.evaluate(node => node === document.activeElement) && await page.locator('#tooltip').isHidden());
  await page.keyboard.press('Shift+Tab');
  check('Keyboard focus stays inside the modal', await dialog.evaluate(node => node.contains(document.activeElement)));
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  check('Escape restores focus to the rating', await trigger.evaluate(node => node === document.activeElement));
  check('Viewing details does not change filters, scores, rows or the URL', await page.evaluate(before => location.href === before.url && JSON.stringify(window.steamFeatureAtlas.getView()) === JSON.stringify(before.view), original));
  await page.keyboard.press('Space');
  check('Space also opens the rating', await dialog.isVisible());
  await close.click(); await dialog.waitFor({ state: 'hidden' });
  check('Close restores focus to the rating', await trigger.evaluate(node => node === document.activeElement));
  for (const [target, name, count] of [['steam-machine', 'Steam Machine', 3], ['steam-frame', 'Steam Frame standalone', 5], ['steam-os', 'SteamOS', 1]]) {
    trigger = await openGame(620, target); await trigger.click();
    check(`${name} shows only its own review`, (await page.locator('#compatibility-title').innerText()).endsWith(name + ' compatibility') && await page.locator('.compatibility-notes li').count() === count);
    if (target === 'steam-os') check('SteamOS uses Supported and its startup check', (await page.locator('.compatibility-rating').innerText()).includes('Supported') && (await page.locator('#compatibility-content').innerText()).includes('The game starts successfully.'));
    await close.click();
  }
  trigger = await openGame(219150); await trigger.click();
  check('Equivalent controller notes are shown once', await page.locator('.compatibility-notes li').filter({ hasText: 'External controllers are not supported for the primary player.' }).count() === 1);
  await close.click();
  check('Untested ratings remain plain question marks', await page.locator('tr[data-game-id="219150"] td[data-feature="10039"]').getAttribute('data-status') === 'untested' && await page.locator('tr[data-game-id="219150"] td[data-feature="10039"] button').count() === 0);
  trigger = await openGame(578080); await trigger.click();
  check('Unsupported ratings open their compatibility reason', await page.locator('.compatibility-rating .negative').innerText() === '−' && /anti-cheat/i.test(await page.locator('#compatibility-content').innerText()));
  await page.mouse.click(2, 2); await dialog.waitFor({ state: 'hidden' });
  check('Clicking the backdrop closes the dialog and returns focus', await trigger.evaluate(node => node === document.activeElement));
  trigger = await openGame(1240440); await trigger.click();
  check('Playable uses its yellow rating and shows limitations before passed checks', await page.locator('.compatibility-rating .playable').innerText() === '✓' && await page.locator('.compatibility-section').first().locator('h4').innerText() === 'Things to know' && await page.locator('.compatibility-section.pass li').count() > 0);
  check('Dialog descriptions contain no raw report tokens or collection terminology', !/TestResult|configuration flag|appinfo|lookup|provenance|SteamOSDoes/.test(await page.locator('#compatibility-content').innerText()));
  await screenshot('compatibility-details-desktop');
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: width === 320 ? 480 : 640 });
    const layout = await dialog.evaluate(node => {
      const rect = node.getBoundingClientRect(), content = document.querySelector('#compatibility-content');
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight,
        contentWidth: content.clientWidth, scrollWidth: content.scrollWidth, scrollable: content.scrollHeight > content.clientHeight };
    });
    check(`${width}px dialog fits the viewport and wraps its notes`, layout.left >= 0 && layout.right <= layout.width && layout.top >= 0 && layout.bottom <= layout.height && layout.scrollWidth <= layout.contentWidth + 1);
    if (width === 320) {
      check('Long mobile details scroll inside the dialog', layout.scrollable);
      await page.locator('#compatibility-content').focus(); await page.keyboard.press('End');
      await page.waitForFunction(() => document.querySelector('#compatibility-content').scrollTop > 0);
      check('The close button stays visible while details scroll', await close.isVisible() && await close.evaluate(node => node.getBoundingClientRect().top >= 0));
      await page.locator('#compatibility-content').evaluate(node => { node.scrollTop = 0; });
    }
    if (width === 390) await screenshot('compatibility-details-mobile');
  }
  await close.click();
  const touchContext = await page.context().browser().newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  try {
    const touchPage = await touchContext.newPage();
    touchPage.on('pageerror', error => errors.push(error.message));
    await touchPage.goto(base + '?q=Portal+2&hw=1&highlight=steam-deck');
    await touchPage.waitForFunction(() => document.querySelector('tr[data-game-id="620"] button[data-compatibility="10019"]'));
    const touchTrigger = touchPage.locator('tr[data-game-id="620"] button[data-compatibility="10019"]');
    await touchTrigger.tap();
    check('Tapping a rating opens its dialog on a touch screen', await touchPage.locator('#compatibility-dialog').isVisible());
    await touchPage.getByRole('button', { name: 'Close compatibility details' }).tap();
    check('Tapping Close dismisses the dialog', await touchPage.locator('#compatibility-dialog').isHidden());
  } finally { await touchContext.close(); }
  check('No browser runtime errors', errors.length === 0);
  return { passed: checks.length, checks, errors };
}
