async (page, options = {}) => {
  const base = String(options.baseURL ?? 'http://127.0.0.1:4178/').replace(/\/+$/, '') + '/';
  const checks = [], errors = [], layouts = [];
  const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
  const view = () => page.evaluate(() => window.steamFeatureAtlas.getView());
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.querySelector('#results').hidden && !document.querySelector('#results').hasAttribute('aria-busy'));
  const highlighted = key => page.waitForFunction(value => window.steamFeatureAtlas?.getView().highlight === value, key);
  const featureTip = async id => {
    await page.keyboard.press('Escape');
    await page.locator('#feature-' + id + ' button').click();
    await page.locator('#tooltip .highlight-button').waitFor({state:'visible'});
  };
  const highlightParam = () => page.evaluate(() => new URLSearchParams(location.search).get('highlight'));
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width:1440,height:1050});
  await page.goto(base); await settled();
  check('Highlight starts empty and does not enter the worker filters', (await view()).highlight === null && !('highlight' in (await view()).filters) && await page.locator('#highlight-chip').isHidden());
  await page.locator('#matrix-region').evaluate(region => { region.scrollTop = 150; });
  await page.waitForFunction(() => document.querySelector('#matrix-region').scrollTop > 0);
  await featureTip(23);
  check('Feature tooltip exposes an unpressed highlight button', await page.locator('#tooltip .highlight-button').getAttribute('aria-pressed') === 'false');
  await page.evaluate(() => {
    window.highlightCheckMessages = 0;
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args) { window.highlightCheckMessages++; return original.apply(this, args); };
    window.restoreHighlightCheckWorker = () => { Worker.prototype.postMessage = original; };
    window.highlightCheckRow = document.querySelector('#matrix-body tr');
  });
  const before = await view();
  const scrollBefore = await page.locator('#matrix-region').evaluate(region => region.scrollTop);
  await page.locator('#tooltip .highlight-button').click(); await highlighted('steam-cloud');
  const after = await view();
  check('Highlight changes no query results, scores, filters, or pagination', JSON.stringify(before.filters) === JSON.stringify(after.filters) && JSON.stringify(before.games) === JSON.stringify(after.games) && before.page === after.page && before.matching === after.matching);
  check('Highlight neither queries the worker nor rebuilds or vertically scrolls rows', await page.evaluate(() => window.highlightCheckMessages === 0 && window.highlightCheckRow === document.querySelector('#matrix-body tr')) && await page.locator('#matrix-region').evaluate(region => region.scrollTop) === scrollBefore);
  check('Selected column spans its header and every displayed row', await page.locator('#matrix .column-selected').count() === after.displayed + 1 && await page.locator('#matrix .column-selected:not([data-feature="23"])').count() === 0);
  check('Highlight is shareable by feature slug and has a removable chip', await highlightParam() === 'steam-cloud' && /Highlight:.*Steam Cloud/.test(await page.locator('#highlight-chip').innerText()));
  await page.keyboard.press('Escape');
  await page.locator('#feature-22 button').hover();
  check('Hover moves independently of the selected column', await page.locator('#feature-22.column-highlight').count() === 1 && await page.locator('#feature-23.column-selected').count() === 1);
  await featureTip(23);
  check('Selected feature tooltip exposes a pressed highlight button', await page.locator('#tooltip .highlight-button').getAttribute('aria-pressed') === 'true');
  await page.keyboard.press('Escape');
  await page.locator('#highlight-chip').click(); await highlighted(null);
  check('Clearing the chip removes only the highlight', await highlightParam() === null && await page.locator('#matrix .column-selected').count() === 0 && JSON.stringify((await view()).filters) === JSON.stringify(before.filters));
  await page.goBack(); await highlighted('steam-cloud');
  check('Back restores a highlight without worker work or a row rebuild', await page.evaluate(() => window.highlightCheckMessages === 0 && window.highlightCheckRow === document.querySelector('#matrix-body tr')));
  await page.goForward(); await highlighted(null);
  check('Forward clears the highlight again', await page.locator('#highlight-chip').isHidden());
  await page.evaluate(() => window.restoreHighlightCheckWorker());
  await featureTip(22); await page.locator('#tooltip .highlight-button').click(); await highlighted('steam-achievements');
  await featureTip(23); await page.locator('#tooltip .highlight-button').click(); await highlighted('steam-cloud');
  check('Selecting another feature replaces the previous highlight', await page.locator('#feature-22.column-selected').count() === 0 && await page.locator('#feature-23.column-selected').count() === 1 && await page.evaluate(() => new URLSearchParams(location.search).getAll('highlight').length === 1));
  await page.keyboard.press('Escape');
  await page.locator('#next').click(); await settled();
  check('Pagination preserves the selected column and URL', (await view()).page === 2 && (await view()).highlight === 'steam-cloud' && await highlightParam() === 'steam-cloud' && await page.locator('#feature-23.column-selected').count() === 1);
  await page.locator('#sort').selectOption('reviews'); await settled();
  check('Sorting preserves the highlight', (await view()).filters.sort === 'reviews-desc' && (await view()).highlight === 'steam-cloud');
  await page.locator('button[data-preset="missing-cloud"]').click(); await settled();
  check('Presets preserve the highlight', (await view()).filters.not.includes(23) && (await view()).highlight === 'steam-cloud' && await highlightParam() === 'steam-cloud');
  await page.locator('#reset').click(); await settled();
  check('Reset Filters leaves the highlight intact', (await view()).filters.minReviews === 20 && !(await view()).filters.not.length && (await view()).highlight === 'steam-cloud');
  await featureTip(22);
  await page.evaluate(() => {
    const input = document.querySelector('#search'); input.value = 'Portal'; input.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#tooltip .highlight-button').click();
  });
  await page.waitForFunction(() => window.steamFeatureAtlas.getView().filters.q === 'Portal' && window.steamFeatureAtlas.getView().games.every(game => game.name.toLowerCase().includes('portal')));
  await settled();
  check('Pending search and the next worker result preserve the newest highlight', (await view()).highlight === 'steam-achievements' && await highlightParam() === 'steam-achievements' && await page.evaluate(() => new URLSearchParams(location.search).get('q')) === 'Portal');
  await page.reload(); await settled();
  check('Reload restores filters and highlight together', (await view()).filters.q === 'Portal' && (await view()).highlight === 'steam-achievements' && await page.locator('#feature-22.column-selected').count() === 1);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text => { window.highlightCheckCopiedURL = text; }}});
  });
  await page.locator('#share').click();
  check('Copy Link includes the highlighted feature and current filters', await page.evaluate(() => {
    const url = new URL(window.highlightCheckCopiedURL);
    return url.searchParams.get('highlight') === 'steam-achievements' && url.searchParams.get('q') === 'Portal';
  }));
  await page.goto(base + '?q=Portal&highlight=does-not-exist'); await settled();
  check('An invalid highlight is ignored while valid filters remain active', (await view()).highlight === null && (await view()).filters.q === 'Portal' && (await view()).games.every(game => game.name.toLowerCase().includes('portal')) && await page.locator('#error').isHidden());
  await page.goto(base + '?highlight=multi-player'); await settled();
  check('A hidden multiplayer highlight stays in the URL and is labeled hidden', (await view()).highlight === 'multi-player' && await highlightParam() === 'multi-player' && await page.locator('#matrix .column-selected').count() === 0 && /hidden/i.test(await page.locator('#highlight-chip').innerText()));
  await page.locator('#multiplayer').check(); await settled();
  check('Showing the group restores the highlighted column', await page.locator('#feature-1.column-selected').count() === 1 && !/hidden/i.test(await page.locator('#highlight-chip').innerText()));
  await page.locator('#multiplayer').uncheck(); await settled();
  check('Hiding the group retains the selected feature', (await view()).highlight === 'multi-player' && /hidden/i.test(await page.locator('#highlight-chip').innerText()));
  await page.goto(base + '?highlight=contrast-controls&a11y=1&mp=1'); await settled();
  check('Initial URL reveals a far-right highlighted column beyond the frozen columns', await page.evaluate(() => {
    const selected = document.querySelector('#feature-82').getBoundingClientRect();
    const frozen = document.querySelector('#matrix-head .fixed-score').getBoundingClientRect();
    const region = document.querySelector('#matrix-region').getBoundingClientRect();
    return document.querySelector('#matrix-region').scrollLeft > 0 && selected.left >= frozen.right - 1 && selected.right <= region.right + 1;
  }));
  await page.locator('#accessibility').uncheck(); await settled();
  check('Hidden accessibility highlights also survive their counting toggle', (await view()).highlight === 'contrast-controls' && /hidden/i.test(await page.locator('#highlight-chip').innerText()));
  for (const width of [390, 768, 1280, 1440, 1920]) {
    await page.setViewportSize({width,height:1050});
    for (const allFeatures of [false, true]) {
      await page.goto(base + (allFeatures ? '?a11y=1&mp=1' : '')); await settled();
      const layout = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
        return {width:innerWidth,coarse:matchMedia('(pointer:coarse)').matches,outerWidth:document.documentElement.scrollWidth,region:rect('#matrix-region'),row:rect('#matrix-body tr'),title:rect('#matrix-head .fixed-game'),rank:rect('#matrix-head .fixed-rank'),score:rect('#matrix-head .fixed-score'),feature:rect('#matrix-head .feature-head'),group:rect('#matrix-head .group-start'),countColumns:document.querySelectorAll('#matrix .fixed-count').length};
      });
      layouts.push({...layout,allFeatures});
      check(`${width}px ${allFeatures ? 'all' : 'default'} columns stay within the page`, layout.outerWidth <= width && layout.countColumns === 0);
      if (width > 650) {
        check(`${width}px ${allFeatures ? 'all' : 'default'} columns use compact rows and usable widths`, Math.abs(layout.row.height - (layout.coarse ? 40 : 36)) < 1 && layout.title.width >= 251 && layout.title.width <= 385 && layout.rank.width >= 35 && layout.score.width >= 51 && layout.feature.width >= (layout.coarse ? 27 : 25));
        check(`${width}px feature headers retain compact two-tier heights`, Math.abs(layout.feature.height - 48) < 1 && Math.abs(layout.group.height - 28) < 1);
      }
      await page.locator('#matrix-body .info-button').first().click();
      const tip = await page.evaluate(() => {
        const bounds = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
        return {tip:bounds('#tooltip'),score:bounds('#matrix-head .fixed-score'),row:bounds('#matrix-body tr'),width:innerWidth,height:innerHeight};
      });
      check(`${width}px game tooltip stays within the viewport`, tip.tip.left >= 11 && tip.tip.right <= width - 11 && tip.tip.top >= 11 && tip.tip.bottom <= tip.height - 11);
      if (tip.score.right + 8 + tip.tip.width <= width - 12) {
        const expectedTop = Math.max(12, Math.min(tip.row.top, tip.height - tip.tip.height - 12));
        check(`${width}px game tooltip leaves titles and scores visible`, Math.abs(tip.tip.left - tip.score.right - 8) < 1 && Math.abs(tip.tip.top - expectedTop) < 1);
      }
      await page.keyboard.press('Escape');
    }
  }
  await page.setViewportSize({width:320,height:760});
  await page.goto(base + '?highlight=playable-without-timed-input'); await settled();
  check('A long hidden-feature chip wraps without overflowing a 320px viewport', await page.locator('#highlight-chip').evaluate(chip => chip.textContent.includes('(hidden)') && chip.scrollWidth <= chip.clientWidth && document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({width:1440,height:1050});
  await page.goto(base + '?highlight=steam-cloud'); await settled();
  await featureTip(23); await page.locator('#tooltip .highlight-button').focus(); await page.keyboard.press('Enter'); await highlighted(null);
  check('Keyboard users can clear the highlight from its tooltip', await page.locator('#matrix .column-selected').count() === 0 && await highlightParam() === null);
  check('No browser runtime errors during highlight and layout checks', errors.length === 0);
  return {passed:checks.length,checks,errors,layouts};
}
