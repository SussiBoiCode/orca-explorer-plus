# Explorer+ working notes

Read this first when picking the project up again.

## What and why (decided 2026-11-09)

- The user wanted Orca's explorer sortable by date created (asc/desc). The plugin API cannot touch
  the built-in explorer (plugins add panels, editors, commands, themes, icon themes only), so the
  user chose **a plugin with its own explorer panel**, over a PR to Orca or a patched app.asar.
- Repo: public `SussiBoiCode/orca-explorer-plus`, installed via Settings → Plugins → Add plugin →
  From a Git URL. Not submitted to the community catalog (user did not ask).
- Spec the user confirmed: panel name "Explorer+"; follows the focused workspace; sort via one ⇅
  icon menu (Name / Date Created / Date Modified + Ascending / Descending), one global sort kept
  across restarts; folders first, files and folders both follow the sort; no date column; click
  opens file, expand/collapse, Reveal in File Explorer, new/rename/delete; multi-select, drag &
  drop move, filter box; hidden files same as built-in (.git and node_modules only); delete and
  refresh "same as built-in" (local delete = Recycle Bin, no confirm, live refresh); right-click
  "Show Only This Folder" with a breadcrumb bar (crumbs clickable, ← up one level, ✕ full tree),
  focus kept per workspace; expanded folders remembered; must look native; must be fast on big
  repos.
- Fixes asked 2026-11-12: use Orca's selected app font (live); Reveal was broken; Alt+click =
  select + reveal (no open/toggle); OS drops copy in. Clash choices the user picked: Keep both
  (asks the name, 'name copy.ext' pre-filled), Replace, Skip, + "do this for the rest" when
  several clash (keep-both-for-all names them itself); progress toast.

## How it works

- `orca-plugin.json`: trusted-worker, panel `panel/index.html` (HTML frame, not a components
  panel: components panels have no right-click, drag & drop or inline inputs).
- `src/worker.ts`: all disk work, path-checked against the workspace root. Handlers: ws.resolve,
  ws.list, fs.list (paged compact rows, 1 MiB answer cap), fs.search, fs.create, fs.rename,
  fs.move, fs.trash (PowerShell VisualBasic SendToRecycleBin on Windows), fs.deletePermanently,
  fs.reveal, editor.open (Orca wants a RELATIVE path), app.font, fs.conflicts / fs.freeName /
  fs.mkdir / fs.write (OS drops), watch.ping (recursive fs.watch, posts
  fs.changed; panel pings every 20 s, idle watches stop after 90 s).
- Workspace resolution: `workspace.readContext` gives only displayName/branch/terminal ids, and
  names collide (several "master"). The worker maps a terminal id to its folder with Orca's CLI
  (`<resourcesPath>/bin/orca.exe terminal show --terminal <id> --json`). The worker env lacks
  APPDATA, so `cliEnv()` supplies it. Fallback: name+branch, else the panel shows a picker.
- `panel/app.js`: virtualized rows (24 px), slots keyed by path and only patched when their HTML
  changes (rebuilding rows lost clicks during watcher refreshes), DOM order kept = screen order.
  State in localStorage: `xp:sort`, `xp:expanded:<ws path>`, `xp:focus:<ws path>`.
- Look: values copied from Orca's FileExplorerRow/Toolbar/context-menu source and CSS. The frame
  does not get `--sidebar`; `--panel-bg` = card (dark) / card+2% fg (light) matches the default
  theme (#171717 / #fafafa). Geist font bundled (Orca's default); the font chosen in Orca's
  settings overrides it via `--app-font` (see Gotchas).

## Gotchas found the hard way

- Reveal on Windows: run()'s `windowsHide` reaches explorer.exe, which then opens its window
  HIDDEN (looked like nothing happened). And Node's quoting `"/select,C:\a b"` makes Explorer open
  Documents. Fix: spawn without windowsHide, `/select,"<path>"` with windowsVerbatimArguments.
- Font: frames get no font from Orca. The worker reads `appFontFamily` from
  `%APPDATA%/orca/profiles/<activeProfileId>/profile-state.db` (table profile_state_documents,
  domain 'settings') with node:sqlite (works in the worker), raw-scan fallback. The panel builds
  Orca's stack (app-font-family.ts: family, Geist, -apple-system, BlinkMacSystemFont, Segoe UI,
  sans-serif), polls every 5 s + on focus, caches the last one in `xp:font`.
- OS drops: the frame cannot get a dropped file's disk path, so the panel reads files (folders
  via webkitGetAsEntry) and sends 512 KiB base64 chunks to fs.write. Replace copies under a
  temp name first, then trashes the old item and renames, so dropping a file onto its own folder
  works and a failed copy loses nothing.

## Testing

- `node tools/harness.mjs <folder>` serves the panel with a mock `window.orca` wired to the real
  worker. `tests/e2e.mjs` (playwright-core, Edge) covers 80 checks: sorts, persistence, focus,
  new/rename/conflict, drag & drop, filter, live refresh, delete, keyboard, app font, Alt+click
  (harness `--record-reveal`), OS drops (synthetic DataTransfer + stand-in folder entries, all
  clash paths), 12k-file folder.
- In real Orca: `orca plugin dev load . --approve <fp>`, `orca plugin dev request . <handler>`,
  `orca plugin shot local.explorer-plus [--window]`.
- `orca plugin types` is broken in Orca 1.4.251 (the .d.ts files are not shipped); typings for
  `tsc` were copied from the Orca source tag v1.4.251 (`resources/plugins/{declarative,types}`).
