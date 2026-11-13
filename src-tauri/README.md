# Bookmark Desk backend

Tauri v2 desktop backend. Run the Tauri CLI from the frontend project root. The `beforeDevCommand` hook runs `npm run dev` for `http://localhost:5173`; the `beforeBuildCommand` hook runs `npm run build` to refresh `../dist` before each native build.

## Frontend contract

Using `invoke` from `@tauri-apps/api/core`:

```typescript
const library = await invoke<Library>('load_library');
await invoke('save_library', { library });
await invoke('open_bookmark', { url: 'https://example.com' });
const metadata = await invoke<{ title: string | null; icon: string | null }>(
  'fetch_metadata', { url: 'https://example.com' }
);
```

`Library` has `bookmarks`, `collections`, and `trash` arrays. Older save payloads may omit `trash`; it defaults to an empty array. Each bookmark has string fields `id`, `title`, `url`, `description`, `createdAt`, and string arrays `tags`, `collectionIds`. Each trash entry has those same flattened bookmark fields plus a string `deletedAt` (not a nested `bookmark` object). Collections have string `id`, `name`, and nullable string `parentId`. Timestamps are preserved as supplied by the frontend (use ISO 8601 timestamps). A fresh database returns three empty arrays.

SQLite is stored as `library.sqlite3` in Tauri's per-user app data directory for `com.bookmarkdesk.desktop`. Saves replace the entire library atomically, preserve array order, and roll back on errors (including duplicate IDs). Tags and collection membership are JSON arrays in bookmark table columns. Trash entries are JSON payloads in a separate `trash` table, created additively with `IF NOT EXISTS` so existing bookmarks and collections are preserved. Trash is read and replaced in the same transaction as the active library, including rollback on duplicate trash IDs; array order is preserved. References are preserved without requiring parent collections to precede children. All database commands share a mutex; the last successful full-library save wins. Back up the database only after closing the app, or use SQLite's backup facilities to include WAL data safely.

Only HTTP/HTTPS URLs with a host can be opened, through the Rust opener plugin. The window has no frontend plugin permissions; the registered application commands are available through Tauri IPC. Command errors reject the invoke promise with a string. Packaging is disabled; the included original icon is needed for Windows executable resources.

## Automatic local JSON backups

Native commands (all errors reject with a string):

```typescript
type BackupConfig = { enabled: boolean; intervalMinutes: number; retention: number; location: string };
type BackupStatus = { config: BackupConfig; lastSuccess: string | null; lastError: string | null };
const status = await invoke<BackupStatus>('backup_status');
await invoke<BackupStatus>('configure_backups', { config: status.config });
await invoke<BackupStatus>('create_backup');
const backups = await invoke<{ name: string; createdAt: number; size: number }[]>('list_backups');
const payload = await invoke<{ version: 1; library: Library }>('read_backup', { name: backups[0].name });
```

Defaults: enabled, every 60 minutes, retention 20, absolute `backups` subdirectory of app data. Intervals accept 1–10080 minutes; retention accepts 1–100 files. Configuration and last-success/error status persist in separate SQLite tables without changing library revisions or connector semantics. `lastSuccess` is UTC ISO 8601; list `createdAt` is epoch milliseconds and `size` is bytes. The scheduler checks immediately on startup and every 30 seconds while the app runs; overdue/never-run backups execute at the next check. Errors retry at the next check. No background service runs after exit. Manual backups work when automatic backups are disabled. Changes to interval/location apply to the next check; existing backup directories are not migrated or swept.

Files contain the existing **plain Library JSON**, including trash and smart collections (not a SQLite copy or an envelope). A transaction reads a consistent library snapshot; backups do not write library data or change its revision. Unique versioned filenames use a timestamp and nonce. Complete synced staging files are atomically published with a non-overwriting hard link; unsupported filesystems fail explicitly rather than exposing partial backups. Only successful publications registered in this database at the current location are listed, read, or considered for retention. Newest files are retained, including manual backups. Unregistered files and backups from other locations/installations are not deleted. Interrupted staging/unregistered files may remain and are intentionally never swept. A failure after publication can leave a complete unregistered backup and reports an error.

Locations must be absolute local directories without symlinks/reparse points. Owned filenames follow a strict ASCII pattern; reads reject paths, unknown filenames, directories, links/reparse points, malformed Library JSON, invalid IDs, and files over 128 MiB. Windows directory handles prevent ancestor rename/delete during filesystem operations; file reads open reparse points rather than following them. Retention only unlinks registered regular files, never recursively removes directories. Ordinary local backups are not encrypted; select a protected directory. Concurrent hostile filesystem mutation is not an authentication boundary; protect write access to the backup directory and its ancestors.

`read_backup` **only reads** and returns `{version:1,library}` for frontend preview. It never restores or replaces SQLite data. The frontend must run `validateLibrary`, preview and explicitly confirm, then `mergeLibrary` through the existing revision-guarded commit/Undo flow. There is no destructive native restore command. Backup creation/list/read errors are visible in persisted `lastError`; successful creation clears the error. Backend tests run with `cargo test --lib backups::tests` and cover scheduling/settings persistence, retention, plain JSON round trips, read-only restoration input, filename/link/directory rejection, non-overwriting atomic errors, and serialized status contracts.

## Metadata fetching

`fetch_metadata(url)` returns a normalized HTML title and an optional base64 raster icon data URL. The frontend is responsible for caching; this command does not modify SQLite. Missing titles/icons are `null`. Page errors reject the promise; icon errors never discard a successfully extracted title. The first usable `rel="icon"` link (including `shortcut icon`, case-insensitive) is resolved against the final page URL, followed by `/favicon.ico` if fetching or format detection fails.

Only HTTP/S URLs without credentials are fetched. Literal IPs and all DNS answers must be public; private, loopback, link-local, multicast, reserved/documentation and transition ranges are rejected. Validated DNS answers are pinned for the actual connection to prevent DNS rebinding. Environment proxies are disabled. Every page/icon redirect is validated and resolved again, with at most five redirects per fetch. Each fetch, including DNS and redirects, has a 12-second deadline and a 4-second connection timeout. At most two icon fetches follow the page (36 seconds maximum total). Responses are streamed with limits of 2 MiB per page and 256 KiB per icon, even without Content-Length. Automatic decompression is not enabled.

Icon MIME types are determined from PNG/JPEG/GIF/WebP/ICO byte signatures, not server-supplied Content-Type; SVG and other formats are rejected. Signature detection does not fully decode/validate an image. No frontend files or permissions are required for this command.

## Validation

From this directory:

```powershell
cargo check
cargo test
cargo fmt -- --check
```

Tests cover empty state, old-database migration, missing-trash JSON defaults, flattened trash JSON, full data/trash round trips, replacement/clearing, whole-library rollback on duplicate active or trash IDs, persistence across connections, URL validation, public-address/DNS filtering, redirect validation, final-URL-relative icon extraction, response-size enforcement, raster data URLs, and title preservation on icon failure. Metadata tests are deterministic and require no external network. A Rust MSVC toolchain, Windows build tools, and WebView2 are required on Windows. Production compilation also requires the frontend's built `dist` directory.

## SQL display queries and incremental persistence

```typescript
const result = await invoke<{ bookmarks: (Bookmark & { deletedAt?: string })[]; total: number }>(
  'query_bookmarks', {
    input: { view: 'all', tag: '', query: '', sort: 'newest', page: 0 }
  }
);
await invoke('apply_library_patch', {
  patch: {
    bookmarks: [], collections: [], trash: [],
    deletedBookmarkIds: [], deletedCollectionIds: [], deletedTrashIds: []
  }
});
```

`query_bookmarks` accepts **one `input` object**, not flat invocation arguments. All five fields are required. `view` is `all`, `inbox` (zero collection memberships), `untagged` (zero tags), `trash`, or a collection ID; `collection:<id>` is also accepted and disambiguates reserved collection names. Membership is direct, not recursive. Unknown collection IDs return zero results. `tag` is an exact case-sensitive tag, or empty for all tags. Trimmed `query` is a literal substring searched across title, URL, description, and individual tags; `%` and `_` are not wildcards. Search uses SQLite `lower()` (ASCII case folding, not Unicode linguistic folding). View, tag, and search filters intersect. Trash is queried independently and returns flattened `deletedAt`; active results omit it.

`sort` must be `newest` (createdAt descending), `title` (SQLite NOCASE ascending), or `domain` (parsed lowercase host with leading `www.` removed, ascending; invalid/hostless URLs sort as empty). All ties use binary ID ascending. Newest means creation time, including in trash, not deletion time. Use consistently normalized ISO timestamps for chronological lexical ordering. URL paths, queries, and fragments are preserved; domain sorting is not URL identity normalization or duplicate detection. No URL deduplication/import urlKey behavior is changed.

`page` must be a signed 64-bit integer. Pages are **zero-based** (`0` first, `1` second), clamped to `[0, max(0, ceil(total/75) - 1)]`; each response contains at most 75 rows. `total` is the filtered count before pagination. Count and page share a read transaction/snapshot. Invalid types, missing fields, unknown fields, and unsupported sorts reject with a string; arbitrary collection view strings are valid.

`apply_library_patch` requires exactly the six arrays shown above and resolves to `null`. Rows are complete records, not partial field updates. Only supplied rows are upserted and supplied IDs deleted, in one transaction; omitted records remain untouched. Existing positions are retained; new rows append in patch-array order. Identical records cause **zero row writes**. There are no full-library reads, table clears, or rewrites of other rows. Duplicate/blank IDs, duplicate delete IDs, same-table upsert/delete conflicts, and simultaneous active/trash upserts of the same ID reject. JSON types are checked by serde. Content strings, timestamps, URLs, and dangling collection references are preserved, matching full-save behavior. Deletes of nonexistent IDs are no-ops; deletion does not cascade or scrub memberships. Move to trash explicitly deletes the active ID and upserts its flattened trash row; restore explicitly does the reverse. SQL errors roll back all tables, including earlier successful statements. Neither command normalizes URL identities or merges bookmarks.

Initialization adds only `IF NOT EXISTS` indexes (newest, NOCASE title, deterministic parsed domain, and positions); original tables/columns and JSON payloads remain intact. The domain function is registered on every application connection before using its expression index. External SQLite writers must also register a compatible `bookmark_domain` function or drop that derived index first. Legacy load/save semantics remain unchanged, including full-save replacement and input order. Frontend files are intentionally unchanged: consumers should render SQL query results while retaining `load_library` for mutation baselines and backups, and send changed/deleted records from their persisted baseline through the patch command. This backend change alone does not switch an existing frontend's render path.

### Measured debug validation

`cargo test -- --nocapture`: **22 passed**, including migration/idempotent initialization, full-save compatibility, patch order/moves, SQL-trigger rollback, validation, filters, trash, stable sort, pagination, and a 25,000-active + 100-trash + 1-collection import. File-backed SQLite with production WAL/FULL settings, Windows debug build (2026-11-13):

| Operation | Elapsed | Table rows written |
| --- | ---: | ---: |
| Import through incremental patch | 1.161 s | 25,101 |
| First SQL count + 75-row page | 9.872 ms | 0 |
| Single bookmark title edit | 1.799 ms | 1 |
| Identical edit replay | not timed | 0 |

Write counts are asserted using SQLite `total_changes()` deltas (logical table rows, not index entries/pages). Timings are evidence, not machine-independent thresholds. Test data includes multiple hosts, duplicate titles, fragments, tags, collections, Unicode descriptions, and timestamps. Performance fixture uses a dedicated file under `src-tauri/target` and removes it after success. `cargo fmt -- --check` passed; no release build was run. Cargo emitted a nonfatal Windows incremental-cache access warning; all tests completed successfully.

## Chrome MV3 native messaging

The separate `bookmark-desk-connector` executable delegates to the library's exported `run_native_host()`. Build debug binaries with `cargo build --bins`; `cargo run` still selects the desktop app. Chrome host name: **`com.bookmarkdesk.connector`**. The extension must declare `nativeMessaging` permission. No HTTP listener, browser-accessible CORS endpoint, standalone connector database writes, or icon fetching is used.

On Windows, install for the current user (no elevation):

```powershell
.\setup-native-host.ps1 -ExtensionId aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
# Or specify the actual installed/debug connector executable:
.\setup-native-host.ps1 -ExtensionId aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -ConnectorExe 'C:\apps\bookmark-desk-connector.exe'
```

Use the actual ID shown by Chrome, not the example. Keep the connector executable at that path. The script creates an HKCU Chrome NativeMessagingHosts registration and a manifest pointing directly to the actual EXE, with exactly one allowed extension origin. Re-run after moving the binary or changing IDs. `-Uninstall` removes registration only; invoke `disable_extension` to revoke pairing too. The script accepts `-Browser Chrome|Edge|Both`, default `Both`, and installs/removes the corresponding HKCU Google Chrome and Microsoft Edge native-host registrations. Both registrations share one manifest and the desktop still allows only one paired extension ID; use the same ID in both browsers. Selective uninstall retains the shared manifest while the other browser remains registered.

The desktop must be running and explicitly paired through `configure_extension`. Registration alone never enables requests. Pairing persists across restarts and re-pairing rotates a 256-bit SQLite `randomblob(32)` secret. The desktop binds an ephemeral IPv4 loopback TCP port and publishes `native-connector.json` in its Tauri `app_data_dir`. On Windows this is `%APPDATA%\com.bookmarkdesk.desktop`; the connector derives the same roaming directory from the identifier embedded from `tauri.conf.json`, not from its executable directory or a caller-supplied path. The setup script uses that same identifier. The descriptor contains the port, secret, and paired origin: do not publish or copy it. It inherits the per-user app-data directory's access control. This is a per-user trust boundary, not protection from malicious code already running as that OS user. A stale descriptor cannot authorize a revoked pairing because the server checks the current SQLite configuration on every request.

The connector requires Chrome's first argument to equal the paired `chrome-extension://<id>/` origin exactly (32 lowercase `a`�`p` characters). Chrome may append its standard parent-window argument. Both the connector and desktop validate the origin; desktop additionally validates the random secret. Both transports use four-byte little-endian JSON byte lengths, maximum 512 KiB. TCP reads/writes/connects have five-second timeouts and the desktop caps concurrent connections at eight. Each TCP connection carries one authenticated request/response; Chrome stdin/stdout can carry multiple messages. Malformed/truncated/oversized frames terminate processing. No logging is written to stdout. Browser stdin can remain idle awaiting the next message; partial stdin frames remain bounded in memory. Secret rotation/revocation invalidates existing host sessions; reconnect after re-pairing.

### Desktop commands (camelCase invocation arguments)

```typescript
const snapshot = await invoke<{ library: Library; revision: string }>('load_library_snapshot');
const revision = await invoke<string>('get_library_revision');
const nextRevision = await invoke<string>('apply_library_patch', {
  patch, expectedRevision: snapshot.revision
});
const setup = await invoke<{
  extensionId: string; origin: string; descriptorPath: string;
  connectorExe: string; hostName: string;
}>('configure_extension', { extensionId });
await invoke('disable_extension');
const status = await invoke<{
  enabled: boolean; extensionId: string | null; origin: string | null;
  descriptorPath: string; connectorExe: string; hostName: string;
}>('get_extension_status');
const icon = await invoke<string | null>('get_extension_icon', { url });
```

`configure_extension` reports the expected sibling connector EXE path (debug desktop: `target\debug\bookmark-desk-connector.exe`); build it before registration. Setup/status never return the secret. `load_library` is unchanged. Snapshot reads and revision reads use the shared database mutex. `apply_library_patch` compares optional `expectedRevision` and applies the patch while retaining that same lock; mismatches reject with `Library revision conflict` before writing anything. It returns the post-commit revision atomically, so clients must retain that returned revision rather than fetching a later revision to label an older in-memory library. Omitting `expectedRevision` retains backward compatibility but cannot protect stale clients. Persisted SQLite triggers advance revision on all bookmark/collection/trash inserts, updates and deletes, including legacy full saves. Revisions are opaque decimal strings, not JavaScript numbers. A revision counts row mutations, not transactions. Existing full saves remain last-writer-wins and should not be used by revision-aware clients.

Successful native inserts emit `extension-saved` with unit/null payload; frontend clients should reload a snapshot when idle and resolve stale-patch errors by reloading/rebasing rather than retrying with a fresh revision on stale state. Native requests and UI mutations use the same database mutex and incremental SQL, preserving unrelated data.

### Browser request/response contract

Requests: `{op:'catalog'|'check'|'save', url?, requestId?, title?, favicon?, tags?, collectionIds?, createdAt?}`. Fields use camelCase; unknown fields are rejected. `catalog` returns `{ok:true,collections:[{id,name,parentId}],tags:string[]}`; tags are sorted unique active-bookmark tags. `check` requires URL and returns `{ok:true,saved:boolean}`. `save` requires URL and returns `{ok:true,status:'saved'|'already-saved',id:string}`. Errors are `{ok:false,error:string}`. Transport/disconnection failures are retried by the extension using the same request ID; no desktop auto-start is attempted. Pending entries display the latest connection error (including missing native-host registration) instead of silently waiting. Desktop-offline/pairing failures remain automatically retryable; invalid save data still requires explicit attention. Reload an updated unpacked extension rather than uninstalling it, to preserve pending saves.

URLs must be HTTP/S with a host, no credentials or controls, and at most 8192 bytes. URL parsing canonicalizes and removes fragments for duplicate checks. Title is limited to 2048 characters; at most 32 tags, each at most 100 characters; text controls are rejected. Collection IDs must already exist. Optional request IDs are nonempty, at most 128 characters, and persisted transactionally alongside the insert and response; reusing an ID for another normalized URL fails. Missing title defaults to URL, missing tags/collections to empty arrays, missing creation time to SQLite UTC time. Supplied creation timestamps must parse via SQLite julianday, are bounded to 100 characters, and reject controls; callers should supply ISO strings. Collection IDs are nonempty, control-free, at most 256 characters and must exist. Existing bookmarks are never overwritten. Trash is not restored: saving a URL only found in trash inserts a new active bookmark and leaves trash untouched.

Favicons are empty, HTTP/S URLs (no credentials, at most 8192 bytes, no fetch), or base64 raster data URIs. PNG/ICO/JPEG/GIF/WebP are allowed with matching byte signatures and decoded size at most 128 KiB; SVG/HTML and malformed base64 are rejected. Signature checks are not full image decoding. Favicons are stored separately in `extension_icons` keyed by bookmark ID, without changing `Bookmark`; `get_extension_icon(url)` finds only active bookmarks using fragment-insensitive URL matching and returns the stored original URL/data URI or null. Moving/deleting bookmarks does not change unrelated icons or records.

Validation: `cargo test` includes origin/secret/revocation tests, framed malformed/bounds tests, URL/favicon validation, persistent receipt replay, preservation of library/trash, stale-patch rejection, and a Windows real connector process test against a loopback fixture using a project-local test APPDATA directory. No test-only descriptor override or production bypass is provided. All validation uses debug builds.

Pairing responses additionally include `setupCommands: {shell: 'PowerShell', build: string, register: string, unregister: string}`. These are copyable, fully quoted commands using the source checkout's `src-tauri\Cargo.toml` and setup script paths; registration points at the reported sibling connector EXE. They are instructions only and never execute automatically. The source checkout must still exist for build/setup commands; relocated installations should supply their distributed script path. The subprocess-to-SQLite regression uses the real production authentication/operation handler after receiving the actual connector's TCP frame.

