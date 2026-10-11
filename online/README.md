# Build and deployment

For the fixture-based development setup, see the [main README](../README.md#development). Commands below run from `online/`. The preview serves `dist/` at http://127.0.0.1:4178/; set `PORT` to change the port. Source edits require a rebuild. Opening `index.html` directly will not load the catalog worker.

## Build a full catalog

For the expanded StoreBrowse/PICS collection, including cloud streaming and Steam hardware details, see the [collection reference](../docs/steam-data.md). With the existing catalog and prepared sources, run:

```sh
npm run collect:steam -- --sources .cache/prepared-sources.json --build
```

The command resumes its SQLite checkpoint, then builds and verifies the site. It does not deploy it. System requirements are deferred.

The first import downloads the bulk sources and checks released games through Steam:

```sh
npm run build -- --bootstrap-steam
```

Rerun the command to resume an interrupted import. Progress is saved in `.cache/steam-refresh-state.json`; unresolved entries are listed in `.cache/steam-refresh-unresolved.json`.

Before first publication, every released game must have known features, tags and review counts, or a confirmed Steam access denial (result code `15`). Confirmed empty tags and zero reviews count as known. Denied games keep their available data and are retried after 30 days. Other incomplete results block the initial build.

After the initial import, `npm run build` fetches the latest bulk sources, discovers new releases and refreshes a rotating selection of existing games. Builds replace `dist/` only after success.

### Prepared sources and offline builds

To pin the bulk inputs for reuse, save the result of [`fetchSources`](scripts/sources.mjs):

```sh
node --input-type=module -e "
import { writeFile } from 'node:fs/promises';
import { fetchSources } from './scripts/sources.mjs';
const sources = await fetchSources('.cache');
await writeFile('.cache/prepared-sources.json', JSON.stringify(sources, null, 2));
"
```

This downloads the bulk sources and records their paths, revisions and checksums. Use those inputs for a bootstrap or incremental refresh:

```sh
npm run build -- --sources .cache/prepared-sources.json --bootstrap-steam
npm run build -- --sources .cache/prepared-sources.json --refresh-steam
```

With a completed checkpoint for those sources, rebuild without Steam requests:

```sh
npm run build -- --sources .cache/prepared-sources.json --finalize-steam
```

`--sources` alone builds from the bulk files without merging saved Steam metadata. `--finalize-steam` includes that metadata and checks bootstrap coverage using the checkpoint and archived responses.

## Publish to GitHub Pages

Push the source to a public repository and select **Settings → Pages → Build and deployment → GitHub Actions**. The workflow needs permission to deploy Pages and commit `online/provenance-lock.json`; branch protection must allow that bot commit.

### First deployment

Build a complete catalog as described above, then package it:

```sh
npm run package:bootstrap
```

This verifies the catalog, saved refresh state and raw response archive, then writes `.cache/steam-feature-atlas-bootstrap.tar.gz`. Packaging requires `tar`. Fixtures and incomplete imports are rejected.

Upload the package as a release asset and run the workflow with that release tag. From the repository root, using GitHub CLI:

```sh
gh release create bootstrap-initial online/.cache/steam-feature-atlas-bootstrap.tar.gz --repo peterth/steamfeatures --title "Initial catalog snapshot" --notes "Catalog and refresh state for the first deployment."
gh workflow run pages.yml --repo peterth/steamfeatures --ref main -f bootstrap_release=bootstrap-initial
```

Replace `peterth/steamfeatures` for another repository. The same upload and workflow dispatch can be done through GitHub's web interface. This first run deploys the package as-is, so rebuild and repackage after source changes.

### Daily refreshes

Leave `bootstrap_release` empty for subsequent runs. The workflow runs on source changes, manual dispatch and daily at **04:17 UTC**. It restores the published refresh state and raw data, applies updates, verifies the result and deploys it. After deployment, it commits only the small provenance file; generated datasets stay out of Git.

Normal workflow runs require a completed published catalog. If it is missing or invalid, the job stops rather than starting another full bootstrap. The existing site remains available when a build fails.

## Refresh settings and recovery

| Setting | Default | Purpose |
| --- | --- | --- |
| `STEAM_REFRESH_LIMIT` / `--steam-limit` | `4000` | Existing released games checked per UTC day, shared across runs; range 1–5000 |
| `STEAM_REQUEST_SPACING_MS` | `5000` | Pause after each Steam response; full collection requires at least 5000 ms |
| `PAGES_BASE_URL` | Set by the workflow | HTTPS deployment used to recover published data and compare coverage |
| `--steam-state <file>` | None | Initial checkpoint when no published state is available |
| `STEAM_ALLOW_BOOTSTRAP` | `0` in Actions | Prevents automatic full backfills in normal workflow runs |

New-release discovery has a separate allowance. Existing games are requested in batches of 100; incremental runs allow at most 100 HTTP attempts, including retries. Discovery and refresh progress are checkpointed. Rate limits use bounded retries; persistent throttling or a long `Retry-After` stops the run.

The published `data/refresh.<hash>.json.gz` contains saved Steam metadata and scheduling state. An Actions cache can supply a newer checkpoint from an interrupted run; the published copy allows updates to continue if the cache is evicted. To investigate a failed bootstrap, inspect the unresolved-entry report and resume with the same sources and checkpoint.

### Response archives

Parsed Steam responses are saved before validation in `.cache/steam-responses/`, with their request parameters, timestamps, HTTP status and result codes. The archive includes fields returned by Steam even when the site does not use them. [`readSteamResponseArchive`](scripts/steam-archive.mjs) reads and verifies these files offline.

Expanded deployments include `data/steam-raw.<hash>.jsonl.zst`: the latest usable StoreBrowse and PICS payloads per app, explicit fallback facts and the tag dictionary. It uses a single Zstd stream without a trained dictionary. The previous `steam-raw.<hash>.json.gz` format remains readable for migration. The next workflow run restores the archive before merging new responses. Visitors do not download it or the refresh checkpoint.

Actions caches the response journal and uploads it as an artifact with 90-day retention. The published archive keeps the latest per-app data; it is not a complete request history.

## Data and formats

The importer combines three sources:

| Source | Use |
| --- | --- |
| [BlueBoxWare/steamdb](https://github.com/BlueBoxWare/steamdb) | App types, store categories, genres and release data |
| [leinstay/steamdb](https://github.com/leinstay/steamdb) | Fallback review totals and community tags |
| Steam store endpoints | Direct metadata for released games and new-release discovery |

Bulk revisions, asset identifiers and checksums are recorded in the manifest. The catalog includes games present in the sources, including upcoming games; DLC, demos and software are excluded. Steam review summaries cover Steam purchases across all languages. Fallback review totals can use different populations.

Unknown values remain distinct from zero, empty lists and absent features. Feature and tag filters require known data, including exclusions. [`normalize.mjs`](scripts/normalize.mjs) defines source normalization; [`features.mjs`](src/features.mjs) defines feature aliases, groups and weights; [`query.mjs`](src/query.mjs) defines filters, URL state, sorting and presets.

[`view-state.mjs`](src/view-state.mjs) adds the optional `highlight=<feature-key>` URL parameter. Highlighting selects one column without changing the query, including when a counting toggle hides that column.

[`feature-presentation.mjs`](src/feature-presentation.mjs) groups each hardware target into one column and hides detailed compatibility flags without discarding collected data. Compatibility filters use `deck`, `machine`, `frame` and `os` URL parameters; `ignore` is the default. Deck/Machine/Frame accept `untested`, `unsupported`, `playable` or `verified`; SteamOS accepts `untested`, `unsupported` or `supported`. Selections combine with AND and work independently of `hw=1`, which controls columns and scoring. Unavailable ratings never satisfy `untested`.

Publication requires at least 50,000 games, 70% known feature data and 30% known reviews. A drop of more than 10% in games, known features, known reviews or known tags against the published catalog blocks the build. Unclassified Steam category IDs also block publication until the feature registry is updated.

### Published files

`data/manifest.json` identifies the current catalog, optionally one retained predecessor, source provenance, coverage and maintenance files. Catalog filenames include a content hash. Each payload descriptor records its filename, size and SHA-256; paths and redirects must stay within the manifest's origin and directory.

The browser downloads the binary catalog, using Brotli when supported, then gzip or uncompressed binary as fallbacks. JSON and gzip JSON copies support inspection and clients using JSON-only manifests. Compressed and decompressed data are both verified.

Binary format `steam-feature-atlas-binary-v1` stores UTF-8 titles, variable-length integers, repeated-value dictionaries, feature bitsets and tag postings in columns. Games are grouped by feature set, with app ID breaking ties. Tag postings refer to row indices in that order. The format preserves every field, including missing versus null values. See the [encoder](scripts/catalog-binary.mjs), [decoder](src/catalog-binary.mjs) and [descriptor validation](src/catalog-descriptor.mjs); incompatible changes require a new format version.

The worker expands tag postings and prepares query indexes. [`verify-site.mjs`](scripts/verify-site.mjs) checks binary/JSON equivalence, compressed variants, provenance and saved refresh state before deployment.

## Checks and licenses

Run `npm test` for importer, codec, query and recovery tests, or `npm run verify:site` to check a built production package. [Browser checks](test-browser/README.md) cover the interface against a full catalog.

Source code is [MIT licensed](../LICENSE). The bundled font and imported data retain their own terms; see [third-party notices](../THIRD_PARTY_NOTICES.md). Builds include those notices and license files under `dist/licenses/` and `dist/fonts/`.
