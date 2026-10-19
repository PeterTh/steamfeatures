import { DEFAULT_QUERY, PRESETS, normalizeQuery, parseQuery, serializeQuery } from './query.mjs';
import { parseView, serializeView } from './view-state.mjs';
import { featureColumns, columnState, compatibilityTargets, disclosureDetails } from './feature-presentation.mjs';
import { compatibilityDetails } from './compatibility-details.mjs';
import { LANGUAGE_KINDS } from './languages.mjs';
import { createGameImageLoader, steamHeaderURL } from './game-images.mjs';
import { normalizeCreditSearch } from './game-credits.mjs';

const $ = id => document.getElementById(id);
const fmt = n => n == null ? 'Unknown' : new Intl.NumberFormat('en-US').format(n);
const date = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString().slice(0, 10) : 'Unknown';
const groupColors = { 'Play modes': '#709de0', Input: '#b4a0e8', 'Steam features': '#69baa9', Creation: '#e0b775', 'Features?': '#d57a84', 'Remote Play': '#6bb8d2', 'Cloud streaming': '#6bb8d2', 'Display & VR': '#d095b7', Accessibility: '#becb77', 'Steam hardware': '#89c5ad' };
let data = {}, features = new Map(), columns = new Map(), games = new Map(), state = { ...DEFAULT_QUERY }, view = [], visibleFeatures = [], matching = 0;
let tagOptionsBuilt = false;
let languageOptionsBuilt = false;
let worker, ready = false, requestId = 0, latestRequest = 0, latestResult = null, inputTimer;
let fullWorker, fullReady = false, backgroundStarted = false, backgroundError = null, pendingFullQuery = false;
let lastSubmittedQuery = null, completedRequest = 0, fullReadyAt = null;
let creditsStatus = 'idle', creditsError = null, creditsFile = null, pendingCreditsQuery = false;
let creditsRefreshRequest = 0;
const creditFields = [['developer', 'Developer'], ['publisher', 'Publisher']];
const textFields = [['q', 'search', 'q'], ['developer', 'developer-filter', 'dev'], ['publisher', 'publisher-filter', 'pub']];
const textFilterPatch = () => Object.fromEntries(textFields.map(([field, id]) => [field, $(id).value]));
let tipAnchor = null, tipPinned = false, currentColumn = null, suppressFocusTip = false, columnCells = new Map();
let tipHideTimer, focusFeatureAfterRender = null;
let preserveGameTip = false;
let highlightedFeature = null, revealHighlightPending = false;
let requestedSearch = null, activeQueryRequest = 0;
let layoutFrame;
let dateDraftDirty = false;
let compatibilityAnchor = null;
let gameCard = null, tipSearch = null, loadGameImage = createGameImageLoader(null);

  const paths = {
    steam: '<g fill="currentColor" stroke="none" transform="translate(2 1.9) scale(.226)"><path d="M44.238 .601C21 .601 1.963 18.519 .154 41.29l23.71 9.803a12.45 12.45 0 0 1 7.047-2.179c.234 0 .467 .008 .698 .021l10.544-15.283c0-.073-.001-.144-.001-.216 0-9.199 7.483-16.683 16.683-16.683S75.517 24.237 75.517 33.436 68.034 50.12 58.835 50.12c-.127 0-.253-.003-.379-.006l-15.038 10.73c.008 .195 .015 .394 .015 .592 0 6.906-5.617 12.522-12.522 12.522-6.061 0-11.129-4.326-12.277-10.055L1.678 56.893c5.25 18.568 22.309 32.181 42.56 32.181 24.432 0 44.237-19.806 44.237-44.235C88.475 20.406 68.669 .601 44.238 .601Z"/><path d="m27.875 67.723-5.434-2.245c.963 2.005 2.629 3.684 4.841 4.606 4.782 1.992 10.295-.277 12.288-5.063a9.34 9.34 0 0 0 .014-7.189 9.33 9.33 0 0 0-5.074-5.097 9.34 9.34 0 0 0-6.926-.105l5.613 2.321c3.527 1.47 5.195 5.52 3.725 9.047-1.467 3.523-5.52 5.191-9.047 3.725Z"/><path d="M69.95 33.436c0-6.129-4.986-11.116-11.116-11.116S47.718 27.307 47.718 33.436 52.705 44.551 58.834 44.551 69.95 39.565 69.95 33.436ZM50.502 33.417a8.35 8.35 0 1 1 16.702 0 8.35 8.35 0 0 1-16.702 0Z"/></g>',
    steamograph: '<path fill="currentColor" fill-rule="evenodd" stroke="none" d="M6 2h12a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4ZM13.35 14.66q0-.3-.21-.54-.2-.23-.64-.48-.44-.25-1.16-.56-.8-.32-1.4-.66-.61-.34-1.04-.76-.42-.42-.63-.95-.21-.53-.21-1.23 0-.73.27-1.36.26-.62.78-1.1.52-.47 1.26-.75.74-.27 1.67-.27 1.3 0 2.24.45.93.46 1.44 1.27.51.82.51 1.9h-3q0-.39-.12-.69-.12-.31-.38-.48-.26-.17-.7-.17-.32 0-.57.14-.25.14-.39.37-.15.23-.15.54 0 .23.11.41.1.19.32.36.23.17.6.35.38.19.94.42 1.15.43 1.9.92.74.49 1.11 1.15.36.65.36 1.62 0 .77-.3 1.4-.29.63-.84 1.09-.56.46-1.34.7-.77.25-1.73.25-1.4 0-2.36-.56-.97-.55-1.46-1.42-.49-.87-.49-1.81h2.84q.03.57.23.9.19.32.53.45.34.13.77.13.42 0 .69-.11.27-.12.41-.35.14-.24.14-.57Z"/>',
    lock: '<rect x="5" y="10" width="14" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 15v3"/>',
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
    'steam-deck': '<rect x="1" y="5" width="22" height="14" rx="4"/><rect x="7" y="7" width="10" height="10" rx="1"/><path d="M3 10h2m-1-1v2m15-1h2m-1 4h.01M4 15h.01"/>',
    'steam-machine': '<path d="m3 6 12-3 6 4v13l-12 1-6-4Zm0 0 6 4 12-3M9 10v11m3-4 6-.5"/><circle cx="12" cy="13" r=".6"/>',
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
    steamdb: '<path fill="currentColor" fill-rule="evenodd" stroke="none" transform="translate(2.22 2) scale(.2381)" d="M41.0645 0C63.7437 0 82.1289 8.45818 82.1289 18.8906C82.1286 23.2692 78.8889 27.2985 73.4531 30.502C78.8892 33.705 82.1287 37.7346 82.1289 42.1133C82.1289 46.4413 78.9631 50.427 73.6406 53.6123C78.963 56.7973 82.1288 60.7825 82.1289 65.1104C82.1284 75.5426 63.7434 83.999 41.0645 83.999C18.3855 83.999 .000555205 75.5426 0 65.1104C.000124576 60.7827 3.1654 56.7972 8.4873 53.6123C3.16524 50.4271 .0000102266 46.4411 0 42.1133C.000201977 37.7347 3.23999 33.706 8.67578 30.5029C3.23974 27.2995 .000259609 23.2694 0 18.8906C0 8.45819 18.3852 .00000853624 41.0645 0ZM68.167 56.3027C60.9354 59.2275 51.4506 61.0029 41.0645 61.0029C30.6784 61.0029 21.1935 59.2275 13.9619 56.3027V63.4668L13.9707 63.7422C14.3417 69.5114 26.3302 74.1435 41.0645 74.1436C55.7988 74.1435 67.7873 69.5114 68.1582 63.7422L68.167 63.4668V56.3027ZM68.167 33.0801C60.9354 36.0048 51.4505 37.7803 41.0645 37.7803C30.6784 37.7803 21.1935 36.0048 13.9619 33.0801V40.4717C13.9624 46.3681 26.0966 51.1483 41.0645 51.1484C55.7981 51.1484 67.7861 46.5169 68.1582 40.748L68.167 40.4717V33.0801ZM41.0645 8.21387C26.0962 8.21389 13.9619 12.6263 13.9619 18.0693C13.9628 23.5121 26.0967 27.9248 41.0645 27.9248C56.0322 27.9248 68.1661 23.5121 68.167 18.0693C68.167 12.6263 56.0328 8.21387 41.0645 8.21387Z"/>'
  };
  $('icon-defs').innerHTML = Object.entries(paths).map(([id, path]) => `<symbol id="icon-${id}" viewBox="0 0 24 24">${path}</symbol>`).join('');
  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  const promptGlyphs = { 'prompt-gamepad': '\u243c', 'prompt-mouse-keyboard': '\u243f', 'prompt-ds4': '\u2440', 'prompt-dualsense': '\u2441', 'prompt-vr': '\u{1f57b}', 'prompt-steam': '\ue00b' };
  function icon(name) {
    if (promptGlyphs[name]) { const node = element('span', 'icon prompt-icon', promptGlyphs[name]); node.setAttribute('aria-hidden', 'true'); return node; }
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); node.setAttribute('class', 'icon'); node.setAttribute('aria-hidden', 'true'); const use = document.createElementNS(node.namespaceURI, 'use'); use.setAttribute('href', '#icon-' + name); node.append(use); return node;
  }
  function tipTrigger(node, kind, id) { node.dataset.tip = kind; node.dataset.id = id; return node; }
  function link(url, label, className, text) { const a = element('a', className, text); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.setAttribute('aria-label', label); return a; }
  function gameDestinations(game) {
    return [
      { key: 'steam', title: 'Steam page', url: `https://store.steampowered.com/app/${game.id}/`, icon: 'steam' },
      { key: 'steamdb', title: 'SteamDB', url: `https://steamdb.info/app/${game.id}/`, icon: 'steamdb' },
      { key: 'steamograph', title: 'Steamograph', url: `https://steamograph.com/games/${game.id}`, icon: 'steamograph' }
    ];
  }

  function render() {
    if ($('compatibility-dialog').open) $('compatibility-dialog').close();
    const keepGameTip = (preserveGameTip || tipPinned && tipSearch === requestedSearch) && tipAnchor?.dataset.tip === 'game';
    if (!keepGameTip) hideTip();
    highlightColumn(null); columnCells = new Map();
    view = latestResult.rows.map(g => ({ ...g, featureSet: new Set(g.featureIds) })); games = new Map(view.map(g => [g.id,g])); matching = latestResult.total; visibleFeatures = latestResult.columns.map(id => columns.get(id));
    if (keepGameTip && gameCard) {
      const credits = latestResult.pinnedCredits ?? games.get(gameCard.id);
      if (credits) updateCardCredits(credits);
    }
    $('legend-listed-label').textContent = state.includeHardware ? 'Listed / Verified' : 'Listed';
    $('legend-absent-label').textContent = 'Not listed';
    $('legend-unknown-label').textContent = state.includeHardware ? 'Untested / Unknown' : 'Unknown';
    $('legend-playable').hidden = !state.includeHardware;
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
      const title = tipTrigger(element('button', 'game-name', g.name), 'game', g.id); title.type = 'button';
      title.setAttribute('aria-label', 'Details for ' + g.name); title.setAttribute('aria-haspopup', 'dialog'); title.setAttribute('aria-controls', 'tooltip'); title.setAttribute('aria-expanded', 'false');
      const links = element('span', 'game-links');
      for (const destination of gameDestinations(g)) {
        const item = link(destination.url, `${g.name}: ${destination.title}`, 'game-link'); item.dataset.service = destination.key;
        item.title = 'Open ' + destination.title; item.append(icon(destination.icon)); links.append(item);
      }
      cell.append(title); if (g.earlyAccess) { const ea = element('span', 'ea-mark', 'EA'); ea.title = 'Early Access'; cell.append(ea); } cell.append(links); name.append(cell);
      const score = element('td', 'fixed-score', g.score == null ? '?' : String(g.score)); score.setAttribute('aria-label', g.score == null ? 'Feature score unknown' : g.score + ' feature points');
      tr.append(rank, name, score);
      let group = null;
      for (const f of visibleFeatures) {
        const status = columnState(g, f), td = element('td', 'feature-cell' + (f.group !== group ? ' group-start' : ''));
        td.dataset.feature = f.id; td.dataset.supported = status.supported; td.dataset.status = status.status; td.setAttribute('headers', `game-${g.id} feature-${f.id}`); td.title = `${f.name}: ${status.label}`;
        const mark = element('span', status.className, status.mark); mark.setAttribute('aria-hidden', 'true');
        if (f.statuses && !['unknown', 'untested'].includes(status.status)) {
          const button = element('button', 'compatibility-button'); button.type = 'button'; button.dataset.compatibility = f.id; button.dataset.gameId = g.id;
          button.setAttribute('aria-label', `${f.name}: ${status.label}. Compatibility details for ${g.name}`);
          button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', 'compatibility-dialog');
          td.title += ' · Click for compatibility details'; button.append(mark); td.append(button);
        } else if (disclosureDetails(g, f)) {
          const button = element('button', 'compatibility-button'); button.type = 'button'; button.dataset.disclosure = f.id; button.dataset.gameId = g.id;
          button.setAttribute('aria-label', `${f.name}: ${status.label}. Details for ${g.name}`);
          button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', 'compatibility-dialog');
          td.title += ' · Click for details'; button.append(mark); td.append(button);
        } else td.append(mark, element('span', 'sr-only', status.label));
        tr.append(td); columnCells.get(f.id).push(td); group = f.group;
      }
      rows.append(tr);
    }
    $('matrix-body').replaceChildren(rows);
    if (keepGameTip) {
      // Keep the card usable even when excluding a tag removes its game.
      const anchor = $('game-' + tipAnchor.dataset.id)?.querySelector('.game-name');
      if (anchor) {
        tipAnchor.removeAttribute('aria-expanded'); tipAnchor.removeAttribute('aria-haspopup'); tipAnchor.removeAttribute('aria-controls');
        tipAnchor = anchor;
        anchor.setAttribute('aria-expanded', 'true'); anchor.setAttribute('aria-haspopup', 'dialog'); anchor.setAttribute('aria-controls', 'tooltip');
      }
    }
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
    const selected = [...columns.values()].find(f => f.key === highlightedFeature);
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
    const selected = [...columns.values()].find(f => f.key === highlightedFeature);
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
    writeURL(parseQuery(location.search, data.features, data.tags, data.languages), 'push');
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
    tipAnchor = null; tipPinned = false; preserveGameTip = false; gameCard = null; tipSearch = null;
    $('tooltip').hidden = true; $('tooltip').classList.remove('pinned', 'interactive', 'game-card', 'no-header');
  }
  function scheduleTipHide() {
    clearTimeout(tipHideTimer);
    if (!tipPinned) tipHideTimer = setTimeout(() => { if (!tipPinned && !$('tooltip').contains(document.activeElement)) hideTip(); }, 220);
  }
  function closeTipAndRestoreFocus() {
    const old = tipAnchor; hideTip(); suppressFocusTip = true;
    if (old) (old.isConnected ? old : $('tag-toggle')).focus({ preventScroll: true });
    suppressFocusTip = false;
  }
  function pinTip() {
    if (tipPinned) return;
    const tip = $('tooltip'); tipPinned = true; tip.classList.add('pinned'); tip.setAttribute('role', 'dialog');
    const close = element('button', 'tip-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close details'); close.addEventListener('click', closeTipAndRestoreFocus); tip.append(close);
    tipAnchor.setAttribute('aria-expanded', 'true');
  }
  function addPair(dl, label, value) { dl.append(element('dt', '', label), element('dd', '', value)); }
  function updateCardCredits(values) {
    if (!gameCard?.dl || values.developerNames === undefined) return;
    if (!gameCard.creditRows) {
      gameCard.creditRows = creditFields.map(() => [element('dt'), element('dd', 'card-credits')]);
      gameCard.dl.prepend(...gameCard.creditRows.flat());
    }
    gameCard.creditNames ??= {};
    creditFields.forEach(([role, label], i) => {
      const names = values[role + 'Names'], [term, description] = gameCard.creditRows[i];
      const signature = JSON.stringify(names);
      if (gameCard.creditNames[role] === signature) return;
      gameCard.creditNames[role] = signature;
      term.textContent = label + (names?.length > 1 ? 's' : '');
      description.replaceChildren();
      if (!names?.length) description.textContent = names === null ? 'Unknown' : 'Not listed';
      else names.forEach((name, index) => {
        const button = element('button', 'tip-credit', name); button.type = 'button';
        button.dataset.creditRole = role; button.dataset.creditName = name;
        button.addEventListener('click', () => {
          if (!tipPinned) pinTip();
          setFilters({ [role]: matchesCreditFilter(role, name) ? '' : name }, true, true);
        });
        if (index) description.append(document.createTextNode(' · '));
        description.append(button);
      });
    });
    syncGameCredits();
    positionTip();
  }
  function showCompatibility(anchor) {
    const game = games.get(Number(anchor.dataset.gameId)), column = columns.get(Number(anchor.dataset.compatibility));
    if (!game || !column?.statuses) return;
    hideTip(); compatibilityAnchor = anchor;
    const status = columnState(game, column), content = $('compatibility-content');
    $('compatibility-title').replaceChildren(icon(column.icon), document.createTextNode(column.name + ' compatibility'));
    const rating = element('p', 'compatibility-rating'), mark = element('span', status.className, status.mark);
    mark.setAttribute('aria-hidden', 'true'); rating.append(mark, document.createTextNode(status.label));
    content.replaceChildren(element('h3', 'compatibility-game', game.name), rating);
    const details = compatibilityDetails(game, column.key, data.compatibilityDetails ?? []);
    for (const [tone, title, symbol] of [['warning', 'Things to know', '!'], ['pass', 'Passed checks', '✓'], ['info', 'Additional details', 'i']]) {
      const notes = details.filter(detail => detail.tone === tone);
      if (!notes.length) continue;
      const section = element('section', 'compatibility-section ' + tone), list = element('ul', 'compatibility-notes');
      section.append(element('h4', '', title));
      for (const note of notes) {
        const item = element('li'), badge = element('span', 'compatibility-note-icon', symbol); badge.setAttribute('aria-hidden', 'true');
        item.append(badge, element('span', '', note.text)); list.append(item);
      }
      section.append(list); content.append(section);
    }
    if (!details.length) content.append(element('p', 'compatibility-empty', 'No compatibility details are available.'));
    const store = link(`https://store.steampowered.com/app/${game.id}/`, game.name + ' on Steam', 'compatibility-store', 'View on Steam');
    store.append(icon('external')); content.append(store);
    $('compatibility-dialog').showModal(); content.scrollTop = 0;
  }
  function showDisclosure(anchor) {
    const game = games.get(Number(anchor.dataset.gameId)), column = columns.get(Number(anchor.dataset.disclosure));
    if (!game || !column) return;
    const details = disclosureDetails(game, column);
    if (!details) return;
    hideTip(); compatibilityAnchor = anchor;
    const content = $('compatibility-content'), status = columnState(game, column);
    $('compatibility-title').replaceChildren(icon(column.icon), document.createTextNode(column.name));
    const rating = element('p', 'compatibility-rating'), mark = element('span', status.className, status.mark);
    mark.setAttribute('aria-hidden', 'true'); rating.append(mark, document.createTextNode(details.summary));
    content.replaceChildren(element('h3', 'compatibility-game', game.name), rating,
      element('p', 'disclosure-description', details.description));
    if (details.facts.length) {
      const facts = element('dl', 'disclosure-facts');
      for (const [label, value] of details.facts) addPair(facts, label, value);
      content.append(facts);
    }
    content.append(element('p', 'tip-fine', 'These are Steam’s published disclosures. Missing information does not establish that a game is free of DRM, account requirements or anti-cheat.'));
    const store = link(`https://store.steampowered.com/app/${game.id}/`, game.name + ' on Steam', 'compatibility-store', 'View on Steam');
    store.append(icon('external')); content.append(store);
    $('compatibility-dialog').showModal(); content.scrollTop = 0;
  }
  function showTip(anchor, pinned = false) {
    if (tipPinned && !pinned) return;
    if (!pinned && tipAnchor === anchor && anchor.dataset.tip === 'game' && !$('tooltip').hidden) return;
    if (pinned && tipPinned && tipAnchor === anchor) { hideTip(); return; }
    if (pinned && tipAnchor === anchor && anchor.dataset.tip === 'game' && !$('tooltip').hidden) {
      pinTip(); $('tooltip').tabIndex = -1; $('tooltip').focus({ preventScroll: true }); return;
    }
    hideTip(); tipAnchor = anchor;
    const tip = $('tooltip'), id = Number(anchor.dataset.id), interactive = ['feature', 'game'].includes(anchor.dataset.tip); tip.replaceChildren(); tip.hidden = false; tip.classList.toggle('pinned', pinned); tip.classList.toggle('interactive', interactive); tip.setAttribute('role', pinned || interactive ? 'dialog' : 'tooltip');
    if (anchor.dataset.tip === 'feature') {
      const f = columns.get(id), weight = f.weight ?? 1;
      tip.append(element('p', 'tip-kicker', f.group), element('h3', '', f.name), element('p', '', f.description)); tip.setAttribute('aria-label', f.name);
      if (f.statuses) {
        const ratings = element('div', 'rating-options');
        for (const rating of f.statuses) {
          const status = columnState({ featureIds: [rating.id] }, f), row = element('div', 'rating-option');
          const mark = element('span', status.className, status.mark); mark.setAttribute('aria-hidden', 'true');
          row.append(mark, element('span', '', `${rating.label} (${rating.weight > 0 ? '+' : rating.weight < 0 ? '−' : ''}${Math.abs(rating.weight)})`)); ratings.append(row);
        }
        tip.append(ratings);
      } else {
        const weightText = f.id === 10005 ? '−1 score point for kernel mode; 0 otherwise'
          : `${weight < 0 ? '−' + Math.abs(weight) : weight} score ${Math.abs(weight) === 1 ? 'point' : 'points'}${weight === 0 ? ' · Included in raw count only' : ''}`;
        tip.append(element('p', 'tip-weight', weightText), element('p', 'tip-fine', `${view.filter(g => g.featureSet.has(id)).length} of ${view.length} displayed games advertise this feature.`));
      }
      const controls = element('div', 'tip-actions');
      const highlight = element('button', 'highlight-button', f.key === highlightedFeature ? 'Clear highlight' : 'Highlight column');
      highlight.type = 'button'; highlight.dataset.featureKey = f.key; highlight.setAttribute('aria-pressed', String(f.key === highlightedFeature));
      highlight.addEventListener('click', () => setHighlight(f.key === highlightedFeature ? null : f.key));
      controls.append(highlight);
      if (f.statuses) {
        const filter = element('button', 'highlight-button', 'Filter by compatibility'); filter.type = 'button';
        filter.addEventListener('click', () => {
          hideTip(); if ($('compatibility-picker').hidden) togglePicker('compatibility');
          $('compatibility-' + f.key).focus();
        }); controls.append(filter);
      } else controls.append(featureActions(f, true));
      tip.append(controls);
    } else {
      const g = games.get(id); if (!g) { hideTip(); return; }
      tipSearch = requestedSearch; tip.classList.add('game-card');
      const header = element('div', 'game-card-header'), image = element('img');
      image.alt = ''; image.width = 460; image.height = 215; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; header.append(image);
      const body = element('div', 'game-card-body'); tip.append(header, body);
      const card = { id, image }; gameCard = card;
      image.addEventListener('error', () => {
        if (gameCard !== card) return;
        const fallback = steamHeaderURL(id);
        if (image.src !== fallback) image.src = fallback;
        else { header.remove(); tip.classList.add('no-header'); positionTip(); }
      });
      loadGameImage(id).catch(() => steamHeaderURL(id)).then(url => { if (gameCard === card) image.src = url; });
      body.append(element('p', 'tip-kicker', (g.earlyAccess ? 'Early Access · ' : '') + g.releaseStatus), element('h3', '', g.name)); tip.setAttribute('aria-label', g.name + ' details');
      const all = [...columns.values()], dl = element('dl'), non = all.filter(f => !f.accessibility), count = list => g.featureDataKnown ? list.filter(f => columnState(g, f).listed).length + ' / ' + list.length : 'Unknown';
      addPair(dl, 'Feature score', g.score == null ? 'Unknown' : `${g.score} / ${latestResult.maxScore}`); addPair(dl, 'Visible feature count', count(visibleFeatures));
      addPair(dl, 'Non-accessibility total', count(non)); addPair(dl, 'All features', count(all));
      addPair(dl, g.reviewSource === 'steam' ? 'Steam-purchase reviews' : 'Reviews', fmt(g.reviews));
      if (g.positivePercent != null) addPair(dl, 'Positive reviews', g.positivePercent + '%');
      addPair(dl, 'Release date', date(g.releaseISO));
      if (g.achievementCount !== undefined) addPair(dl, 'Achievements', fmt(g.achievementCount));
      if (g.metadataUpdatedAt) addPair(dl, 'Steam metadata checked', date(g.metadataUpdatedAt));
      body.append(dl);
      card.dl = dl; updateCardCredits(g);
      const destinations = element('p', 'tip-game-links');
      for (const [index, destination] of gameDestinations(g).entries()) {
        if (index) destinations.append(document.createTextNode(' · '));
        destinations.append(link(destination.url, `${g.name}: ${destination.title}`, '', destination.title));
      }
      body.append(destinations, element('p', 'tip-fine', 'Steam app ' + g.id));
      if (g.steamLookupStatus === 'unavailable' && g.steamLookupResultCode === 15) body.append(element('p', 'tip-fine', 'Steam metadata unavailable; showing older data where available.'));
      if (g.tagIds?.length) {
        const tags = element('p', 'tip-tags', 'Tags: ');
        for (const [index, id] of g.tagIds.entries()) {
          const name = data.tags[id], tag = element('button', 'tip-tag', name); tag.type = 'button'; tag.dataset.tagName = name;
          tag.addEventListener('click', () => {
            if (!tipPinned) pinTip();
            const hasTags = state.hasTags.filter(value => value !== name), notTags = state.notTags.filter(value => value !== name);
            if (state.hasTags.includes(name)) notTags.push(name);
            else if (!state.notTags.includes(name)) hasTags.push(name);
            setFilters({ hasTags, notTags }, true, true);
          });
          if (index) tags.append(document.createTextNode(' · '));
          tags.append(tag);
        }
        body.append(tags); syncGameTags();
      }
      else if (g.tagDataKnown) body.append(element('p', 'tip-tags', 'Tags: None listed'));
      else addPair(dl, 'Tag data', 'Unknown');

    }
    if (pinned) pinTip();
    else if (!interactive) anchor.setAttribute('aria-describedby', 'tooltip');
    if (interactive) { anchor.setAttribute('aria-haspopup', 'dialog'); anchor.setAttribute('aria-controls', 'tooltip'); anchor.setAttribute('aria-expanded', 'true'); }
    positionTip();
    if (pinned) { tip.tabIndex = -1; tip.focus({ preventScroll: true }); }
  }
  function positionTip() {
    const anchor = tipAnchor, tip = $('tooltip');
    if (!anchor || tip.hidden) return;
    const r = anchor.getBoundingClientRect(), t = tip.getBoundingClientRect();
    let left = Math.max(12, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 12));
    let top = r.bottom + 9; if (top + t.height > innerHeight - 12) top = Math.max(12, r.top - t.height - 9);
    if (anchor.dataset.tip === 'game' && anchor.isConnected) {
      const beside = $('matrix-head').querySelector('.fixed-score').getBoundingClientRect().right + 8;
      if (beside + t.width <= innerWidth - 12) {
        left = beside;
        top = Math.max(12, Math.min(anchor.closest('tr').getBoundingClientRect().top, innerHeight - t.height - 12));
      }
    }
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
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
  if (fullWorker !== worker) fullWorker?.terminate();
  fullWorker = null; fullReady = false; backgroundStarted = false; backgroundError = null;
  pendingFullQuery = false; lastSubmittedQuery = null; completedRequest = 0; fullReadyAt = null;
  creditsStatus = 'idle'; creditsError = null; creditsFile = null; pendingCreditsQuery = false; syncCreditsControls();
  $('catalog-progress').hidden = true; $('catalog-retry').hidden = true;
  worker?.terminate(); ready = false; requestedSearch = null;
  $('query-controls').disabled = true;
  $('error').hidden = true; $('loading').hidden = false; $('results').hidden = true;
  $('loading-message').textContent = 'Loading the game catalog…';
  for (const button of $('presets').querySelectorAll('button')) button.disabled = true;
  worker = new Worker(new URL('./filter-worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('error', ({ target }) => { if (target === worker) showError('The catalog worker could not start. Reload this page or try a browser that supports module workers.', true); });
  worker.addEventListener('message', ({ target, data: message }) => {
    if (target !== worker) return;
    if (receiveCredits(message)) return;
    if (message.type === 'error') {
      if (message.requestId != null && message.requestId !== latestRequest) return;
      showError(message.message, !ready); return;
    }
    if (message.type === 'ready') {
      fullReady = !message.progressive?.partial; fullReadyAt = fullReady ? performance.now() : null;
      data = message; loadGameImage = createGameImageLoader(message.gameImages, { manifestURL: new URL('./data/manifest.json', location.href) });
      data.tags ??= []; data.languages ??= []; features = new Map(data.features.map(f => [f.id, f])); columns = new Map(featureColumns(data.features).map(f => [f.id, f])); ready = true;
      buildPicker(); buildCompatibilityPicker(); tagOptionsBuilt = false; $('tag-options').replaceChildren(); if (!$('tag-picker').hidden) buildTagPicker(); updateMetadata(); $('query-controls').disabled = false;
      languageOptionsBuilt = false; $('language-options').replaceChildren(); if (!$('language-picker').hidden) buildLanguagePicker();
      for (const button of $('presets').querySelectorAll('button')) button.disabled = false;
      loadURL();
    }
    receiveResult(message);
  });
  worker.postMessage({ type: 'init', minReviews: new URLSearchParams(location.search).get('minReviews') ?? DEFAULT_QUERY.minReviews, manifestURL: new URL('./data/manifest.json', location.href).href });
}

function receiveResult(message) {
  if (message.type !== 'result' || message.requestId !== latestRequest) return;
  completedRequest = message.requestId;
  latestResult = message.result;
  if (message.requestId === creditsRefreshRequest) {
    // Metadata arrival must not replace rows, reset scroll, or close a dialog.
    for (const row of latestResult.rows) {
      const game = games.get(row.id);
      if (game) Object.assign(game, { developerNames: row.developerNames, publisherNames: row.publisherNames });
    }
    if (gameCard) updateCardCredits(latestResult.pinnedCredits ?? games.get(gameCard.id) ?? {});
    $('results').removeAttribute('aria-busy');
    return;
  }
  state = latestResult.query;
  requestedSearch = serializeQuery(state, data.features, data.tags, data.languages);
  writeURL(state);
  syncControls(true, true, true); render();
  $('error').hidden = true; $('loading').hidden = true; $('results').hidden = false; $('results').removeAttribute('aria-busy');
  updateMatrixLayout();
  if (data.progressive?.partial && !backgroundStarted) requestAnimationFrame(() => requestAnimationFrame(() => startBackgroundCatalog()));
  if (fullReady && creditsStatus === 'idle') scheduleCredits();
}
function syncCreditsControls() {
  for (const [role] of creditFields) $(role + '-filter').disabled = creditsStatus !== 'ready';
  $('credits-status').hidden = creditsStatus === 'ready';
  $('credits-retry').hidden = creditsStatus !== 'error';
  $('credits-status-text').textContent = creditsStatus === 'error' ? 'Developer and publisher data could not load.'
    : creditsStatus === 'unavailable' ? 'Developer and publisher data is unavailable in this snapshot.' : 'Developer and publisher data is loading…';
}
function scheduleCredits() { requestAnimationFrame(() => requestAnimationFrame(() => startCredits())); }
function startCredits(retry = false) {
  if (!ready || !fullReady || creditsStatus === 'loading' || creditsStatus === 'ready' || (creditsStatus === 'error' && !retry)) return;
  creditsStatus = data.gameCredits ? 'loading' : 'unavailable'; creditsError = null;
  syncCreditsControls();
  if (creditsStatus === 'unavailable') { if (pendingCreditsQuery) creditsFailed('Developer and publisher data is unavailable in this snapshot.'); return; }
  if (pendingCreditsQuery) {
    $('catalog-progress').hidden = false; $('catalog-retry').hidden = true;
    $('catalog-status').textContent = 'Loading developer and publisher data to apply this filter…';
  }
  worker.postMessage({ type: 'credits', descriptor: data.gameCredits, snapshot: data.snapshot, manifestURL: new URL('./data/manifest.json', location.href).href });
}
function creditsFailed(message) {
  creditsStatus = 'error'; creditsError = message; syncCreditsControls();
  if (pendingCreditsQuery) {
    $('loading').hidden = true; $('catalog-progress').hidden = false; $('catalog-retry').hidden = false;
    $('catalog-status').textContent = 'Developer and publisher data could not load. Retry, or clear these filters.';
  }
}
function receiveCredits(message) {
  if (message.type === 'error' && message.phase === 'credits') { creditsFailed(message.message); return true; }
  if (message.type !== 'credits-ready') return false;
  creditsStatus = 'ready'; creditsError = null; creditsFile = { compression: message.compression, bytes: message.bytes };
  syncCreditsControls(); updateMetadata();
  // A newer typing draft belongs to its debounce, rather than this completion.
  if (lastSubmittedQuery?.requestId === latestRequest) query(true, !pendingCreditsQuery && completedRequest === latestRequest);
  return true;
}
function backgroundFailed(message) {
  backgroundError = message;
  $('catalog-progress').hidden = false; $('catalog-retry').hidden = false;
  $('catalog-status').textContent = 'More games could not load. Games with at least 20 reviews are still available.';
  if (pendingFullQuery) showError('The complete catalog could not load. Retry, or raise the review minimum to 20.');
}
function startBackgroundCatalog(retry = false) {
  if (!data.progressive?.partial || fullReady || (backgroundStarted && !retry)) return;
  fullWorker?.terminate(); backgroundStarted = true; backgroundError = null;
  $('catalog-progress').hidden = !pendingFullQuery; $('catalog-retry').hidden = true;
  $('catalog-status').textContent = 'Loading more games to apply this filter…';
  fullWorker = new Worker(new URL('./filter-worker.js', import.meta.url), { type: 'module' });
  fullWorker.addEventListener('error', ({ target }) => {
    if (target !== fullWorker) return;
    if (target === worker) showError('The catalog worker stopped. Reload this page to try again.', true);
    else backgroundFailed('The background worker could not start.');
  });
  fullWorker.addEventListener('message', ({ target, data: message }) => {
    if (target !== fullWorker) return;
    if (receiveCredits(message)) return;
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
      data.progressive = message.progressive;
      updateMetadata();
      $('catalog-progress').hidden = !pendingCreditsQuery;
      pendingFullQuery = false;
      previous.terminate();
      // A terminated worker may have an outstanding result. Reissue only the
      // latest submitted query, never a newer search draft awaiting its debounce.
      if (!pendingCreditsQuery && lastSubmittedQuery?.requestId === latestRequest && completedRequest !== latestRequest) worker.postMessage({ type: 'query', ...lastSubmittedQuery });
      scheduleCredits();
    } else receiveResult(message);
  });
  fullWorker.postMessage({ type: 'init', mode: 'full', plan: data.progressive.plan });
}

function writeURL(query, mode = 'replace') {
  const search = serializeView(query, highlightedFeature, data.features, data.tags, data.languages);
  if (search !== location.search) history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', location.pathname + search + location.hash);
}
function loadURL() {
  clearTimeout(inputTimer);
  try {
    const next = parseView(location.search, data.features, data.tags, data.languages);
    const sameQuery = requestedSearch === serializeQuery(next.query, data.features, data.tags, data.languages) && activeQueryRequest === latestRequest && $('error').hidden;
    const highlightChanged = highlightedFeature !== next.highlight;
    state = next.query; highlightedFeature = next.highlight;
    hideTip(); syncControls(); syncHighlight(highlightChanged);
    if (sameQuery) writeURL(state);
    else query();
  } catch (error) { latestRequest = ++requestId; showError('This link has invalid filters: ' + error.message); }
}
function query(keepGameTip = false, creditsOnly = false) {
  preserveGameTip = keepGameTip && tipPinned && tipAnchor?.dataset.tip === 'game';
  if (!preserveGameTip && !creditsOnly) hideTip();
  $('error').hidden = true;
  $('results').setAttribute('aria-busy', 'true');
  latestRequest = ++requestId;
  creditsRefreshRequest = creditsOnly ? latestRequest : 0;
  activeQueryRequest = latestRequest;
  requestedSearch = serializeQuery(state, data.features, data.tags, data.languages);
  pendingFullQuery = false;
  pendingCreditsQuery = false;
  $('catalog-progress').hidden = !backgroundError;
  lastSubmittedQuery = { requestId: latestRequest, query: state, ...(tipPinned && gameCard ? { pinnedGameId: gameCard.id } : {}) };
  if ((state.developer || state.publisher) && creditsStatus !== 'ready') {
    pendingCreditsQuery = true;
    $('results').hidden = true;
    if (data.progressive?.partial && !fullReady) startBackgroundCatalog();
    else startCredits();
    $('catalog-progress').hidden = false; $('catalog-retry').hidden = creditsStatus !== 'error';
    $('catalog-status').textContent = creditsStatus === 'error' ? 'Developer and publisher data could not load. Retry, or clear these filters.' : 'Loading developer and publisher data to apply this filter…';
    return;
  }
  if (!data.progressive?.partial || state.minReviews >= data.progressive.plan.minReviews) worker.postMessage({ type: 'query', ...lastSubmittedQuery });
  else {
    pendingFullQuery = true;
    startBackgroundCatalog();
    $('catalog-progress').hidden = false;
    $('catalog-status').textContent = backgroundError ? 'More games could not load. Retry to use this filter.' : 'Loading more games to apply this filter…';
  }
}
function setFilters(patch, resetPage = true, keepGameTip = false) {
  if (!ready) return;
  clearTimeout(inputTimer);
  try {
    const next = normalizeQuery({ ...state, ...patch, ...(resetPage && !('page' in patch) ? { page: 1 } : {}) }, data.features, data.tags, data.languages);
    writeURL(next, 'push');
    state = next;
    syncControls(!('releaseFrom' in patch) && !('releaseTo' in patch), !('q' in patch) || patch.q === $('search').value,
      creditFields.every(([role]) => !(role in patch) || patch[role] === $(role + '-filter').value));
    query(keepGameTip);
  } catch (error) { showError(error.message); }
}
function syncControls(preserveDateDraft = false, preserveSearchDraft = false, preserveCreditDraft = false) {
  // Normalize the query for matching and URLs without rewriting a title being typed.
  if (!preserveSearchDraft) $('search').value = state.q;
  if (!preserveCreditDraft) for (const [role] of creditFields) $(role + '-filter').value = state[role];
  $('early-access').checked = state.includeEarlyAccess; $('accessibility').checked = state.includeAccessibility;
  $('multiplayer').checked = state.includeMultiplayer;
  $('hardware').checked = state.includeHardware;
  $('min-reviews').value = state.minReviews; $('release').value = state.release;
  if (!preserveDateDraft || !dateDraftDirty) {
    $('release-from').value = state.releaseFrom; $('release-to').value = state.releaseTo;
    setDateError(''); dateDraftDirty = false;
  }
  const [sortField, sortDirection] = state.sort.split('-'); $('sort').value = sortField;
  for (const direction of ['asc', 'desc']) $('sort-' + direction).setAttribute('aria-pressed', String(direction === sortDirection));
  for (const option of $('feature-options').children) {
    const id = Number(option.dataset.featureId), kind = state.has.includes(id) ? 'has' : state.not.includes(id) ? 'not' : '';
    option.classList.toggle('selected', !!kind); option.classList.toggle('excluded', kind === 'not');
    for (const button of option.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.action === kind));
  }
  $('active-count').textContent = state.has.length + state.not.length;
  $('active-tag-count').textContent = state.hasTags.length + state.notTags.length;
  $('active-date-count').textContent = Number(!!state.releaseFrom) + Number(!!state.releaseTo);
  $('active-compatibility-count').textContent = Object.values(state.compatibility).filter(value => value !== 'ignore').length;
  $('active-language-count').textContent = state.hasLanguages.length + state.notLanguages.length;
  $('active-developer-count').textContent = Number(!!state.developer.trim()) + Number(!!state.publisher.trim());
  for (const target of compatibilityTargets) {
    const select = $('compatibility-' + target.key); select.value = state.compatibility[target.key];
    select.closest('label').classList.toggle('selected', select.value !== 'ignore');
  }
  syncTagOptions();
  syncGameTags();
  syncGameCredits();
  syncLanguageOptions();
  const chips = [], chipContainer = $('active-filters');
  const existingChips = new Map([...chipContainer.children].map(chip => [chip.dataset.filterKey, chip]));
  const addChip = (key, classes, label, ariaLabel, remove) => {
    let chip = existingChips.get(key);
    if (!chip) {
      chip = element('button', 'filter-chip ' + classes);
      chip.type = 'button'; chip.dataset.filterKey = key; chip.setAttribute('aria-label', ariaLabel);
      chip.addEventListener('click', remove);
    }
    if (chip.textContent !== label) chip.textContent = label;
    chips.push(chip); return chip;
  };
  for (const kind of ['has', 'not']) for (const id of state[kind]) {
    const f = features.get(id);
    addChip(JSON.stringify([kind, id]), kind, `${kind === 'has' ? '✓' : '−'} ${f.name} ×`,
      'Remove ' + (kind === 'has' ? 'required ' : 'excluded ') + f.name,
      () => setFilters({ [kind]: state[kind].filter(value => value !== id) }));
  }
  for (const [role, label] of creditFields) {
    if (state[role]) addChip(role, 'developer-chip', `${label}: ${state[role]} ×`, `Remove ${role} filter`, () => setFilters({ [role]: '' }));
  }
  for (const kind of ['hasTags', 'notTags']) for (const name of state[kind]) {
    const required = kind === 'hasTags';
    addChip(JSON.stringify([kind, name]), 'tag-chip ' + (required ? 'has' : 'not'), `${required ? '✓' : '−'} Tag: ${name} ×`,
      'Remove ' + (required ? 'required' : 'excluded') + ' tag ' + name,
      () => setFilters({ [kind]: state[kind].filter(value => value !== name) }));
  }
  for (const [key, label, boundary] of [['releaseFrom', 'Released from', 'start'], ['releaseTo', 'Released through', 'end']]) {
    if (!state[key]) continue;
    const chip = addChip(key, 'date-chip', `${label} ${state[key]} ×`, 'Remove ' + boundary + ' release date', () => setFilters({ [key]: '' }));
    chip.dataset.dateBound = key;
  }
  for (const target of compatibilityTargets) {
    const rating = target.ratings.find(option => option.value === state.compatibility[target.key]);
    if (!rating) continue;
    const chip = addChip(JSON.stringify(['compatibility', target.key, rating.value]), 'compatibility-chip', `${target.name}: ${rating.label} ×`,
      `Remove ${target.name} compatibility filter`, () => setFilters({ compatibility: { ...state.compatibility, [target.key]: 'ignore' } }));
    chip.dataset.compatibilityTarget = target.key;
  }
  for (const kind of ['hasLanguages', 'notLanguages']) for (const rule of state[kind]) {
    const [key, category] = rule.split(':'), language = data.languages.find(item => item.key === key);
    const required = kind === 'hasLanguages', name = `${language.name} ${category}`;
    const chip = addChip(JSON.stringify([kind, rule]), 'language-chip ' + (required ? 'has' : 'not'), `${required ? '✓' : '−'} ${name} ×`,
      `Remove ${required ? 'required' : 'excluded'} ${name}`, () => setFilters({ [kind]: state[kind].filter(value => value !== rule) }));
    chip.dataset.languageRule = rule;
  }
  // Keep unchanged buttons in place so a date-field blur cannot interrupt their click or focus.
  for (const [index, chip] of chips.entries()) {
    if (chipContainer.children[index] !== chip) chipContainer.insertBefore(chip, chipContainer.children[index] ?? null);
  }
  while (chipContainer.children.length > chips.length) chipContainer.lastElementChild.remove();
  for (const button of $('presets').querySelectorAll('button')) {
    const preset = PRESETS.find(p => p.id === button.dataset.preset);
    const active = serializeQuery({ ...state, page: 1 }, data.features, data.tags, data.languages) === serializeQuery(preset.query, data.features, data.tags, data.languages);
    button.setAttribute('aria-pressed', String(active));
  }
}
function setDateError(message) {
  if (message && $('date-picker').hidden) togglePicker('date');
  $('date-error').textContent = message; $('date-error').hidden = !message;
  for (const id of ['release-from', 'release-to']) {
    if (message) $(id).setAttribute('aria-invalid', 'true');
    else $(id).removeAttribute('aria-invalid');
  }
}
function applyReleaseDates(otherFilters = {}) {
  dateDraftDirty = true;
  for (const [id, label] of [['release-from', 'start'], ['release-to', 'end']]) {
    if (!$(id).validity.valid) { setDateError(`Enter the ${label} date as YYYY, YYYY-MM, or YYYY-MM-DD.`); return; }
  }
  const patch = { ...otherFilters, releaseFrom: $('release-from').value, releaseTo: $('release-to').value };
  try {
    const next = normalizeQuery({ ...state, ...patch }, data.features, data.tags, data.languages);
    // Ignore repeated change events once these filters have already been requested.
    if (serializeQuery(next, data.features, data.tags, data.languages) === requestedSearch && activeQueryRequest === latestRequest && $('error').hidden) {
      dateDraftDirty = false; setDateError(''); return;
    }
  }
  catch (error) { setDateError(error.message); return; }
  setFilters(patch);
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
    if (f.hardware) continue;
    const label = element('div', 'feature-option'); label.dataset.name = f.name.toLowerCase(); label.dataset.featureId = f.id; label.title = f.description;
    label.style.setProperty('--group-color', groupColors[f.group] ?? '#667a91');
    const name = element('span', 'option-name'); name.append(icon(f.icon), element('span', '', f.name));
    label.append(name, featureActions(f)); fragment.append(label);
  }
  $('feature-options').replaceChildren(fragment);
}
function buildCompatibilityPicker() {
  const fragment = document.createDocumentFragment();
  for (const target of compatibilityTargets) {
    const label = element('label', 'compatibility-option'), name = element('span', 'option-name', target.name);
    const column = [...columns.values()].find(column => column.key === target.key);
    if (column) name.prepend(icon(column.icon));
    const select = element('select'); select.id = 'compatibility-' + target.key;
    select.setAttribute('aria-describedby', 'compatibility-help');
    for (const rating of [{ value: 'ignore', label: 'Ignore' }, ...target.ratings]) {
      const option = element('option', '', rating.label); option.value = rating.value; select.append(option);
    }
    select.addEventListener('change', () => setFilters({ compatibility: { ...state.compatibility, [target.key]: select.value } }));
    label.append(name, select); fragment.append(label);
  }
  $('compatibility-options').replaceChildren(fragment);
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
function buildLanguagePicker() {
  if (languageOptionsBuilt) return;
  const fragment = document.createDocumentFragment();
  const ordered = [...data.languages].sort((a, b) => (data.languageCounts?.[b.id] ?? 0) - (data.languageCounts?.[a.id] ?? 0) || a.name.localeCompare(b.name, 'en'));
  for (const language of ordered) {
    const card = element('div', 'language-card'); card.dataset.language = language.key;
    card.dataset.search = `${language.name} ${language.key}`.normalize('NFKC').toLocaleLowerCase('en');
    const header = element('div', 'language-heading'), heading = element('h3', '', language.name); heading.id = 'language-name-' + language.key;
    const count = element('span', 'language-frequency', fmt(data.languageCounts?.[language.id] ?? 0));
    count.title = `${count.textContent} games with ${language.name} interface support in the full catalog`;
    header.append(heading, count);
    card.setAttribute('role', 'group'); card.setAttribute('aria-labelledby', heading.id); card.append(header);
    for (const category of LANGUAGE_KINDS) {
      const rule = `${language.key}:${category.key}`, row = element('div', 'language-row'); row.dataset.languageRule = rule;
      const label = element('span', '', category.name), actions = element('span', 'feature-actions');
      actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', `${language.name} ${category.name.toLowerCase()}`);
      for (const [kind, action, verb] of [['hasLanguages', 'has', 'Require'], ['notLanguages', 'not', 'Exclude']]) {
        const button = element('button', 'feature-action'); button.type = 'button'; button.dataset.action = action;
        button.append(icon(action === 'has' ? 'plus' : 'minus')); button.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-label', `${verb} ${language.name} ${category.name.toLowerCase()}`); button.title = button.getAttribute('aria-label');
        button.addEventListener('click', () => {
          const hasLanguages = state.hasLanguages.filter(value => value !== rule), notLanguages = state.notLanguages.filter(value => value !== rule);
          if (!state[kind].includes(rule)) (kind === 'hasLanguages' ? hasLanguages : notLanguages).push(rule);
          setFilters({ hasLanguages, notLanguages });
        }); actions.append(button);
      }
      row.append(label, actions); card.append(row);
    }
    fragment.append(card);
  }
  $('language-options').replaceChildren(fragment); languageOptionsBuilt = true; filterLanguageOptions();
}
function syncLanguageOptions() {
  if (!languageOptionsBuilt) return;
  for (const row of $('language-options').querySelectorAll('.language-row')) {
    const rule = row.dataset.languageRule, kind = state.hasLanguages.includes(rule) ? 'has' : state.notLanguages.includes(rule) ? 'not' : '';
    row.classList.toggle('selected', !!kind); row.classList.toggle('excluded', kind === 'not');
    for (const button of row.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.action === kind));
  }
  for (const card of $('language-options').children) card.classList.toggle('selected', !!card.querySelector('.language-row.selected'));
}
function filterLanguageOptions() {
  const search = $('language-search').value.normalize('NFKC').toLocaleLowerCase('en').trim(); let visible = 0;
  for (const card of $('language-options').children) { card.hidden = !card.dataset.search.includes(search); if (!card.hidden) visible++; }
  $('language-empty').hidden = visible > 0;
  $('language-empty').textContent = data.languages.length ? 'No languages match your search.' : 'Language filters are unavailable for this catalogue.';
}
function matchesCreditFilter(role, name) {
  const term = normalizeCreditSearch(state[role]).trim();
  return !!term && normalizeCreditSearch(name).includes(term);
}
function syncGameCredits() {
  for (const button of $('tooltip').querySelectorAll('.tip-credit')) {
    const { creditRole: role, creditName: name } = button.dataset;
    const matches = matchesCreditFilter(role, name);
    const action = matches ? `Clear ${role} filter: ${name}` : `Filter by ${role}: ${name}`;
    button.classList.toggle('has', matches);
    button.setAttribute('aria-pressed', String(matches));
    button.setAttribute('aria-label', action);
    button.title = action;
  }
}
function syncGameTags() {
  for (const tag of $('tooltip').querySelectorAll('.tip-tag')) {
    const name = tag.dataset.tagName, kind = state.hasTags.includes(name) ? 'has' : state.notTags.includes(name) ? 'not' : '';
    const status = kind === 'has' ? 'Required' : kind === 'not' ? 'Excluded' : 'Not filtered';
    const action = kind === 'has' ? 'Exclude' : kind === 'not' ? 'Clear filter for' : 'Require';
    tag.classList.toggle('has', kind === 'has'); tag.classList.toggle('not', kind === 'not');
    tag.setAttribute('aria-pressed', String(!!kind)); tag.setAttribute('aria-label', `${name}: ${status}. ${action} tag ${name}`);
    tag.title = `${status}. ${action} tag ${name}`;
  }
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
  for (const name of ['feature', 'tag', 'date', 'compatibility', 'language', 'developer']) {
    const expanded = name === kind && open; $(name + '-picker').hidden = !expanded;
    const searchControl = $(name + '-search-control'); if (searchControl) searchControl.hidden = !expanded;
    $(name + '-toggle').setAttribute('aria-expanded', String(expanded));
  }
  if (kind === 'tag' && open) { buildTagPicker(); syncTagOptions(); }
  if (kind === 'language' && open) { buildLanguagePicker(); syncLanguageOptions(); }
}
function formatCatalogFile(file) {
  const compression = { brotli: 'Brotli', gzip: 'gzip', uncompressed: 'uncompressed' }[file.compression];
  return compression + (file.bytes == null ? '' : ' (' + (file.bytes / 1_000_000).toFixed(2) + ' MB)');
}
function updateMetadata() {
  $('package-summary').textContent = `${fmt(data.gameCount)} games · ${columns.size} feature columns`;
  const files = data.progressive?.files;
  const fileInfo = files ? ` Initial data file: ${formatCatalogFile(files.priority)}.${files.remainder ? ` Second data file: ${formatCatalogFile(files.remainder)}.` : ''}`
    : data.catalogCompression ? ` Data file: ${formatCatalogFile({ compression: data.catalogCompression, bytes: data.catalogBytes })}.` : '';
  $('method-dates').textContent = `Updated ${date(data.importedAt)}. Individual games may have older data.${fileInfo}${creditsFile ? ` Developer/publisher data file: ${formatCatalogFile(creditsFile)}.` : ''}`;
}

function getView() { return { filters: state, highlight: highlightedFeature, matching, displayed: view.length, featureColumns: visibleFeatures.length, maxScore: latestResult?.maxScore, page: latestResult?.page, pageCount: latestResult?.pageCount, games: view.map(({ id, name, score, count, rank, reviews, positivePercent, releaseISO, earlyAccess, tagIds }) => ({ id, name, score, count, rank, reviews, positivePercent, releaseISO, earlyAccess, tags: (tagIds ?? []).map(id => data.tags[id]) })) }; }
for (const preset of PRESETS) {
  const button = element('button', 'view-button'); button.append(icon(preset.id === 'feature-leaders' ? 'trophy' : 'warning'), element('span', '', preset.title)); button.type = 'button'; button.disabled = true; button.dataset.preset = preset.id; button.title = preset.description;
  button.addEventListener('click', () => setFilters(preset.query)); $('presets').append(button);
}
$('filters').addEventListener('submit', e => { e.preventDefault(); if ($('min-reviews').reportValidity()) applyReleaseDates({ ...textFilterPatch(), minReviews: Number($('min-reviews').value) }); });
for (const [field, id] of textFields) $(id).addEventListener('input', e => {
  clearTimeout(inputTimer); state = { ...state, [field]: e.target.value }; latestRequest = ++requestId;
  inputTimer = setTimeout(() => setFilters(textFilterPatch()), 250);
});
$('early-access').addEventListener('change', e => setFilters({ includeEarlyAccess: e.target.checked }));
$('accessibility').addEventListener('change', e => setFilters({ includeAccessibility: e.target.checked }));
$('multiplayer').addEventListener('change', e => setFilters({ includeMultiplayer: e.target.checked }));
$('hardware').addEventListener('change', e => setFilters({ includeHardware: e.target.checked }));
$('release').addEventListener('change', e => setFilters({ release: e.target.value }));
for (const id of ['release-from', 'release-to']) {
  $(id).addEventListener('input', () => { dateDraftDirty = true; });
  $(id).addEventListener('change', () => applyReleaseDates());
  $(id).addEventListener('invalid', () => { if ($('date-picker').hidden) togglePicker('date'); });
}
$('sort').addEventListener('change', e => setFilters({ sort: e.target.value + '-' + state.sort.split('-')[1] }));
for (const direction of ['asc', 'desc']) $('sort-' + direction).addEventListener('click', () => setFilters({ sort: state.sort.split('-')[0] + '-' + direction }));
$('min-reviews').addEventListener('change', e => { if (e.target.value !== '' && e.target.reportValidity()) setFilters({ minReviews: Number(e.target.value) }); else e.target.value = state.minReviews; });
$('feature-search').addEventListener('input', e => { for (const label of $('feature-options').children) label.hidden = !label.dataset.name.includes(e.target.value.toLowerCase()); });
$('tag-search').addEventListener('input', filterTagOptions);
$('language-search').addEventListener('input', filterLanguageOptions);
for (const kind of ['feature', 'tag', 'date', 'compatibility', 'language', 'developer']) $(kind + '-toggle').addEventListener('click', () => togglePicker(kind));
for (const id of ['reset', 'empty-reset', 'error-reset']) $(id).addEventListener('click', () => setFilters(DEFAULT_QUERY));
$('retry').addEventListener('click', startWorker);
$('highlight-chip').addEventListener('click', () => setHighlight(null));
$('previous').addEventListener('click', () => setFilters({ page: state.page - 1 }, false));
$('next').addEventListener('click', () => setFilters({ page: state.page + 1 }, false));
function goToPage() { if ($('page').reportValidity()) setFilters({ page: Number($('page').value) }, false); }
$('go-page').addEventListener('click', goToPage);
$('page').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); goToPage(); } });
for (const [id, name] of [['news', 'bell'], ['about', 'info']]) {
  $(id).prepend(icon(name));
  $(id).addEventListener('click', () => { hideTip(); $(id + '-dialog').showModal(); $(id + '-content').scrollTop = 0; });
  $(id + '-close').addEventListener('click', () => $(id + '-dialog').close());
}
$('share').prepend(icon('link'));
$('compatibility-close').addEventListener('click', () => $('compatibility-dialog').close());
$('compatibility-dialog').addEventListener('keydown', e => {
  if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
  const stops = [...e.currentTarget.querySelectorAll('button, a[href], [tabindex="0"]')];
  const first = stops[0], last = stops.at(-1);
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
$('compatibility-dialog').addEventListener('close', () => {
  if (compatibilityAnchor?.isConnected) compatibilityAnchor.focus({ preventScroll: true });
  compatibilityAnchor = null;
});
$('faq-example').addEventListener('click', e => {
  if (!ready || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const target = new URL(e.currentTarget.href);
  let next;
  try { next = parseQuery(target.search, data.features, data.tags, data.languages); }
  catch { return; }
  e.preventDefault();
  $('about-dialog').close();
  setFilters(next);
});
for (const id of ['news-dialog', 'about-dialog', 'compatibility-dialog']) $(id).addEventListener('click', e => {
  if (e.target !== e.currentTarget) return;
  const rect = e.currentTarget.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) e.currentTarget.close();
});
$('share').addEventListener('click', async () => {
  if (ready && textFields.some(([, id, parameter]) => $(id).value !== (new URLSearchParams(location.search).get(parameter) ?? ''))) setFilters(textFilterPatch(), false);
  try { await navigator.clipboard.writeText(location.href); $('share-status').textContent = 'Link copied'; $('share-label').textContent = 'Copied!'; setTimeout(() => { $('share-label').textContent = 'Copy link'; }, 1800); }
  catch { $('share-status').textContent = 'Copy the address from your browser to share this view.'; $('share-label').textContent = 'Copy address bar URL'; }
});
window.addEventListener('popstate', () => { if (ready) loadURL(); });
  $('matrix').addEventListener('pointerover', e => { const cell = e.target.closest('[data-feature]'); highlightColumn(cell ? Number(cell.dataset.feature) : null); const anchor = e.target.closest('[data-tip]'); if (anchor && !anchor.contains(e.relatedTarget) && e.pointerType !== 'touch') showTip(anchor); });
  $('matrix').addEventListener('pointerout', e => { const anchor = e.target.closest('[data-tip]'); if (anchor && !anchor.contains(e.relatedTarget) && !$('tooltip').contains(e.relatedTarget)) scheduleTipHide(); });
  $('matrix').addEventListener('pointerleave', e => { highlightColumn(null); if (!$('tooltip').contains(e.relatedTarget)) scheduleTipHide(); });
  $('matrix').addEventListener('focusin', e => { const anchor = e.target.closest('[data-tip]'); if (anchor && !suppressFocusTip) showTip(anchor); const cell = e.target.closest('[data-feature]'); highlightColumn(cell ? Number(cell.dataset.feature) : null); });
  $('matrix').addEventListener('focusout', e => { if (!$('tooltip').contains(e.relatedTarget)) { highlightColumn(null); scheduleTipHide(); } });
  $('matrix').addEventListener('click', e => {
    const disclosure = e.target.closest('button[data-disclosure]'); if (disclosure) { showDisclosure(disclosure); return; }
    const rating = e.target.closest('button[data-compatibility]'); if (rating) { showCompatibility(rating); return; }
    const anchor = e.target.closest('button[data-tip]'); if (anchor) showTip(anchor, true);
  });
  $('tooltip').addEventListener('pointerenter', () => clearTimeout(tipHideTimer));
  $('tooltip').addEventListener('pointerleave', e => { if (!tipAnchor?.contains(e.relatedTarget)) scheduleTipHide(); });
  $('tooltip').addEventListener('focusin', () => clearTimeout(tipHideTimer));
  $('tooltip').addEventListener('focusout', e => { if (!$('tooltip').contains(e.relatedTarget) && !tipAnchor?.contains(e.relatedTarget)) scheduleTipHide(); });
  document.addEventListener('pointerdown', e => { if (tipAnchor && !tipAnchor.contains(e.target) && !$('tooltip').contains(e.target)) hideTip(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTipAndRestoreFocus(); });
  $('matrix-region').addEventListener('scroll', () => { if (!preserveGameTip && !(tipPinned && tipAnchor?.dataset.tip === 'game')) hideTip(); }, { passive: true });
  window.addEventListener('resize', () => {
    if (tipPinned && tipAnchor?.dataset.tip === 'game') {
      const rect = $('tooltip').getBoundingClientRect();
      $('tooltip').style.left = Math.max(12, Math.min(rect.left, innerWidth - rect.width - 12)) + 'px';
      $('tooltip').style.top = Math.max(12, Math.min(rect.top, innerHeight - rect.height - 12)) + 'px';
    } else hideTip();
    scheduleMatrixLayout();
  });
  const layoutObserver = new ResizeObserver(scheduleMatrixLayout);
  layoutObserver.observe($('matrix-region'));
  layoutObserver.observe(document.querySelector('main'));


$('catalog-retry').addEventListener('click', () => pendingCreditsQuery && fullReady ? startCredits(true) : startBackgroundCatalog(true));
$('credits-retry').addEventListener('click', () => startCredits(true));
window.steamFeatureAtlas = Object.freeze({ getView, setFilters, getLoadState: () => ({ fullReady, backgroundStarted, backgroundError, pendingFullQuery, fullReadyAt, partial: data.progressive?.partial === true, creditsStatus, creditsError, pendingCreditsQuery }) });
startWorker();
