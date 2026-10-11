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
- Compatibility tests retain their tokens and display values, alongside input, launcher, text, internet, frame-limiter, HDR and runtime configuration. These details remain in the collected data and are excluded from the interface, filters, feature counts and scores.
- Hardware columns and scoring are opt-in (`hw=1`). Each target has one column: `?` untested/unavailable, a red minus unsupported, a yellow check playable and a green check verified/supported. Tooltips distinguish untested from unavailable data. Verified/supported scores +1, unsupported −1, playable/untested 0. Each explicit overall rating counts once. No keyboard/mouse support and In-App Purchases use the same red minus for their −1 penalties.
- The separate **Filter by compatibility** panel selects an exact rating for each target, independent of column visibility. Ignore leaves that target unrestricted; selections across targets combine with AND. `deck`, `machine`, `frame` and `os` URL parameters preserve the selections. Missing ratings do not match Untested. SteamOS offers Supported instead of Playable/Verified. Hardware ratings are excluded from the ordinary feature selector.
- Dynamic Cloud Sync appears next to Steam Cloud; GeForce NOW is the fourth Remote Play entry. Both score +1. Generic cloud-streaming category 45 is retained in the data but contributes no separate column, filter, count or score.
- PromptFont v1.15 is embedded locally for controller, headset and Steam symbols (82,856-byte original WOFF2, SIL OFL 1.1). Deck and Machine use SVG icons. Font attribution and license are included in the site.
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
| Complete generated site, including archives | 549,914,453 | 549.91 MB |
| Local SQLite checkpoint | 3,005,304,832 | 3.005 GB |

Allow additional disk space for SQLite's transaction journal, the prior deployment, a local archive copy and build staging. Production verification checks archive checksums, every JSONL record, sorted app IDs and counts, refresh completeness, and equivalence between the browser's JSON and binary catalogs.

## Optional future requirements pass

System requirements are postponed. The confirmed source is `https://store.steampowered.com/api/appdetails?appids=<id>&filters=basic&l=english&cc=US`. It requires one app per request; batching app IDs with this filter is unsupported. Requesting only a `requirements` filter does not return the needed data.

Retain only `pc_requirements`, `mac_requirements` and `linux_requirements`, including minimum/recommended HTML, rather than another copy of the full basic response. Preserve empty versus unavailable results and use the same checkpoint/fallback policy. These are publisher-authored strings, not reliably normalized hardware specifications; an old platform requirements block does not establish current platform support.

At a 5-second post-response pause and the sampled response time, 200,000 apps take about 12 days before retries. The requirements-only addition projects to approximately 200 MB uncompressed or 13 MB with Zstd-19. Implement this as a separate resumable pass so it does not delay or repeat StoreBrowse/PICS collection. It is not started by the current collector.
