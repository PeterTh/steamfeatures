function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Prototype source anchor changed: ' + before.slice(0, 70));
  return source.replace(before, after);
}

/** Build a local experimental app without editing the deployed entry point. */
export function prototypeApp(source) {
  source = replaceOnce(source, 'function startWorker() {', `let fullWorker, fullReady = false, backgroundStarted = false, backgroundError = null, pendingFullQuery = false, lastSubmittedQuery = null, completedRequest = 0, fullReadyAt = null;
function startWorker() {
  fullWorker?.terminate(); fullWorker = null; fullReady = false; backgroundStarted = false; backgroundError = null; pendingFullQuery = false; lastSubmittedQuery = null; completedRequest = 0; fullReadyAt = null;
  $('catalog-progress').hidden = true; $('catalog-retry').hidden = true;`);
  source = replaceOnce(source, "  worker.addEventListener('error', () => showError('The catalog worker could not start. Reload this page or try a browser that supports module workers.', true));",
    "  worker.addEventListener('error', ({ target }) => { if (target === worker) showError('The catalog worker could not start. Reload this page or try a browser that supports module workers.', true); });");
  source = replaceOnce(source, "  worker.addEventListener('message', ({ data: message }) => {",
    "  worker.addEventListener('message', ({ target, data: message }) => {\n    if (target !== worker) return;");
  source = replaceOnce(source, "      data = message; data.tags", "      fullReady = !message.progressive.partial; data = message; data.tags");
  const block = /    if \(message.type === 'result' && message.requestId === latestRequest\) \{([\s\S]*?)\n    \}\n  \}\);/;
  const match = source.match(block);
  if (!match) throw new Error('Prototype result handler anchor changed.');
  const receiveResult = `function receiveResult(message) {
    if (message.type !== 'result' || message.requestId !== latestRequest) return;
    completedRequest = message.requestId;
${match[1]}
    if (data.progressive.partial && !backgroundStarted) requestAnimationFrame(() => requestAnimationFrame(() => startBackgroundCatalog()));
}`;
  source = source.replace(block, '    receiveResult(message);\n  });');
  source = replaceOnce(source, "worker.postMessage({ type: 'init', manifestURL: new URL('./data/manifest.json', location.href).href });",
    "worker.postMessage({ type: 'init', minReviews: new URLSearchParams(location.search).get('minReviews') ?? 20, manifestURL: new URL('./data/manifest.json', location.href).href });");
  source = replaceOnce(source, "  worker.postMessage({ type: 'query', requestId: latestRequest, query: state });", `  pendingFullQuery = false;
  lastSubmittedQuery = { requestId: latestRequest, query: state };
  if (!data.progressive.partial || state.minReviews >= 20) worker.postMessage({ type: 'query', ...lastSubmittedQuery });
  else {
    pendingFullQuery = true;
    startBackgroundCatalog();
    $('catalog-progress').hidden = false;
    $('catalog-status').textContent = backgroundError ? 'More games could not load. Retry to use this filter.' : 'Loading more games to apply this filter…';
  }`);
  source = source.replace(' Data file:', ' Initial data file:');
  source += `\n${receiveResult}
function backgroundFailed(message) {
  backgroundError = message;
  $('catalog-progress').hidden = false; $('catalog-retry').hidden = false;
  $('catalog-status').textContent = 'More games could not load. Games with at least 20 reviews are still available.';
  if (pendingFullQuery) showError('The complete catalog could not load. Retry, or raise the review minimum to 20.');
}
function startBackgroundCatalog(retry = false) {
  if (!data.progressive.partial || fullReady || (backgroundStarted && !retry)) return;
  fullWorker?.terminate(); backgroundStarted = true; backgroundError = null;
  $('catalog-progress').hidden = false; $('catalog-retry').hidden = true;
  $('catalog-status').textContent = pendingFullQuery ? 'Loading more games to apply this filter…' : 'Loading games with fewer reviews…';
  fullWorker = new Worker(new URL('./filter-worker.js', import.meta.url), { type: 'module' });
  fullWorker.addEventListener('error', ({ target }) => {
    if (target !== fullWorker) return;
    if (target === worker) showError('The catalog worker stopped. Reload this page to try again.', true);
    else backgroundFailed('The background worker could not start.');
  });
  fullWorker.addEventListener('message', ({ target, data: message }) => {
    if (target !== fullWorker) return;
    if (message.type === 'error') {
      if (target !== worker) backgroundFailed(message.message);
      else if (message.requestId == null || message.requestId === latestRequest) showError(message.message, !ready);
      return;
    }
    if (message.type === 'ready') {
      if (fullReady) return;
      fullReady = true; fullReadyAt = performance.now();
      // Switch references on the main thread; the full index stays in its worker.
      const previous = worker; worker = fullWorker;
      data.progressive.partial = false;
      $('catalog-progress').hidden = true;
      pendingFullQuery = false;
      previous.terminate();
      // A terminated worker may have an outstanding result. Reissue only the
      // latest submitted query, never a newer search draft awaiting its debounce.
      if (lastSubmittedQuery?.requestId === latestRequest && completedRequest !== latestRequest) worker.postMessage({ type: 'query', ...lastSubmittedQuery });
    } else receiveResult(message);
  });
  fullWorker.postMessage({ type: 'init', mode: 'full', plan: data.progressive.plan });
}
$('catalog-retry').addEventListener('click', () => startBackgroundCatalog(true));
window.steamFeatureAtlas = Object.freeze({ getView, setFilters, getLoadState: () => ({ fullReady, backgroundStarted, backgroundError, pendingFullQuery, fullReadyAt, partial: data.progressive?.partial === true }) });
`;
  return source;
}

export function prototypeHTML(source) {
  return replaceOnce(source, '    <div id="loading"', '    <p id="catalog-progress" class="language-help" role="status" hidden><span id="catalog-status"></span> <button id="catalog-retry" class="subtle-button" type="button" hidden>Retry</button></p>\n    <div id="loading"');
}
