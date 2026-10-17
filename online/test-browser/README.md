# Browser checks

Serve the full catalog with `npm start` from `online/`. `checks.js` contains an async function that accepts an existing Playwright `Page` and optional settings:

```js
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Run from online/ with a Playwright page supplied by your runner.
const check = (0, eval)(await readFile('test-browser/checks.js', 'utf8'));
const result = await check(page, {
  baseURL: 'http://127.0.0.1:4178/',
  screenshotDirectory: resolve('test-results/browser'),
});
console.log(result);
```

The default base URL is `http://127.0.0.1:4178/`. Screenshots are disabled unless `screenshotDirectory` is supplied. When enabled, the harness writes `desktop.png`, `mobile.png`, and `tags.png` inside that directory. Test reports and screenshots belong in the ignored `test-results/` directory.

These checks use real catalog entries and cover filtering, sorting, shared URLs, history, tooltips, tags, and desktop/mobile layouts. They require a full catalog rather than the tiny fixture used by the Node importer tests. Playwright is a separate development tool; the browser application itself has no npm dependencies. The offline Steam collector uses the locked `steam-user` dependency.

Run `highlight-checks.js` in the same way for column selection, URL persistence, compact table sizing, and tooltip placement. It checks viewports from 320 to 1920 pixels and returns their measured layouts with its results.

Run `game-card-checks.js` for title-button pinning, Steam/SteamDB/Steamograph links, on-demand artwork, scrolling, keyboard focus, mobile layouts, failed images and stale lookup responses. It verifies that initial loading makes no artwork requests. Optional `screenshotDirectory` output captures the desktop and mobile cards.

`layout-checks.js` checks how the matrix fits the viewport when panels open and close, the window resizes, and keyboard navigation reveals a highlighted column.

`release-date-checks.js` checks inclusive day, month, and year bounds, independent settings, filter combinations, invalid dates and ranges, shared URLs, history, and mobile layouts. It also verifies ISO dates in controls, chips, game details, and the catalog update note. Expected results come from the served catalog.

`steam-enrichment-checks.js` checks cloud flag ordering, Dynamic Cloud Sync, negative-score badges, achievement counts, the four opt-in hardware columns and their rating symbols. It verifies the dedicated compatibility dropdowns, exact rating matches, combinations, chips, URL/history/reset behavior, unavailable-data handling, embedded icons, and layouts from 320 to 1440 pixels. It needs an enriched catalog with examples of these flags and all four Deck ratings.

`compatibility-details-checks.js` opens real Deck, Machine, Frame and SteamOS ratings and checks device-specific notes, duplicate removal, keyboard focus and dismissal, unchanged filters/scores, and scrolling mobile dialogs. It uses Portal 2, Hotline Miami, Halo Infinite and PUBG from the enriched catalog.

`language-checks.js` verifies searchable per-language cards, regional variants, independent interface/audio/subtitle requirements and exclusions, combined filters, unchanged table columns and scores, removable chips, shared URLs, history, reset, keyboard focus, and layouts from 320 to 1440 pixels. It needs a full catalog with language support data.

`search-tag-checks.js` checks whitespace and cursor preservation during slow title typing, normalized matching and URLs, and clickable game-card tags cycling through required, excluded, and off. It covers synchronized picker/chip state, keyboard and touch input, cards whose games are filtered out, focus restoration, hover previews, history, reload, reset, and mobile layout. Supply a page created with `hasTouch: true` for its mobile tap checks.

Run all eight harnesses in Firefox and Chromium.

`catalog-checks.cjs` runs the eight interface harnesses plus blocked-download, failure/retry, search-draft and worker-handover checks against the normal `dist/` build, in Edge and Firefox. `catalog-benchmark.cjs` compares its initial loading time against the same code and records served through the full-catalogue fallback. The comparison server strips only `current.progressive` from the reference manifest, and can pace catalogue transfers at 10 Mbps with 150 ms request latency.

With Playwright available to Node, run from `online/`:

```sh
node test-browser/catalog-checks.cjs
node test-browser/catalog-benchmark.cjs
```

Set `CATALOG_PLAYWRIGHT` to the module path if Playwright is installed elsewhere. `CATALOG_BROWSERS` defaults to `edge,firefox`; `CATALOG_LOCAL_REPS` and `CATALOG_SLOW_REPS` default to 6 and 3 measured samples per variant and browser. Reports go to the ignored `test-results/` directory. The built catalogue must contain progressive descriptors; no separate prototype build is used.
