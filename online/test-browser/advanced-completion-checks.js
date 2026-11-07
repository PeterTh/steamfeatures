async (page, options = {}) => {
  const base = String(options.baseURL ?? 'http://127.0.0.1:4178/').replace(/\/+$/, '') + '/';
  const checks = [], errors = [];
  const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
  const editor = page.locator('#advanced-query'), popup = page.locator('#advanced-suggestions');
  const choices = popup.getByRole('option'), selected = popup.locator('[aria-selected="true"]');
  const settled = () => page.waitForFunction(() => window.steamFeatureAtlas?.getView().page && !document.querySelector('#results').hidden && !document.querySelector('#results').hasAttribute('aria-busy'));
  const passive = async name => check(name, await popup.isVisible() && await selected.count() === 0 && await editor.getAttribute('aria-activedescendant') === null);
  const type = async text => { await editor.fill(''); await editor.pressSequentially(text); };
  const caret = async position => {
    await editor.evaluate((e, position) => e.setSelectionRange(position, position), position);
    // Let the browser deliver its native selectionchange event.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const original = 'feature:/.*-controller-support/';
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '?v=2&expr=' + encodeURIComponent(original)); await settled();
  const appliedURL = page.url();

  // Reproduce the reported mouse interaction, not just a programmatic caret move.
  const field = await page.locator('#advanced-highlights .query-field').first().boundingBox();
  await page.mouse.click(field.x + 1, field.y + field.height / 2);
  check('Clicking the first character places the caret at the start of the query', await editor.evaluate(e => e.selectionStart === 0 && e.selectionEnd === 0));
  await passive('Clicking into existing text shows suggestions without selecting one');
  await editor.press('Enter');
  check('Enter at the start inserts a newline without duplicating feature:', await editor.inputValue() === '\n' + original);
  check('Inserting a line updates highlighting and line numbers without applying the draft', await editor.evaluate(e => document.getElementById('advanced-highlights').textContent === e.value && document.querySelectorAll('.advanced-line-number').length === 2) && page.url() === appliedURL);
  await editor.fill(original); await caret(3); await editor.press('Tab');
  check('Tab inside an existing field preserves its suffix, delimiter and value', await editor.inputValue() === original && await editor.evaluate(e => e.selectionStart === 'feature:'.length));

  await type('fea');
  check('Typing a field prefix selects its first completion accessibly', await selected.textContent() === 'feature' && await editor.getAttribute('aria-activedescendant') === await selected.getAttribute('id'));
  await editor.press('Enter');
  check('Enter accepts a completion while typing', await editor.inputValue() === 'feature:');
  await passive('Completing a field does not preselect an arbitrary value');
  await editor.press('Enter');
  check('A second Enter inserts a newline after the completed field', await editor.inputValue() === 'feature:\n');

  for (const text of ['', 'tag:', 'tag:"', 'language:english:', 'title:Portal AND ']) {
    await type(text); await editor.click();
    await passive(`The empty prefix in ${JSON.stringify(text)} stays unselected`);
    await editor.press('Enter'); await editor.press('Enter');
    check(`Consecutive Enter presses insert blank lines after ${JSON.stringify(text)}`, await editor.inputValue() === text + '\n\n');
  }
  await type('tag:"Turn-Based St');
  check('Typing a quoted value selects the matching tag', await selected.textContent() === 'Turn-Based Strategy');
  await editor.press('Enter');
  check('Enter completes and closes a quoted tag value', await editor.inputValue() === 'tag:"Turn-Based Strategy"');

  await type('fea'); await editor.press('ArrowLeft');
  await passive('Moving the caret with an arrow key clears automatic selection');
  await editor.press('Enter');
  check('Enter after caret movement inserts a newline into the existing word', await editor.inputValue() === 'fe\na');
  await type('fea'); await editor.press('Home'); await editor.press('End');
  await passive('Home and End also leave suggestions unselected');
  await editor.pressSequentially('t');
  check('Typing again resumes automatic completion selection', await selected.textContent() === 'feature');
  await caret(2);
  await passive('Other caret changes clear selection through the native selection event');

  await type(''); await editor.click(); await editor.press('ArrowDown');
  check('Down explicitly selects the first passive suggestion', await selected.textContent() === await choices.first().textContent());
  await editor.press('Enter');
  check('Enter accepts an explicitly selected suggestion', await editor.inputValue() === 'feature:');
  await type(''); await editor.click();
  const lastField = await choices.last().textContent();
  await editor.press('ArrowUp');
  check('Up from no selection chooses the last suggestion', await selected.textContent() === lastField);
  await editor.press('ArrowDown');
  check('Arrow navigation wraps through the suggestion list', await selected.textContent() === 'feature');
  await editor.press('ArrowDown'); await editor.press('Tab');
  check('Tab accepts the explicitly selected suggestion', await editor.inputValue() === 'tag:');
  await type('tag:'); await editor.click();
  const firstTag = await choices.first().textContent();
  await editor.press('Tab');
  check('Tab accepts the first suggestion even when none was selected', await editor.inputValue() === 'tag:' + (/^[\w.-]+$/.test(firstTag) ? firstTag : JSON.stringify(firstTag)));

  await type('tag:"Turn-Based St'); await editor.press('Shift+Enter');
  check('Shift+Enter inserts a newline instead of accepting an automatic completion', await editor.inputValue() === 'tag:"Turn-Based St\n');
  await type('fea'); await editor.press('Home'); await editor.press('End'); await editor.press('ArrowDown'); await editor.press('Shift+Enter');
  check('Shift+Enter also overrides explicit arrow-key selection', await editor.inputValue() === 'fea\n');
  await type('fea'); await editor.press('Escape');
  check('Escape dismisses suggestions', await popup.isHidden() && await editor.getAttribute('aria-activedescendant') === null);
  await editor.press('Enter');
  check('Enter after Escape inserts a newline', await editor.inputValue() === 'fea\n');
  await type('fea'); await editor.press('Shift+Tab');
  check('Shift+Tab keeps native reverse focus navigation without inserting a completion', await editor.inputValue() === 'fea' && await editor.evaluate(e => document.activeElement !== e));
  await type('fea'); await editor.press('Shift+ArrowLeft');
  check('Shift+arrow keeps native text selection and closes suggestions', await editor.evaluate(e => e.selectionStart === 2 && e.selectionEnd === 3) && await popup.isHidden());
  await editor.press('Shift+Enter');
  check('Shift+Enter replaces selected text with a newline', await editor.inputValue() === 'fe\n');

  await type('fea'); await editor.press('Backspace');
  check('Editing a nonempty prefix with Backspace still selects its completion', await selected.textContent() === 'feature');
  await editor.press('Backspace'); await editor.press('Backspace');
  await passive('Deleting the entire prefix clears automatic selection');
  await type('fea'); await editor.press('Shift+Enter'); await editor.press('Control+z');
  // Firefox groups the preceding typing with the newline; Edge undoes just the newline.
  check('Forced newlines retain native undo', ['', 'fea'].includes(await editor.inputValue()));
  await passive('Undo restores suggestions without preselecting a completion');
  await type('tag:"Turn-Based Ta'); await page.getByRole('option', { name: 'Turn-Based Tactics', exact: true }).click();
  check('Clicking a suggestion still completes its value', await editor.inputValue() === 'tag:"Turn-Based Tactics"');

  // Synthetic composition events cover the keyboard guard without relying on an installed IME.
  await type('fea');
  await editor.dispatchEvent('compositionstart', { data: '' });
  check('Starting composition hides suggestions', await popup.isHidden());
  check('Enter during composition is left to the IME', await editor.evaluate(e => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
    return e.dispatchEvent(event) && e.value === 'fea';
  }));
  await editor.dispatchEvent('compositionend', { data: 'a' });
  check('Finishing composition restores prefix completion', await selected.textContent() === 'feature');

  await editor.fill('title:/^portal(?: 2)?$/i'); await editor.press('Control+Enter'); await settled();
  check('Ctrl+Enter still applies the query without inserting text', await editor.inputValue() === 'title:/^portal(?: 2)?$/i' && await page.evaluate(() => window.steamFeatureAtlas.getView().matching === 2));
  await editor.fill('title:/^portal$/i'); await editor.press('Meta+Enter'); await settled();
  check('Cmd+Enter also applies through the same shortcut', await editor.inputValue() === 'title:/^portal$/i' && await page.evaluate(() => window.steamFeatureAtlas.getView().matching === 1));
  check('No uncaught browser errors', errors.length === 0);
  return { checks, errors };
}
