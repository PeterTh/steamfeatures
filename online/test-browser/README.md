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

These checks use real catalog entries and cover filtering, sorting, shared URLs, history, tooltips, tags, and desktop/mobile layouts. They require a full catalog rather than the tiny fixture used by the Node importer tests. Playwright is a separate development tool; the application itself has no npm dependencies.

Run `highlight-checks.js` in the same way for column selection, URL persistence, compact table sizing, and tooltip placement. It checks viewports from 320 to 1920 pixels and returns their measured layouts with its results.

`layout-checks.js` checks how the matrix fits the viewport when panels open and close, the window resizes, and keyboard navigation reveals a highlighted column.

`release-date-checks.js` checks inclusive day, month, and year bounds, independent settings, filter combinations, invalid dates and ranges, shared URLs, history, and mobile layouts. It also verifies ISO dates in controls, chips, game details, and the catalog update note. Expected results come from the served catalog.

Run all four harnesses in Firefox and Chromium.
