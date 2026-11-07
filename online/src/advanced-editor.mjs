import { parseExpression, basicExpression, expressionToBasic, expressionCompletions, expressionHighlights, EXPRESSION_LIMIT } from './query-expression.mjs';

/** Keep unapplied text and selection outside URL/query state. */
export function createAdvancedEditor({ catalog, query, libraryFilters, libraryAvailable, apply, returnBasic, layout }) {
  const $ = id => document.getElementById(id), input = $('advanced-query'), popup = $('advanced-suggestions');
  const highlights = $('advanced-highlights');
  const countLayer = $('advanced-line-counts'), numberLayer = $('advanced-line-numbers'), countFormat = new Intl.NumberFormat('en-US');
  let lastApplied, dirty = false, suggestions = [], selected = -1, timer, conversion;
  let composing = false, suggestionStart = 0, suggestionEnd = 0;
  let automaticHeight = '', editorWidth = 0, parentheses = new Map(), hoveredParenthesis = null, markedPair = [];
  let countResult = null, lineAnchors = [], lineStarts = [];
  const active = () => query().expression !== null;
  function draftStatus() {
    const failedCounts = !dirty && countResult?.text === query().expression && countResult.error;
    $('advanced-draft-status').textContent = active() ? dirty ? 'Unapplied changes' : failedCounts ? 'Applied · line counts unavailable' : 'Applied' : 'Basic filters remain active until you apply this query.';
    $('advanced-draft-status').title = failedCounts || '';
  }
  function renderCounts() {
    const current = !dirty && active() && countResult?.text === query().expression && countResult.text === input.value;
    const counts = current ? countResult.counts ?? [] : [];
    const source = input.value.split('\n');
    input.parentElement.classList.toggle('has-line-counts', counts.length > 0);
    countLayer.hidden = !counts.length; countLayer.replaceChildren();
    let previousCount = catalog().gameCount, previousLine = -1, countDigits = 1, changeDigits = 1;
    for (const { line, count } of counts) {
      const row = document.createElement('span'); row.className = 'advanced-count-row'; row.dataset.line = String(line); row.setAttribute('role', 'listitem');
      const badge = document.createElement('span'); badge.className = 'advanced-line-count'; badge.dataset.line = String(line);
      badge.textContent = countFormat.format(count); badge.title = `${badge.textContent} games match the query through line ${line + 1}.`;
      badge.setAttribute('aria-label', badge.title); row.append(badge);
      const change = document.createElement('span'), delta = Number.isFinite(previousCount) ? count - previousCount : null;
      change.className = 'advanced-line-change' + (delta > 0 ? ' added' : delta < 0 ? ' removed' : '');
      change.textContent = delta === null ? '—' : delta === 0 ? '±0' : `${delta > 0 ? '+' : '−'}${countFormat.format(Math.abs(delta))}`;
      let firstLine = previousLine + 1;
      while (firstLine < line && !source[firstLine].trim()) firstLine++;
      const label = firstLine === line ? `line ${line + 1}` : `lines ${firstLine + 1}–${line + 1}`;
      const condition = source.slice(firstLine, line + 1).join('\n').trim();
      const effect = delta === null ? 'Change unavailable' : delta === 0 ? 'No net change in result count' : `${countFormat.format(Math.abs(delta))} ${Math.abs(delta) === 1 ? 'game' : 'games'} ${delta > 0 ? 'added' : 'removed'} (net)`;
      change.title = `${effect} by ${label}:\n${condition}` + (previousLine < 0 && delta !== null ? `\nCompared with all ${countFormat.format(previousCount)} games.` : '');
      change.setAttribute('aria-label', change.title); row.append(change); countLayer.append(row);
      countDigits = Math.max(countDigits, badge.textContent.length); changeDigits = Math.max(changeDigits, change.textContent.length);
      previousCount = count; previousLine = line;
    }
    countLayer.style.setProperty('--count-total-size', `calc(${countDigits}ch + .6rem)`);
    countLayer.style.setProperty('--count-change-size', `calc(${changeDigits}ch + .6rem)`);
    draftStatus();
  }
  function sizeCountGutter() {
    const width = countLayer.hidden ? 0 : countLayer.getBoundingClientRect().width;
    const value = (width ? Math.ceil(width) + 16 : 0) + 'px';
    if (input.parentElement.style.getPropertyValue('--query-count-width') === value) return false;
    input.parentElement.style.setProperty('--query-count-width', value); return true;
  }
  function positionDecorations() {
    const origin = highlights.getBoundingClientRect();
    numberLayer.style.height = input.clientHeight + 'px';
    const numberPositions = [...numberLayer.children].map(number => {
      const rect = lineStarts[Number(number.dataset.line)].getBoundingClientRect();
      return [number, rect.top - origin.top + (rect.height - number.offsetHeight) / 2];
    });
    for (const [number, top] of numberPositions) number.style.top = top + 'px';
    if (!countLayer.hidden) {
      countLayer.style.height = input.clientHeight + 'px';
      // The union includes every wrapped text fragment, not only logical line ends.
      const range = document.createRange(); range.selectNodeContents(highlights);
      const right = range.getBoundingClientRect().right;
      const left = Math.min(right - origin.left + input.clientLeft + 16, input.clientLeft + input.clientWidth - countLayer.getBoundingClientRect().width - 8);
      const positions = [...countLayer.children].flatMap(row => {
        const anchor = lineAnchors[Number(row.dataset.line)]; if (!anchor) return [];
        const rect = anchor.getBoundingClientRect();
        return [[row, rect.top - origin.top + (rect.height - row.offsetHeight) / 2]];
      });
      countLayer.style.left = left + 'px';
      for (const [row, top] of positions) row.style.top = top + 'px';
    }
  }
  function setCounts(text, counts, error) {
    countResult = text === null ? null : { text, counts, error };
    renderCounts(); fitHeight(); syncHighlightViewport(); layout();
  }
  function close() {
    suggestions = []; selected = -1; popup.hidden = true; popup.replaceChildren();
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
    suggestionStart = input.selectionStart; suggestionEnd = input.selectionEnd;
  }
  function error(message = '') {
    $('advanced-error').textContent = message; $('advanced-error').hidden = !message;
    input.setAttribute('aria-invalid', String(!!message)); layout();
  }
  function validate() {
    try {
      const text = input.value; parseExpression(text, catalog());
      dirty = !active() || text !== query().expression;
      error(); renderCounts(); fitHeight(); syncHighlightViewport();
      return text;
    } catch (e) {
      dirty = true;
      error(`At character ${(e.start ?? 0) + 1}: ${e.message}`);
      $('advanced-draft-status').textContent = 'Unapplied changes'; return null;
    }
  }
  function syncHighlightViewport() {
    if (sizeCountGutter()) fitHeight();
    // Use the textarea's inner viewport so wrapped lines also align beside a scrollbar.
    highlights.style.width = input.clientWidth + 'px'; highlights.style.height = input.clientHeight + 'px';
    highlights.scrollTop = input.scrollTop; highlights.scrollLeft = input.scrollLeft;
    positionDecorations();
  }
  function markParentheses() {
    let current = parentheses.get(hoveredParenthesis);
    if (!current && document.activeElement === input && input.selectionStart === input.selectionEnd) {
      current = parentheses.get(input.selectionStart) ?? parentheses.get(input.selectionStart - 1);
    }
    const match = parentheses.get(current?.match);
    const next = match ? [current.span, match.span] : [];
    if (next.length === markedPair.length && next.every(span => markedPair.includes(span))) return;
    for (const span of markedPair) span.classList.remove('query-parenthesis-match');
    for (const span of next) span.classList.add('query-parenthesis-match');
    markedPair = next;
  }
  function highlight() {
    const text = input.value, fragment = document.createDocumentFragment(); let offset = 0;
    lineAnchors = []; lineStarts = [];
    const anchor = (parent, start = false) => {
      const span = document.createElement('span'); span.className = start ? 'query-line-start' : 'query-line-end'; parent.append(span); (start ? lineStarts : lineAnchors).push(span);
    };
    const append = (parent, value) => {
      if (text.length > EXPRESSION_LIMIT) { parent.append(document.createTextNode(value)); return; }
      const lines = value.split('\n');
      lines.forEach((line, index) => { parent.append(document.createTextNode(line)); if (index < lines.length - 1) { anchor(parent); parent.append(document.createTextNode('\n')); anchor(parent, true); } });
    };
    anchor(fragment, true);
    parentheses = new Map(); hoveredParenthesis = null;
    for (const { start, end, kind, match } of expressionHighlights(text)) {
      append(fragment, text.slice(offset, start));
      const span = document.createElement('span'); span.className = `query-${kind}`; append(span, text.slice(start, end)); fragment.append(span);
      if (kind === 'parenthesis') parentheses.set(start, { span, match });
      offset = end;
    }
    append(fragment, text.slice(offset)); anchor(fragment); highlights.replaceChildren(fragment);
    numberLayer.replaceChildren(); numberLayer.hidden = text.length > EXPRESSION_LIMIT;
    if (!numberLayer.hidden) lineStarts.forEach((_, line) => {
      const number = document.createElement('span'); number.className = 'advanced-line-number'; number.dataset.line = String(line); number.textContent = String(line + 1); numberLayer.append(number);
    });
    input.parentElement.style.setProperty('--query-line-digits', Math.max(2, String(lineStarts.length).length) + 'ch');
    markParentheses(); renderCounts();
  }
  function fitHeight() {
    // Native dragging changes the inline height. Keep that choice on later edits.
    if (!input.style.height || input.style.height === automaticHeight) {
      input.style.height = 'auto'; input.style.height = Math.max(66, input.scrollHeight + 2) + 'px';
      automaticHeight = input.style.height;
    }
  }
  function resize() {
    highlight(); fitHeight();
    syncHighlightViewport(); layout();
  }
  input.addEventListener('scroll', () => { hoveredParenthesis = null; syncHighlightViewport(); markParentheses(); });
  new ResizeObserver(() => {
    if (input.clientWidth !== editorWidth) { editorWidth = input.clientWidth; if (editorWidth) fitHeight(); }
    syncHighlightViewport(); layout();
  }).observe(input);
  input.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    hoveredParenthesis = null;
    for (const [position, { span }] of parentheses) {
      const rect = span.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom) { hoveredParenthesis = position; break; }
    }
    markParentheses();
  });
  input.addEventListener('pointerleave', () => { hoveredParenthesis = null; markParentheses(); });
  input.addEventListener('focus', markParentheses);
  document.addEventListener('selectionchange', () => {
    if (document.activeElement !== input) return;
    hoveredParenthesis = null; markParentheses();
    // Input already recorded its new caret; don't deselect typing's completion on the queued event.
    if (!composing && (input.selectionStart !== suggestionStart || input.selectionEnd !== suggestionEnd)) suggest();
  });
  function markSelection() {
    for (const [i, option] of [...popup.children].entries()) option.setAttribute('aria-selected', String(i === selected));
    if (selected >= 0) { input.setAttribute('aria-activedescendant', popup.children[selected].id); popup.children[selected].scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function insert(index) {
    const suggestion = suggestions[index]; if (!suggestion) return;
    input.focus({ preventScroll: true }); input.setRangeText(suggestion.text, suggestion.start, suggestion.end, 'end');
    dirty = true; close(); resize(); validate(); suggest();
  }
  function suggest(typing = false) {
    if (composing || document.activeElement !== input || input.selectionStart !== input.selectionEnd) { close(); return; }
    suggestionStart = input.selectionStart; suggestionEnd = input.selectionEnd;
    suggestions = expressionCompletions(input.value, suggestionStart, catalog());
    const prefix = suggestions.length ? input.value.slice(suggestions[0].start, suggestionStart).replace(/^"/, '').trim() : '';
    selected = typing && prefix ? 0 : -1;
    popup.replaceChildren(); popup.hidden = !suggestions.length; input.setAttribute('aria-expanded', String(!!suggestions.length));
    suggestions.forEach((suggestion, index) => {
      const option = document.createElement('div'); option.id = `advanced-option-${index}`; option.setAttribute('role', 'option');
      option.textContent = suggestion.label; option.addEventListener('pointerdown', e => e.preventDefault()); option.addEventListener('click', () => insert(index)); popup.append(option);
    });
    markSelection();
  }
  function submit() {
    clearTimeout(timer); const text = validate(); if (text === null) {
      try { parseExpression(input.value, catalog()); } catch (e) { input.focus(); input.setSelectionRange(e.start ?? 0, Math.max((e.start ?? 0) + 1, e.end ?? 0)); }
      return;
    }
    close(); lastApplied = text; dirty = false; apply(text); sync();
  }
  function sync(reset = false) {
    const expression = query().expression;
    if (expression !== lastApplied || reset) {
      lastApplied = expression; dirty = false; clearTimeout(timer); close(); error();
      input.value = expression ?? ''; resize();
    }
    $('advanced-active').hidden = !active(); $('active-advanced-count').textContent = active() ? 'On' : '0';
    $('advanced-basic').hidden = !active(); $('advanced-basic').removeAttribute('title');
    if (active()) {
      conversion = expressionToBasic(expression, catalog(), libraryAvailable());
      const omitted = conversion.omitted;
      $('advanced-basic-warning').toggleAttribute('hidden', !omitted.length);
      if (omitted.length) $('advanced-basic').title = `Returning to basic filters will remove: ${omitted.join('; ')}. Back restores the advanced query.`;
    }
    draftStatus();
  }
  function open() {
    if (!active() && !dirty) input.value = basicExpression(query(), catalog(), libraryFilters());
    resize();
  }
  input.addEventListener('input', e => {
    dirty = true; resize(); clearTimeout(timer);
    if (composing || e.isComposing) { close(); return; }
    const typing = /^(?:insertText|insertReplacementText|deleteContentBackward|deleteContentForward|deleteWordBackward|deleteWordForward)$/.test(e.inputType) && !/[\r\n]/.test(e.data ?? '');
    suggest(typing); timer = setTimeout(validate, 200);
  });
  input.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); close(); });
  input.addEventListener('compositionend', () => { composing = false; suggest(true); clearTimeout(timer); timer = setTimeout(validate, 200); });
  input.addEventListener('click', () => suggest());
  input.addEventListener('keyup', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) suggest(); });
  input.addEventListener('keydown', e => {
    if (composing || e.isComposing) return;
    if (e.key === 'Enter' && e.shiftKey) { close(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape') { close(); return; }
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter') {
      if (selected >= 0) { e.preventDefault(); insert(selected); }
      else close();
    } else if (suggestions.length && e.key === 'Tab') { e.preventDefault(); insert(selected >= 0 ? selected : 0); }
    else if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault(); selected = selected < 0 ? e.key === 'ArrowDown' ? 0 : suggestions.length - 1 : (selected + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      markSelection();
    }
  });
  input.addEventListener('blur', () => { close(); markParentheses(); });
  $('advanced-apply').addEventListener('click', submit);
  $('advanced-basic').addEventListener('click', () => { close(); clearTimeout(timer); dirty = false; returnBasic(conversion); });
  $('advanced-help-toggle').addEventListener('click', () => {
    $('advanced-help').hidden = !$('advanced-help').hidden;
    $('advanced-help-toggle').setAttribute('aria-expanded', String(!$('advanced-help').hidden)); layout();
  });
  for (const button of document.querySelectorAll('[data-expression-example]')) button.addEventListener('click', () => { input.value = button.dataset.expressionExample; dirty = true; input.focus(); resize(); validate(); });
  return { sync, open, close, submit, setCounts, clearCounts() { setCounts(null); }, loadInvalid(text, failure) { input.value = text; dirty = true; error(failure.message); resize(); } };
}
