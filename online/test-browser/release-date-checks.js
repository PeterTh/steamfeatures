async (page, options = {}) => {
  const base = String(options.baseURL ?? 'http://127.0.0.1:4178/').replace(/\/+$/, '') + '/';
  const checks = [], errors = [], layouts = [];
  const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
  const view = () => page.evaluate(() => window.steamFeatureAtlas.getView());
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.querySelector('#results').hidden && !document.querySelector('#results').hasAttribute('aria-busy'));
  const dates = (from, to) => page.waitForFunction(({from, to}) => {
    const current = window.steamFeatureAtlas.getView();
    return current.filters.releaseFrom === from && current.filters.releaseTo === to && !document.querySelector('#results').hasAttribute('aria-busy');
  }, {from, to});
  const edit = async (id, value) => { await page.locator(id).fill(value); await page.locator(id).dispatchEvent('change'); };
  const openDates = async () => {
    if (await page.locator('#date-picker').isVisible()) return;
    if (await page.locator('#filter-category').isVisible()) await page.locator('#filter-category').selectOption('date');
    else await page.locator('#date-toggle').click();
  };
  const dateParams = () => page.evaluate(() => {
    const params = new URLSearchParams(location.search);
    return {from:params.get('releaseFrom'),to:params.get('releaseTo'),highlight:params.get('highlight')};
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width:1440,height:1050});
  await page.goto(base); await settled();
  const fixture = await page.evaluate(async () => {
    const manifest = await fetch('./data/manifest.json').then(response => response.json());
    const catalog = await fetch('./data/' + manifest.current.catalog).then(response => response.json());
    const defaults = game => game.releaseStatus === 'released' && game.earlyAccess === false && game.reviews !== null && game.reviews >= 20;
    const validDate = game => typeof game.releaseISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(game.releaseISO) && Number.isFinite(Date.parse(game.releaseISO)) && new Date(game.releaseISO).toISOString().slice(0, 10) === game.releaseISO;
    const game = catalog.games.filter(game => defaults(game) && validDate(game) && game.featureIds.length && game.tagDataKnown).sort((a, b) => b.reviews - a.reviews)[0];
    if (!game) throw new Error('The browser checks need a released, reviewed game with a date, feature, and tag.');
    const row = catalog.games.indexOf(game);
    const tagId = catalog.tagIndex.lists.findIndex(deltas => {
      let current = 0;
      for (const delta of deltas) {
        current += delta;
        if (current === row) return true;
        if (current > row) return false;
      }
      return false;
    });
    if (tagId < 0) throw new Error('The browser date fixture needs a tagged game.');
    let tagRow = 0;
    const tagRows = new Set(catalog.tagIndex.lists[tagId].map(delta => tagRow += delta));
    const feature = catalog.features.find(feature => game.featureIds.includes(feature.id));
    const day = game.releaseISO;
    const previous = new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
    const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
    const current = catalog.games.filter(defaults);
    const exact = current.filter(candidate => validDate(candidate) && candidate.releaseISO === day);
    const combined = catalog.games.filter((candidate, index) => defaults(candidate) && validDate(candidate) && candidate.releaseISO >= day && candidate.releaseISO <= next && candidate.featureDataKnown && candidate.featureIds.includes(feature.id) && tagRows.has(index));
    return {
      game:{id:game.id,name:game.name,metadataDay:new Date(game.metadataUpdatedAt).toISOString().slice(0, 10)},feature:{id:feature.id,key:feature.key,name:feature.name},tag:catalog.tags[tagId],day,previous,next,updated:new Date(catalog.importedAt).toISOString().slice(0, 10),
      totals:{all:current.length,from:current.filter(candidate => validDate(candidate) && candidate.releaseISO >= day).length,to:current.filter(candidate => validDate(candidate) && candidate.releaseISO <= day).length,exact:exact.length,range:current.filter(candidate => validDate(candidate) && candidate.releaseISO >= day && candidate.releaseISO <= next).length,combined:combined.length,year2024:current.filter(candidate => validDate(candidate) && candidate.releaseISO >= '2024-01-01' && candidate.releaseISO <= '2024-12-31').length,february2024:current.filter(candidate => validDate(candidate) && candidate.releaseISO >= '2024-02-01' && candidate.releaseISO <= '2024-02-29').length,throughFebruary2023:current.filter(candidate => validDate(candidate) && candidate.releaseISO <= '2023-02-28').length},
    };
  });
  let current = await view();
  check('Date bounds start independently empty and leave default results unchanged', current.filters.releaseFrom === '' && current.filters.releaseTo === '' && current.matching === fixture.totals.all && await page.locator('#date-picker').isHidden() && await page.locator('#active-date-count').innerText() === '0');
  await openDates();
  check('Date panel exposes labeled ISO text fields regardless of browser locale', await page.getByLabel('Start date', {exact:true}).getAttribute('type') === 'text' && await page.getByLabel('End date', {exact:true}).getAttribute('type') === 'text' && await page.locator('#release-from').getAttribute('placeholder') === 'YYYY-MM-DD' && await page.locator('#release-to').getAttribute('placeholder') === 'YYYY-MM-DD' && await page.locator('#date-toggle').getAttribute('aria-expanded') === 'true');
  check('The catalog update note displays its UTC ISO date', (await page.locator('#method-dates').textContent()).startsWith('Updated ' + fixture.updated + '.'));
  for (const value of ['2025-2-03', '2025-02-30', 'not-a-date']) {
    await edit('#release-from', value); await page.locator('#date-error').waitFor({state:'visible'});
    check(`Invalid typed date is rejected without changing results: ${value}`, await page.locator('#release-from').inputValue() === value && await page.locator('#release-from').getAttribute('aria-invalid') === 'true' && (await view()).filters.releaseFrom === '' && (await view()).matching === fixture.totals.all && (await dateParams()).from === null && await page.locator('#error').isHidden());
  }
  await edit('#release-from', ''); await dates('', '');
  check('Clearing an invalid typed date removes the error', await page.locator('#date-error').isHidden() && await page.locator('#release-from').getAttribute('aria-invalid') === null);
  await edit('#release-from', '2024'); await dates('2024', '');
  check('A start year keeps its precision in the field, chip, and URL', await page.locator('#release-from').inputValue() === '2024' && await page.locator('[data-date-bound="releaseFrom"]').innerText() === 'Released from 2024 ×' && (await dateParams()).from === '2024' && (await dateParams()).to === null && (await view()).games.every(game => game.releaseISO >= '2024-01-01'));
  await edit('#release-from', '2024');
  check('Re-entering an unchanged year retains the same precision', await page.locator('#release-from').inputValue() === '2024' && (await dateParams()).from === '2024');
  await edit('#release-to', '2024'); await dates('2024', '2024');
  check('An end year keeps its precision and includes the entire year', await page.locator('#release-to').inputValue() === '2024' && await page.locator('[data-date-bound="releaseTo"]').innerText() === 'Released through 2024 ×' && (await dateParams()).to === '2024' && (await view()).matching === fixture.totals.year2024 && (await view()).games.every(game => game.releaseISO >= '2024-01-01' && game.releaseISO <= '2024-12-31'));
  await page.locator('#reset').click(); await dates('', '');
  await edit('#release-from', '2024-02'); await dates('2024-02', '');
  check('A start month keeps its precision and includes its first day', await page.locator('#release-from').inputValue() === '2024-02' && await page.locator('[data-date-bound="releaseFrom"]').innerText() === 'Released from 2024-02 ×' && (await dateParams()).from === '2024-02' && (await view()).games.every(game => game.releaseISO >= '2024-02-01'));
  await edit('#release-to', '2024-02'); await dates('2024-02', '2024-02');
  check('A leap-year end month keeps its precision and includes February 29', await page.locator('#release-to').inputValue() === '2024-02' && await page.locator('[data-date-bound="releaseTo"]').innerText() === 'Released through 2024-02 ×' && (await dateParams()).to === '2024-02' && (await view()).matching === fixture.totals.february2024 && (await view()).games.every(game => game.releaseISO >= '2024-02-01' && game.releaseISO <= '2024-02-29'));
  await page.locator('#reset').click(); await dates('', '');
  await edit('#release-to', '2023-02'); await dates('', '2023-02');
  check('A non-leap end month includes February 28 with no start bound', await page.locator('#release-to').inputValue() === '2023-02' && (await dateParams()).to === '2023-02' && (await dateParams()).from === null && (await view()).matching === fixture.totals.throughFebruary2023);
  await page.locator('#reset').click(); await dates('', '');
  for (const draft of ['2024', '2024-02-30']) {
    const valid = draft === '2024';
    await page.evaluate(({draft, valid}) => {
      const title = document.querySelector('#search'), from = document.querySelector('#release-from');
      title.value = 'Portal'; title.dispatchEvent(new Event('input', {bubbles:true}));
      from.value = draft; from.dispatchEvent(new Event('input', {bubbles:true}));
      if (!valid) from.dispatchEvent(new Event('change', {bubbles:true}));
    }, {draft, valid});
    await page.waitForFunction(() => new URLSearchParams(location.search).get('q') === 'Portal' && !document.querySelector('#results').hasAttribute('aria-busy'));
    check(`A pending title search preserves the date draft without applying it: ${draft}`, await page.locator('#release-from').inputValue() === draft && (await view()).filters.releaseFrom === '' && (await dateParams()).from === null && (await view()).filters.q === 'Portal' && await page.locator('#date-error').isHidden() === valid);
    if (valid) {
      await page.locator('#release-from').dispatchEvent('change'); await dates('2024', '');
      check('A date draft preserved across title search can be committed', await page.locator('#release-from').inputValue() === '2024' && (await dateParams()).from === '2024' && (await view()).filters.q === 'Portal' && (await view()).games.every(game => game.releaseISO >= '2024-01-01' && game.name.toLowerCase().includes('portal')));
    }
    await page.locator('#reset').click(); await dates('', '');
    check(`Reset clears the date draft and its error after pending title search: ${draft}`, await page.locator('#release-from').inputValue() === '' && await page.locator('#date-error').isHidden() && (await view()).filters.q === '' && (await view()).matching === fixture.totals.all);
  }
  await edit('#release-from', fixture.day); await dates(fixture.day, '');
  current = await view();
  check('Start date alone includes its boundary and excludes earlier or unknown dates', current.matching === fixture.totals.from && current.games.every(game => game.releaseISO && game.releaseISO >= fixture.day));
  check('Start-only state has its own URL parameter and active count', JSON.stringify(await dateParams()) === JSON.stringify({from:fixture.day,to:null,highlight:null}) && await page.locator('#active-date-count').innerText() === '1' && await page.locator('[data-date-bound="releaseFrom"]').count() === 1 && await page.locator('[data-date-bound="releaseTo"]').count() === 0);
  await edit('#release-to', fixture.day); await dates(fixture.day, fixture.day);
  current = await view();
  check('Equal start and end dates include the entire release day', fixture.totals.exact > 0 && current.matching === fixture.totals.exact && current.games.every(game => game.releaseISO === fixture.day));
  check('Both date bounds have independent chips and count as two active settings', await page.locator('[data-date-bound]').count() === 2 && await page.locator('#active-date-count').innerText() === '2');
  check('Date inputs and active chips retain the YYYY-MM-DD format', await page.locator('#release-from').inputValue() === fixture.day && await page.locator('#release-to').inputValue() === fixture.day && await page.locator('[data-date-bound="releaseFrom"]').innerText() === 'Released from ' + fixture.day + ' ×' && await page.locator('[data-date-bound="releaseTo"]').innerText() === 'Released through ' + fixture.day + ' ×');
  await page.locator('[data-date-bound="releaseFrom"]').click(); await dates('', fixture.day);
  current = await view();
  check('Removing start after the edited end field blurs leaves the end bound intact', current.matching === fixture.totals.to && current.games.every(game => game.releaseISO && game.releaseISO <= fixture.day) && await page.locator('#release-from').inputValue() === '' && await page.locator('#release-to').inputValue() === fixture.day);
  check('End-only URL does not retain a start date', JSON.stringify(await dateParams()) === JSON.stringify({from:null,to:fixture.day,highlight:null}) && await page.locator('#active-date-count').innerText() === '1');
  await page.locator('[data-date-bound="releaseTo"]').click(); await dates('', '');
  check('Removing the end bound restores the default catalog', (await view()).matching === fixture.totals.all && await page.locator('[data-date-bound]').count() === 0 && await page.locator('#release-to').inputValue() === '');
  await edit('#release-from', '2012-08'); await dates('2012-08', '');
  await page.locator('#release-to').fill('2013');
  await page.locator('[data-date-bound="releaseFrom"]').click(); await dates('', '2013');
  check('Clicking a chip while a changed date field blurs applies both actions', await page.locator('[data-date-bound="releaseFrom"]').count() === 0 && await page.locator('#release-from').inputValue() === '' && await page.locator('#release-to').inputValue() === '2013' && (await dateParams()).to === '2013');
  await page.locator('#reset').click(); await dates('', '');
  await page.evaluate(({day, next}) => {
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.type === 'query') setTimeout(() => original.call(this, message, ...args), 350);
      else original.call(this, message, ...args);
    };
    window.restoreReleaseDateWorker = () => { Worker.prototype.postMessage = original; };
    const from = document.querySelector('#release-from'), to = document.querySelector('#release-to');
    from.value = day; from.dispatchEvent(new Event('input', {bubbles:true})); from.dispatchEvent(new Event('change', {bubbles:true}));
    to.value = next; to.dispatchEvent(new Event('input', {bubbles:true}));
  }, fixture);
  await dates(fixture.day, '');
  check('A pending result does not overwrite an uncommitted second date', await page.locator('#release-to').inputValue() === fixture.next && (await view()).filters.releaseTo === '' && (await view()).matching === fixture.totals.from);
  await page.evaluate(() => window.restoreReleaseDateWorker());
  await page.locator('#release-to').dispatchEvent('change'); await dates(fixture.day, fixture.next);
  check('The preserved second-date draft can be committed normally', (await view()).matching === fixture.totals.range);
  await edit('#release-to', fixture.day); await dates(fixture.day, fixture.day);
  const validURL = page.url(), validResult = await view();
  await edit('#release-to', fixture.previous);
  await page.locator('#date-error').waitFor({state:'visible'});
  check('A reversed draft range shows an inline error without changing results or URL', page.url() === validURL && JSON.stringify((await view()).games) === JSON.stringify(validResult.games) && (await view()).matching === validResult.matching && (await view()).filters.releaseTo === fixture.day && await page.locator('#error').isHidden());
  await page.locator('#release-to').press('Enter');
  await page.locator('#filters').evaluate(form => form.requestSubmit());
  check('Submitting the filter form cannot bypass a reversed date range', await page.locator('#date-error').isVisible() && page.url() === validURL && !(await page.locator('#results').getAttribute('aria-busy')) && (await view()).filters.releaseTo === fixture.day && JSON.stringify((await view()).games) === JSON.stringify(validResult.games));
  await page.locator('#date-toggle').click();
  await page.locator('#filters').evaluate(form => form.requestSubmit());
  check('Submitting a hidden invalid date draft reopens its panel and exposes the error', await page.locator('#date-picker').isVisible() && await page.locator('#date-error').isVisible() && page.url() === validURL && (await view()).filters.releaseTo === fixture.day && JSON.stringify((await view()).games) === JSON.stringify(validResult.games));
  await edit('#release-to', fixture.next); await dates(fixture.day, fixture.next);
  check('Correcting a reversed range applies it and clears the error', await page.locator('#date-error').isHidden() && (await view()).matching === fixture.totals.range);
  await page.locator('#feature-toggle').click();
  check('Opening features closes dates and retains both bounds', await page.locator('#feature-picker').isVisible() && await page.locator('#date-picker').isHidden() && await page.locator('#date-toggle').getAttribute('aria-expanded') === 'false' && (await view()).filters.releaseFrom === fixture.day && (await view()).filters.releaseTo === fixture.next);
  await page.getByRole('button', {name:'Require ' + fixture.feature.name,exact:true}).click(); await settled();
  await page.locator('#tag-toggle').click();
  await page.locator('#tag-search').fill(fixture.tag);
  await page.getByRole('button', {name:'Require tag ' + fixture.tag,exact:true}).click(); await settled();
  await openDates();
  current = await view();
  check('Dates combine with active feature and tag requirements', current.matching === fixture.totals.combined && current.filters.has.includes(fixture.feature.id) && current.filters.hasTags.includes(fixture.tag) && current.games.every(game => game.tags.includes(fixture.tag) && game.releaseISO >= fixture.day && game.releaseISO <= fixture.next));
  check('Opening dates closes the other panels without clearing their filters', await page.locator('#feature-picker').isHidden() && await page.locator('#tag-picker').isHidden() && await page.locator('#feature-toggle').getAttribute('aria-expanded') === 'false' && await page.locator('#tag-toggle').getAttribute('aria-expanded') === 'false' && await page.locator('#active-count').innerText() === '1' && await page.locator('#active-tag-count').innerText() === '1');
  await page.locator('#search').fill(fixture.game.name);
  await page.waitForFunction(name => window.steamFeatureAtlas.getView().filters.q === name && new URLSearchParams(location.search).get('q') === name && !document.querySelector('#results').hasAttribute('aria-busy'), fixture.game.name);
  check('Title filtering preserves both date bounds and finds the catalog example', (await view()).games.some(game => game.id === fixture.game.id) && (await view()).filters.releaseFrom === fixture.day && (await view()).filters.releaseTo === fixture.next);
  await page.locator(`tr[data-game-id="${fixture.game.id}"] .game-name`).click();
  const tooltipDates = await page.locator('#tooltip').evaluate(tip => Object.fromEntries([...tip.querySelectorAll('dt')].map(label => [label.textContent, label.nextElementSibling.textContent])));
  check('Game details use ISO release and metadata-check dates', tooltipDates['Release date'] === fixture.day && tooltipDates['Steam metadata checked'] === fixture.game.metadataDay);
  await page.keyboard.press('Escape');
  const shared = new URL(page.url()); shared.searchParams.set('highlight', 'steam-cloud');
  await page.goto(shared.href); await settled();
  check('A shared URL restores dates alongside other filters and a column highlight', (await view()).filters.releaseFrom === fixture.day && (await view()).filters.releaseTo === fixture.next && (await view()).filters.has.includes(fixture.feature.id) && (await view()).filters.hasTags.includes(fixture.tag) && (await view()).filters.q === fixture.game.name && (await view()).highlight === 'steam-cloud' && await page.locator('#release-from').inputValue() === fixture.day && await page.locator('#release-to').inputValue() === fixture.next);
  await openDates();
  await edit('#release-to', fixture.day); await dates(fixture.day, fixture.day);
  await page.goBack(); await dates(fixture.day, fixture.next);
  check('Back restores the prior date range and keeps the highlight', await page.locator('#release-to').inputValue() === fixture.next && (await view()).highlight === 'steam-cloud');
  await page.goForward(); await dates(fixture.day, fixture.day);
  check('Forward restores the changed end date independently', await page.locator('#release-from').inputValue() === fixture.day && await page.locator('#release-to').inputValue() === fixture.day);
  await page.reload(); await settled();
  check('Reload restores the current date range and active chips', (await view()).filters.releaseFrom === fixture.day && (await view()).filters.releaseTo === fixture.day && await page.locator('[data-date-bound]').count() === 2 && (await view()).highlight === 'steam-cloud');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text => { window.releaseDateCopiedURL = text; }}}));
  await page.locator('#share').click();
  check('Copy Link includes both dates and the highlight', await page.evaluate(day => {
    const params = new URL(window.releaseDateCopiedURL).searchParams;
    return params.get('releaseFrom') === day && params.get('releaseTo') === day && params.get('highlight') === 'CLD';
  }, fixture.day));
  await page.locator('#reset').click(); await dates('', '');
  check('Reset clears both dates with other filters while keeping the highlight', (await view()).matching === fixture.totals.all && !(await view()).filters.has.length && !(await view()).filters.hasTags.length && !(await view()).filters.q && (await view()).highlight === 'steam-cloud' && await page.locator('#release-from').inputValue() === '' && await page.locator('#release-to').inputValue() === '' && await page.locator('#active-date-count').innerText() === '0');
  await page.goto(base + '?releaseFrom=2024&releaseTo=2024-02&highlight=steam-cloud'); await settled();
  check('Shared year and month bounds retain their precision and the highlight', (await view()).filters.releaseFrom === '2024' && (await view()).filters.releaseTo === '2024-02' && await page.locator('#release-from').inputValue() === '2024' && await page.locator('#release-to').inputValue() === '2024-02' && JSON.stringify(await dateParams()) === JSON.stringify({from:'2024',to:'2024-02',highlight:'CLD'}));
  for (const search of ['?releaseFrom=2025-02-30', '?releaseTo=2025-2-03', '?releaseFrom=2025-02-04&releaseTo=2025-02-03']) {
    await page.goto(base + search); await page.locator('#error:not([hidden])').waitFor();
    check(`Invalid shared date query is rejected: ${search}`, await page.locator('#results').isHidden());
    await page.locator('#error-reset').click(); await settled();
    check(`Reset recovers from invalid shared dates: ${search}`, (await view()).filters.releaseFrom === '' && (await view()).filters.releaseTo === '' && (await view()).matching === fixture.totals.all);
  }
  for (const width of [320, 390]) {
    await page.setViewportSize({width,height:900});
    await page.goto(base + '?releaseFrom=' + fixture.day + '&releaseTo=' + fixture.next); await settled();
    await openDates();
    const layout = await page.evaluate(() => {
      const bounds = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width}; };
      return {width:innerWidth,outerWidth:document.documentElement.scrollWidth,panel:bounds('#date-picker'),from:bounds('#release-from'),to:bounds('#release-to'),toggle:bounds('#filter-category'),chips:[...document.querySelectorAll('[data-date-bound]')].map(chip => ({scrollWidth:chip.scrollWidth,clientWidth:chip.clientWidth}))};
    });
    layouts.push(layout);
    check(`${width}px date controls and chips fit without page overflow`, layout.outerWidth <= width && [layout.panel,layout.from,layout.to,layout.toggle].every(rect => rect.left >= 0 && rect.right <= width) && layout.chips.every(chip => chip.scrollWidth <= chip.clientWidth));
    await page.locator('#filter-category').selectOption('tag');
    check(`${width}px picker switching retains both active dates`, await page.locator('#date-picker').isHidden() && await page.locator('#tag-picker').isVisible() && (await view()).filters.releaseFrom === fixture.day && (await view()).filters.releaseTo === fixture.next);
  }
  check('Release date filtering produces no browser runtime errors', errors.length === 0);
  return {passed:checks.length,checks,errors,layouts,fixture};
}
