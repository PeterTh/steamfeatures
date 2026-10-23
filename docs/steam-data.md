# Steam data collection

## Collected data

The collection covers every game in the prepared catalog, including upcoming games. It uses anonymous Steam access, English text and the US storefront. Media files are not downloaded; their URLs and metadata are retained.

| Data | Steam field or collection method |
| --- | --- |
| Cloud streaming | PICS `common.category.category_45` |
| NVIDIA GeForce NOW | PICS `common.category.category_46` |
| No keyboard/mouse support | StoreBrowse `extra_details.no_mouse_keyboard_support`; PICS `common.nokeyboardmouse` |
| Dynamic Cloud Sync | PICS `ufs.sync_while_suspended` |
| Steam Deck rating | StoreBrowse `platforms.steam_deck_compat_category`; PICS `common.steam_deck_compatibility.category` |
| SteamOS rating | StoreBrowse `platforms.steam_os_compat_category`; PICS `common.steam_deck_compatibility.steamos_compatibility` |
| Steam Machine rating | StoreBrowse `platforms.steam_machine_compat_category`; PICS `common.steam_deck_compatibility.steam_machine_compatibility` |
| Steam Frame rating | StoreBrowse `platforms.steam_frame_compat_category`; PICS `common.steam_frame_compatibility.category` |
| Compatibility details | PICS compatibility `tests`, `steam_machine_tests`, `steamos_tests`, `configuration`, test timestamps and tested build IDs |
| Achievement count | StoreBrowse `extra_details.links_and_info.achievement_count` |
| Platforms and VR | StoreBrowse `platforms`; PICS OS lists, VR devices/controllers and play areas |
| Languages | StoreBrowse `supported_languages`, including audio/subtitle support; PICS language configuration |
| Credits and classification | Developers, publishers, franchises, genres, community tags, release status/dates, Early Access, app type and parent relationships |
| Store disclosures | Third-party DRM/accounts, anti-cheat disclosures, EULAs, content warnings, age ratings and interactive elements where returned |
| Descriptions and links | Basic descriptions, full BBCode descriptions, website/support links, asset URLs, screenshots and trailers |
| Client configuration | Public PICS `common`, `extended`, `config`, `install`, `depots`, `ufs` and any additional returned sections: launches, controller configuration, cloud paths/quotas, public builds/branches/manifests and DLC relationships |
| Existing catalog data | Advertised categories, tags and review summaries continue to be collected |

StoreBrowse requests release/basic information, reviews, up to 100 tags, platforms, extra details, supported languages, links, ratings, assets, full descriptions, screenshots, trailers and assets without overrides. Purchase offers and recursive included-item expansion are disabled. PICS requests appinfo in batches through an anonymous Steam client, including access tokens available to that anonymous session.

The complete returned StoreBrowse item and public appinfo are retained so future projections do not require another full crawl. Full achievement schemas, system requirements, ultrawide/FOV research, player counts, news and additional live-price/activity endpoints are excluded from this pass.

## Interpretation

- Cloud category flags describe Steam's advertised participation/configuration. They do not guarantee current GeForce NOW availability in every region. Dynamic Cloud Sync describes configuration, not verified save reliability; it is independent of the ordinary Steam Cloud badge.
- Deck, Machine and Frame ratings use 0 = untested, 1 = unsupported, 2 = playable, 3 = verified. Frame ratings concern standalone execution on the headset, not streaming from another PC. SteamOS uses 0 = untested, 1 = unsupported, 2 = supported. An explicit untested rating differs from an unavailable lookup.
- Compatibility tests retain their tokens and display values, alongside input, launcher, text, internet, frame-limiter, HDR and runtime configuration. The browser catalog includes individual visible test results and selected configuration flags; test timestamps, build IDs and other raw fields remain in the full archive. Clicking a tested hardware rating opens its game/device details, with readable notes, limitations first, and equivalent test/configuration notes combined. Details remain excluded from columns, filters, feature counts and scores. Untested and unavailable ratings have no details action.
- Hardware columns and scoring are opt-in (`hw=1`). Each target has one column: `?` untested/unavailable, a red minus unsupported, a yellow check playable and a green check verified/supported. Tooltips distinguish untested from unavailable data. Verified/supported scores +1, unsupported −1, playable/untested 0. Each explicit overall rating counts once. No keyboard/mouse support and In-App Purchases use the same red minus for their −1 penalties.
- The separate **Filter by compatibility** panel selects an exact rating for each target, independent of column visibility. Ignore leaves that target unrestricted; selections across targets combine with AND. `deck`, `machine`, `frame` and `os` URL parameters preserve the selections. Missing ratings do not match Untested. SteamOS offers Supported instead of Playable/Verified. Hardware ratings are excluded from the ordinary feature selector.
- Dynamic Cloud Sync appears next to Steam Cloud; GeForce NOW is the fourth Remote Play entry. Both score +1. Generic cloud-streaming category 45 is retained in the data but contributes no separate column, filter, count or score.
- Every table column has a distinct symbol in the shared `column-icons.svg` sprite. PlayStation and SteamOS shapes preserve vector outlines from PromptFont v1.15 (SIL OFL 1.1); the unchanged 82,856-byte source WOFF2, attribution and license remain bundled. Rendering uses SVG rather than loading the icon font.
- PICS `public_only` means private sections can be absent. Missing UFS in such a response does not mean Dynamic Cloud Sync is disabled. Native Linux support and SteamOS compatibility are different properties. Store platform support takes precedence over legacy platform requirements or OS lists when interpreting storefront support.
- Achievement count is collected without downloading names, descriptions or icons for individual achievements. An omitted count stays unknown unless an explicit cached count is available.

## Fallback and storage

Successful Steam values take precedence. Failures keep the last usable response and explicit equivalent facts from existing data. A public-only PICS response preserves previously known private sections. Fresh complete sections replace old sections, including false values and empty lists; category/test memberships are not unioned across refreshes. Fields that were never observed remain unknown and cannot satisfy exclusion filters.

The working checkpoint is `online/.cache/steam-data/steam.sqlite`. SQLite commits each batch atomically. Request results and attempt times stay in this checkpoint; the exported data has no per-field provenance or confidence metadata. Archive restoration uses the refresh checkpoint's per-app check times to preserve newer local StoreBrowse responses. Existing deployment attribution and integrity checks remain in place.

The full archive is `steam-raw.<hash>.jsonl.zst`, identified by the manifest's `steamArchive` descriptor and format `steam-feature-atlas-raw-v2`. Its first line contains the format, generation time and tag dictionary. Subsequent lines, sorted by app ID, contain `{id, store?, appinfo?, fallback?}`. There is one latest usable payload per API/app, with redundant fallback sections omitted. Readers accept the previous gzip archive for migration.

Export and verification stream the data with bounded memory. Zstd level 19 uses a checksum and no trained dictionary. The browser still downloads only its compact binary catalog. The local SQLite file and operational caches are larger than the compressed archive and are not shipped to browsers or committed to Git.

Dictionary compression is deferred. On existing records it reduced independent per-game frames from 23.11 MB to 10.09 MB, but a normal single stream occupied 6.95 MB. Selective access would additionally require an index and independent frames; current consumers scan the whole snapshot.

## Running and resuming

Use Node.js 24.15 or later and install the locked dependencies with `npm ci --ignore-scripts` from `online/`. A prepared local catalog and pinned bulk sources are required; see `online/README.md` for preparing them.

```sh
npm run collect:steam -- --sources .cache/prepared-sources.json --build
```

Rerunning this command resumes completed batches. `--limit 100` caps each source to 100 pending apps for a smoke run. `--retry-failed` retries individual generic failures; explicit unavailable results remain recorded. `--export-only` rebuilds the archive from a completed checkpoint without Steam requests. `--directory <path>` selects a separate collection checkpoint.

Progress is written to `.cache/steam-data/progress.json`; `collection.lock` prevents concurrent collectors. A whole-request failure stops the run, preserving completed batches. StoreBrowse uses bounded retries and respects `Retry-After`; authorization failures and sustained throttling stop collection. PICS disconnects/timeouts also stop collection. Resume after resolving the failure or waiting out a cooldown.

With `--build`, completion builds the site from the saved data, exports the archive once, copies it to the collection cache, and runs production verification. This does not publish or deploy the site. Explicit `--steam-data` offline finalization uses that checkpoint without importing older deployment data or discovery journals. Manual offline finalization is also available:

```sh
npm run build -- --sources .cache/prepared-sources.json --finalize-steam --steam-data .cache/steam-data/steam.sqlite
npm run verify:site
```

Daily builds restore the published archive, collect PICS alongside the scheduled StoreBrowse refresh and discovery batches, and export a replacement snapshot. CI also caches the SQLite checkpoint so completed PICS batches survive a failed build. Newly introduced hardware test tokens receive deterministic IDs; the build rejects a hash collision instead of silently merging unrelated results.

## Resource budget

Use serial batches of at most 100 apps and a minimum 5-second pause after each response. The StoreBrowse and PICS phases run sequentially. The October 10–11, 2026 collection checked all **199,542** seeded apps in **7 h 33 min 39 s**: 4 h 21 min for StoreBrowse and 3 h 13 min for PICS. Neither phase had generic failures requiring retries. A Zstd-19 export took approximately 19 minutes; the complete offline build and verification took **20 min 55 s**, including 28 seconds of production verification. Budget 8–10 hours for a comparable collection and build; throttling or service interruptions can extend this.

StoreBrowse returned 196,227 successful responses and 3,315 unavailable apps. PICS returned 199,538 appinfo records and four unavailable apps. Every seeded app had a successful response from at least one API. Of the PICS records, 63,784 were public-only, limiting certainty about private configuration such as Dynamic Cloud Sync.

The resulting catalog contains **198,879 games and 209 collected feature labels**. The interface presents **69 columns** with all options enabled: 65 ordinary features and four hardware ratings. The default view has 30 columns. Apps now identified as non-games are omitted from the site but retained in the raw snapshot. Counts below refer to site games; an unknown value is not a negative result.

| Field | Positive / available | Known membership or rating |
| --- | ---: | ---: |
| Cloud streaming | 6,454 | 198,809 |
| GeForce NOW | 6,445 | 198,809 |
| No keyboard/mouse support | 1,227 | 196,007 |
| Dynamic Cloud Sync | 4,756 | 135,697 |
| Achievement count | 78,547 | — |
| Steam Deck: verified / playable / unsupported / untested | 9,166 / 21,512 / 6,718 / 158,652 | 196,048 |
| Steam Machine: verified / playable / unsupported / untested | 12,592 / 17,212 / 3,907 / 162,337 | 196,048 |
| Steam Frame standalone: verified / playable / unsupported / untested | 210 / 46 / 52 / 195,328 | 195,636 |
| SteamOS: supported / unsupported / untested | 31,933 / 4,387 / 159,728 | 196,048 |

The verified 199,542-app snapshot includes retained fallback fields and achieves an **85.9% reduction, or 7.10× compression**. Actual sizes use decimal units:

| Artifact | Bytes | Size |
| --- | ---: | ---: |
| Full JSONL snapshot, uncompressed | 2,529,681,404 | 2.530 GB |
| Full snapshot, Zstd-19 | 356,293,784 | 356.29 MB |
| Browser binary, uncompressed | 16,945,551 | 16.95 MB |
| Browser binary, Brotli | 5,195,012 | 5.20 MB |
| Browser binary, gzip | 6,117,259 | 6.12 MB |
| Complete generated site, including archives | 549,928,771 | 549.93 MB |
| Local SQLite checkpoint | 3,005,304,832 | 3.005 GB |

Allow additional disk space for SQLite's transaction journal, the prior deployment, a local archive copy and build staging. Production verification checks archive checksums, every JSONL record, sorted app IDs and counts, refresh completeness, and equivalence between the browser's JSON and binary catalogs.

## Language filters

The browser catalog includes 103 languages with independent interface, full-audio and subtitle support. Regional variants remain distinct. Steam China's Simplified Chinese identifier and migrated Indonesian/Malay identifiers share their corresponding language cards. Numeric StoreBrowse identifiers are mapped to the same stable language keys used by PICS.

StoreBrowse's complete language table takes precedence, including explicit false flags and empty lists. Unavailable or hidden store listings use a complete PICS `common.supported_languages` table when available; a previously retained store table remains usable when PICS cannot supply one. Malformed PICS language labels and legacy language strings do not establish complete language support. Missing data matches neither requirements nor exclusions. New unrecognized StoreBrowse language IDs stop the build until the dictionary is updated.

**Filter by languages** has searchable cards with separate require/exclude controls for Interface, Audio and Subtitles. Cards show the number of games with interface support in the full catalog and are ordered by that count. Clicking a selected control clears it. Rules across all languages and categories combine with AND. Repeated `lang` and `notLang` URL parameters carry `language:category` pairs, such as `lang=german:interface&notLang=german:audio`. Languages do not add table columns, feature counts or score points.

Each game's `languageBits` holds three flags per stable language ID, packed into 40 bytes and stored as Base64. Omission means unknown; an all-zero value means a known empty table. The existing binary dictionary encoding shares repeated profiles, and the worker decodes each profile once. The catalog's `languages` dictionary supplies IDs, stable keys and display names. No further Steam collection is needed to build these filters from the full snapshot.

The verified October 12 projection of the October 11 snapshot has language information for **198,844 of 198,879 games**. Its browser binary is **18,882,490 bytes**, gzip **6,465,072 bytes**, and Brotli **5,496,574 bytes**. The Brotli increase is **301,562 bytes (5.8%)** over the preceding catalog. The raw archive and refresh checkpoint are unchanged.

## Achievement schemas and system requirements

The supplemental collector gathers achievement schemas for games with Steam Achievements and the previously postponed system requirements for every site game. Run it separately from normal StoreBrowse/PICS imports and daily deployments:

```sh
npm --prefix online run collect:supplement
```

`--achievements-only --directory <new-directory>` creates an achievement-only collection with no planned requirements lookups. Its source selection is frozen with the seed, and a completed archive is verified against that selection. It cannot silently change the scope of an existing combined checkpoint.

It seeds a fixed collection scope from the checksummed, complete live browser catalog, then processes games by descending review count, breaking ties by ascending app ID. Counts are frozen at seeding; missing review counts become zero. For each game, the achievement lookup (when advertised) precedes the requirements lookup. `--manifest <url>` selects another catalog; `--seed-file <json>` accepts an explicit `{ "games": [...] }` seed for small checks. The seed is used only when creating a checkpoint. Resume with the same `--directory` (default `online/.cache/steam-supplement`); subsequent runs skip each completed source independently and do not silently add new games. `--limit N` stops after N completed source lookups for a partial run. `--export-only` exports the current checkpoint without Steam requests.

Both endpoints share one serial queue and a post-response pause, including retries. The default is **1,500 ms**; `STEAM_REQUEST_SPACING_MS` accepts 1,000–60,000 ms. This is a combined limit across both Steam hosts. The collection started at 2,000 ms; on October 21 the user approved 1,500 ms and then a **1,000 ms trial**. The local resume helper reads `spacingMs` from `online/.cache/steam-supplement/monitor-config.json`. A 429 raises the active shared pause to at least 1,500 ms and saves that minimum in SQLite and the local configuration, so restarting cannot silently repeat the faster trial. HTTP 429/5xx and network errors retain bounded backoff and Retry-After handling. `request-failures.jsonl` records every failed attempt, including HTTP status, API result, retry cause, planned backoff and requested cooldown; even cooldowns on subsequently successful retries are persisted. A persistent transport failure, generic API error or unexpected schema stops the run. Explicit rate-limit cooldowns and the last response time survive restarts. The existing daily StoreBrowse/PICS workflow retains its separate five-second configuration.

Achievement schemas come from the anonymous `IPlayerService/GetGameAchievements/v1` endpoint with `appid` and `language=english`. Preserve the complete JSON envelope, schema version/hash, achievements and groups. Every game automatically has a default group (`groupid=0`); an achievement-sets positive requires an additional nonempty, public group that is neither developer-only nor archived. A valid schema containing only the default group is a known negative. Unqueried, failed and unavailable schemas remain unknown. Steam's NoMatch, FileNotFound and AccessDenied results are recorded as unavailable, not negative. See the [Steamworks achievement sets guide](https://partner.steamgames.com/doc/features/achievements/ach_guide?l=english).

On October 22, the user approved treating HTTP 200 with `EResult=2` and exactly `{ "response": {} }` as no public achievement catalog, following Steam/SteamDB checks and the finding that 1,738 of 1,752 affected games were marked coming soon in local metadata. The collector counts these as checked/unavailable, so they do not block completion or contribute an achievement-sets positive. This is an availability interpretation, not a fabricated valid schema. A recently validated schema or a successful known-good control through the shared queue is required first. Startup also resolves matching archived failures while preserving their original observation times and raw responses; an earlier usable schema is never downgraded. Other generic errors remain unknown, and a failed service control stops collection and preserves any cooldown.

Steam may omit the achievements list in a successful empty schema, as observed for Grapple (1428870). Accept that omission only when every validated group explicitly reports zero achievements; populated groups without the list still stop collection as an incomplete response. The first such response was replayed from its journal with its original observation time after this validation fix. All 4,335 previously successful schemas retained their classifications, and the regression suite passed 309 tests.

The requirements source is `https://store.steampowered.com/api/appdetails?appids=<id>&filters=basic&l=english&cc=US`. It requires one app per request; batching app IDs with this filter is unsupported. Requesting only a `requirements` filter does not return the needed data.

Retain only `pc_requirements`, `mac_requirements` and `linux_requirements`, including minimum/recommended HTML, rather than another copy of the full basic response. Preserve empty versus unavailable results and use the same checkpoint/fallback policy. These are publisher-authored strings, not reliably normalized hardware specifications; an old platform requirements block does not establish current platform support.

The independent `supplement.sqlite` uses FULL synchronous SQLite commits and compressed response journaling. Latest attempt metadata and the last usable payload have separate references, so later unavailability cannot erase an earlier successful schema or requirements block. Per-source observation times remain distinct from export time. A PID lock prevents duplicate writers; `progress.json` records coverage, failures, positive set counts and the current process. Once collection completes, the collector exports a separate `steam-feature-atlas-supplement-v1` gzip JSONL artifact and verifies its SHA-256, record counts, ordering and payload semantics before publishing `archive.json`. The original raw-v2 StoreBrowse/PICS checkpoint is unchanged. Collection alone does not publish a new browser feature or add requirements HTML to browser downloads.

Progress and monitor-state JSON replacement uses bounded retries for transient Windows file locks (`EPERM`, `EACCES`, `EBUSY`). The prior file remains available until rename succeeds; only the rename is retried, so a locked progress file cannot repeat a Steam request. Routine collecting snapshots are written at most every 30 seconds. If a snapshot remains busy after retries, log a warning and defer it while continuing from the authoritative SQLite checkpoint. Other I/O errors, terminal-state writes and archive metadata remain strict. Rate-limit cooldowns are saved in SQLite before reporting a stop, and resume honors both those deadlines and older progress-file deadlines.

The first progress-file lock on October 16 at 22:18 UTC led to bounded rename retries. A recurring lock on October 17 at 01:52 UTC exceeded that retry window, leading to the deferred routine snapshots above. All 16,293 completed source lookups survived, including 60 achievement-set positives. The expanded suite passed 316 tests, including continuing both sources under a busy progress file and preserving Retry-After when stopped progress cannot be written.

The October 16–23, 2026 collection is complete. It froze **201,409 games**, including **93,110** with Steam Achievements, from the live catalog imported at `2026-10-16T09:02:46.758Z` (snapshot `4c7e45acd2c47f6908099791c87601ca7f76404a755cb46547d61ca481ea729c`). The priority cohort with at least 20 reviews contains 60,504 requirements lookups and 37,760 achievement lookups. The initial 13-request live smoke test checked supporting, default-only and unavailable schemas, verified its export, and confirmed interruption/resume skipped completed lookups.

Final source coverage, independently reconciled between the read-only checkpoint and exported archive:

| Source | Planned / checked | Successful | Unavailable | Unresolved errors |
| --- | ---: | ---: | ---: | ---: |
| Achievement schemas | 93,110 | 70,055 | 23,055 | 0 |
| Publisher requirements | 201,409 | 198,155 | 3,254 | 0 |

The successful schemas contain **176 public achievement-set positives** and **69,879 valid-schema negatives**. The unavailable schemas comprise 9,514 health-checked empty EResult 2 catalogs and 13,541 EResult 42 responses; they retain unavailable status and their raw responses, without fabricated schemas or negative flags. Detected sets by frozen review cohort were 117 / 37,760 achievement checks for 20+ reviews, 47 / 26,994 for 1–19 reviews, and 12 / 28,356 for zero/missing reviews.

Final local artifact: `online/.cache/steam-supplement/steam-supplement.62846e08fe05ae0a.jsonl.gz`, with SHA-256 `62846e08fe05ae0a23afd823a45e15102f0b5e77193b54f6f420dcecf0d10f38` and descriptor `archive.json` in the same directory.

| Stored data | Bytes / records |
| --- | ---: |
| Gzip JSONL archive | 185,795,934 bytes |
| Uncompressed JSONL | 1,148,683,392 bytes; 201,409 app records plus one header |
| SQLite checkpoint | 359,768,064 bytes |
| Journaled compressed response payloads | 253,716,128 bytes; 294,814 responses |

Seeding at `2026-10-16T15:19:49.879Z` through the final lookup at `2026-10-23T06:01:55.798Z` took **6 days, 14 hours, 42 minutes, 5.919 seconds**, including interruptions, retries and the approved pacing changes. The first response was at `2026-10-16T15:19:50.756Z`. The final export, including its built-in verification, ran from `2026-10-23T06:13:25.603Z` to `2026-10-23T06:14:28.140Z` (**62.537 seconds**) without further Steam requests. No HTTP 429 appears in retained responses or the failure log, whose detailed telemetry began on October 21 at 17:31 UTC.

At completion, publisher strings containing Unicode line/paragraph separators exposed a JSONL reader issue. Export now escapes U+2028 and U+2029 so Node's line reader cannot split a JSON record inside a string; decoding preserves the original text. The regression reproduced the failure before the fix, and all **369 Node tests** passed afterward. A separate process reran `verifySupplement` successfully in **7.410 seconds**, then independently checked frozen app IDs and seed, SQLite integrity, source counts, every successful schema's set flag, and the exact uncompressed byte count. The complete verification and sample audit took **20.072 seconds** and was recorded locally in `final-verification.json` at `2026-10-23T06:19:12.054Z`.

Archived samples matched their checkpoint payloads and timestamps exactly: set positives Team Fortress 2 (440), Left 4 Dead 2 (550), Portal 2 (620), Euro Truck Simulator 2 (227300) and Unturned (304930); valid-schema negatives Terraria (105600) and Grapple (1428870); and six health-checked unavailable catalogs including Faceless (243240). Requirements samples included iRacing (266410), preserving its literal Unicode line separator, and an unavailable result for Soldiers: Heroes of World War II - Enhanced Edition (11480).

Monitoring is finished, with `enabled=false` in `online/.cache/steam-supplement/monitor-config.json`. The earlier queued-message timer remains disabled. The archive and checkpoint remain local; completing collection does not publish a new browser feature or change the daily StoreBrowse/PICS workflow.

### Browser projection

The Achievement Sets feature (`10002`, URL code `SET`) sits immediately after Steam Achievements and scores **+1**. It uses the same public-set definition as the verified archive: a nonempty public group beyond the automatic default group, excluding developer-only and archived groups. This can describe DLC, game modes, updates or other parts of a game.

`online/scripts/achievement-sets.mjs` verifies a completed supplement and extracts `online/data/achievement-sets.json`, a build input containing sorted known app IDs, supporting app IDs, the source archive checksum and observation date range. The initial projection preserves all **70,055** validated schemas and **176** positives. Unavailable schemas without an earlier usable payload are omitted, so they remain unknown. An earlier usable schema survives a subsequent unavailable attempt.

Imports apply achievement flags after the ordinary Steam metadata merge and pin their source checksum in `sources.achievementSets`. Fixture and bulk-only builds use the compact projection; production refreshes use the persistent achievement checkpoint described below. The browser receives only the feature bit and the existing `knownFeatureGroups` state; it downloads no schemas or requirements and makes no new API requests.

Measured on October 23 against the **203,314-game** production snapshot imported at `2026-10-22T09:25:59.049Z` (binary SHA-256 `b24f390b8240a75948f0013886064207d03c60655050ee36bc3bee3444b25521`), using the same games and gzip level 9 / Brotli quality 11 before and after. Re-encoded full, initial and remainder baseline files matched the production checksums exactly.

| Browser catalog | Gzip before → after | Gzip increase | Brotli before → after | Brotli increase |
| --- | ---: | ---: | ---: | ---: |
| Initial, 20+ reviews | 2,306,733 → 2,308,090 bytes | 1,357 bytes | 1,953,153 → 1,954,939 bytes | 1,786 bytes |
| Background remainder | 4,410,587 → 4,411,588 bytes | 1,001 bytes | 3,747,576 → 3,749,133 bytes | 1,557 bytes |
| Normal combined download | 6,717,320 → 6,719,678 bytes | **2,358 bytes (0.035%)** | 5,700,729 → 5,704,072 bytes | **3,343 bytes (0.059%)** |
| Full-catalog fallback | 6,633,283 → 6,634,712 bytes | 1,429 bytes | 5,638,773 → 5,639,649 bytes | 876 bytes |

The uncompressed initial/remainder binaries grew by 6,224 / 5,418 bytes (11,642 combined); the full binary grew by 6,949 bytes. Developer/publisher names and their uncompressed file size were unchanged. Rebinding that file to the new catalog checksum left gzip unchanged and made Brotli 1,453 bytes smaller in this run; that compression variation is excluded from the feature-catalog increases above. The build-only JSON projection is 546,054 bytes and is not a browser download.

All **374 Node tests** passed after integration. Focused Edge 155 and Firefox 153 checks each passed 18 assertions covering placement, +1 scoring, initial/full loading, compact URL reloads, require/exclude behavior, validated negatives, unavailable schemas and mobile layout. All 176 positives are available with unrestricted reviews/releases; the default released/20+ reviews view contains 108. Local measurement and browser reports are retained in `online/.cache/achievement-sets-integration/`.

### Rolling achievement refresh

The automatic build has a separate achievement phase after StoreBrowse/PICS enrichment. Never-checked games advertising Steam Achievements come first, then newly released games or schemas awaiting a full response, followed by older eligible checks in observation-time order. Existing StoreBrowse/PICS batching and five-second pacing remain unchanged. Publisher requirements remain outside daily collection.

The achievement phase uses a shared serial queue with a **2,000-attempt / 30-minute daily allowance** and a **1,000 ms post-response pause**. Attempts include hash-only requests, full schemas, retries and service controls. Daily attempts and elapsed time persist in SQLite and the published maintenance checkpoint, so rerunning a build does not reset the allowance. HTTP 429 raises the minimum to 1,500 ms; Retry-After and cooldowns survive restarts. Long delays or exhausted budgets end the optional phase without holding up deployment.

Validated older schemas use `hash_only` to compare schema version/hash. A match retains the known flag and updates its confirmation time; a mismatch requires a complete validated schema. If the budget ends between the two requests, the prior flag remains usable and the pending full request is resumed later. An empty EResult 2 catalog requires a healthy known-good schema control before being recorded unavailable. Other service/schema failures preserve known facts and stop this optional phase.

`data/achievement-state.json.gz` provides the initial seed. Subsequent builds restore `manifest.achievementState`, independently merge newer cached observations and retain the latest usable facts even when a later attempt is unavailable. The published file contains flags, schema hashes/versions, observation times, retry state and daily budgets, not the full schemas or requirements. Its checksum is recorded in provenance and production verification reconciles its flags with every game in the browser catalog. Browsers do not request this file.

Full API envelopes are separately journaled under `.cache/steam-achievements/responses/` and included in the workflow's cached/uploaded response artifacts. Cache restoration covers SQLite/WAL files and responses, excluding the process lock. The completed original supplement and its requirements remain unchanged; offline seed generation opens both original and delta checkpoints read-only and verifies their archives before merging.

The October 23 achievement-only top-up targeted **1,029** missing schema checks from the current **203,685-game** catalog: 908 added games advertising achievements and 121 existing games newly advertising them. It ran from `2026-10-23T12:14:32.844Z` to `2026-10-23T12:36:11.260Z` (**21 minutes, 38.416 seconds**), retaining a cached Portal 2 schema as a service-control record. The new games yielded **71 valid schemas and 958 unavailable catalogs**, with no unresolved failures and **zero requirements requests**.

Three additional positives were Mimic Alert (3280980), Bunny Hopper (4015730) and Void Core (4429440). The merged seed contains **94,139 observations**, **70,126 usable flags** and **179 set-supporting games**, and compresses to **1,418,274 bytes**. The independently verified delta archive is `steam-supplement.290a08a70b05f43c.jsonl.gz` (171,145 bytes; SHA-256 `290a08a70b05f43c172410a20d9a52b548bba9101be02e654ae76d398a5e0e6f`). The original frozen seed hash and all 294,814 original response rows were independently confirmed unchanged.

A three-request live smoke test on October 23 verified the actual hash-only transport: Portal 2's schema matched the seed, while Team Fortress 2's hash had changed and its subsequent full schema validated as supporting public sets. These responses were archived separately; no requirements endpoint was used. Reports and independent verification are retained locally in `.cache/achievement-sets-planning/`.

The final suite passed **392 tests**, including new-game priority, daily attempt/time limits across reruns, hash-change interruption/resume, unavailable-result preservation, Retry-After/throttle persistence, full service-health controls and deployment checkpoint/projection verification. Edge 155 and Firefox 153 each passed 20 focused browser checks against the refreshed **203,685-game** preview, including all three added positives and zero maintenance-checkpoint downloads. The default released/20+ reviews view now contains **111** supporting games; unrestricted filters contain **179**.

Against the same current production catalog, the release preview's initial/remainder files grew by **2,503 / 2,138 bytes Brotli** (4,641 total), or **1,216 / 1,154 bytes gzip** (2,370 total). The separate 1,418,274-byte achievement seed/checkpoint is build-only. These measurements include the completed top-up and updated provenance; the earlier 176-game projection measurement above remains a separate, older snapshot comparison.
