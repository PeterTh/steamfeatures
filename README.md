# Steam Feature Atlas

Explore Steam games through a feature matrix, required/excluded badges, title search, review thresholds, release filters, and shareable URLs.

The GitHub Pages application lives in [`online/`](online/README.md). Filtering runs locally in the browser. A daily workflow combines bulk datasets with new Steam releases and a rolling refresh of up to 4,000 existing games.

See the [setup and deployment instructions](online/README.md#publish-to-github-pages) for `peterth/steamfeatures`.

## Development

Node.js 22+ and Git are required. There are no npm dependencies to install.

```sh
npm --prefix online test
```

For a fresh checkout, build a small fixture catalog and start the local server:

```sh
npm --prefix online run build:fixture
npm --prefix online start
```

Open http://127.0.0.1:4178/. Edit files in `online/src/`; `online/dist/` is generated. The [application guide](online/README.md) covers full imports, local data reuse, and first deployment.

## Layout

| Path | Contents |
| --- | --- |
| `online/src/` | Application, styles, template, icons, and bundled font |
| `online/scripts/` | Import, build, preview, and release tools |
| `online/test/`, `online/test-query/` | Node tests |
| `online/test-browser/` | Portable browser checks |
| `online/docs/benchmarks/` | Recorded data-format measurements |
| `.github/workflows/` | Refresh and GitHub Pages deployment |

Generated catalogs (`online/dist/`), download/checkpoint caches (`online/.cache/`), and screenshots/reports (`online/test-results/`) are ignored. The earlier offline prototype and research are preserved locally under `.local/archive/offline-prototype/`, outside the repository contents.

## License

Project source: [MIT](LICENSE), copyright 2026 Peter Thoman. See [third-party notices](THIRD_PARTY_NOTICES.md) for the font, Steam symbol, and imported data.
