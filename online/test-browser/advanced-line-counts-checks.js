async (page, options = {}) => {
  const base = String(options.baseURL ?? 'http://127.0.0.1:4178/').replace(/\/+$/, '') + '/';
  const checks = [], errors = [];
  const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
  const editor = page.locator('#advanced-query');
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.getElementById('results').hasAttribute('aria-busy') && !document.getElementById('results').hidden);
  const view = () => page.evaluate(() => window.steamFeatureAtlas.getView());
  const counts = () => page.locator('.advanced-line-count').evaluateAll(badges => badges.map(e => ({ line: Number(e.dataset.line), count: Number(e.textContent.replaceAll(',', '')) })));
  const counted = () => page.waitForFunction(() => !document.getElementById('advanced-line-counts').hidden);
  const apply = async text => { await editor.fill(text); await page.locator('#advanced-apply').click(); await settled(); };
  const lines = [
    'feature:/.*-controller-support/ ',
    'AND (tag:"Turn-Based Combat" OR tag:"Turn-Based Strategy" OR tag:"Turn-Based Tactics") ',
    'AND tag:"Party-Based RPG" ',
    'AND ((reviews >= 10 AND rating >= 90) OR (reviews >= 200 AND rating >= 80)) ',
    'AND NOT feature:/.*co-op.*/ ',
    'AND NOT release:early-access AND NOT library:owned',
    'AND (language:english:interface OR language:german:interface)',
  ];
  const text = lines.join('\n');
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const manifest = await (await page.request.get(base + 'data/manifest.json')).json();
  const remainderPattern = '**/' + manifest.current.progressive.remainder.file + '*';
  let releaseRemainder;
  const remainderGate = new Promise(resolve => { releaseRemainder = resolve; });
  await page.route(remainderPattern, async route => { await remainderGate; await route.continue(); });
  try {
    await page.goto(base + '?v=2&expr=' + encodeURIComponent('feature:full-controller-support\nAND reviews >= 100')); await settled();
    check('Optional line counts do not delay results available from the priority catalog', !(await page.evaluate(() => window.steamFeatureAtlas.getLoadState())).fullReady && (await view()).matching > 0 && await page.locator('#advanced-line-counts').isHidden());
  } finally { releaseRemainder(); }
  await counted();
  check('Counts arrive from the full catalog, including earlier matches below the final review threshold', (await counts())[0].count > (await counts())[1].count && (await counts())[1].count === (await view()).matching && (await page.evaluate(() => window.steamFeatureAtlas.getLoadState())).fullReady);
  await page.unroute(remainderPattern);
  await page.goto(base + '?v=2&expr=' + encodeURIComponent('title:Portal')); await settled();
  check('A single-line editor has a line number even without applied counts', await page.locator('.advanced-line-number').allTextContents().then(numbers => numbers.join() === '1'));
  const expected = [];
  for (let line = 0; line < lines.length; line++) { await apply(lines.slice(0, line + 1).join(' ')); expected.push({ line, count: (await view()).matching }); }
  const started = Date.now();
  await apply(text); await counted();
  const countElapsedMs = Date.now() - started;
  check('Each of the seven example lines agrees with applying that complete prefix', JSON.stringify(await counts()) === JSON.stringify(expected));
  const changes = await page.locator('.advanced-line-change').evaluateAll(badges => badges.map(e => ({ text: e.textContent, title: e.title, removed: e.classList.contains('removed') })));
  check('Red changes compare with the previous step, starting from the full catalog', changes.every((change, i) => {
    const delta = expected[i].count - (i ? expected[i - 1].count : manifest.current.progressive.statistics.gameCount);
    return delta < 0 && change.removed && change.text === '−' + Math.abs(delta).toLocaleString('en-US') && change.title.includes(lines[i].trim());
  }));
  check('The first change explains its full-catalog baseline', changes[0].title.includes('Compared with all ' + manifest.current.progressive.statistics.gameCount.toLocaleString('en-US') + ' games.'));
  check('The final line count equals the results, and missing library data stays visibly explained', (await counts()).at(-1).count === (await view()).matching && await page.locator('#advanced-library-warning').isVisible());
  check('Line counts do not modify the query text or highlighted copy', await editor.inputValue() === text && await page.locator('#advanced-highlights').textContent() === text);
  check('The URL encodes line breaks and preserves spacing', page.url().includes('%0A') && new URL(page.url()).searchParams.get('expr') === text);
  await page.reload(); await settled(); await counted();
  check('Reload restores the multiline layout and its counts', await editor.inputValue() === text && JSON.stringify(await counts()) === JSON.stringify(expected));

  const appearance = await page.evaluate(() => {
    const button = document.getElementById('advanced-basic'), warning = document.getElementById('advanced-basic-warning');
    return { color: getComputedStyle(button).backgroundColor, warning: getComputedStyle(warning).color, shareWarning: getComputedStyle(document.getElementById('share-library-warning')).color,
      onRight: warning.getBoundingClientRect().left >= button.querySelector('span').getBoundingClientRect().right };
  });
  check('Return uses a red action and the same yellow warning icon on its right as Copy link', appearance.color === 'rgb(105, 62, 54)' && appearance.warning === appearance.shareWarning && appearance.onRight);
  await page.locator('#advanced-hint').click();
  check('Clicking the instructions does not open the syntax foldout', await page.locator('#advanced-help').isHidden());
  const toolbar = await page.locator('.advanced-help-toolbar').boundingBox();
  await page.mouse.click(toolbar.x + toolbar.width / 2, toolbar.y + toolbar.height / 2);
  check('Clicking the empty part of the help row does not open the foldout', await page.locator('#advanced-help').isHidden());
  await page.locator('#advanced-help-toggle').click();
  check('The Syntax & examples control opens the foldout', await page.locator('#advanced-help').isVisible());
  await page.locator('#advanced-help-toggle').press('Space');
  check('The syntax control remains keyboard accessible', await page.locator('#advanced-help').isHidden());

  for (const width of [2560, 1440, 801, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await editor.evaluate(e => { e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event('scroll')); });
    const alignment = await page.evaluate(() => {
      const e = document.getElementById('advanced-query'), h = document.getElementById('advanced-highlights'), anchors = h.querySelectorAll('.query-line-end'), starts = h.querySelectorAll('.query-line-start');
      const range = document.createRange(); range.selectNodeContents(h);
      const textRight = range.getBoundingClientRect().right;
      const countRects = [...document.querySelectorAll('.advanced-line-count')].map(e => e.getBoundingClientRect());
      return { fits: document.documentElement.scrollWidth <= innerWidth, text: e.value === h.textContent, scroll: Math.abs(e.scrollTop - h.scrollTop) < 1,
        close: countRects.every(rect => rect.left - textRight >= 10 && rect.left - textRight <= 18),
        columns: countRects.every(rect => Math.abs(rect.left - countRects[0].left) < 1 && Math.abs(rect.right - countRects[0].right) < 1),
        numbers: [...document.querySelectorAll('.advanced-line-number')].every((number, index) => {
          const rect = number.getBoundingClientRect(), start = starts[index].getBoundingClientRect();
          return number.textContent === String(index + 1) && Math.abs(rect.top + rect.height / 2 - start.top - start.height / 2) < 1 && rect.right < start.left;
        }),
        aligned: [...document.querySelectorAll('.advanced-line-count')].every(badge => {
          const rect = badge.getBoundingClientRect(), line = anchors[Number(badge.dataset.line)].getBoundingClientRect(), change = badge.nextElementSibling.getBoundingClientRect();
          return Math.abs(rect.top + rect.height / 2 - line.top - line.height / 2) < 1 && rect.left > line.right && change.left > rect.right && change.right <= e.getBoundingClientRect().right;
        }) };
    });
    check(`Counts align to logical line ends after wrapping and scrolling at ${width}px`, alignment.fits && alignment.text && alignment.scroll && alignment.aligned);
    check(`Count columns sit just beyond the widest text at ${width}px`, alignment.close && alignment.columns);
    check(`Line numbers align with logical line starts at ${width}px`, alignment.numbers);
  }
  if (options.screenshotDirectory) {
    await page.setViewportSize({ width: 1440, height: 1000 }); await editor.evaluate(e => { e.scrollTop = 0; });
    await page.screenshot({ path: options.screenshotDirectory + '/line-counts-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await editor.evaluate(e => { e.scrollTop = 0; });
    await page.screenshot({ path: options.screenshotDirectory + '/line-counts-mobile.png', fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await editor.fill(text + '\nAND title:Portal');
  check('Editing immediately hides stale counts', await page.locator('#advanced-line-counts').isHidden());
  check('Line numbers keep updating in an unapplied draft', (await page.locator('.advanced-line-number').allTextContents()).join() === '1,2,3,4,5,6,7,8');
  await page.locator('#sort').selectOption('title'); await settled();
  check('A background result never puts counts beside an unapplied draft', await page.locator('#advanced-line-counts').isHidden() && await editor.inputValue() === text + '\nAND title:Portal');
  await apply('title:/^Portal$/i\nOR title:/^Portal 2$/i\nAND reviews >= 20'); await counted();
  check('Cumulative counts respect OR precedence and can increase', JSON.stringify(await counts()) === JSON.stringify([{ line: 0, count: 1 }, { line: 1, count: 2 }, { line: 2, count: 2 }]));
  const added = page.locator('.advanced-line-change').nth(1), unchanged = page.locator('.advanced-line-change').nth(2);
  check('Added games use a green + badge and quote the responsible line', await added.textContent() === '+1' && (await added.getAttribute('class')).includes('added') && (await added.getAttribute('title')).includes('1 game added (net) by line 2:\nOR title:/^Portal 2$/i'));
  check('A zero change stays neutral', await unchanged.textContent() === '±0' && await unchanged.getAttribute('class') === 'advanced-line-change');
  await page.goBack(); await settled(); await counted();
  check('Back restores the original line breaks and counts', await editor.inputValue() === text && JSON.stringify(await counts()) === JSON.stringify(expected));
  await page.goForward(); await settled(); await counted();
  check('Forward restores the other multiline expression', (await editor.inputValue()).split('\n').length === 3 && (await counts()).length === 3);
  await apply('title:/^Portal$/i\nOR (\n title:/^Portal 2$/i\n AND reviews >= 20\n)\n'); await counted();
  check('Groups spanning lines get a count only when they close', JSON.stringify(await counts()) === JSON.stringify([{ line: 0, count: 1 }, { line: 4, count: 2 }]));
  check('Blank and continuation lines retain their actual line numbers', (await page.locator('.advanced-line-number').allTextContents()).join() === '1,2,3,4,5,6');
  check('A group change tooltip quotes the whole added group', (await page.locator('.advanced-line-change').nth(1).getAttribute('title')).includes('1 game added (net) by lines 2–5:\nOR (\n title:/^Portal 2$/i\n AND reviews >= 20\n)'));
  await apply('title:/^Portal$/i\nAND title:"not this game" OR title:/^Portal 2$/i'); await counted();
  check('A zero net change does not claim that the matching games are unchanged', (await view()).games[0].id === 620 && (await counts()).every(row => row.count === 1) && (await page.locator('.advanced-line-change').nth(1).getAttribute('title')).includes('No net change in result count'));
  await apply('title:/^Portal(?: 2)?$/i\nAND NOT library:owned'); await counted();
  const beforeLibrary = await counts();
  await page.locator('#library-toggle').click();
  await page.locator('#library-file').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ rgOwnedApps: [400], rgWishlist: [] })) });
  await page.waitForFunction(() => window.steamFeatureAtlas.getView().matching === 1 && document.querySelector('.advanced-count-row:last-child .advanced-line-count')?.textContent === '1');
  check('Library imports recompute counts without changing earlier prefixes', beforeLibrary[1].count === 2 && JSON.stringify(await counts()) === JSON.stringify([{ line: 0, count: 2 }, { line: 1, count: 1 }]));
  await page.locator('#library-forget').click();
  await page.waitForFunction(() => document.querySelector('.advanced-count-row:last-child .advanced-line-count')?.textContent === '2');
  check('Forgetting a library invalidates cached counts', (await view()).matching === 2);
  await page.locator('#advanced-toggle').click();
  // Drop count replies in this isolated page to exercise the watchdog in both engines.
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.restoreCountTestWorker = () => { window.Worker = NativeWorker; };
    window.Worker = class extends NativeWorker {
      addEventListener(type, listener, options) {
        return super.addEventListener(type, type === 'message' ? event => { if (event.data?.type !== 'line-counts') listener(event); } : listener, options);
      }
    };
  });
  await page.reload(); await settled();
  await page.waitForFunction(() => document.getElementById('advanced-draft-status').textContent.includes('line counts unavailable'), null, { timeout: 12000 });
  check('An unresponsive count calculation cannot erase a completed result', await page.locator('#results').isVisible() && await page.locator('#error').isHidden());
  await page.evaluate(() => window.restoreCountTestWorker());
  await apply('title:/^Portal$/i\nAND reviews >= 20'); await counted();
  check('Applying a new query recovers after a line-count limit', (await view()).matching === 1 && (await counts()).at(-1).count === 1);
  check('No uncaught browser errors', errors.length === 0);
  return { checks, errors, countElapsedMs, exampleCounts: expected };
}
