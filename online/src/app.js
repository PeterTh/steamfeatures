import { DEFAULT_QUERY, PRESETS, normalizeQuery, parseQuery, serializeQuery } from './query.mjs';
import { parseView, serializeView } from './view-state.mjs';

const $ = id => document.getElementById(id);
const fmt = n => n == null ? 'Unknown' : new Intl.NumberFormat('en-US').format(n);
const date = value => value && !Number.isNaN(Date.parse(value)) ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value)) : 'Unknown';
const groupColors = { 'Play modes': '#709de0', Controllers: '#b4a0e8', 'Steam features': '#69baa9', Creation: '#e0b775', 'Remote Play': '#6bb8d2', 'Display & VR': '#d095b7', Accessibility: '#becb77' };
let data = {}, features = new Map(), games = new Map(), state = { ...DEFAULT_QUERY }, view = [], visibleFeatures = [], matching = 0;
let tagOptionsBuilt = false;
let worker, ready = false, requestId = 0, latestRequest = 0, latestResult = null, inputTimer;
let tipAnchor = null, tipPinned = false, currentColumn = null, suppressFocusTip = false, columnCells = new Map();
let tipHideTimer, focusFeatureAfterRender = null;
let highlightedFeature = null, revealHighlightPending = false;
let requestedSearch = null, activeQueryRequest = 0;
let layoutFrame;

  const paths = {
    warning: '<path d="M12 3 2 21h20ZM12 9v5m0 3v1"/>',
    link: '<path d="m10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 -1)"/>',
    plus: '<path d="M4 12h16M12 4v16"/>',
    minus: '<path d="M4 12h16"/>',
    person: '<circle cx="12" cy="7" r="3"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/>',
    people: '<circle cx="9" cy="7" r="3"/><path d="M2 21v-3a7 7 0 0 1 14 0v3M17 4a3 3 0 0 1 0 6m2 4a6 6 0 0 1 3 5v2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    swords: '<path d="m4 3 16 17m-5-1 4-4M3 4l1 5 5-5Zm17-1L4 20m1-5 4 4m7-15 4 5 1-6Z"/>',
    network: '<rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v5M5 17v-5h14v5"/>',
    split: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M12 4v14M8 22h8m-4-4v4"/>',
    handshake: '<path d="m2 9 4-5 6 1 5-1 5 5-8 10-3 1-9-9m4-5 7 7 3-3m-9 6 3-3m0 6 3-3M2 9l4 3m16-3-4 3"/>',
    cross: '<rect x="1" y="3" width="9" height="7" rx="1"/><rect x="14" y="14" width="9" height="7" rx="1"/><path d="M17 3h4v7m-3-3 3 3 2-3M7 21H3v-7m-2 3 2-3 3 3"/>',
    gamepad: '<path d="M7 7h10c3 0 5 10 4 12-1 2-4-2-5-3H8c-1 1-4 5-5 3C2 17 4 7 7 7ZM6 11v5m-2-3h5"/><circle cx="16" cy="11" r=".7"/><circle cx="18" cy="14" r=".7"/>',
    sliders: '<path d="M5 3v5m0 5v8m7-18v10m0 5v3m7-18v3m0 5v10M2 8h6v5H2Zm7 5h6v5H9Zm7-7h6v5h-6Z"/>',
    motion: '<circle cx="9" cy="6" r="4"/><path d="m7 10 2 11h4l-2-11m5-6q5 2 3 7m-2-5q2 1 1 4"/>',
    trophy: '<path d="M7 3h10v7a5 5 0 0 1-10 0ZM7 5H3v3a4 4 0 0 0 4 4m10-7h4v3a4 4 0 0 1-4 4m-5 3v6m-5 0h10"/>',
    cards: '<rect x="8" y="5" width="12" height="16" rx="2"/><path d="M5 18H3V2h12v1m-3 8 2-2 2 2-2 2Z"/>',
    cloud: '<path d="M7 19h11a5 5 0 0 0 0-10 7 7 0 0 0-13-1A6 6 0 0 0 7 19Z"/>',
    chart: '<path d="M3 3v18h18M7 17v-4m5 4V8m5 9V5"/>',
    podium: '<path d="M2 12h6v9H2Zm6-7h8v16H8Zm8 11h6v5h-6ZM12 1v1"/>',
    wrench: '<path d="M21 3a6 6 0 0 1-8 8L5 21l-3-3 10-8a6 6 0 0 1 8-8l-4 4 2 2Z"/>',
    cart: '<path d="M2 3h3l3 13h11l3-10H6"/><circle cx="9" cy="21" r="1"/><circle cx="18" cy="21" r="1"/>',
    shield: '<path d="m12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5Zm-5 9 3 3 6-6"/>',
    timeline: '<path d="M2 12h20M6 3v4m6 10v4m6-18v4"/><circle cx="6" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="18" cy="12" r="2"/>',
    bell: '<path d="M4 18h16l-2-4V9a6 6 0 0 0-12 0v5Zm6 3h4"/>',
    pencil: '<path d="m3 16 13-13 5 5L8 21l-6 1Zm11-11 5 5M3 16l5 5"/>',
    code: '<path d="m8 5-7 7 7 7m8-14 7 7-7 7M14 3l-4 18"/>',
    mic: '<rect x="8" y="2" width="8" height="13" rx="4"/><path d="M4 10v1a8 8 0 0 0 16 0v-1m-8 9v3m-4 0h8"/>',
    phone: '<rect x="6" y="1" width="12" height="22" rx="2"/><path d="M11 19h2"/>',
    tablet: '<rect x="3" y="1" width="18" height="22" rx="2"/><path d="M11 19h2"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v5m-5 0h10"/>',
    broadcast: '<path d="M5 4a12 12 0 0 0 0 16M19 4a12 12 0 0 1 0 16M8 7a7 7 0 0 0 0 10M16 7a7 7 0 0 1 0 10"/><circle cx="12" cy="12" r="2"/>',
    sun: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
    vr: '<path d="M5 6h14l3 3v9h-6l-4-4-4 4H2V9Z"/><circle cx="7" cy="11" r="2"/><circle cx="17" cy="11" r="2"/>',
    cube: '<path d="m12 2 10 5v10l-10 5-10-5V7Zm0 10 10-5M2 7l10 5v10"/>',
    captions: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M10 9H6v6h4m8-6h-4v6h4"/>',
    text: '<path d="M2 4h13M8.5 4v17m-4 0h8m2-13h8m-4 0v13m-3 0h6"/>',
    palette: '<path d="M12 2a10 10 0 1 0 0 20c4 0-2-5 2-5h3a7 7 0 0 0 0-14Z"/><circle cx="7" cy="8" r="1"/><circle cx="12" cy="6" r="1"/><circle cx="17" cy="8" r="1"/>',
    camera: '<path d="M3 7h5l2-3h4l2 3h5v14H3Z"/><circle cx="12" cy="14" r="4"/>',
    speaker: '<path d="M2 9h4l6-5v16l-6-5H2ZM16 8q4 4 0 8m3-11q7 7 0 14"/>',
    chat: '<path d="M3 3h18v14H8l-5 5Zm4 5h10M7 12h7"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v7l4 2"/>',
    keyboard: '<rect x="1" y="5" width="22" height="14" rx="2"/><path d="M5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M7 16h10"/>',
    mouse: '<rect x="6" y="1" width="12" height="22" rx="6"/><path d="M12 2v7M6 10h12"/>',
    touch: '<path d="M9 13V4a2 2 0 0 1 4 0v7l5 1 3 2-3 8H9l-6-8 2-2 4 4M4 5V3m13 2V3"/>',
    save: '<path d="M3 2h15l4 4v16H2V2Zm4 0v7h9V2M7 22v-9h10v9"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM3 3l18 18"/><circle cx="12" cy="12" r="3"/>',
    contrast: '<circle cx="12" cy="12" r="10"/><path d="M12 2v20"/><path d="M12 2a10 10 0 0 1 0 20Z" fill="currentColor" stroke="none"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 11v7M12 6v1"/>',
    external: '<path d="M14 2h8v8m0-8L10 14M10 3H3v18h18v-7"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0"/>'
  };
  $('icon-defs').innerHTML = Object.entries(paths).map(([id, path]) => `<symbol id="icon-${id}" viewBox="0 0 24 24">${path}</symbol>`).join('');
  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function icon(name) { const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); node.setAttribute('class', 'icon'); node.setAttribute('aria-hidden', 'true'); const use = document.createElementNS(node.namespaceURI, 'use'); use.setAttribute('href', '#icon-' + name); node.append(use); return node; }
  function tipTrigger(node, kind, id) { node.dataset.tip = kind; node.dataset.id = id; return node; }
  function link(url, label, className, text) { const a = element('a', className, text); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.setAttribute('aria-label', label); return a; }

  function render() {
    hideTip(); highlightColumn(null); columnCells = new Map();
    view = latestResult.rows.map(g => ({ ...g, featureSet: new Set(g.featureIds) })); games = new Map(view.map(g => [g.id,g])); matching = latestResult.total; visibleFeatures = latestResult.columns.map(id => features.get(id));
    $('result-summary').textContent = `${fmt(matching)} matching games · ${visibleFeatures.length} counted features · ${latestResult.maxScore}-point scale`;
    $('page-summary').textContent = 'Page ' + fmt(latestResult.page) + ' of ' + fmt(latestResult.pageCount);
    $('page').value = latestResult.page; $('page').max = latestResult.pageCount;
    $('previous').disabled = latestResult.page <= 1; $('next').disabled = latestResult.page >= latestResult.pageCount;
    $('view-note').hidden = !state.not.length;
    $('view-note').textContent = 'Excluded features are not listed in the source snapshot. This does not verify whether they work in the game. Records with unknown feature data are excluded.';
    const first = element('tr', 'group-row'), second = element('tr', 'feature-row');
    for (const [kind, title] of [['rank', '#'], ['game', 'Game'], ['score', 'Score']]) {
      const th = element('th', 'corner fixed-' + kind); th.rowSpan = 2; th.scope = 'col';
      if (kind === 'score') { th.append(element('span', 'corner-count', title), element('span', 'corner-pool', 'of ' + latestResult.maxScore)); th.title = 'Weighted feature score. Hover feature icons for their point values.'; }
      else th.textContent = title;
      first.append(th);
    }
    for (const group of [...new Set(visibleFeatures.map(f => f.group))]) {
      const members = visibleFeatures.filter(f => f.group === group), th = element('th', 'group-start', group); th.colSpan = members.length; th.scope = 'colgroup'; th.style.setProperty('--group-color', groupColors[group]); first.append(th);
      if (members.length === 1) { th.classList.add('group-single'); th.title = group; th.textContent = group === 'Play modes' ? 'Play' : group; }
    }
    let previousGroup = null;
    for (const f of visibleFeatures) {
      const th = element('th', 'feature-head' + (f.group !== previousGroup ? ' group-start' : '')); th.scope = 'col'; th.id = 'feature-' + f.id; th.dataset.feature = f.id;
      const button = tipTrigger(element('button', 'header-button'), 'feature', f.id); button.type = 'button'; button.setAttribute('aria-label', f.name); button.append(icon(f.icon), element('span', 'header-short', f.short)); th.append(button); second.append(th); columnCells.set(f.id, [th]); previousGroup = f.group;
    }
    $('matrix-head').replaceChildren(first, second);
    const rows = document.createDocumentFragment();
    for (const g of view) {
      const tr = element('tr'); tr.dataset.gameId = g.id;
      const rank = element('td', 'fixed-rank', g.rank == null ? '?' : String(g.rank)); rank.setAttribute('aria-label', g.rank == null ? 'Rank unknown' : 'Rank ' + g.rank);
      const name = element('th', 'fixed-game'); name.scope = 'row'; name.id = 'game-' + g.id;
      const cell = element('div', 'game-cell');
      const title = tipTrigger(link(`https://store.steampowered.com/app/${g.id}/`, g.name + ' on Steam', 'game-name', g.name), 'game', g.id);
      const links = element('span', 'game-links');
      const info = tipTrigger(element('button', 'info-button'), 'game', g.id); info.type = 'button'; info.setAttribute('aria-label', 'Details for ' + g.name); info.append(icon('info'));
      const db = link(`https://steamdb.info/app/${g.id}/`, g.name + ' on SteamDB', 'game-link'); db.title = 'Open SteamDB'; db.append(icon('database'));
      links.append(info, db); cell.append(title); if (g.earlyAccess) { const ea = element('span', 'ea-mark', 'EA'); ea.title = 'Early Access'; cell.append(ea); } cell.append(links); name.append(cell);
      const score = element('td', 'fixed-score', g.score == null ? '?' : String(g.score)); score.setAttribute('aria-label', g.score == null ? 'Feature score unknown' : g.score + ' feature points');
      tr.append(rank, name, score);
      let group = null;
      for (const f of visibleFeatures) {
        const advertised = g.featureSet.has(f.id), td = element('td', 'feature-cell' + (f.group !== group ? ' group-start' : ''));
        td.dataset.feature = f.id; td.dataset.supported = g.featureDataKnown ? String(advertised) : 'unknown'; td.setAttribute('headers', `game-${g.id} feature-${f.id}`);
        const mark = element('span', advertised ? 'check' : 'dash', !g.featureDataKnown ? '?' : advertised ? '✓' : '–'); mark.setAttribute('aria-hidden', 'true'); td.append(mark, element('span', 'sr-only', !g.featureDataKnown ? 'Unknown' : advertised ? 'Listed' : 'Not listed')); tr.append(td); columnCells.get(f.id).push(td); group = f.group;
      }
      rows.append(tr);
    }
    $('matrix-body').replaceChildren(rows);
    $('matrix').style.setProperty('--feature-total', visibleFeatures.length);
    $('matrix').style.width = `calc(var(--rank) + var(--game) + var(--score) + ${visibleFeatures.length} * var(--cell))`;
    $('empty-state').hidden = view.length > 0; $('matrix').hidden = view.length === 0;
    $('matrix-region').scrollTop = 0;
    syncHighlight();
    if (focusFeatureAfterRender !== null) {
      suppressFocusTip = true;
      $('feature-' + focusFeatureAfterRender)?.querySelector('button')?.focus({ preventScroll: true });
      suppressFocusTip = false; focusFeatureAfterRender = null;
    }
  }
  function highlightColumn(id) {
    if (id === currentColumn) return;
    for (const node of columnCells.get(currentColumn) || []) node.classList.remove('column-highlight');
    currentColumn = id;
    for (const node of columnCells.get(currentColumn) || []) node.classList.add('column-highlight');
  }
  function syncHighlight(reveal = false) {
    const selected = data.features.find(f => f.key === highlightedFeature);
    const visible = selected && columnCells.has(selected.id) && view.length > 0;
    for (const [id, nodes] of columnCells) for (const node of nodes) node.classList.toggle('column-selected', id === selected?.id);
    const chip = $('highlight-chip');
    chip.hidden = !selected;
    chip.dataset.hidden = String(!visible);
    if (selected) {
      chip.textContent = `Highlight: ${selected.name}${visible ? '' : ' (hidden)'} ×`;
      chip.setAttribute('aria-label', 'Clear highlight for ' + selected.name);
    }
    const button = $('tooltip').querySelector('.highlight-button');
    if (button) {
      const active = button.dataset.featureKey === highlightedFeature;
      button.setAttribute('aria-pressed', String(active));
      button.textContent = active ? 'Clear highlight' : 'Highlight column';
    }
    revealHighlightPending = !!selected && (revealHighlightPending || reveal || !visible);
    if (revealHighlightPending) requestAnimationFrame(revealHighlightedColumn);
  }
  function revealHighlightedColumn() {
    if (!revealHighlightPending || $('results').hidden) return;
    const selected = data.features.find(f => f.key === highlightedFeature);
    const header = selected && $('feature-' + selected.id);
    if (!header || !view.length) return;
    const region = $('matrix-region'), rect = header.getBoundingClientRect();
    const left = $('matrix-head').querySelector('.fixed-score').getBoundingClientRect().right;
    const right = region.getBoundingClientRect().left + region.clientLeft + region.clientWidth;
    const delta = rect.left < left ? rect.left - left : rect.right > right ? rect.right - right : 0;
    if (delta) {
      if ($('tooltip').contains(document.activeElement)) closeTipAndRestoreFocus();
      region.scrollLeft += delta;
    }
    revealHighlightPending = false;
  }
  function setHighlight(key) {
    highlightedFeature = key;
    // A pending title edit belongs to its debounce; highlighting does not submit it.
    writeURL(parseQuery(location.search, data.features, data.tags), 'push');
    syncHighlight(true);
  }
  function updateMatrixLayout() {
    if ($('results').hidden) return;
    const region = $('matrix-region');
    $('matrix').style.setProperty('--matrix-width', region.clientWidth + 'px');
    const rect = region.getBoundingClientRect();
    const below = document.querySelector('main').getBoundingClientRect().bottom - rect.bottom;
    // Document coordinates keep page scrolling from changing the table's height.
    const available = innerHeight - (rect.top + scrollY) - below;
    const height = Math.max(parseFloat(getComputedStyle(region).minHeight), Math.floor(available)) + 'px';
    if (region.style.getPropertyValue('--matrix-height') !== height) region.style.setProperty('--matrix-height', height);
    if (revealHighlightPending) requestAnimationFrame(revealHighlightedColumn);
  }
  function scheduleMatrixLayout() {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(updateMatrixLayout);
  }
  function hideTip() {
    clearTimeout(tipHideTimer);
    if (tipAnchor) { tipAnchor.removeAttribute('aria-describedby'); tipAnchor.removeAttribute('aria-expanded'); }
    tipAnchor = null; tipPinned = false; $('tooltip').hidden = true; $('tooltip').classList.remove('pinned', 'interactive');
  }
  function scheduleTipHide() {
    clearTimeout(tipHideTimer);
    if (!tipPinned) tipHideTimer = setTimeout(() => { if (!tipPinned && !$('tooltip').contains(document.activeElement)) hideTip(); }, 220);
  }
  function closeTipAndRestoreFocus() {
    const old = tipAnchor; hideTip(); suppressFocusTip = true;
    old?.focus({ preventScroll: true }); suppressFocusTip = false;
  }
  function addPair(dl, label, value) { dl.append(element('dt', '', label), element('dd', '', value)); }
  function showTip(anchor, pinned = false) {
    if (tipPinned && !pinned) return;
    if (pinned && tipPinned && tipAnchor === anchor) { hideTip(); return; }
    hideTip(); tipAnchor = anchor; tipPinned = pinned;
    const tip = $('tooltip'), id = Number(anchor.dataset.id), interactive = anchor.dataset.tip === 'feature'; tip.replaceChildren(); tip.hidden = false; tip.classList.toggle('pinned', pinned); tip.classList.toggle('interactive', interactive); tip.setAttribute('role', pinned || interactive ? 'dialog' : 'tooltip');
    if (anchor.dataset.tip === 'feature') {
      const f = features.get(id), weight = f.weight ?? 1; tip.append(element('p', 'tip-kicker', f.group), element('h3', '', f.name), element('p', '', f.description), element('p', 'tip-weight', `${weight < 0 ? '−' + Math.abs(weight) : weight} score ${Math.abs(weight) === 1 ? 'point' : 'points'}${weight === 0 ? ' · Included in raw count only' : ''}`), element('p', 'tip-fine', `${view.filter(g => g.featureSet.has(id)).length} of ${view.length} displayed games advertise this feature.`)); tip.setAttribute('aria-label', f.name);
      const controls = element('div', 'tip-actions');
      const highlight = element('button', 'highlight-button', f.key === highlightedFeature ? 'Clear highlight' : 'Highlight column');
      highlight.type = 'button'; highlight.dataset.featureKey = f.key; highlight.setAttribute('aria-pressed', String(f.key === highlightedFeature));
      highlight.addEventListener('click', () => setHighlight(f.key === highlightedFeature ? null : f.key));
      controls.append(highlight, featureActions(f, true)); tip.append(controls);
    } else {
      const g = games.get(id); if (!g) { hideTip(); return; }
      tip.append(element('p', 'tip-kicker', (g.earlyAccess ? 'Early Access · ' : '') + g.releaseStatus), element('h3', '', g.name)); tip.setAttribute('aria-label', g.name + ' details');
      const dl = element('dl'), non = data.features.filter(f => !f.accessibility), count = list => g.featureDataKnown ? list.filter(f => g.featureSet.has(f.id)).length + ' / ' + list.length : 'Unknown';
      addPair(dl, 'Feature score', g.score == null ? 'Unknown' : `${g.score} / ${latestResult.maxScore}`); addPair(dl, 'Visible feature count', count(visibleFeatures));
      addPair(dl, 'Non-accessibility total', count(non)); addPair(dl, 'All features', count(data.features));
      addPair(dl, g.reviewSource === 'steam' ? 'Steam-purchase reviews' : 'Reviews', fmt(g.reviews));
      if (g.positivePercent != null) addPair(dl, 'Positive reviews', g.positivePercent + '%');
      addPair(dl, 'Release date', g.releaseDate || 'Unknown');
      if (g.metadataUpdatedAt) addPair(dl, 'Steam metadata checked', date(g.metadataUpdatedAt));
      tip.append(dl);
      tip.append(element('p', 'tip-fine', (g.genres || []).join(' · ')), element('p', 'tip-fine', 'Steam app ' + g.id));
      if (g.steamLookupStatus === 'unavailable' && g.steamLookupResultCode === 15) tip.append(element('p', 'tip-fine', 'Steam metadata unavailable; showing older data where available.'));
      if (g.tagIds?.length) tip.append(element('p', 'tip-tags', 'Tags: ' + g.tagIds.map(id => data.tags[id]).join(' · ')));
      else if (g.tagDataKnown) tip.append(element('p', 'tip-tags', 'Tags: None listed'));
      else addPair(dl, 'Tag data', 'Unknown');

    }
    if (pinned) { const close = element('button', 'tip-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close details'); close.addEventListener('click', closeTipAndRestoreFocus); tip.append(close); anchor.setAttribute('aria-expanded', 'true'); }
    else if (!interactive) anchor.setAttribute('aria-describedby', 'tooltip');
    if (interactive) { anchor.setAttribute('aria-haspopup', 'dialog'); anchor.setAttribute('aria-controls', 'tooltip'); anchor.setAttribute('aria-expanded', 'true'); }
    const r = anchor.getBoundingClientRect(), t = tip.getBoundingClientRect();
    let left = Math.max(12, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 12));
    let top = r.bottom + 9; if (top + t.height > innerHeight - 12) top = Math.max(12, r.top - t.height - 9);
    if (anchor.dataset.tip === 'game') {
      const beside = $('matrix-head').querySelector('.fixed-score').getBoundingClientRect().right + 8;
      if (beside + t.width <= innerWidth - 12) {
        left = beside;
        top = Math.max(12, Math.min(anchor.closest('tr').getBoundingClientRect().top, innerHeight - t.height - 12));
      }
    }
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
    if (pinned) { tip.tabIndex = -1; tip.focus({ preventScroll: true }); }
  }


function showError(message, loading = false) {
  hideTip();
  $('error-message').textContent = message;
  $('error').hidden = false;
  $('retry').hidden = !loading;
  $('error-reset').hidden = loading;
  $('loading').hidden = true;
  $('results').hidden = true;
  $('results').removeAttribute('aria-busy');
}
function startWorker() {
  worker?.terminate(); ready = false; requestedSearch = null;
  $('query-controls').disabled = true;
  $('error').hidden = true; $('loading').hidden = false; $('results').hidden = true;
  $('loading-message').textContent = 'Loading the complete game catalog…';
  for (const button of $('presets').querySelectorAll('button')) button.disabled = true;
  worker = new Worker(new URL('./filter-worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('error', () => showError('The catalog worker could not start. Reload this page or try a browser that supports module workers.', true));
  worker.addEventListener('message', ({ data: message }) => {
    if (message.type === 'error') {
      if (message.requestId != null && message.requestId !== latestRequest) return;
      showError(message.message, !ready); return;
    }
    if (message.type === 'ready') {
      data = message; data.tags ??= []; features = new Map(data.features.map(f => [f.id, f])); ready = true;
      buildPicker(); tagOptionsBuilt = false; $('tag-options').replaceChildren(); if (!$('tag-picker').hidden) buildTagPicker(); updateMetadata(); $('query-controls').disabled = false;
      for (const button of $('presets').querySelectorAll('button')) button.disabled = false;
      loadURL();
    }
    if (message.type === 'result' && message.requestId === latestRequest) {
      latestResult = message.result;
      state = latestResult.query;
      requestedSearch = serializeQuery(state, data.features, data.tags);
      writeURL(state);
      syncControls(); render();
      $('error').hidden = true; $('loading').hidden = true; $('results').hidden = false; $('results').removeAttribute('aria-busy');
      updateMatrixLayout();
    }
  });
  worker.postMessage({ type: 'init', manifestURL: new URL('./data/manifest.json', location.href).href });
}

function writeURL(query, mode = 'replace') {
  const search = serializeView(query, highlightedFeature, data.features, data.tags);
  if (search !== location.search) history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', location.pathname + search + location.hash);
}
function loadURL() {
  clearTimeout(inputTimer);
  try {
    const next = parseView(location.search, data.features, data.tags);
    const sameQuery = requestedSearch === serializeQuery(next.query, data.features, data.tags) && activeQueryRequest === latestRequest && $('error').hidden;
    const highlightChanged = highlightedFeature !== next.highlight;
    state = next.query; highlightedFeature = next.highlight;
    hideTip(); syncControls(); syncHighlight(highlightChanged);
    if (sameQuery) writeURL(state);
    else query();
  } catch (error) { latestRequest = ++requestId; showError('This link has invalid filters: ' + error.message); }
}
function query() {
  hideTip(); $('error').hidden = true;
  $('results').setAttribute('aria-busy', 'true');
  latestRequest = ++requestId;
  activeQueryRequest = latestRequest;
  requestedSearch = serializeQuery(state, data.features, data.tags);
  worker.postMessage({ type: 'query', requestId: latestRequest, query: state });
}
function setFilters(patch, resetPage = true) {
  if (!ready) return;
  clearTimeout(inputTimer);
  try {
    const next = normalizeQuery({ ...state, ...patch, ...(resetPage && !('page' in patch) ? { page: 1 } : {}) }, data.features, data.tags);
    writeURL(next, 'push');
    state = next; syncControls(); query();
  } catch (error) { showError(error.message); }
}
function syncControls() {
  $('search').value = state.q; $('early-access').checked = state.includeEarlyAccess; $('accessibility').checked = state.includeAccessibility;
  $('multiplayer').checked = state.includeMultiplayer;
  $('min-reviews').value = state.minReviews; $('release').value = state.release;
  const [sortField, sortDirection] = state.sort.split('-'); $('sort').value = sortField;
  for (const direction of ['asc', 'desc']) $('sort-' + direction).setAttribute('aria-pressed', String(direction === sortDirection));
  for (const option of $('feature-options').children) {
    const id = Number(option.dataset.featureId), kind = state.has.includes(id) ? 'has' : state.not.includes(id) ? 'not' : '';
    option.classList.toggle('selected', !!kind); option.classList.toggle('excluded', kind === 'not');
    for (const button of option.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.action === kind));
  }
  $('active-count').textContent = state.has.length + state.not.length;
  $('active-tag-count').textContent = state.hasTags.length + state.notTags.length;
  syncTagOptions();
  const chips = [];
  for (const kind of ['has', 'not']) for (const id of state[kind]) {
    const f = features.get(id), chip = element('button', 'filter-chip ' + kind, `${kind === 'has' ? '✓' : '−'} ${f.name} ×`);
    chip.type = 'button'; chip.setAttribute('aria-label', 'Remove ' + (kind === 'has' ? 'required ' : 'excluded ') + f.name);
    chip.addEventListener('click', () => setFilters({ [kind]: state[kind].filter(value => value !== id) })); chips.push(chip);
  }
  for (const kind of ['hasTags', 'notTags']) for (const name of state[kind]) {
    const required = kind === 'hasTags', chip = element('button', 'filter-chip tag-chip ' + (required ? 'has' : 'not'), `${required ? '✓' : '−'} Tag: ${name} ×`);
    chip.type = 'button'; chip.setAttribute('aria-label', 'Remove ' + (required ? 'required' : 'excluded') + ' tag ' + name);
    chip.addEventListener('click', () => setFilters({ [kind]: state[kind].filter(value => value !== name) })); chips.push(chip);
  }
  $('active-filters').replaceChildren(...chips);
  for (const button of $('presets').querySelectorAll('button')) {
    const preset = PRESETS.find(p => p.id === button.dataset.preset);
    const active = serializeQuery({ ...state, page: 1 }, data.features, data.tags) === serializeQuery(preset.query, data.features, data.tags);
    button.setAttribute('aria-pressed', String(active));
  }
}
function featureActions(f, fromTip = false) {
  const actions = element('span', 'feature-actions'); actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', 'Filter ' + f.name);
  for (const [kind, verb] of [['has', 'Require'], ['not', 'Exclude']]) {
    const button = element('button', 'feature-action'); button.type = 'button'; button.dataset.action = kind; button.append(icon(kind === 'has' ? 'plus' : 'minus'));
    button.setAttribute('aria-label', verb + ' ' + f.name); button.setAttribute('aria-pressed', String(state[kind].includes(f.id))); button.title = verb + ' ' + f.name;
    button.addEventListener('click', () => {
      const has = state.has.filter(id => id !== f.id), not = state.not.filter(id => id !== f.id);
      if (!state[kind].includes(f.id)) (kind === 'has' ? has : not).push(f.id);
      if (fromTip) focusFeatureAfterRender = f.id;
      setFilters({ has, not });
    }); actions.append(button);
  }
  return actions;
}
function buildPicker() {
  const fragment = document.createDocumentFragment();
  for (const f of data.features) {
    const label = element('div', 'feature-option'); label.dataset.name = f.name.toLowerCase(); label.dataset.featureId = f.id; label.title = f.description;
    label.style.setProperty('--group-color', groupColors[f.group] ?? '#667a91');
    const name = element('span', 'option-name'); name.append(icon(f.icon), element('span', '', f.name));
    label.append(name, featureActions(f)); fragment.append(label);
  }
  $('feature-options').replaceChildren(fragment);
}
function buildTagPicker() {
  if (tagOptionsBuilt) return;
  const fragment = document.createDocumentFragment();
  const ordered = data.tags.map((name, id) => ({ name, id, count: data.tagCounts?.[id] ?? 0 })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en'));
  for (const tag of ordered) {
    const option = element('div', 'feature-option tag-option'); option.dataset.tagName = tag.name;
    option.dataset.search = tag.name.normalize('NFKC').toLocaleLowerCase('en');
    const name = element('span', 'option-name', tag.name), count = element('span', 'tag-frequency', fmt(tag.count)); count.title = `${fmt(tag.count)} games with this tag in the full catalog`;
    const actions = element('span', 'feature-actions'); actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', 'Filter tag ' + tag.name);
    for (const [kind, action, verb] of [['hasTags', 'has', 'Require'], ['notTags', 'not', 'Exclude']]) {
      const button = element('button', 'feature-action'); button.type = 'button'; button.dataset.action = action; button.append(icon(action === 'has' ? 'plus' : 'minus'));
      button.setAttribute('aria-label', verb + ' tag ' + tag.name); button.setAttribute('aria-pressed', 'false'); button.title = verb + ' tag ' + tag.name;
      button.addEventListener('click', () => {
        const hasTags = state.hasTags.filter(name => name !== tag.name), notTags = state.notTags.filter(name => name !== tag.name);
        if (!state[kind].includes(tag.name)) (kind === 'hasTags' ? hasTags : notTags).push(tag.name);
        setFilters({ hasTags, notTags });
      }); actions.append(button);
    }
    option.append(name, count, actions); fragment.append(option);
  }
  $('tag-options').replaceChildren(fragment); tagOptionsBuilt = true; filterTagOptions();
}
function syncTagOptions() {
  if (!tagOptionsBuilt) return;
  for (const option of $('tag-options').children) {
    const kind = state.hasTags.includes(option.dataset.tagName) ? 'has' : state.notTags.includes(option.dataset.tagName) ? 'not' : '';
    option.classList.toggle('selected', !!kind); option.classList.toggle('excluded', kind === 'not');
    for (const button of option.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.action === kind));
  }
}
function filterTagOptions() {
  const search = $('tag-search').value.normalize('NFKC').toLocaleLowerCase('en').trim(); let visible = 0;
  for (const option of $('tag-options').children) { option.hidden = !option.dataset.search.includes(search); if (!option.hidden) visible++; }
  $('tag-empty').hidden = visible > 0;
  $('tag-empty').textContent = data.tags.length ? 'No tags match your search.' : 'No tag data in this snapshot.';
}
function togglePicker(kind) {
  const open = $(kind + '-picker').hidden;
  for (const name of ['feature', 'tag']) {
    const expanded = name === kind && open; $(name + '-picker').hidden = !expanded;
    $(name + '-search-control').hidden = !expanded;
    $(name + '-toggle').setAttribute('aria-expanded', String(expanded));
  }
  if (kind === 'tag' && open) { buildTagPicker(); syncTagOptions(); }
}
function updateMetadata() {
  $('package-summary').textContent = `${fmt(data.gameCount)} games · ${data.features.length} feature labels`;
  const compression = { brotli: 'Brotli', gzip: 'gzip', uncompressed: 'uncompressed' }[data.catalogCompression];
  const fileSize = data.catalogBytes == null ? '' : ` (${(data.catalogBytes / 1_000_000).toFixed(2)} MB)`;
  $('method-dates').textContent = `Updated ${date(data.importedAt)}. Individual games may have older data.${compression ? ` Data file: ${compression}${fileSize}.` : ''}`;
}

function getView() { return { filters: state, highlight: highlightedFeature, matching, displayed: view.length, featureColumns: visibleFeatures.length, maxScore: latestResult?.maxScore, page: latestResult?.page, pageCount: latestResult?.pageCount, games: view.map(({ id, name, score, count, rank, reviews, positivePercent, earlyAccess, tagIds }) => ({ id, name, score, count, rank, reviews, positivePercent, earlyAccess, tags: (tagIds ?? []).map(id => data.tags[id]) })) }; }
for (const preset of PRESETS) {
  const button = element('button', 'view-button'); button.append(icon(preset.id === 'feature-leaders' ? 'trophy' : 'warning'), element('span', '', preset.title)); button.type = 'button'; button.disabled = true; button.dataset.preset = preset.id; button.title = preset.description;
  button.addEventListener('click', () => setFilters(preset.query)); $('presets').append(button);
}
$('filters').addEventListener('submit', e => { e.preventDefault(); if ($('min-reviews').reportValidity()) setFilters({ q: $('search').value, minReviews: Number($('min-reviews').value) }); });
$('search').addEventListener('input', e => { clearTimeout(inputTimer); state = { ...state, q: e.target.value }; latestRequest = ++requestId; inputTimer = setTimeout(() => setFilters({ q: state.q }), 250); });
$('early-access').addEventListener('change', e => setFilters({ includeEarlyAccess: e.target.checked }));
$('accessibility').addEventListener('change', e => setFilters({ includeAccessibility: e.target.checked }));
$('multiplayer').addEventListener('change', e => setFilters({ includeMultiplayer: e.target.checked }));
$('release').addEventListener('change', e => setFilters({ release: e.target.value }));
$('sort').addEventListener('change', e => setFilters({ sort: e.target.value + '-' + state.sort.split('-')[1] }));
for (const direction of ['asc', 'desc']) $('sort-' + direction).addEventListener('click', () => setFilters({ sort: state.sort.split('-')[0] + '-' + direction }));
$('min-reviews').addEventListener('change', e => { if (e.target.value !== '' && e.target.reportValidity()) setFilters({ minReviews: Number(e.target.value) }); else e.target.value = state.minReviews; });
$('feature-search').addEventListener('input', e => { for (const label of $('feature-options').children) label.hidden = !label.dataset.name.includes(e.target.value.toLowerCase()); });
$('tag-search').addEventListener('input', filterTagOptions);
for (const kind of ['feature', 'tag']) $(kind + '-toggle').addEventListener('click', () => togglePicker(kind));
for (const id of ['reset', 'empty-reset', 'error-reset']) $(id).addEventListener('click', () => setFilters(DEFAULT_QUERY));
$('retry').addEventListener('click', startWorker);
$('highlight-chip').addEventListener('click', () => setHighlight(null));
$('previous').addEventListener('click', () => setFilters({ page: state.page - 1 }, false));
$('next').addEventListener('click', () => setFilters({ page: state.page + 1 }, false));
function goToPage() { if ($('page').reportValidity()) setFilters({ page: Number($('page').value) }, false); }
$('go-page').addEventListener('click', goToPage);
$('page').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); goToPage(); } });
$('about').prepend(icon('info'));
$('share').prepend(icon('link'));
$('about').addEventListener('click', () => { hideTip(); $('about-dialog').showModal(); $('about-content').scrollTop = 0; });
$('about-close').addEventListener('click', () => $('about-dialog').close());
$('faq-example').addEventListener('click', e => {
  if (!ready || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const target = new URL(e.currentTarget.href);
  let next;
  try { next = parseQuery(target.search, data.features, data.tags); }
  catch { return; }
  e.preventDefault();
  $('about-dialog').close();
  setFilters(next);
});
$('about-dialog').addEventListener('click', e => {
  if (e.target !== e.currentTarget) return;
  const rect = e.currentTarget.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) e.currentTarget.close();
});
$('share').addEventListener('click', async () => {
  if (ready && $('search').value !== (new URLSearchParams(location.search).get('q') ?? '')) setFilters({ q: $('search').value }, false);
  try { await navigator.clipboard.writeText(location.href); $('share-status').textContent = 'Link copied'; $('share-label').textContent = 'Copied!'; setTimeout(() => { $('share-label').textContent = 'Copy link'; }, 1800); }
  catch { $('share-status').textContent = 'Copy the address from your browser to share this view.'; $('share-label').textContent = 'Copy address bar URL'; }
});
window.addEventListener('popstate', () => { if (ready) loadURL(); });
  $('matrix').addEventListener('pointerover', e => { const cell = e.target.closest('[data-feature]'); highlightColumn(cell ? Number(cell.dataset.feature) : null); const anchor = e.target.closest('[data-tip]'); if (anchor && !anchor.contains(e.relatedTarget) && e.pointerType !== 'touch') showTip(anchor); });
  $('matrix').addEventListener('pointerout', e => { const anchor = e.target.closest('[data-tip]'); if (anchor && !anchor.contains(e.relatedTarget) && !$('tooltip').contains(e.relatedTarget)) scheduleTipHide(); });
  $('matrix').addEventListener('pointerleave', e => { highlightColumn(null); if (!$('tooltip').contains(e.relatedTarget)) scheduleTipHide(); });
  $('matrix').addEventListener('focusin', e => { const anchor = e.target.closest('[data-tip]'); if (anchor && !suppressFocusTip) showTip(anchor); const cell = e.target.closest('[data-feature]'); highlightColumn(cell ? Number(cell.dataset.feature) : null); });
  $('matrix').addEventListener('focusout', e => { if (!$('tooltip').contains(e.relatedTarget)) { highlightColumn(null); scheduleTipHide(); } });
  $('matrix').addEventListener('click', e => { const anchor = e.target.closest('button[data-tip]'); if (anchor) showTip(anchor, true); });
  $('tooltip').addEventListener('pointerenter', () => clearTimeout(tipHideTimer));
  $('tooltip').addEventListener('pointerleave', e => { if (!tipAnchor?.contains(e.relatedTarget)) scheduleTipHide(); });
  $('tooltip').addEventListener('focusin', () => clearTimeout(tipHideTimer));
  $('tooltip').addEventListener('focusout', e => { if (!$('tooltip').contains(e.relatedTarget) && !tipAnchor?.contains(e.relatedTarget)) scheduleTipHide(); });
  document.addEventListener('pointerdown', e => { if (tipAnchor && !tipAnchor.contains(e.target) && !$('tooltip').contains(e.target)) hideTip(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTipAndRestoreFocus(); });
  $('matrix-region').addEventListener('scroll', hideTip, { passive: true });
  window.addEventListener('resize', () => { hideTip(); scheduleMatrixLayout(); });
  const layoutObserver = new ResizeObserver(scheduleMatrixLayout);
  layoutObserver.observe($('matrix-region'));
  layoutObserver.observe(document.querySelector('main'));

window.steamFeatureAtlas = Object.freeze({ getView, setFilters });
startWorker();
