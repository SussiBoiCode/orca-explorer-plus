# Explorer+ for Orca

A file explorer panel for [Orca](https://github.com/stablyai/orca) that you can sort by **name**,
**date created** or **date modified**, ascending or descending, with a **Show Only This Folder**
focus mode for workspaces that hold several projects.

Orca's plugin API cannot change the order of Orca's built-in explorer, so Explorer+ is its own
panel in the right sidebar. It follows the workspace you have focused, looks like the built-in
explorer, and does the same file work.

## What it does

- **Sort** (⇅ in the header): Name, Date Created or Date Modified, Ascending or Descending.
  Folders stay on top and both groups follow the sort. Name sort is natural and
  case-insensitive (`file2` before `file10`), like Orca's. The choice is kept across restarts and
  applies to every folder and workspace.
- **Show Only This Folder** (right-click a folder): the tree shows just that folder. A breadcrumb
  bar takes you back: click any part, ← goes up one level, ✕ shows the full tree. Each workspace
  remembers its focus, and its open folders, across restarts.
- **Files**: click to open in Orca's editor; **New File / New Folder** (+ in the header, or
  right-click); **Rename** (Enter or F2); **Delete** (Del) moves to the Recycle Bin / Trash without
  asking, like Orca's explorer, and offers a permanent delete only if that fails; **Reveal in
  File Explorer**; **Copy Path / Copy Relative Path**.
- **Multi-select** with Ctrl/Cmd-click and Shift-click, **drag and drop** to move (onto a folder,
  or a file to use its folder), and a **filter box** that searches the whole tree by name.
- **Live**: files that agents create, change or delete show up within about a second.
- Hidden like Orca's explorer: `.git` and `node_modules`. Dotfiles and git-ignored files show.
- Fast on big repos: folders load when you open them and only visible rows are drawn
  (a 12,000-file folder opens in well under a second).

Keyboard (tree focused): ↑ ↓ Home End PgUp PgDn move, Shift extends the selection, → opens a
folder, ← closes it or goes to the parent, Space opens a file or toggles a folder, Enter/F2
renames, Del deletes, Ctrl/Cmd+A selects all, Esc clears the selection.

## Install

Needs Orca 1.4.248 or newer, on the desktop app.

1. Orca **Settings → Plugins** (click **Turn on plugins** if asked).
2. **Add plugin → From a Git URL…** and enter
   `https://github.com/SussiBoiCode/orca-explorer-plus.git`.
3. Review the access it asks for and approve it.
4. Open **Explorer+** from the right sidebar's activity bar (the folder icon).

Git-URL installs don't update by themselves: to update, use the plugin's **Update** in Settings →
Plugins.

### Access it asks for

Explorer+ runs a small worker (`src/worker.ts`) on your computer because a panel cannot touch
the disk. It asks for:

- `workspace:read`: which workspace is focused, so the tree follows it.
- `workspace:write`: opening files in Orca's editor.

The worker reads and changes files only inside the focused workspace's folder; every path is
checked to stay inside it. It also runs Orca's own CLI (`orca terminal show`) to tell apart
workspaces that share a name, and the OS tools for the Recycle Bin and Reveal in File Explorer.
Nothing is sent over the network.

## Limits

- Local workspaces only; SSH and remote hosts are not shown.
- When several workspaces share a name and branch and the focused one has no terminal open,
  Orca does not say which one is focused, so Explorer+ asks you to pick.
- Some file systems record no creation time; those entries sort by their change time instead.

## Develop

```sh
orca plugin validate .
orca plugin dev load .          # prints an --approve fingerprint the first time
node tools/harness.mjs <folder> # the panel in a normal browser against the real worker
npm install && npm run test:e2e # end-to-end tests in headless Edge (BROWSER_CHANNEL=chrome for Chrome)
```

`panel/icons.js` is generated from Orca's own file-type icon tables by `tools/build-icons.mjs` so the
icons match the built-in explorer.

## License

MIT. The bundled Geist font is under the SIL Open Font License and the icon shapes come from
lucide (ISC); see `LICENSE`.
