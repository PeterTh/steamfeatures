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
