async (page, options = {}) => {
  const base = String(options.baseURL ?? 'http://127.0.0.1:4178/').replace(/\/+$/, '') + '/';
  const checks = [], errors = [], layouts = [];
  const check = (name, value) => { if (!value) throw new Error(name); checks.push(name); };
  const view = () => page.evaluate(() => window.steamFeatureAtlas.getView());
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.querySelector('#results').hidden && !document.querySelector('#results').hasAttribute('aria-busy'));
  const choose = async name => { await page.getByRole('button', { name, exact: true }).click(); await settled(); };
  const screenshot = async name => {
    if (options.screenshotDirectory) await page.screenshot({ path: String(options.screenshotDirectory).replace(/[\\/]+$/, '') + `/${name}.png`, fullPage: true });
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(base + '?minReviews=0&ea=1&release=all'); await settled();
  const initial = await view();
  const expected = await page.evaluate(async () => {
    const manifest = await fetch('./data/manifest.json').then(response => response.json());
    const catalog = await fetch('./data/' + manifest.current.catalog).then(response => response.json());
    const german = catalog.languages.find(language => language.key === 'german').id;
    const english = catalog.languages.find(language => language.key === 'english').id;
    const flags = (game, id) => {
      if (game.languageBits === undefined) return null;
      const bytes = atob(game.languageBits), bit = id * 3, byte = bit >> 3, shift = bit & 7;
      return ((bytes.charCodeAt(byte) | ((bytes.charCodeAt(byte + 1) || 0) << 8)) >> shift) & 7;
    };
    const games = catalog.games.map(game => ({ german: flags(game, german), english: flags(game, english) }));
    return { languages: catalog.languages.length, germanInterface: games.filter(game => (game.german & 1) !== 0).length,
      germanAll: games.filter(game => game.german === 7).length,
      germanText: games.filter(game => (game.german & 5) === 5).length,
      germanTextNoAudio: games.filter(game => game.german === 5).length,
      mixed: games.filter(game => game.german === 5 && (game.english & 4) !== 0).length };
  });
  await page.locator('#language-toggle').click();
  check('Languages have a dedicated searchable filter panel', await page.locator('#language-picker').isVisible() && await page.locator('#language-search').isVisible());
  check('Each language has a card with six accessible require/exclude buttons', await page.locator('.language-card').count() === expected.languages && await page.locator('.language-card[data-language="german"] button').count() === 6);
  check('Regional language variants have distinct cards', await page.locator('[data-language="brazilian"] h3').innerText() === 'Portuguese (Brazil)' && await page.locator('[data-language="portuguese"] h3').innerText() === 'Portuguese (Portugal)' && await page.locator('[data-language="latam"]').count() === 1);
  await screenshot('languages-desktop');
  await page.locator('#language-search').fill('German');
  check('Search finds languages without changing results', await page.locator('.language-card:visible').count() === 1 && (await view()).matching === initial.matching);
  await choose('Require German interface');
  check('Interface requirement filters the whole catalogue', (await view()).matching === expected.germanInterface);
  await choose('Exclude German audio');
  await choose('Require German subtitles');
  check('Mixed categories combine with AND', (await view()).matching === expected.germanTextNoAudio);
  check('Language rules produce chips, a count and stable URL keys', await page.locator('.language-chip').count() === 3 && await page.locator('#active-language-count').innerText() === '3' && new URL(page.url()).searchParams.get('notLang') === 'german:audio');
  check('Language selections leave table columns and score limits unchanged', (await view()).featureColumns === initial.featureColumns && (await view()).maxScore === initial.maxScore);
  check('Selected controls expose their pressed state', await page.getByRole('button', { name: 'Exclude German audio', exact: true }).getAttribute('aria-pressed') === 'true');
  await screenshot('languages-mixed-rules');
  await choose('Require German audio');
  check('Requiring a category replaces its exclusion', (await view()).matching === expected.germanAll && !(await view()).filters.notLanguages.includes('german:audio'));
  await choose('Require German audio');
  check('Clicking a selected choice returns that category to Ignore', (await view()).matching === expected.germanText && !(await view()).filters.hasLanguages.includes('german:audio'));
  await choose('Exclude German audio');
  await page.locator('#language-search').fill('English'); await choose('Require English subtitles');
  check('Requirements can combine different languages', (await view()).matching === expected.mixed);
  const sharedURL = page.url();
  await page.locator('.language-chip[data-language-rule="german:audio"]').click(); await settled();
  check('Removing one chip preserves other language constraints', (await view()).filters.hasLanguages.length === 3 && (await view()).filters.notLanguages.length === 0);
  await page.goBack(); await settled();
  check('Back restores language filters and results', page.url() === sharedURL && (await view()).matching === expected.mixed);
  await page.reload(); await settled(); await page.locator('#language-toggle').click();
  check('Reload restores chips and card selection', await page.locator('.language-chip').count() === 4 && await page.getByRole('button', { name: 'Exclude German audio', exact: true }).getAttribute('aria-pressed') === 'true');
  await page.locator('#compatibility-toggle').click();
  check('Switching tabs hides language cards and their search', await page.locator('#language-picker').isHidden() && await page.locator('#language-search-control').isHidden());
  await page.locator('#language-toggle').click();
  await page.locator('#reset').click(); await settled();
  check('Reset clears every language rule and URL parameter', (await view()).filters.hasLanguages.length === 0 && (await view()).filters.notLanguages.length === 0 && await page.locator('.language-chip').count() === 0 && !new URL(page.url()).search);
  await page.locator('#language-search').fill('no-such-language');
  check('Unmatched search shows an empty state', await page.locator('#language-empty').isVisible() && await page.locator('.language-card:visible').count() === 0);
  await page.locator('#language-search').fill('German');
  const keyboard = page.getByRole('button', { name: 'Require German audio', exact: true });
  await keyboard.focus(); await page.keyboard.press('Space'); await settled();
  check('Keyboard selection preserves button focus', await keyboard.getAttribute('aria-pressed') === 'true' && await keyboard.evaluate(node => node === document.activeElement));
  await page.keyboard.press('Space'); await settled();
  await page.locator('#language-search').fill('');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1100 });
    const layout = await page.evaluate(() => ({ width: innerWidth, outer: document.documentElement.scrollWidth,
      panel: document.querySelector('#language-options').clientWidth, content: document.querySelector('#language-options').scrollWidth,
      cardCount: document.querySelectorAll('.language-card').length }));
    layouts.push(layout);
    check(`${width}px language cards fit without horizontal overflow`, layout.outer <= width && layout.content <= layout.panel + 1);
    if ([390, 1440].includes(width)) await screenshot(`languages-${width}`);
  }
  await page.goto(base + '?notLang=does-not-exist:audio');
  await page.waitForFunction(() => !document.querySelector('#error').hidden);
  check('Invalid shared language filters show an error rather than broadening results', /Unknown language filter/.test(await page.locator('#error-message').innerText()));
  check('No browser runtime errors', errors.length === 0);
  return { passed: checks.length, checks, errors, layouts, expected };
}
