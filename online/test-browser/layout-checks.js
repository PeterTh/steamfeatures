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
    const region = document.querySelector('#matrix-region'), header = document.querySelector('#feature-62');
    region.scrollTop = 150;
    region.scrollLeft += header.getBoundingClientRect().right - (region.getBoundingClientRect().left + region.clientLeft + region.clientWidth) - 10;
    header.querySelector('button').focus({preventScroll:true});
    return {scrollLeft:region.scrollLeft,scrollTop:region.scrollTop};
  });
  await page.keyboard.press('Enter');
  await page.locator('#tooltip .highlight-button').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.steamFeatureAtlas.getView().highlight === 'family-sharing');
  await layout('keyboard reveal');
  check('Revealing a partially hidden column keeps keyboard focus and vertical position', await page.evaluate(previous => {
    const region = document.querySelector('#matrix-region'), header = document.querySelector('#feature-62'), bounds = header.getBoundingClientRect();
    return document.activeElement === header.querySelector('button') && region.scrollLeft > previous.scrollLeft && region.scrollTop === previous.scrollTop && bounds.left >= document.querySelector('#matrix-head .fixed-score').getBoundingClientRect().right - 1 && bounds.right <= region.getBoundingClientRect().left + region.clientLeft + region.clientWidth + 1;
  }, partial));
  check('Layout resizing produces no browser or ResizeObserver errors', errors.length === 0);
  return {passed:checks.length,checks,layouts,errors};
}
