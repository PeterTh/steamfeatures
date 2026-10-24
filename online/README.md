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

Browser catalog and developer/publisher packages compress concurrently in Node's bounded native thread pool, retaining gzip level 9 and Brotli quality 11. Raw archives retain Zstandard level 19 and checksums. When `zstd` is available on `PATH` and the host has spare CPUs, archive compression uses up to three workers, reserving one CPU for the producer. Otherwise it uses Node's existing single-threaded encoder; no extra dependency is required for local builds. Browser packaging finishes before raw archive compression begins.

### Column icons

`src/column-icons.svg` contains one distinct 24-unit SVG symbol per table column, keyed by the feature's stable key (or the combined hardware target key). The build embeds this sprite once in `index.html`; table, feature picker and compatibility dialogs use local references without icon-file or icon-font requests. Most shapes retain the original line artwork. PlayStation and SteamOS outlines come from the bundled PromptFont; attribution remains in `fonts/PromptFont-NOTICE.txt`.

Add a dedicated symbol when adding a column. The column-icon regression check requires complete coverage and unique artwork, including optional columns. General navigation and service logos remain inline UI symbols in `app.js`.

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

### Developer and publisher data

Builds extract the listed developer/publisher names from the archived StoreBrowse/PICS and fallback data, without additional Steam requests. The separate `gameCredits` manifest entry pins a shared-name/shared-credit-combination binary file to the full catalog snapshot. Its app-ID index uses delta integers; raw, gzip and Brotli representations are verified with the production package.

The browser loads this file in its full-catalog worker after the initial and background catalog files. It attaches a credit lookup without rebuilding the feature index. The Developers panel has separate case-insensitive substring fields, combined with AND; shared links use `dev` and `pub`. Missing credits cannot satisfy an active role filter. Cards display both roles once the file is ready; clicking an individual name sets that role's filter, or clears it if the name is highlighted, and keeps the card open.

The 198,879-game local snapshot produces 3,689,891 raw bytes, 1,964,859 gzip bytes and 1,715,903 Brotli bytes. The catalog downloads themselves are unchanged. File details appear in Data & counting rules after loading.

### Achievement Sets

Achievement Sets appears beside Steam Achievements, uses the `SET` URL code, and adds one score point. Additional nonempty public sets qualify; Steam's automatic default group does not. Require/exclude filters use the same known-data rules as other features: unavailable or unchecked schemas cannot satisfy an exclusion.

Production refreshes bootstrap from `data/achievement-state.json.gz`, restore the published `achievementState` and merge any newer SQLite checkpoint. New games advertising achievements are checked first, followed by newly released or interrupted checks, then older games on a best-effort, oldest-first basis. Successful results become eligible again after seven days. Unavailable released/upcoming games normally retry after seven/thirty days; failures use per-game backoff. Freshly released games can bypass an older unavailable result's ordinary schedule.

The separate serial achievement phase defaults to **2,000 HTTP attempts and 30 minutes per UTC day**, shared across repeated builds. It uses a one-second post-response pause, raises that minimum to 1.5 seconds on HTTP 429, and persists Retry-After/cooldowns. Existing StoreBrowse/PICS batches and their five-second pacing are unchanged. Hash-only checks avoid downloading unchanged older schemas; changed hashes require a full validated response before any flag changes. Hash checks, full responses, retries and service controls all count against the same achievement budget. The workflow allows 90 minutes overall so this phase has room alongside the existing import, compression and verification work.

Transport or schema failures end this optional phase while the catalog builds from saved usable flags. Unavailable or failed requests cannot erase earlier successful data. Requests and outcomes are checkpointed separately from the frozen supplemental collection; publisher requirements are not queried. Full returned responses are retained in `.cache/steam-achievements/responses/`, cached and uploaded with the workflow's response-journal artifact. PID locks are local and excluded from the Actions cache.

The compressed `achievementState` is a maintenance file containing flags, schema identities, observation times and scheduling state; visitors do not download it. The checked-in `data/achievement-sets.json` projection supports fixture and bulk-only offline builds. Both paths apply after StoreBrowse/PICS enrichment and pin their source checksum in provenance. Visitors receive only the feature flag and its known-data state in the existing catalog files; full schemas and requirements are not added to browser downloads. Production verification checks that every projected flag agrees with its persisted checkpoint.

After an explicitly collected supplement is complete, regenerate this build input offline:

```sh
npm run project:achievement-sets
```

The command independently verifies `.cache/steam-supplement/archive.json` and its archive before generating the compressed seed and lookup. Use repeated `--directory <path>` options to merge completed collections, including an achievement-only delta; the source databases are opened read-only. Existing seed results merge by observation time without losing later usable data. Review and commit both generated seed files with the associated source changes; no separate upload of the full raw supplement is required.

## User Library filter

The User Library panel imports the signed-in Steam store's `dynamicstore/userdata/` JSON through a local file picker. It validates and deduplicates `rgOwnedApps` and `rgWishlist`, discards all other fields, and retains only those app IDs and the local filter choices in this browser's local storage. Owned games and Wishlisted each have independent +/− controls: require, exclude or ignore. All active rules apply together, so requiring wishlisted games and excluding owned games finds unowned wishlist entries. No library file, account identifier or login is uploaded. Importing or changing these filters makes no network requests; filtering combines with the ordinary query in the existing catalog worker, including its progressive handover.

Copied links contain the ordinary filters only. Owned and wishlist choices are local to the browser and are never placed in a URL. App IDs are written only on an explicit file import; preferences use a separate storage key. Reset filters clears both local rules while retaining the imported IDs; Forget library removes both saved lists and invalidates other open tabs, including their pending file reads. A stale tab changing preferences cannot write the IDs back. Invalid files leave the prior data intact, and blocked/full local storage still permits use for the current visit. A missing wishlist disables wishlist controls; an explicitly empty wishlist is a valid empty list. This imports owned apps, not the separate Steam Families shared library. Game cards retain their existing on-demand artwork loading.

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
| `STEAM_ACHIEVEMENT_REQUEST_LIMIT` | `2000` | Achievement HTTP attempts per UTC day, including retries and controls; `0` disables requests |
| `STEAM_ACHIEVEMENT_TIME_LIMIT_MS` | `1800000` | Achievement phase time allowance per UTC day, shared across repeated builds |
| `STEAM_ACHIEVEMENT_REQUEST_SPACING_MS` | `1000` | Minimum pause after achievement responses; persisted throttle fallback can raise it |

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

The **Input** category contains controller, Steam Input and keyboard/mouse features. **Features?**, after Creation, groups In-App Purchases, third-party DRM, account requirements, Third-party Anti-Cheat (TAC) and VAC. DRM and required third-party accounts score −1. TAC scores −1 with a red minus when Steam explicitly discloses kernel-mode operation, and 0 with a grey check otherwise; missing kernel-mode flags do not incur a penalty. VAC scores 0. TAC and VAC remain independent of the multiplayer counting toggle. Ordinary zero-point features use grey checkmarks; hardware rating colours retain their separate meaning.

Disclosure flags and details are projected from the existing StoreBrowse/PICS archive. Explicit no-DRM declarations and wholly optional accounts are not penalized; accounts required for particular modes or features are. TAC excludes disclosures naming only VAC; another disclosed provider can coexist with the separate VAC badge. An unnamed anti-cheat record counts when VAC is not advertised, but remains unknown alongside VAC because it may describe VAC alone. VAC without a disclosure section does not establish whether third-party anti-cheat is present. Click disclosure entries to open their published text and supplied flags in the same dialog used for hardware details, including optional-account and explicit no-DRM entries. Missing source sections remain unknown, and absent disclosures do not prove that a game has no DRM, account requirement or anti-cheat. The browser stores these details in an optional `disclosures` field using the existing binary format.

Feature-filter URLs use the table's unique 2–3-character codes, for example `has=ACH,CLD&not=DRM,TAC`. Codes are case-insensitive; existing full feature keys remain valid and can be mixed with codes. Generated links use uppercase codes. Codes are public URL identifiers and should remain stable; the feature-code tests check uniqueness across all table columns, including optional ones. Hardware ratings retain their dedicated parameters, such as `deck=verified`.

The Count row follows table order: Multiplayer, Compatibility, Remote Play, Accessibility. All four are off by default. Remote Play includes phone, tablet, TV, GeForce NOW and Remote Play Together; it is independent of the Multiplayer toggle. Use `rp=1` to count Remote Play in a shared URL. Explicit require/exclude filters still apply when a category is not counted. The same group order is applied to older catalog snapshots in the browser. Early Access belongs to Release status: `released` excludes Early Access and unknown Early Access status, `released-ea` includes all released games, `early-access` requires a released game explicitly in Early Access, `upcoming` selects upcoming games, and `all` includes unknown statuses. Older `ea=1` links still select the combined released/Early Access option.

Reviews provides inclusive `minReviews`, `maxReviews`, `minRating` and `maxRating` bounds; ratings are positive-review percentages from 0 to 100 and may be fractional. The default minimum count remains 20. A blank minimum count means 0 (no lower bound); other blank bounds mean no limit. Unknown counts require both count bounds to be unrestricted; unknown ratings cannot satisfy an active rating bound. Bounds combine with every other filter, and contradictory ranges fail explicitly. Each active bound has a removable chip, including the default 20-review minimum.

[`view-state.mjs`](src/view-state.mjs) adds the optional `highlight=<code>` URL parameter, with full feature keys also accepted. Highlighting selects one column without changing the query, including when a counting toggle hides that column. Combined hardware columns use their table codes, such as `highlight=DCK` for Steam Deck.

Game titles preview their cards on hover or focus; clicking locks a card open, including while the table scrolls. The row icons and bold card links open Steam, SteamDB and Steamograph. Cards keep the interactive tag list and omit the redundant static genre line.

Header artwork is requested immediately when a card opens, with no hover delay or artwork prefetch during initial loading. An optional `gameImages` manifest descriptor identifies 256 content-versioned JSON lookup files (`00.json`–`ff.json`). `Math.imul(appid, 0x9e3779b1) >>> 24` selects the bucket. Each maps app IDs to nonstandard relative header filenames, projected from the existing archive; `header.jpg` is the default. Lookups share an in-memory cache and use the browser cache. Images load directly from Steam's CDN, falling back to the default header or a card without artwork on failure. The image paths remain outside the catalog partitions. Builds retain one previous lookup directory for older clients; no additional Steam API collection is involved.

[`feature-presentation.mjs`](src/feature-presentation.mjs) groups each hardware target into one column and hides detailed compatibility flags without discarding collected data. Compatibility filters use `deck`, `machine`, `frame` and `os` URL parameters; `ignore` is the default. Deck/Machine/Frame accept `untested`, `unsupported`, `playable` or `verified`; SteamOS accepts `untested`, `unsupported` or `supported`. Selections combine with AND and work independently of `hw=1`, which controls columns and scoring. Unavailable ratings never satisfy `untested`.

Publication requires at least 50,000 games, 70% known feature data and 30% known reviews. A drop of more than 10% in games, known features, known reviews or known tags against the published catalog blocks the build. Unclassified Steam category IDs also block publication until the feature registry is updated.

### Published files

`data/manifest.json` identifies the current catalog, optionally one retained predecessor, source provenance, coverage and maintenance files. Catalog filenames include a content hash. Each payload descriptor records its filename, size and SHA-256; paths and redirects must stay within the manifest's origin and directory.

Normal builds publish two browser archives under `current.progressive`: all games with at least 20 known reviews, and the remaining games. The first archive provides complete results for the default filter and any higher review minimum. Catalogue-wide tag and language counts are stored in the manifest so the pickers remain accurate before the second archive loads.

After the first results appear, a second worker loads and prepares the full catalogue in the background, reusing the first archive from the browser cache. It takes over all queries when ready and the initial worker is terminated. Lower review thresholds wait for complete data; shared links below 20 load both archives immediately. Background loading is silent unless a requested filter needs to wait or a download fails. The data panel adds the second file's compression and size when loading finishes.

Each archive uses Brotli when supported, then gzip or uncompressed binary as fallbacks. Full binary, JSON and gzip JSON copies remain available for older clients and inspection. Compressed and decompressed data are verified. Both partitions and their transport variants are retained alongside the previous catalogue, with snapshot, review-cutoff, record-equivalence and picker-count checks before deployment.

Uncompressed JSON is bounded at 256 MiB; binary payloads remain bounded at 150 MiB and compressed downloads at 40 MiB. These limits apply to loading, verification and retained catalog files.

Binary format `steam-feature-atlas-binary-v1` stores UTF-8 titles, variable-length integers, repeated-value dictionaries, feature bitsets and tag postings in columns. Games are grouped by feature set, with app ID breaking ties. Tag postings refer to row indices in that order. The format preserves every field, including missing versus null values. See the [encoder](scripts/catalog-binary.mjs), [decoder](src/catalog-binary.mjs) and [descriptor validation](src/catalog-descriptor.mjs); incompatible changes require a new format version.

The worker expands tag postings and prepares query indexes. [`verify-site.mjs`](scripts/verify-site.mjs) checks full and merged binary/JSON equivalence, compressed variants, provenance and saved refresh state before deployment.

## Checks and licenses

Run `npm test` for importer, codec, query and recovery tests, or `npm run verify:site` to check a built production package. [Browser checks](test-browser/README.md) cover the interface against a full catalog.

Source code is [MIT licensed](../LICENSE). The bundled font and imported data retain their own terms; see [third-party notices](../THIRD_PARTY_NOTICES.md). Builds include those notices and license files under `dist/licenses/` and `dist/fonts/`.
