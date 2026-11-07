async (page, options = {}) => {
  const base = String(options.baseURL ?? 'http://127.0.0.1:4178/').replace(/\/+$/, '') + '/';
  const checks = [], errors = [];
  const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
  const view = () => page.evaluate(() => window.steamFeatureAtlas.getView());
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.querySelector('#results').hidden && !document.querySelector('#results').hasAttribute('aria-busy'));
  const editor = page.locator('#advanced-query');
  const open = async () => { if (await page.locator('#advanced-picker').isHidden()) { if (await page.locator('#advanced-toggle').isVisible()) await page.locator('#advanced-toggle').click(); else await page.locator('#filter-category').selectOption('advanced'); } };
  const apply = async text => { await open(); await editor.fill(text); await page.locator('#advanced-apply').click(); await settled(); return view(); };
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(base); await settled();
  const baseline = await view();
  await open();
  check('Opening Advanced translates the existing defaults without activating them', (await editor.inputValue()).includes('reviews >= 20') && (await editor.inputValue()).includes('release:released') && (await view()).filters.expression === null);
  const compactEditor = await page.evaluate(() => ({
    labelHeight: document.querySelector('label[for=advanced-query]').getBoundingClientRect().height,
    applyHeight: document.getElementById('advanced-apply').getBoundingClientRect().height,
    toggleHeight: document.getElementById('advanced-toggle').getBoundingClientRect().height,
    hint: document.getElementById('advanced-hint').textContent,
  }));
  check('The editor omits the redundant label and empty-query hint, and uses compact buttons', compactEditor.labelHeight <= 1 && !compactEditor.hint.includes('empty') && compactEditor.applyHeight <= compactEditor.toggleHeight + 2);
  await editor.fill('NOT (title:"<b>AND</b>" OR title:/tag:[a/]\\//i) AND reviews >= 100');
  check('Highlighting preserves literal text and distinguishes fields, operators, regexes, and numbers', await page.evaluate(() => {
    const input = document.getElementById('advanced-query'), mirror = document.getElementById('advanced-highlights');
    return mirror.getAttribute('aria-hidden') === 'true' && mirror.textContent === input.value && !mirror.querySelector('b')
      && mirror.querySelector('.query-field').textContent === 'title' && mirror.querySelector('.query-operator').textContent === 'NOT'
      && mirror.querySelector('.query-regex').textContent === '/tag:[a/]\\//i' && mirror.querySelector('.query-number').textContent === '100';
  }));
  await editor.fill('title:"Portal"'); await editor.press('End'); await editor.press('Backspace'); await editor.press('p');
  await editor.press('Control+z');
  check('Highlighting preserves native undo and selection', await editor.inputValue() === 'title:"Portal' && await editor.evaluate(e => e.selectionStart === e.value.length && document.getElementById('advanced-highlights').textContent === e.value));
  const full = await apply('feature:full-controller-support'), partial = await apply('feature:partial-controller-support');
  const both = await apply('feature:full-controller-support AND feature:partial-controller-support');
  const either = await apply('feature:full-controller-support OR feature:partial-controller-support');
  check('Controller OR is exactly the union, including games outside the basic defaults', either.matching === full.matching + partial.matching - both.matching && either.matching > both.matching);
  const strategy = await apply('tag:"Turn-Based Strategy"'), tactics = await apply('tag:"Turn-Based Tactics"');
  const tagBoth = await apply('tag:"Turn-Based Strategy" AND tag:"Turn-Based Tactics"');
  const tagEither = await apply('tag:"Turn-Based Strategy" OR tag:"Turn-Based Tactics"');
  check('Tag OR is exactly the union', tagEither.matching === strategy.matching + tactics.matching - tagBoth.matching);
  const portal = await apply('title:/^portal(?: 2)?$/i');
  check('Regex title matching finds Portal and Portal 2', portal.matching === 2 && portal.games.every(g => [400, 620].includes(g.id)));
  check('Advanced mode disables ordinary filters but keeps display controls usable', await page.locator('#search').isDisabled() && await page.locator('#feature-toggle').isDisabled() && await page.locator('#release').isDisabled() && await page.locator('#library-owned-has').isDisabled() && await page.locator('#sort').isEnabled() && await page.locator('#hardware').isEnabled());
  check('Advanced URLs use version 2 without hidden basic filters', new URL(page.url()).searchParams.get('v') === '2' && !new URL(page.url()).searchParams.has('minReviews'));
  await page.goto(base + '?v=2&expr=' + encodeURIComponent('title:/^portal(?: 2)?$/i AND (developer:/^valve$/i OR publisher:/^valve$/i)')); await settled();
  check('Credit regexes inside groups load their metadata before matching', (await view()).matching === 2);
  await apply('title:/^portal(?: 2)?$/i');
  const appliedURL = page.url();
  await editor.fill('title:/unterminated');
  await page.waitForFunction(() => !document.querySelector('#advanced-error').hidden);
  check('Invalid drafts keep the applied results and URL', (await view()).matching === 2 && page.url() === appliedURL);
  await page.locator('#sort').selectOption('title'); await settled();
  check('Sorting preserves an invalid draft', await editor.inputValue() === 'title:/unterminated');
  await page.locator('#advanced-apply').click();
  check('Applying invalid text selects the error without changing the active expression', (await view()).filters.expression === 'title:/^portal(?: 2)?$/i' && await editor.evaluate(e => e.selectionEnd > e.selectionStart));
  await editor.fill('tag:"Turn-Based St');
  await page.getByRole('option', { name: 'Turn-Based Strategy', exact: true }).click();
  check('Tag completion inserts and highlights a correctly quoted value', await editor.inputValue() === 'tag:"Turn-Based Strategy"' && await page.locator('#advanced-highlights .query-value').textContent() === '"Turn-Based Strategy"');
  await editor.fill('title:/^portal(?: 2)?$/i'); await editor.press('Control+Enter'); await settled();
  check('Ctrl+Enter applies without submitting other controls', (await view()).matching === 2);
  await page.goto(base + '?v=2&expr=' + encodeURIComponent('reviews >= 100 AND (feature:full-controller-support OR feature:partial-controller-support)')); await settled();
  check('Shared advanced links activate the editor', await page.locator('#advanced-picker').isVisible() && await page.locator('#advanced-active').isVisible());
  const beforeReturn = (await view()).filters.expression;
  check('Lossy return explains the removed OR group in the button tooltip', await page.locator('#advanced-basic-warning').isVisible() && (await page.locator('#advanced-basic').getAttribute('title')).includes('OR'));
  await page.locator('#advanced-basic').click(); await settled();
  const basic = await view();
  check('Lossy return preserves the review threshold and adds no release default', basic.filters.expression === null && basic.filters.minReviews === 100 && basic.filters.release === 'all' && basic.filters.has.length === 0);
  check('Returning to basic filters clears the previous highlighted expression', await editor.evaluate(e => document.getElementById('advanced-highlights').textContent === e.value && e.value === ''));
  await page.goBack(); await settled();
  check('Back restores the exact advanced query', (await view()).filters.expression === beforeReturn);
  await page.goForward(); await settled();
  check('Forward restores converted basic filters', (await view()).filters.expression === null && (await view()).filters.minReviews === 100);
  const representable = await apply('reviews >= 20 AND feature:CLD AND NOT tag:RPG');
  check('Lossless conversion has no warning', await page.locator('#advanced-basic-warning').isHidden() && await page.locator('#advanced-basic').getAttribute('title') === null);
  await page.locator('#advanced-basic').click(); await settled();
  check('Lossless return preserves results', (await view()).matching === representable.matching);

  await apply('library:owned OR title:/^portal$/i');
  check('Missing owned conditions are pruned from OR and leave a visible warning', (await view()).matching === 1 && await page.locator('#advanced-library-warning').isVisible());
  await page.locator('#advanced-library-warning').click();
  check('The warning opens the library panel', await page.locator('#library-picker').isVisible());
  await page.locator('#library-file').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ rgOwnedApps: [620], rgWishlist: [] })) });
  await page.waitForFunction(() => window.steamFeatureAtlas.getView().matching === 2 && !document.querySelector('#results').hasAttribute('aria-busy'));
  check('Import restores evaluation of the full expression without changing it', (await view()).filters.expression === 'library:owned OR title:/^portal$/i' && await page.locator('#advanced-library-warning').isHidden());
  const libraryURL = page.url();
  check('Shared URLs carry symbolic library terms without app IDs', libraryURL.includes('library') && !libraryURL.includes('620'));
  await apply('library:wishlist');
  check('An empty imported wishlist is evaluated instead of ignored', (await view()).matching === 0 && await page.locator('#advanced-library-warning').isHidden());
  await apply('library:owned OR title:/^portal$/i');
  await page.locator('#library-toggle').click(); await page.locator('#library-forget').click(); await settled();
  check('Forgetting a library restores missing-data fallback', (await view()).matching === 1 && await page.locator('#advanced-library-warning').isVisible());
  const prunedConversion = await apply('library:owned OR title:Portal');
  await page.locator('#advanced-basic').click(); await settled();
  check('Returning to basic filters preserves conditions left by a missing library list', (await view()).matching === prunedConversion.matching && (await view()).filters.q === 'Portal');
  await page.goto(libraryURL); await settled();
  check('Reload retains symbolic library conditions and warns when data is missing', (await view()).matching === 1 && await page.locator('#advanced-library-warning').isVisible());
  await page.locator('#advanced-library-warning').click();
  await page.locator('#library-file').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ rgOwnedApps: [620], rgWishlist: [] })) });
  await page.waitForFunction(() => window.steamFeatureAtlas.getView().matching === 2 && !document.querySelector('#results').hasAttribute('aria-busy'));
  const otherTab = await page.context().newPage();
  try {
    await otherTab.goto(base); await otherTab.waitForFunction(() => window.steamFeatureAtlas?.getView().page);
    await otherTab.locator('#library-toggle').click(); await otherTab.locator('#library-forget').click();
    await page.waitForFunction(() => window.steamFeatureAtlas.getView().matching === 1 && !document.getElementById('advanced-library-warning').hidden);
    check('Forgetting in another tab removes library terms without erasing the expression', (await view()).filters.expression === 'library:owned OR title:/^portal$/i');
  } finally { await otherTab.close(); }

  await apply('title:/^portal(?: 2)?$/i');
  for (const width of [320, 390, 800, 801, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await page.evaluate(() => ({ width: innerWidth, page: document.documentElement.scrollWidth, editor: document.getElementById('advanced-query').getBoundingClientRect().width }));
    check(`Editor fits at ${width}px`, layout.page <= width + 1 && layout.editor > 0 && layout.editor <= width);
    check(`Advanced control remains reachable at ${width}px`, await page.locator(width <= 800 ? '#filter-category' : '#advanced-toggle').isVisible());
    await editor.evaluate(e => { e.style.height = '180px'; });
    await editor.fill(('title:"' + 'Portal café 𐐷 '.repeat(12) + '" AND\n').repeat(8) + 'title:/^portal$/i\n');
    await editor.evaluate(e => { e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event('scroll')); });
    const mirror = await editor.evaluate(e => {
      const h = document.getElementById('advanced-highlights');
      return { text: h.textContent === e.value, viewport: h.clientWidth === e.clientWidth && h.clientHeight === e.clientHeight, height: Math.abs(h.scrollHeight - e.scrollHeight), scroll: Math.abs(h.scrollTop - e.scrollTop), scrolling: e.scrollTop > 0 };
    });
    check(`Highlighting follows wrapping and scrolling at ${width}px`, mirror.text && mirror.viewport && mirror.height <= 1 && mirror.scroll <= 1 && mirror.scrolling);
    await editor.evaluate(e => { e.style.height = ''; });
    await editor.fill('title:/^portal(?: 2)?$/i');
  }
  await page.emulateMedia({ forcedColors: 'active' });
  check('High contrast mode keeps native editor text visible', await editor.evaluate(e => getComputedStyle(e).color !== 'rgba(0, 0, 0, 0)' && getComputedStyle(document.getElementById('advanced-highlights')).visibility === 'hidden'));
  await page.emulateMedia({ forcedColors: 'none' });
  if (options.screenshotDirectory) {
    await page.screenshot({ path: options.screenshotDirectory + '/advanced-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: options.screenshotDirectory + '/advanced-mobile.png', fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await apply('title:/^portal(?: 2)?$/i');
  await editor.fill('title:/(.+)+\\uFFFF/'); await page.locator('#advanced-apply').click();
  await editor.fill('title:/^portal$/i');
  check('The editor stays usable during regex matching', await editor.inputValue() === 'title:/^portal$/i');
  await page.waitForFunction(() => !document.getElementById('error').hidden && /took too long|matching limit/.test(document.getElementById('error-message').textContent), null, { timeout: 15000 });
  await page.locator('#advanced-apply').click(); await settled();
  check('A stalled or engine-rejected regex can be replaced without reloading the page', (await view()).matching === 1 && (await view()).filters.expression === 'title:/^portal$/i');
  await page.waitForFunction(() => window.steamFeatureAtlas.getLoadState().creditsStatus === 'ready');
  // Simulate a worker stuck on one query so watchdog recovery is deterministic in both engines.
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage, stalled = new WeakSet();
    window.restoreQueryTestWorkers = () => { Worker.prototype.postMessage = post; };
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message.type === 'query' && message.query.expression === 'title:/review-stall/') { stalled.add(this); window.queryTestStalled = true; }
      if (!stalled.has(this)) return post.call(this, message, ...rest);
    };
  });
  await editor.fill('title:/review-stall/'); await page.locator('#advanced-apply').click();
  await page.waitForFunction(() => window.queryTestStalled);
  await editor.fill('title:/^portal(?: 2)?$/i'); await page.locator('#advanced-apply').click();
  await page.waitForFunction(() => window.steamFeatureAtlas.getView().filters.expression === 'title:/^portal(?: 2)?$/i' && window.steamFeatureAtlas.getView().matching === 2 && !document.getElementById('results').hasAttribute('aria-busy'), null, { timeout: 15000 });
  check('A newer applied query recovers automatically when an older regex stalls', await page.locator('#error').isHidden());
  await page.evaluate(() => window.restoreQueryTestWorkers());
  await page.locator('#reset').click(); await settled();
  check('Reset restores the basic defaults', (await view()).filters.expression === null && (await view()).matching === baseline.matching && await page.locator('#search').isEnabled());
  await page.goto(base + '?v=2&expr=' + encodeURIComponent('title:/['));
  await page.waitForFunction(() => !document.getElementById('advanced-error').hidden);
  check('Malformed shared expressions remain editable', await editor.inputValue() === 'title:/[' && await page.locator('#advanced-picker').isVisible());
  await apply('title:/^portal$/i');
  check('Malformed links can be repaired in place', (await view()).matching === 1);
  check('No uncaught browser errors', errors.length === 0);
  return { checks, errors };
}
