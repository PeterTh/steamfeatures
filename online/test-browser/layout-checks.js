async (page, options = {}) => {
  const base = String(options.baseURL ?? 'http://127.0.0.1:4178/').replace(/\/+$/, '') + '/';
  const checks = [], layouts = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.querySelector('#results').hidden && !document.querySelector('#results').hasAttribute('aria-busy'));
  const layout = async label => {
    // Layout uses a ResizeObserver and a following animation frame.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const result = await page.evaluate(() => {
      const region = document.querySelector('#matrix-region'), rect = region.getBoundingClientRect(), main = document.querySelector('main').getBoundingClientRect();
      return {width:innerWidth,height:innerHeight,top:rect.top + scrollY,bottom:rect.bottom + scrollY,matrixHeight:rect.height,mainBottom:main.bottom + scrollY,scrollHeight:region.scrollHeight,clientHeight:region.clientHeight,minimum:parseFloat(getComputedStyle(region).minHeight),pageHeight:document.documentElement.scrollHeight};
    });
    layouts.push({label,...result});
    return result;
  };
  const filled = value => value.matrixHeight > value.minimum + 2 && Math.abs(value.mainBottom - value.height) <= 2 && value.scrollHeight > value.clientHeight;
  await page.setViewportSize({width:1440,height:1400}); await page.goto(base); await settled();
  let current = await layout('1440x1400');
  check('Tall desktop fills the available height while keeping the footer visible', filled(current));
  check('The sort menu labels raw counts Feature Count', await page.locator('#sort option[value="features"]').innerText() === 'Feature Count');
  const initialHeight = current.matrixHeight;
  await page.locator('#feature-toggle').click(); current = await layout('features open');
  check('Opening features reduces the table height to preserve the footer', filled(current) && current.matrixHeight < initialHeight - 100);
  await page.locator('#tag-toggle').click(); current = await layout('tags open');
  check('Opening tags preserves the fitted layout', filled(current) && current.matrixHeight < initialHeight - 100);
  await page.locator('#tag-toggle').click(); current = await layout('pickers closed');
  check('Closing the picker restores the table height', filled(current) && Math.abs(current.matrixHeight - initialHeight) <= 2);
  await page.locator('.methodology > summary').click(); current = await layout('data notes open');
  check('Expanded data notes are included in the available-height calculation', filled(current) && current.matrixHeight < initialHeight - 100);
  await page.locator('.methodology > summary').click(); current = await layout('data notes closed');
  check('Closing the data notes restores the table height', filled(current) && Math.abs(current.matrixHeight - initialHeight) <= 2);
  await page.setViewportSize({width:1920,height:1200}); current = await layout('1920x1200');
  check('Width and height resize refits the table', filled(current));
  await page.setViewportSize({width:1280,height:900}); current = await layout('1280x900');
  check('A shorter desktop still uses the remaining viewport height', filled(current));
  await page.locator('#feature-toggle').click(); current = await layout('short viewport, features open');
  check('Limited space keeps the minimum table height and allows page scrolling', Math.abs(current.matrixHeight - current.minimum) <= 2 && current.pageHeight > current.height);
  await page.locator('#feature-toggle').click();
  await page.setViewportSize({width:768,height:1050}); await page.goto(base); await settled();
  const partial = await page.evaluate(() => {
    const region = document.querySelector('#matrix-region'), header = document.querySelector('.feature-head:last-child');
    const gameLeft = document.querySelector('#matrix-head .fixed-game').getBoundingClientRect().left;
    const scoreLeft = document.querySelector('#matrix-head .fixed-score').getBoundingClientRect().left;
    region.scrollTop = 150;
    region.scrollLeft += header.getBoundingClientRect().right - (region.getBoundingClientRect().left + region.clientLeft + region.clientWidth) - 10;
    header.querySelector('button').focus({preventScroll:true});
    return {scrollLeft:region.scrollLeft,scrollTop:region.scrollTop,headerId:header.id,gameLeft,scoreLeft};
  });
  check('Compact tables keep titles pinned while Score scrolls with features', await page.evaluate(previous =>
    Math.abs(document.querySelector('#matrix-head .fixed-game').getBoundingClientRect().left-previous.gameLeft) <= 1 &&
    Math.abs(document.querySelector('#matrix-head .fixed-score').getBoundingClientRect().left-(previous.scoreLeft-previous.scrollLeft)) <= 1, partial));
  await page.keyboard.press('Enter');
  const featureKey = await page.locator('#tooltip .highlight-button').getAttribute('data-feature-key');
  await page.locator('#tooltip .highlight-button').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(key => window.steamFeatureAtlas.getView().highlight === key, featureKey);
  await layout('keyboard reveal');
  check('Revealing a partially hidden column keeps keyboard focus and vertical position', await page.evaluate(previous => {
    const region = document.querySelector('#matrix-region'), header = document.getElementById(previous.headerId), bounds = header.getBoundingClientRect();
    return document.activeElement === header.querySelector('button') && region.scrollLeft > previous.scrollLeft && region.scrollTop === previous.scrollTop && bounds.left >= document.querySelector('#matrix-head .fixed-game').getBoundingClientRect().right - 1 && bounds.right <= region.getBoundingClientRect().left + region.clientLeft + region.clientWidth + 1;
  }, partial));
  await page.evaluate(() => window.steamFeatureAtlas.setFilters({ includeMultiplayer: true, includeHardware: true, includeRemotePlay: true, includeAccessibility: true })); await settled();
  const wideLayouts = [];
  for (const width of [2100, 2200, 2560, 3440]) {
    await page.setViewportSize({ width, height: 1200 }); await layout('all columns at ' + width);
    const bounds = await page.evaluate(() => {
      const region = document.querySelector('#matrix-region'), rect = region.getBoundingClientRect(), styles = getComputedStyle(document.querySelector('main'));
      return { viewport: document.documentElement.clientWidth, left: rect.left, right: rect.right, width: rect.width,
        controlsWidth: document.querySelector('#filters').getBoundingClientRect().width,
        paddingLeft: parseFloat(styles.paddingLeft), paddingRight: parseFloat(styles.paddingRight), overflow: region.scrollWidth > region.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
    });
    wideLayouts.push(bounds);
    check('The matrix uses all available width while scrolling at ' + width, !bounds.overflow || Math.abs(bounds.left - bounds.paddingLeft) <= 1 && Math.abs(bounds.right - (bounds.viewport - bounds.paddingRight)) <= 1);
    check('Controls stay capped without page overflow at ' + width, bounds.controlsWidth <= 1936 && !bounds.pageOverflow);
  }
  check('The expanded matrix becomes wider than the controls', wideLayouts[0].width > wideLayouts[0].controlsWidth + 50);
  check('All columns fit once the viewport is wide enough', !wideLayouts.at(-1).overflow);
  await page.evaluate(() => window.steamFeatureAtlas.setFilters({ includeMultiplayer: false, includeHardware: false, includeRemotePlay: false, includeAccessibility: false })); await settled(); await layout('default columns on an ultrawide display');
  check('A matrix that fits retains the normal content width', await page.evaluate(() => Math.abs(document.querySelector('#matrix-region').getBoundingClientRect().width - document.querySelector('#filters').getBoundingClientRect().width) <= 1));
  await page.setViewportSize({width:780,height:360}); await page.goto(base); await settled();
  await page.waitForFunction(() => window.steamFeatureAtlas.getLoadState().fullReady);
  await layout('phone landscape scrolling');
  const wheel = async (position, delta) => {
    // Each case represents a fresh gesture, rather than an ongoing wheel transaction.
    await page.reload(); await settled();
    await page.waitForFunction(() => window.steamFeatureAtlas.getLoadState().fullReady);
    await layout('landscape scroll at ' + position);
    const before = await page.evaluate(position => {
      const region = document.querySelector('#matrix-region');
      scrollTo(0,150);
      region.scrollTop = position === 'top' ? 0 : position === 'bottom' ? region.scrollHeight : 200;
      const rect = region.getBoundingClientRect();
      return {page:scrollY,table:region.scrollTop,x:rect.left+14,y:Math.min(innerHeight-20,Math.max(20,rect.top+120))};
    },position);
    await page.mouse.move(before.x,before.y); await page.mouse.wheel(0,delta);
    await page.waitForTimeout(300);
    return {before,after:await page.evaluate(() => ({page:scrollY,table:document.querySelector('#matrix-region').scrollTop}))};
  };
  let scroll = await wheel('middle',100);
  check('Landscape scrolling within the table keeps the page still', scroll.after.table > scroll.before.table && Math.abs(scroll.after.page-scroll.before.page) <= 1);
  scroll = await wheel('top',-100);
  check('Scrolling past the first row moves the page upward', scroll.after.page < scroll.before.page && scroll.after.table === 0);
  scroll = await wheel('bottom',100);
  check('Scrolling past the last row moves the page downward', scroll.after.page > scroll.before.page && Math.abs(scroll.after.table-scroll.before.table) <= 1);
  check('Layout resizing produces no browser or ResizeObserver errors', errors.length === 0);
  layouts.push({label:'wide layouts',measurements:wideLayouts});
  return {passed:checks.length,checks,layouts,errors};
}
