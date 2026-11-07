async (page, options = {}) => {
  const base = String(options.baseURL ?? 'http://127.0.0.1:4178/').replace(/\/+$/, '') + '/';
  const checks = [], errors = [];
  const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
  const text = '(title:"(Portal)" OR (title:/^(Portal|Half-Life)$/i AND NOT title:"(Stories)"))';
  const editor = page.locator('#advanced-query');
  const parentheses = page.locator('#advanced-highlights .query-parenthesis');
  const pair = () => parentheses.evaluateAll(spans => spans.flatMap((span, index) => span.classList.contains('query-parenthesis-match') ? [index] : []));
  const waitPair = expected => page.waitForFunction(expected => {
    const actual = [...document.querySelectorAll('#advanced-highlights .query-parenthesis')].flatMap((span, index) => span.classList.contains('query-parenthesis-match') ? [index] : []);
    return JSON.stringify(actual) === JSON.stringify(expected);
  }, expected);
  const caret = async position => { await editor.focus(); await editor.evaluate((e, position) => e.setSelectionRange(position, position), position); };
  const hoverParenthesis = async index => {
    const rect = await parentheses.nth(index).boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  };
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '?v=2&expr=' + encodeURIComponent(text));
  await page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.querySelector('#results').hidden && !document.querySelector('#results').hasAttribute('aria-busy'));
  await editor.fill(text);
  check('Only query parentheses are bold, excluding literal and regex parentheses', await parentheses.count() === 4 && await parentheses.first().evaluate(e => Number(getComputedStyle(e).fontWeight) >= 700));
  for (const [position, expected] of [[0, [0, 3]], [1, [0, 3]], [text.indexOf('(title:/'), [1, 2]], [text.length, [0, 3]]]) {
    await caret(position); await waitPair(expected);
    check(`The caret highlights the matching pair at character ${position}`, JSON.stringify(await pair()) === JSON.stringify(expected));
  }
  await caret(1); await editor.press('ArrowRight'); await waitPair([]);
  check('Arrow keys clear the pair when the caret leaves its boundary', (await pair()).length === 0);
  for (const position of [text.indexOf('(Portal)'), text.indexOf('(Portal|')]) {
    await caret(position); await waitPair([]);
    check(`Literal or regex parentheses do not match query groups at character ${position}`, (await pair()).length === 0);
  }
  await editor.evaluate(e => e.setSelectionRange(0, e.value.length)); await waitPair([]);
  check('A text selection does not highlight an unrelated pair', (await pair()).length === 0);
  await page.locator('#sort').focus(); await hoverParenthesis(1); await waitPair([1, 2]);
  check('Hover highlights both nested parentheses without moving focus or editing text', await page.locator('#sort').evaluate(e => document.activeElement === e) && await editor.inputValue() === text);
  await page.mouse.move(5, 5); await waitPair([]);
  await hoverParenthesis(3); await waitPair([0, 3]);
  check('Hovering a closing parenthesis highlights its opening partner', JSON.stringify(await pair()) === '[0,3]');
  await hoverParenthesis(1); await page.mouse.down(); await page.mouse.up(); await waitPair([1, 2]);
  check('Parentheses remain clickable as native editor text', await editor.evaluate((e, position) => document.activeElement === e && e.selectionStart === e.selectionEnd && [position, position + 1].includes(e.selectionStart), text.indexOf('(title:/')));
  await page.mouse.move(5, 5);
  await editor.fill('(title:Portal'); await caret(0); await waitPair([]);
  check('An unmatched parenthesis does not retain a stale partner', (await pair()).length === 0);
  await editor.fill('(title:Portal)'); await caret(0); await waitPair([0, 1]);
  check('Typing a closing parenthesis immediately restores matching', (await pair()).length === 2);
  await editor.press('Escape'); // Caret movement now opens passive suggestions above the help row.

  const header = await page.evaluate(() => {
    const box = document.getElementById('advanced-query').getBoundingClientRect();
    const summary = document.getElementById('advanced-help-toggle').getBoundingClientRect();
    const hint = document.getElementById('advanced-hint').getBoundingClientRect();
    return { direct: summary.top >= box.bottom && summary.top - box.bottom < 5, sameLine: hint.top >= summary.top && hint.bottom <= summary.bottom + 1, right: Math.abs(hint.right - box.right) < 1 };
  });
  check('Syntax help sits directly below the box, with its hint on the same line at the right edge', header.direct && header.sameLine && header.right);
  await page.locator('#advanced-help-toggle').click();
  check('The compact syntax foldout still opens its examples', await page.locator('[data-expression-example]').first().isVisible());
  await page.locator('#advanced-help-toggle').click();
  for (const width of [1440, 1920, 3440]) {
    await page.setViewportSize({ width, height: 1000 });
    const fits = await editor.evaluate(e => Math.abs(e.getBoundingClientRect().width - document.getElementById('advanced-picker').getBoundingClientRect().width) < 1 && e.clientWidth > 1120);
    check(`Desktop editor uses the available panel width at ${width}px`, fits);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const long = Array.from({ length: 16 }, (_, i) => `(title:"Portal (${i})" OR title:/^(Half-Life|Portal)$/i)`).join(' AND\n');
  await editor.fill(long);
  check('Desktop queries grow beyond the old 180px cap', await editor.evaluate(e => e.clientHeight > 180 && e.scrollHeight <= e.clientHeight + 1));
  await editor.scrollIntoViewIfNeeded();
  const rect = await editor.boundingBox();
  await page.mouse.move(rect.x + rect.width - 4, rect.y + rect.height - 4);
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width - 4, rect.y + 460, { steps: 12 }); await page.mouse.up();
  const draggedHeight = await editor.evaluate(e => e.clientHeight);
  check('The native resize handle allows a taller desktop editor', draggedHeight > 430);
  await editor.fill(text);
  check('Typing preserves a manually chosen height', await editor.evaluate((e, height) => Math.abs(e.clientHeight - height) < 1, draggedHeight));
  await page.setViewportSize({ width: 390, height: 844 });
  check('Compact screens retain a bounded editor', await editor.evaluate(e => e.getBoundingClientRect().height <= 180 && document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 1000 });
  check('Returning to desktop restores the chosen height', await editor.evaluate((e, height) => Math.abs(e.clientHeight - height) < 1, draggedHeight));
  await editor.evaluate(e => { e.style.height = '180px'; }); await editor.fill(long);
  await editor.scrollIntoViewIfNeeded(); await page.locator('#sort').focus();
  await editor.evaluate(e => { e.scrollTop = e.scrollHeight; });
  await page.waitForFunction(() => document.getElementById('advanced-query').scrollTop === document.getElementById('advanced-highlights').scrollTop);
  const last = await parentheses.count() - 1;
  await hoverParenthesis(last); await waitPair([last - 1, last]);
  check('Hover matching follows the scrolled text', JSON.stringify(await pair()) === JSON.stringify([last - 1, last]));
  check('Bold parentheses preserve text wrapping and scroll alignment', await editor.evaluate(e => Math.abs(e.scrollHeight - document.getElementById('advanced-highlights').scrollHeight) <= 1));
  await editor.evaluate(e => { e.style.height = ''; }); await editor.fill(text); await caret(text.indexOf('(title:/'));
  await waitPair([1, 2]); await editor.scrollIntoViewIfNeeded();
  if (options.screenshotDirectory) await page.screenshot({ path: options.screenshotDirectory + '/editor-parentheses-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (options.screenshotDirectory) await page.screenshot({ path: options.screenshotDirectory + '/editor-parentheses-mobile.png', fullPage: true });
  check('No uncaught browser errors', errors.length === 0);
  return { checks, errors };
}
