# Steam Feature Atlas

A static, full-catalog Steam feature explorer for **https://peterth.github.io/steamfeatures/**. The browser searches and filters a published snapshot in a Web Worker. A scheduled build combines bulk data with a bounded, rolling refresh from Steam. There is no application server, database service, API key, or browser-to-Steam request.

## Run locally

Requirements: Node.js 22 or newer, Git, and internet access for a full import. No npm dependencies or installation step are needed.

```sh
cd online
npm test
npm run build
npm start
```

Open http://127.0.0.1:4178/. Set `PORT` to use another port. The dependency-free development server binds only to localhost. The application requires HTTP because it loads a module worker and a catalog. The earlier standalone prototype is archived locally under `../.local/archive/offline-prototype/` and is not part of this repository.

For a quick synthetic-data build without downloads:

```sh
npm run build:fixture
```

Fixtures are marked in the manifest and application and are explicitly rejected by the deployment workflow. A real full import is still required before publication.

To reuse pinned bulk files already downloaded locally, pass `--sources` to `npm run build` or `npm run import`:

```sh
npm run build -- --sources .cache/prepared-sources.json
```

The prepared JSON contains `blueboxDirectory` (an extracted source repository with `data/` and `LICENSE`), `reviewsFile` (the leinstay gzip JSON asset), `reviewLicenseFile`, and `sources.apps` / `sources.reviews` provenance. App provenance must contain its immutable Git `revision`; review provenance must contain `revision`, release/asset identifiers, publication date and the archive's `sha256`. The importer verifies the review checksum and records an aggregate app-shard checksum. `PAGES_BASE_URL` optionally names an existing HTTPS deployment to validate against and retain its current catalog. Prepared-source and fixture builds do not make live Steam requests unless the refresh is explicitly enabled; a normal production build enables it.

Complete the initial released-game backfill before first publication. Every released entry must have complete Steam metadata or a confirmed per-app access denial (Steam result code `15`). Denied entries remain in the catalog with their available older data; missing fields stay unknown. Network failures, missing responses, unclassified entries and incomplete successful lookups still block initial publication:

```sh
npm run build -- --refresh-steam --bootstrap-steam
```

Subsequent daily runs discover new releases and rotate through 4,000 existing released games. To run this explicitly, including against prepared bulk files:

```sh
npm run build -- --sources .cache/prepared-sources.json --refresh-steam --steam-limit 4000
```

`STEAM_REFRESH_LIMIT` sets the same existing-game budget; the default is `4000`. `STEAM_REQUEST_SPACING_MS` controls request spacing, defaulting to `2000`. The released catalog therefore refreshes over roughly a month instead of treating every day's build as a full Steam refresh. New releases are discovered separately from the existing-game rotation.

The limit is shared across successful runs on the same UTC day. Existing games use exact-ID batches of 100, so the normal 4,000-game rotation takes 40 requests. Discovery uses up to five 1,000-result pages over an overlapping 14-day window; after a missed job the window starts from the last completed discovery. A frozen window/cursor carries unfinished discovery forward. A completed discovery is not repeated by another build on the same day. Requests are serial, spaced two seconds apart by default, and bounded to 100 HTTP attempts (including retries) per incremental run. HTTP 429 and long `Retry-After` responses stop further traffic. A bootstrap permits 1,000 attempts and checkpoints its listing cursor so rerunning can resume. The follow-up app-ID pass reports and checkpoints progress every 1,000 entries.

The queue and cached Steam fields are stored in a checksummed `data/refresh.<hash>.json.gz` file referenced by the deployed manifest. Every run can recover them from the published site even if the Actions cache is empty. `.cache/steam-refresh-state.json` is an atomic local checkpoint; Actions restores and saves it even on failed runs. A validated newer checkpoint preserves attempts from interrupted runs, including the daily allowance. The published state remains the durable fallback if that optional cache is evicted. `--steam-state <file>` supplies an initial local state when there is no deployed state.

First publication requires known Steam features, tags and a review count for every retained released entry, except confirmed per-app denials with result code `15`. Confirmed empty tags and zero reviews qualify. A denial does not establish empty tags, zero reviews, an app classification or absent features: it preserves older values and leaves missing fields unknown. Other unavailable result codes, network failures, missing responses, unclassified entries and incomplete successful lookups remain unresolved. Unresolved IDs are written to `.cache/steam-refresh-unresolved.json`, and a rerun retries them without repeating completed bootstrap pages. Denied entries enter the normal queue again after a 30-day retry delay. Builds use a staging directory and replace `dist` only after success, preserving the working local site if a fetch or validation fails.

If the completed backfill stopped only because of denied entries, finalize it offline from the existing checkpoint and archived Steam result codes:

```sh
npm run build -- --sources .cache/prepared-sources.json --finalize-steam
```

`--finalize-steam` requires prepared sources and makes no Steam requests. It validates the saved bootstrap progress and uses archived responses to confirm result-code `15` exceptions; it does not turn unspecified failures into denials or bypass the remaining coverage checks. A missing or incomplete checkpoint must be resumed with `--bootstrap-steam` instead.

### Preserve responses for future features

Every parsed Steam JSON response is now saved before schema checks or normalization as a separate atomic gzip file in `.cache/steam-responses/`. Records contain the full JSON body (including fields unused by the site), the endpoint method, exact request input, fetch timestamp, HTTP status and Steam result code. Query pages, individual lookups, tag dictionaries and JSON error responses are included. An archive write failure stops the import before it can mark the response as successfully processed. Non-JSON error pages and network failures have no parsed response to archive.

The saved data covers what Steam returned for the current request options: basic information, release data, reviews and up to 100 tags, plus fields returned by default. It does not claim to include optional data that was never requested, such as additional media. No extra Steam calls are made for archiving. `.cache/steam-refresh-state.json` remains the compact scheduling/normalized metadata checkpoint; it is not a raw response backup.

On successful builds, `data/steam-raw.<hash>.json.gz` preserves each app's complete latest raw item and, after a failed lookup, its last successful raw item. Exact request provenance is shared by hash, and the full latest successful tag dictionary is retained. `manifest.steamArchive` records the compressed checksum, size and archived app counts. Subsequent production builds restore this snapshot from the previous deployment before merging local captures, so current raw data survives an Actions cache eviction. The browser never downloads this file as part of normal browsing.

The local journal keeps complete historical response envelopes. Actions restores/saves that journal alongside interrupted refresh state and uploads it even on failed builds, with 90-day artifact retention. Cache and artifact retention are limited; the deployed latest-per-app snapshot is the durable source for future builds, not an unlimited history service. Local journal files are gitignored and remain available for offline work. `readSteamResponseArchive(directory)` from `scripts/steam-archive.mjs` provides checksum-verified offline replay without contacting Steam.

Archiving starts when a process loads this code. An already running import must be restarted to enable it, and restarting resumes its normalized checkpoint. Responses discarded by older imports cannot be reconstructed: their raw coverage fills in as those apps are fetched during the normal rolling refresh. Archive app counts therefore need not equal catalog size.

## Publish to GitHub Pages

Create an empty **public** repository named `steamfeatures` under `peterth`. This workspace is already initialized on `main`. Review the source files, then commit and push from the repository root:

```sh
git status --short
git add .
git commit -m "Initial Steam Feature Atlas"
git remote add origin https://github.com/peterth/steamfeatures.git
git push -u origin main
```

In the repository's **Settings → Pages → Build and deployment**, choose **GitHub Actions**. Enable Actions if necessary.

### First deployment: reuse the completed local catalog

The first workflow run requires the completed local snapshot. A normal run stops if no completed published catalog exists; it does not start another full Steam backfill.

Build with the saved sources and checkpoint, then package the result. These commands make no Steam requests:

```sh
cd online
npm run build -- --sources .cache/prepared-sources.json --finalize-steam
npm run package:bootstrap
cd ..
```

The package contains the static site, catalog, completed refresh state, raw Steam snapshot, and licenses. It is written to the ignored `online/.cache/steam-feature-atlas-bootstrap.tar.gz`. The packager verifies catalog and auxiliary-file checksums, rejects incomplete/fixture data, and requires the `tar` command (included with current Windows and Linux systems).

After pushing the source and configuring Pages, use GitHub CLI while signed in to the repository owner account:

```sh
gh release create bootstrap-initial online/.cache/steam-feature-atlas-bootstrap.tar.gz --repo peterth/steamfeatures --title "Initial catalog snapshot" --notes "Completed catalog and refresh state for the first Pages deployment."
gh workflow run pages.yml --repo peterth/steamfeatures --ref main -f bootstrap_release=bootstrap-initial
```

Alternatively, upload the package to a release in GitHub's web interface, then run **Refresh catalog and deploy Pages** with `bootstrap_release` set to that release's tag. This input uses the packaged site as-is, so rebuild and repackage after source edits. The workflow validates it before deployment.

### Subsequent deployments

Leave `bootstrap_release` empty. Source pushes, manual runs, and the daily **04:17 UTC** schedule refresh and deploy automatically. Published refresh state and raw data carry the completed backfill into future jobs. `STEAM_ALLOW_BOOTSTRAP=0` prevents an absent or incomplete checkpoint from silently starting a new full backfill in Actions; explicit local backfills remain available.

The workflow requires the normal repository `GITHUB_TOKEN`: read contents during build, Pages/OIDC permissions during deployment, and write contents for the final small provenance commit. If branch protection disallows bot commits, deployment can still succeed but the provenance job will report failure; permit that specific bot update or maintain the lock manually. No personal access token is required. The workflow is prepared locally; creation of the repository and deployment are not performed by these scripts.

The imported catalog files stay out of Git history. Only `online/provenance-lock.json`, containing source revisions, checksums, coverage and the successfully deployed catalog hash, is committed after a successful deployment. Existing data remains live if download, schema, integrity, validation or build steps fail. GitHub schedules can be delayed or disabled after prolonged inactivity; the site always displays its actual snapshot dates and manual dispatch remains available.

## Data flow and semantics

1. Pin the current [BlueBoxWare/steamdb](https://github.com/BlueBoxWare/steamdb) commit and fetch its shallow Git snapshot. Read its numeric `data/<floor(appid/3000)>` JSON shards, taxonomy and genre definitions. These Steam appdetails provide app type, category IDs, release status and current Early Access genre (`70`). Canonical `steam_appid` values deduplicate redirected entries; a matching record key takes precedence.
2. Pin the latest [leinstay/steamdb](https://github.com/leinstay/steamdb) release, release commit and gzip asset ID; verify its published SHA-256 when provided. Join its `steam_reviews_count`, `steam_reviews_percent` and `tags` on `steam_appid` as fallback metadata. Its merged categories, genres and historical Early Access entry dates never override the Steam-specific source.
3. Keep all source-backed games, including upcoming and unknown-status games. DLC, demos and software are excluded by source app type. Missing or empty category data is unknown, and missing reviews stay `null`. Unnamed source records remain addressable as `Steam app <id>`.
4. Map Steam category aliases to the canonical feature registry. Accessibility means category 13 plus 64–82. The obsolete VR Support category (`31`) is omitted entirely; it is not converted into VR Supported or VR Only. The registry contains 62 features, including 42 non-accessibility features. New, unclassified category IDs stop publication with a clear error so they can be reviewed and added to `src/features.mjs`; they are never silently dropped or assumed non-accessibility.
5. Apply cached Steam metadata and refresh a bounded part of the released catalog. New-release discovery runs daily; existing games rotate through an oldest-attempt-first queue, so unsuccessful or regionally unavailable listings cannot monopolize the next batch. The default existing-game budget is 4,000 games per daily run. Upcoming records remain available from bulk sources but do not consume this released-game refresh budget. Complete a one-time initial released-game backfill before first publication. A catalog build date does not mean every game was freshly fetched.
6. Emit versioned JSON and gzip, a manifest, license notices and a provenance lock. A full catalog must contain at least 50,000 games, at least 70% known feature data and at least 30% known reviews. A drop exceeding 10% in total games, known-feature rows or known-review rows compared with the live deployment blocks publication. Once a deployed manifest records `knownTags`, the same 10% guard applies to known-tag rows. Investigate real source changes before deliberately adjusting these guardrails.

“No feature” means **the badge is not listed in the source snapshot**, not that the implementation was independently tested. Unknown category data cannot satisfy a negative-feature filter. Bulk publication dates identify upstream snapshots, not the last time each game was checked. The per-game Steam metadata date records a successful direct fetch; it does not verify the game's implementation. Regional and unavailable listings can be missing from the sources; this is the complete source-backed catalog, not a guarantee of every Steam listing worldwide.

Direct Steam review summaries count Steam-purchase reviews across all languages. Bulk fallback review totals have undocumented language, purchase-source and off-topic settings, so the two populations can differ. The site identifies Steam-derived and fallback totals in game details and explains the distinction in About. The initial publication requires all released games to be resolved by the backfill or explicitly denied by Steam with result code `15`; denied and unreleased records can still use bulk fallback totals. Unknown totals remain `null`, distinct from a confirmed zero.

The feature matrix, URL query engine and named presets all use the same filtering logic. Default filters exclude Early Access, require 20 reviews, and exclude accessibility and multiplayer features from displayed columns, feature counts and scores. These feature-group toggles do not exclude games themselves. Explicit required/excluded feature conditions remain active regardless of the displayed groups or scoring weights: required conditions mean “all”; excluded conditions mean “none.” The missing-Cloud preset requires Single-player, excludes the MMO badge and MMORPG tag, and selects released games with more than 1,000 reviews, no listed Steam Cloud badge and known feature and tag data. Its ordinary filter values are shareable and editable in the URL.

Feature Score is the default sort (`score-desc`); raw feature count, Review Score (percentage of positive reviews, `rating-desc`), Review Count (`reviews-desc`), title and release date are also available. Each of the six criteria supports independently selected ascending or descending order, encoded in the URL. Unknown values remain last in either direction. Review Score ties use review count descending, then title and app ID; games with confirmed zero reviews have an unknown Review Score. The multiplayer toggle is stored as `mp=1` in shared URLs when enabled. Weighted scores give Steam Cloud 3 points and Steam Achievements 2 points. In-App Purchases subtracts 1 point. Gamepad Recommended, Includes Source SDK and VR Only each have weight 0. All remain visible and filterable when their feature groups are included, and each still contributes to the ordinary feature count. Every other feature has weight 1. A game's score is the signed sum of weights for its advertised, currently included features.

The displayed maximum score adds only positive weights, because a game without a negative-weight badge can score higher than a game with every badge. The default groups expose 27 columns with an upper bound of 26 points; the signed sum of all 27 weights is 25. This upper bound does not claim that every positively weighted feature can be supported simultaneously.

Tags are a separate filter vocabulary: they never add feature columns, counts or score. Tag names are trimmed and deduplicated; malformed source values stop the import. A nonempty source tag list establishes known tag data. Missing, null and empty bulk-source tag lists remain unknown, so those games cannot satisfy a required or excluded tag condition. A direct Steam response can establish an authoritative empty list, encoded with `tagDataKnown: true`; it passes tag exclusions but cannot satisfy any required tag. Nonempty memberships always establish known data, even if a contradictory false flag is supplied. Dictionary entries come only from games actually included in the catalog. URLs identify tags by name, not by dictionary position, so links survive dictionary reordering between snapshots. Repeated `tag` parameters require all named tags; repeated `notTag` parameters exclude all named tags.

Multiplayer classification includes all multiplayer and co-op modes, shared/split-screen play, cross-platform multiplayer, Remote Play Together, Valve Anti-Cheat, Steam Turn Notifications, Chat Speech-to-Text and Chat Text-to-Speech (Steam IDs `1, 20, 49, 36, 47, 37, 9, 38, 48, 39, 24, 27, 44, 8, 32, 72, 73`). The two chat features belong to both multiplayer and accessibility, so both groups must be enabled to display and count them. Single-player, leaderboards, remote play to individual devices and other features retain their own classifications.

## Published format

`data/manifest.json` has `version: 1`, `importedAt`, `sources`, `coverage`, `fixture`, `current` and optional `previous`, `refresh`, `refreshState` and `steamArchive`. The refresh-state descriptor supplies a same-directory `file`, compressed `sha256` and `bytes`; the raw archive descriptor adds `apps` and `successfulApps`. Browsers do not download either auxiliary file. Each catalog descriptor contains `catalog`, `compressedCatalog`, `sha256`, `gzipSha256`, `bytes`, `gzipBytes` and `importedAt`. File names are relative to the manifest, under the same origin/directory. Both catalog formats are integrity checked by the browser; unsupported gzip decompression uses plain JSON.

The catalog has `version`, `importedAt`, `fixture`, `sources`, `coverage`, `features`, `tags`, `tagIndex` and `games`, plus optional `refresh` metadata. Game records contain `id`, `name`, canonical numeric `featureIds`, `featureDataKnown`, nullable `reviews` / `positivePercent`, `releaseDate`, precise nullable `releaseISO`, `releaseStatus` (`released`, `upcoming`, `unknown`), nullable `earlyAccess`, and `genres`. Steam-refreshed records also carry `metadataUpdatedAt`, the ISO time of their successful fetch, and `reviewSource: "steam"` when their review count is Steam-derived. Failed attempts do not advance that successful-check date. Confirmed denied entries carry `steamLookupStatus: "unavailable"`, `steamLookupResultCode: 15` and `steamLookupAttemptedAt`; these describe the attempted lookup, not the age or completeness of the fallback metadata. Feature definitions supply stable URL `key` slugs, mapped Steam IDs, finite numeric `weight` (negative values are permitted), and boolean `accessibility` / `multiplayer` classifications. An incompatible wire-format change requires a version bump and a matching loader update.

`refresh` contains `enabled`, `existingLimit`, `lastRunAt`, `checkedGames`, `bootstrapComplete` and `deniedReleased`. The refresh report lists denied released entries, and game details identify older data retained after a denial. `checkedGames` counts games with cached successful Steam metadata; it is not the number of games checked on the latest run. `bootstrapComplete` means the initial pass satisfied the coverage check including confirmed denials; it does not promise complete or fresh fields for every entry.

`tags` is a deterministic sorted dictionary of unique names. The production tag index is `{ "encoding": "delta-game-indices-v1", "lists": [...] }`, with one list per dictionary entry. Each list encodes the ascending **game-array row indices**, not Steam app IDs: its first number is the first row index (possibly 0), and subsequent numbers are positive differences from the preceding row. Games are sorted by Steam app ID before packing. The published games have no `tagIds` field; the worker validates and expands the index into sorted per-game `tagIds` for queries. Rows with no memberships are unknown unless they explicitly carry `tagDataKnown: true`. `coverage.knownTags` counts both nonempty lists and authoritative empty lists, while `coverage.tagCount` is the dictionary size.

This readable inverted delta format was selected after comparing per-game labels, dictionary ID lists, delta IDs, varint/base64 and bitsets. The [historical benchmark](docs/benchmarks/tag-packing-2026-10-09.json) records the earlier 210,736-game bulk snapshot: 67,982 games had 930,840 tag memberships across 468 names. Gzip tag overhead was approximately 0.87 MB, compared with 1.45 MB for per-game dictionary IDs and 2.24 MB for repeated names; binary encoding saved about another 0.03 MB. These are historical measurements, not current coverage figures. Run `npm run benchmark:tags` against locally cached sources to write a new report to `test-results/benchmarks/tag-packing.json`.

Only the new catalog and one previously deployed catalog are retained. Prior manifests accept fixed hash-based file names and checksums; remote file paths cannot leave their trusted HTTPS origin/directory. Content hashes give the browser a stable cache key. Keeping one predecessor lets already-open pages finish fetching the previous data during a deployment; it does not promise indefinite compatibility with arbitrarily old open tabs.

## Tests and licenses

Roboto Condensed is bundled as a variable webfont in `src/fonts/` and copied into the static build. It requires no external font service. Its copyright, Apache 2.0 license, and format-conversion notice are included beside the font.

`npm test` covers normalization, redirect IDs, unknown data, alias deduplication, review/date boundaries, coverage guardrails, query combinations, URL round trips, presets, pagination and catalog integrity/fallback. The fixture import test validates the real JSON/gzip/manifest/license output pipeline. CI performs those tests before every full import; it never substitutes fixture data for a production build.

[`test-browser/checks.js`](test-browser/checks.js) accepts an existing Playwright page and optional base URL and screenshot directory. It checks filtering, sorting, URL history/reload, pagination, presets, tooltip keyboard behavior, invalid links, and mobile overflow against a full catalog. See its [runner instructions](test-browser/README.md). Screenshots are opt-in and belong under the ignored `test-results/` directory, alongside local verification reports.

The build preserves the original BlueBoxWare MIT and leinstay GPL-3.0 license texts in `licenses/`, along with attribution and links to pinned source revisions in the manifest. The derived combined catalog is distributed under GPL-3.0; game names and publisher material retain their respective owners' rights. Normalization source is available in this repository. Generated catalog files and bulk caches should not be committed.

Project source is [MIT licensed](../LICENSE). Builds also include the project's MIT license and [third-party notices](../THIRD_PARTY_NOTICES.md).
