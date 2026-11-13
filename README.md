# Bookmark Desk

A local-first bookmark organizer built with React, TypeScript, Tailwind CSS, Tauri v2, Rust, and SQLite.

## Run

Requires Node.js, Rust, Windows C++ build tools, and WebView2 for the desktop app.

```powershell
npm install
npm run tauri -- dev
```

Browser-only preview:

```powershell
npm run dev
```

The browser preview uses localStorage. The desktop app uses SQLite in its application data directory. These are separate libraries; use a JSON backup to transfer data between them.

## First milestone

- Create and edit bookmarks, notes, and comma-separated tags.
- Create nested collections with a collapsible sidebar tree; bookmarks can belong to multiple collections.
- Compact desktop layout with a bookmark details pane. Click a title to open the website in your browser; use the details (ⓘ) button next to Edit to inspect notes, collections, and tags.
- Inbox for unorganized links and an Untagged view.
- Search titles, URLs, notes, and tags; filter by collection and tag.
- Sort by title, website, or creation date.
- Select individual bookmarks or a page; bulk-add collections/tags or delete.
- Undo the most recent change during the current session.
- Import browser bookmarks HTML with folder hierarchy; duplicate URLs merge memberships and tags.
- Export browser bookmarks HTML or a versioned JSON backup.
- Import JSON backups by merging into the current library, not replacing it.
- Open links in the default browser from the desktop app.
- Paginated rendering (75 links per page) to keep the DOM small.
- Website icons load in the background for visible bookmarks, with a domain-initial fallback. Up to 100 metadata entries are cached locally; two frontend requests run at a time.
- Automatic titles: paste a URL and leave the URL field, or save with a blank title to fetch after saving. Custom titles and imported titles are not overwritten. Unreachable sites retain the domain fallback.

## Sidebar and dismissal

- Collections, Smart collections, and Tags have independent scroll areas; their headings and the local-storage footer remain visible. Very short windows allow the sidebar itself to scroll, with a sticky footer.
- Click outside or press Escape to close bookmark details and Export. Dialogs close immediately when unchanged; edited bookmark/collection/smart-collection/tag forms and settings ask before discarding. **Keep editing** (or Escape in the discard confirmation) preserves edits. Saving blocks dismissal. Focus returns to the opening control, and modal keyboard focus stays within the dialog.
- Nested confirmations and menus handle Escape first. A focused native select/datalist consumes the first Escape; a subsequent Escape closes the dialog or asks about unsaved changes.
- The browser extension popup still closes naturally when clicking outside. Draft URL, title, tags, and collection choices are stored locally as they change and restored only for the same tab ID and original page URL. Navigating that tab or using another tab never applies the old draft. Confirmed and queued saves clear the draft; failures/needs-attention retain it. Edits made during a save are preserved. Opening setup does not close the full options tab.

## Collection, tag, and trash management

- Use the pencil beside a collection to rename or move it. Self/descendant destinations are excluded and hierarchy validation prevents cycles.
- Deleting a collection **keeps all bookmarks**, removes only that collection membership (including in Trash), and reparents direct children to the deleted collection’s parent, or top level. Bookmarks with no remaining memberships appear in Inbox.
- Use the pencil beside Tags to rename, merge into an existing tag, or remove a label without deleting bookmarks. Changes also apply to bookmarks in Trash.
- Bookmark Delete moves selected bookmarks to persistent Trash. Trash survives reloads/restarts in browser localStorage and desktop SQLite. Restore individually or by selection; permanent deletion and Empty trash require confirmation.
- Restore preserves bookmark fields and memberships. If the URL has already been saved again, restore merges tags and memberships into the active bookmark and fills empty notes without replacing its title or existing notes.
- Undo remains session-only for ordinary changes, including trash/restore and collection/tag edits. Permanent deletion clears Undo and cannot be undone. Existing exported backups may still contain deleted data.
- Full version-1 JSON backups now include an optional `trash` list. Older backups without it remain supported. JSON import merges active bookmarks and trash separately, never implicitly restoring deleted entries; repeated imports deduplicate trash by URL and deletion timestamp. Browser HTML exports active bookmarks only.

## Drag-and-drop organization and local backups

- Drag an active bookmark onto a **normal collection** to **move** it: all previous collection memberships are replaced, matching the existing bulk Move menu. Dragging a selected bookmark moves the entire captured selection across pages; dragging an unselected bookmark moves only that bookmark. To preserve memberships, use the separate **Add to collection** menu instead.
- Collection buttons are also draggable: drop onto another normal collection to reparent, or **Collection top level** to remove the parent. Self/descendant cycles, smart destinations, stale library/selection scopes, unknown IDs, and Trash bookmark drags are rejected. Green outlines indicate valid destinations; red dashed outlines indicate invalid ones. Successful moves offer session Undo. Existing collection-management and bulk menus remain keyboard alternatives.
- On Windows the Tauri native file-drop interception is disabled to support internal HTML drag/drop; importing files still uses the Import picker.
- **Backups & restore** exposes desktop-only automatic local JSON snapshots, enable/interval/retention/folder settings, last success/error, **Back up now**, and version previews. Defaults: enabled, every 60 minutes, keep 20 versions, application-data backup folder. Interval is configurable from 1 minute to 7 days; retention from 1 to 100 versions. Atomic non-overwriting publication and registered-file-only retention protect existing files; only this installation's registered snapshot files in the configured folder are eligible for cleanup, never unrelated JSON. Settings survive restarts. Backups run **only while the desktop app is running**, not while closed. Snapshots use the same version-1 JSON envelope as manual exports and include normal/smart collections and Trash.
- Backup settings migrate older flat and `settings`-wrapped saved formats to the current `config` format without resetting preferences or last-success/error values. Malformed or invalid settings disable automatic backups with a visible warning instead of preventing startup; the exact original payload is preserved in the SQLite `backup_state_recovery` table before recovery is persisted. Existing library records, registered snapshots and backup files are not removed during recovery. Review and save settings to resume scheduling.
- Restore requires selecting a version, reviewing its counts, then **Confirm safe merge**. It never replaces the live library: existing titles/notes remain, new links are added, duplicate URLs combine tags/memberships, and Trash is merged separately. Undo can reverse the merge during the session. Backup-read/validation failures do not change the library; regular saves retain SQLite revision-conflict protection.
- Browser preview honestly disables native filesystem scheduling and version browsing; manual JSON Export and Import remain available. Keep another copy on a different device for protection against disk loss. Local backup JSON is not encrypted and can contain private URLs and notes.

## Data and limitations

Export JSON for complete backups: browser HTML does not preserve notes, tags, or trash. Duplicate checks normalize URLs and ignore fragments, but retain query parameters. No account, third-party metadata service, or telemetry is used. Displaying bookmarks requests metadata directly from their websites (which reveals your IP to those sites); icons are then served from a local cache. Metadata requests only allow public HTTP/S destinations, use size/time limits, and do not execute page scripts. Some websites block automated requests or require JavaScript, so titles/icons may be unavailable. The metadata cache is separate from JSON backups and can be recreated. The Vite metadata endpoint is a local development/preview feature, not a production hosting API.

## Performance and duplicate cleanup

- Desktop displayed results now come from SQLite: search titles/URLs/notes/tags, exact tag and collection filters, Inbox/Untagged/Trash, deterministic title/website/newest sorting, and 75-row pagination. Searches debounce by 120 ms; outdated responses cannot replace a newer search or saved revision. Search failures show a retry action rather than falling back to in-memory desktop results.
- Ordinary desktop saves send only changed/new records and deleted IDs in one validated transaction. Unchanged bookmarks, collections and trash are not rewritten. The existing database tables and version-1 JSON format remain compatible; indexes are added without discarding data. Browser preview retains localStorage and in-memory queries.
- **Review duplicates** inspects existing active bookmarks with identical normalized URLs. Matching retains fragments, query parameters, HTTP versus HTTPS, and path distinctions; this is deliberately more conservative than the existing import duplicate rule. Choose explicitly which title to keep. Merge combines distinct notes, tags and memberships, moves removed originals to persistent Trash, and supports Undo. Trash restore retains its existing duplicate-merge behavior; use Undo immediately to reverse a merge exactly, or inspect/export originals in Trash for later recovery.
- The frontend still holds a complete library snapshot for editing, collection/tag counts, backup/export, imports, duplicate review and session Undo. Startup, diff calculation and those operations remain proportional to library size; SQL paging removes full in-memory search/sort from the desktop display path, not all large-library memory use. Substring search may scan SQLite rows; this is not full-text ranked search. SQLite title ordering uses its database collation and can differ from browser locale ordering for non-ASCII text.
- Regression coverage includes 25,000-link repeated import/diff, file-backed 25,101-row SQLite import/page/edit measurements, schema compatibility/transaction rollback, SQL pagination/filtering, conservative duplicate recovery, and an out-of-order desktop-query React integration test. Performance numbers are diagnostic, machine-dependent debug measurements, not production latency guarantees.

## Smart collections and cross-page organization

- Save a search or use **New smart collection** in the sidebar. Name/edit/delete saved rules without changing bookmark memberships. Text, all listed tags (exact, case-sensitive), exact domain (ignoring `www.` and a trailing dot), Untagged, and Inbox rules are combined with AND. Empty rules match every active bookmark. Trash is excluded. Text searches are trimmed, ASCII-case-insensitive substrings of title, URL, notes and space-separated tags in both SQLite and browser preview.
- The save dialog shows supported rules explicitly: a regular collection's membership is **not** saved as a rule. When viewing a smart collection, edit its rules via its pencil; Save search captures the current explicit text/tag/domain and Inbox/Untagged filters, not another smart collection's hidden rules. Contradictory rules (for example Untagged plus a required tag) intentionally match nothing.
- **Select all N matching** captures explicit IDs across every page, not just the visible 75. The selected count and Clear selection remain visible. Page and sort changes retain the snapshot; filter/view changes, successful writes and external connector refresh invalidate it. New matches are never silently added. Desktop ID selection checks the library revision; writes retain revision-conflict protection.
- **Add to collection** preserves existing memberships; **Move to collection** replaces all memberships with the chosen destination. Bulk tag removal affects only the named tags on selected active bookmarks. These operations support session Undo; Delete still moves bookmarks to Trash.
- Full version-1 JSON backups include optional `smartCollections`; old backups without them still import. Smart records merge without duplicating identical name/rule pairs; colliding IDs are remapped. Browser HTML cannot represent smart rules. Desktop adds a separate smart-collection table to existing databases and patches only changed records.

Offline article reading is not implemented.

## Chrome / Edge extension (MV3)

The unpacked [extension](extension) saves the current HTTP/S tab title, URL and browser-provided favicon address; choose collections and comma-separated tags in its popup. The page right-click **Save to Bookmark Desk** uses the last popup defaults. It does not import or synchronize native browser bookmarks.

### Explicit per-user setup

1. Keep `npm run dev` for web preview. To pair/save into SQLite, run `npm run tauri -- dev` (actual desktop; no release build required).
2. In `chrome://extensions` or `edge://extensions`, enable Developer mode, choose **Load unpacked**, and select this repository's `extension` folder. Open extension **Details → Extension options**, and copy the displayed 32-character ID.
3. In desktop, choose **Browser extension**, paste that ID, and select **Pair this extension**. Only one extension ID is paired at a time; Chrome and Edge may be registered with the same ID. Re-pair explicitly if a profile/location change changes the ID.
4. Build/register the debug native connector using the commands in the [native connector guide](src-tauri/README.md). Desktop pairing also displays fully quoted build/register/unregister commands. Registration is an explicit per-user Windows registry operation; the application never silently registers a native host. Neither administrator access nor machine-wide installation is required.
5. Enable the connector in extension options and select **Test connection / retry pending**. A successful catalog response confirms the paired desktop connection. Save a test page and check desktop; it refreshes external saves within approximately two seconds. Browser preview cannot pair and cannot access desktop SQLite.

### Offline, duplicates and privacy

- Pending saves are durably stored **before** sending. While the browser is open, an alarm retries once per minute, and options provide manual retry/removal. Queued does **not** mean saved. A red queue count/rejected entry needs attention; invalid metadata or deleted collections are not silently discarded. Remove and recapture to change their values. Queue capacity is 500; uninstalling/clearing extension storage destroys pending saves.
- Desktop checks normalized URLs (ignoring fragments, retaining query strings and HTTP versus HTTPS). Already-saved saves do not overwrite existing title/tags/memberships. Persistent request receipts and transactional inserts prevent duplicates after lost acknowledgements, including retries after a saved item moves to Trash. Saving a *new* request for a URL that exists only in Trash creates a new active item, not an implicit restore.
- Native messaging has an exact extension-origin allowlist and explicit desktop pairing. A private authenticated loopback **binary** transport connects the host to the running desktop; there is no HTTP server or unauthenticated save endpoint. The connector never opens/writes SQLite independently. Shared locking, atomic revision checks, incremental writes, and live refresh prevent stale UI snapshots overwriting extension saves; external refresh clears session Undo.
- Permissions: `activeTab`, `contextMenus`, `storage`, `nativeMessaging`, and `alarms` (offline retries). No `tabs`, `bookmarks`, host permissions, content scripts, automatic browser bookmark sync, or third-party favicon service. The popup uses `chrome.tabs.query` under the temporary `activeTab` grant, not the broad tabs permission.
- A captured favicon is the browser-provided HTTP/S address, not a screenshot or third-party proxy. Desktop displays it directly; this can contact its original host. Missing/blocked icons fall back to existing local metadata behavior. Captured icon addresses are stored separately from version-1 JSON backups and can be recaptured. Page URLs/metadata are validated again by the desktop (bounded HTTP/S URLs without credentials, bounded title/tags, valid memberships).
- Revoking pairing in desktop disables connector access. Disable retries in extension options to pause its queue. Unregister native hosts using the native guide; disabling does not remove existing bookmarks.

### Manual browser acceptance check

After setup, open an HTTP/S page, select collection/tags in the popup, save, and verify its title/icon and memberships in desktop. Save the same URL again and confirm there is one active item. Stop desktop, save a second page (the popup must say **Queued locally**), restart desktop, retry from options, and confirm one insertion and an empty queue. Test the page right-click action, then revoke pairing and confirm new requests cannot reach desktop. Repeat in Edge with its own extension ID/registration if different. Do not treat a queued status as a desktop acknowledgement.

Chrome/Edge browser installation and real browser-to-native-host behavior require this manual check in the target browser/profile; automated transport tests do not constitute that verification.

## Validate and build

```powershell
npm test
npm run lint
npm run build
cargo test --manifest-path src-tauri\Cargo.toml
cargo build --manifest-path src-tauri\Cargo.toml --bin bookmark-desk-connector
# Optional release packaging (not needed for extension development):
npm run tauri -- build --no-bundle
```

The last command creates a Windows executable without an installer. Use `npm run tauri -- build` to generate configured installers. See [desktop backend documentation](src-tauri/README.md) for storage details.
