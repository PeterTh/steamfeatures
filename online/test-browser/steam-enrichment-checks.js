async (page, options = {}) => {
  const base = String(options.baseURL ?? 'http://127.0.0.1:4178/').replace(/\/+$/, '') + '/';
  const checks = [], errors = [], layouts = [];
  const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
  const view = () => page.evaluate(() => window.steamFeatureAtlas.getView());
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.querySelector('#results').hidden && !document.querySelector('#results').hasAttribute('aria-busy'));
  const screenshot = async name => {
    if (options.screenshotDirectory) await page.screenshot({ path: String(options.screenshotDirectory).replace(/[\\/]+$/, '') + `/${name}.png`, fullPage: true });
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto(base); await settled();
  const catalog = await page.evaluate(async () => {
    const manifest = await fetch('./data/manifest.json').then(response => response.json());
    const catalog = await fetch('./data/' + manifest.current.catalog).then(response => response.json());
    const { presentationFeatures, featureColumns, compatibilityTargets } = await import('./feature-presentation.mjs');
    const { runQuery } = await import('./query.mjs');
    const example = id => catalog.games.find(game => game.featureDataKnown && game.featureIds.includes(id));
    return { features: presentationFeatures(catalog.features), columns: featureColumns(catalog.features), targets: compatibilityTargets,
      defaultColumns: runQuery(catalog).columns.length,
      examples: Object.fromEntries([35, 46, 10000, 10001, 10010, 10011, 10012, 10013].map(id => [id, example(id)])),
      achievements: catalog.games.find(game => game.achievementCount > 0),
      ratingCounts: Object.fromEntries(compatibilityTargets.flatMap(target => target.ratings.map(rating => [rating.id, catalog.games.filter(game => game.featureIds.includes(rating.id)).length]))),
      deckVerifiedOsSupported: catalog.games.filter(game => game.featureIds.includes(10013) && game.featureIds.includes(10042)).length,
      noKeyboardExclusionCount: catalog.games.filter(game => game.knownFeatureGroups?.includes('keyboard-mouse') && !game.featureIds.includes(10000)).length };
  });
  check('Collected examples cover negative features, cloud flags and all Deck ratings', Object.values(catalog.examples).every(Boolean));
  const initial = await view();
  check('Hardware and Remote Play are opt-in by default', !initial.filters.includeHardware && !initial.filters.includeRemotePlay && initial.featureColumns === catalog.defaultColumns && await page.locator('#feature-10019,#feature-41').count() === 0);
  await page.locator('#remote-play').check(); await settled();
  const ordinaryIds = await page.locator('#matrix-head [data-tip="feature"]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.id)));
  check('Dynamic Cloud Sync follows Cloud saves', ordinaryIds[ordinaryIds.indexOf(23) + 1] === 10001);
  check('GeForce NOW is fourth in Remote Play and generic cloud streaming is hidden', ordinaryIds.slice(ordinaryIds.indexOf(41), ordinaryIds.indexOf(41) + 4).join(',') === '41,42,43,46' && !ordinaryIds.includes(45));
  await page.locator('#remote-play').uncheck(); await settled();
  await page.locator('#hardware').check(); await settled();
  check('Hardware toggle adds exactly four columns without filtering games', (await view()).featureColumns === catalog.defaultColumns + 4 && (await view()).matching === initial.matching);
  check('Each hardware target has one column and details have no columns', await page.locator('#matrix-head [data-tip="feature"]').evaluateAll((nodes, allowed) => nodes.every(node => allowed.includes(Number(node.dataset.id))), catalog.columns.map(column => column.id)));
  check('Hardware display state has a shared URL', new URL(page.url()).searchParams.get('hw') === '1');
  await page.reload(); await settled();
  check('Hardware display survives reload', (await view()).filters.includeHardware && await page.locator('#hardware').isChecked());
  await page.locator('#hardware').uncheck(); await settled(); await page.goBack(); await settled();
  check('Back restores the four hardware columns', (await view()).filters.includeHardware && await page.locator('#feature-10019').count() === 1);
  await page.locator('#feature-toggle').click();
  check('The ordinary feature selector contains no hardware ratings or details', await page.locator('#feature-options .feature-option').count() === catalog.features.filter(feature => !feature.hardware).length && await page.locator('#feature-options').innerText().then(text => !/Steam Deck|Steam Machine|Steam Frame|SteamOS/.test(text)));
  await page.locator('#compatibility-toggle').click();
  check('Compatibility has a dedicated panel with four labelled dropdowns', await page.locator('#feature-picker').isHidden() && await page.locator('#compatibility-picker').isVisible() && await page.locator('#compatibility-options select').count() === 4);
  for (const target of catalog.targets) {
    check(`${target.name} offers exactly its available ratings plus Ignore`, (await page.locator(`#compatibility-${target.key} option`).allTextContents()).join(',') === ['Ignore', ...target.ratings.map(rating => rating.label)].join(','));
    check(`${target.name} dropdown has an accessible label`, await page.getByRole('combobox', { name: target.name, exact: true }).count() === 1);
  }
  await page.goto(base + '?minReviews=0&ea=1&release=all'); await settled();
  await page.locator('#compatibility-toggle').click();
  await page.locator('#compatibility-steam-deck').selectOption('verified'); await settled();
  check('Compatibility filters match exact ratings while hardware columns are hidden', !(await view()).filters.includeHardware && (await view()).matching === catalog.ratingCounts[10013] && new URL(page.url()).searchParams.get('deck') === 'verified');
  await page.locator('#compatibility-steam-os').selectOption('supported'); await settled();
  check('Selected targets combine with AND and show two removable chips', (await view()).matching === catalog.deckVerifiedOsSupported && await page.locator('#active-compatibility-count').innerText() === '2' && await page.locator('.compatibility-chip').count() === 2);
  await page.locator('[data-compatibility-target="steam-deck"]').click(); await settled();
  check('Removing one compatibility chip preserves the other target', (await view()).filters.compatibility['steam-deck'] === 'ignore' && (await view()).matching === catalog.ratingCounts[10042] && await page.locator('#compatibility-steam-deck').inputValue() === 'ignore');
  await page.goBack(); await settled();
  check('Back restores dropdowns, chips and matching games', await page.locator('#compatibility-steam-deck').inputValue() === 'verified' && (await view()).matching === catalog.deckVerifiedOsSupported);
  await page.reload(); await settled(); await page.locator('#compatibility-toggle').click();
  check('Compatibility selections survive reload', await page.locator('#compatibility-steam-os').inputValue() === 'supported' && await page.locator('#compatibility-steam-deck').inputValue() === 'verified');
  await page.locator('#compatibility-steam-os').selectOption('ignore'); await settled();
  await page.locator('#compatibility-steam-deck').selectOption('untested'); await settled();
  check('Untested matches explicit ratings and excludes unavailable data', (await view()).matching === catalog.ratingCounts[10010]);
  await page.locator('#reset').click(); await settled();
  check('Reset clears all compatibility selections and their URL parameters', Object.values((await view()).filters.compatibility).every(value => value === 'ignore') && await page.locator('.compatibility-chip').count() === 0 && !new URL(page.url()).search);
  const openGame = async (game, extra = '') => {
    await page.goto(base + '?q=' + encodeURIComponent(game.name) + '&minReviews=0&ea=1&release=all' + extra); await settled();
    await page.waitForFunction(id => window.steamFeatureAtlas.getView().games.some(game => game.id === id), game.id);
  };
  for (const id of [35, 10000]) {
    const game = catalog.examples[id]; await openGame(game);
    const cell = page.locator(`tr[data-game-id="${game.id}"] td[data-feature="${id}"]`);
    check(`Negative feature ${id} uses a red minus badge`, await cell.locator('.check.negative').innerText() === '−' && await cell.locator('.check').evaluate(node => getComputedStyle(node).backgroundColor === 'rgb(75, 37, 46)'));
    const ordinary = catalog.features.filter(feature => !feature.hardware && !feature.accessibility && !feature.multiplayer && !feature.remotePlay);
    const score = ordinary.filter(feature => game.featureIds.includes(feature.id)).reduce((sum, feature) => sum + feature.weight, 0);
    check(`Negative feature ${id} retains its score penalty`, (await view()).games.find(row => row.id === game.id).score === score);
    await page.locator(`#feature-${id} button`).click();
    check(`Negative feature ${id} tooltip explains the penalty`, /−1 score point/.test(await page.locator('#tooltip').innerText()));
    await page.keyboard.press('Escape');
  }
  await screenshot('negative-feature');
  for (const [id, key] of [[46, 'geforce-now'], [10001, 'dynamic-cloud-sync']]) {
    const game = catalog.examples[id]; await openGame(game, '&has=' + key + (id === 46 ? '&rp=1' : ''));
    check(`${key} is independently filterable and listed`, (await view()).filters.has.includes(id) && await page.locator(`tr[data-game-id="${game.id}"] td[data-feature="${id}"]`).getAttribute('data-supported') === 'true');
  }
  await openGame(catalog.achievements);
  await page.locator(`tr[data-game-id="${catalog.achievements.id}"] .game-name`).click();
  check('Game details retain achievement counts', await page.locator('#tooltip').evaluate((tip, count) => [...tip.querySelectorAll('dt')].some(label => label.textContent === 'Achievements' && label.nextElementSibling?.textContent === count.toLocaleString('en-US')), catalog.achievements.achievementCount));
  await page.keyboard.press('Escape');
  await page.goto(base + '?not=no-keyboard-mouse&minReviews=0&ea=1&release=all'); await settled();
  check('Keyboard exclusion cannot admit games with unknown keyboard support', (await view()).matching === catalog.noKeyboardExclusionCount);
  for (const [id, rating, mark, color] of [[10010, 'untested', '?', null], [10011, 'unsupported', '−', 'rgb(75, 37, 46)'], [10012, 'playable', '✓', 'rgb(73, 62, 32)'], [10013, 'verified', '✓', null]]) {
    const game = catalog.examples[id]; await openGame(game, '&hw=1&deck=' + rating);
    const cell = page.locator(`tr[data-game-id="${game.id}"] td[data-feature="10019"]`);
    check(`The Deck column shows ${rating} with the correct symbol`, await cell.getAttribute('data-status') === rating && await cell.locator('[aria-hidden="true"]').innerText() === mark);
    if (color) check(`${rating} has its distinct badge color`, await cell.locator('.check').evaluate((node, expected) => getComputedStyle(node).backgroundColor === expected, color));
    const score = catalog.features.filter(feature => !feature.accessibility && !feature.multiplayer && !feature.remotePlay && game.featureIds.includes(feature.id)).reduce((sum, feature) => sum + feature.weight, 0);
    check(`${rating} scores only the overall hardware ratings`, (await view()).games.find(row => row.id === game.id).score === score);
  }
  await page.locator('#feature-10019 button').click();
  check('Hardware tooltip has a rating legend with no require/exclude actions', await page.locator('#tooltip .rating-option').count() === 4 && await page.locator('#tooltip .feature-action').count() === 0);
  await page.getByRole('button', { name: 'Filter by compatibility', exact: true }).last().click();
  check('Hardware tooltip opens compatibility and focuses its dropdown', await page.locator('#compatibility-picker').isVisible() && await page.locator('#compatibility-steam-deck').evaluate(node => node === document.activeElement));
  await page.locator('#compatibility-toggle').click();
  await page.locator('#feature-10019 button').click();
  await page.getByRole('button', { name: 'Highlight column', exact: true }).click();
  check('The combined Deck column can be highlighted and shared', (await view()).highlight === 'steam-deck' && new URL(page.url()).searchParams.get('highlight') === 'DCK');
  await page.keyboard.press('Escape');
  await page.goto(base + '?hw=1'); await settled();
  await page.waitForFunction(() => [...document.querySelectorAll('.feature-head .icon')].every(icon => icon instanceof SVGSVGElement && icon.getBBox().width > 0));
  check('All headings use rendered SVG column symbols', await page.locator('.feature-head .icon').evaluateAll(nodes => nodes.every(node => node.querySelector('use')?.getAttribute('href').startsWith('#column-'))));
  check('Hardware headings use four distinct icons', await page.locator('#feature-10019 .icon,#feature-10029 .icon,#feature-10039 .icon,#feature-10049 .icon').evaluateAll(nodes => nodes.length === 4 && new Set(nodes.map(node => node.outerHTML)).size === 4));
  await screenshot('hardware-desktop');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1050 });
    if (await page.locator('#filter-category').isVisible()) await page.locator('#filter-category').selectOption('compatibility');
    else await page.locator('#compatibility-toggle').click();
    const layout = await page.evaluate(() => ({ width: innerWidth, outer: document.documentElement.scrollWidth,
      picker: document.querySelector('#compatibility-options').scrollWidth, pickerClient: document.querySelector('#compatibility-options').clientWidth,
      selectsFit: [...document.querySelectorAll('#compatibility-options select')].every(select => select.getBoundingClientRect().right <= innerWidth),
      table: document.querySelector('#matrix-region').scrollWidth, tableClient: document.querySelector('#matrix-region').clientWidth }));
    layouts.push(layout);
    check(`${width}px compatibility dropdowns fit without page overflow`, layout.outer <= width && layout.picker <= layout.pickerClient + 1 && layout.selectsFit);
    if (width < 768) check(`${width}px matrix retains horizontal scrolling`, layout.table > layout.tableClient);
    if ([390, 1440].includes(width)) await screenshot(`compatibility-${width}`);
    if (await page.locator('#filter-category').isVisible()) await page.locator('#compatibility-picker .picker-close').click();
    else await page.locator('#compatibility-toggle').click();
    if (width === 390) await screenshot('hardware-mobile');
  }
  check('No browser runtime errors', errors.length === 0);
  return { passed: checks.length, checks, errors, layouts, columns: catalog.columns.length };
}
