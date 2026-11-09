// Explorer+ worker: the panel's file system access. Runs as a Node process on the Orca host.
// Every path the panel sends is relative to the workspace root ('' is the root itself, '/' separated)
// and is checked to stay inside that root before anything touches the disk.
import type { OrcaWorkerApi } from 'orca/worker'
import { promises as fs, watch, type FSWatcher, type Dirent } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'

/** Always hidden, as in Orca's own explorer. */
const ALWAYS_HIDDEN = new Set(['.git', 'node_modules'])
const SEARCH_LIMIT = 2000
const SEARCH_BUDGET_MS = 4000
const WATCH_IDLE_MS = 90_000
const CHANGE_DEBOUNCE_MS = 150
/** Entries per fs.list answer; at ~60 bytes each this stays well under the 1 MiB answer cap. */
const LIST_PAGE = 5000

type Entry = {
  name: string
  dir: boolean
  link: boolean
  created: number
  modified: number
}

class PluginError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function fail(message: string, code = 'action_failed'): never {
  throw new PluginError(code, message)
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    fail(`${field} must be a string`, 'invalid_params')
  }
  return value
}

function strList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(`${field} must be a list of strings`, 'invalid_params')
  }
  return value as string[]
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Absolute path of `rel` inside `root`; refuses anything that escapes it. */
function inside(root: string, rel: string): string {
  if (!path.isAbsolute(root)) {
    fail('workspace root must be absolute', 'invalid_params')
  }
  const base = path.resolve(root)
  const abs = path.resolve(base, ...rel.split('/').filter(Boolean))
  const back = path.relative(base, abs)
  if (back.startsWith('..') || path.isAbsolute(back)) {
    fail(`path escapes the workspace: ${rel}`, 'invalid_params')
  }
  return abs
}

function toRel(root: string, abs: string): string {
  return path.relative(path.resolve(root), abs).split(path.sep).join('/')
}

function validName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    fail('A file or folder name must be provided.', 'invalid_params')
  }
  if (/[\\/]/.test(trimmed)) {
    fail('A name cannot contain / or \\.', 'invalid_params')
  }
  if (process.platform === 'win32' && /[<>:"|?*\x00-\x1f]/.test(trimmed)) {
    fail('A name cannot contain < > : " | ? or *.', 'invalid_params')
  }
  return trimmed
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs)
    return true
  } catch {
    return false
  }
}

async function listDir(root: string, rel: string): Promise<Entry[]> {
  const abs = inside(root, rel)
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  const visible = dirents.filter((d) => !ALWAYS_HIDDEN.has(d.name))
  const entries: Entry[] = []
  // Bounded concurrency keeps huge folders from opening thousands of handles at once.
  const queue = visible.slice()
  async function next(): Promise<void> {
    for (let d = queue.shift(); d; d = queue.shift()) {
      // null: it vanished between readdir and stat, so it is skipped.
      const entry = await statEntry(path.join(abs, d.name))
      if (entry) {
        entries.push(entry)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(32, queue.length) }, next))
  return entries
}

async function statEntry(abs: string): Promise<Entry | null> {
  try {
    const lst = await fs.lstat(abs)
    let st = lst
    let isDir = lst.isDirectory()
    if (lst.isSymbolicLink()) {
      try {
        st = await fs.stat(abs)
        isDir = st.isDirectory()
      } catch {
        // A broken link shows as a file.
      }
    }
    return {
      name: path.basename(abs),
      dir: isDir,
      link: lst.isSymbolicLink(),
      // Some file systems report no birth time (0); fall back to the change time.
      created: st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs,
      modified: st.mtimeMs
    }
  } catch {
    return null
  }
}

type SearchItem = Entry & { path: string; match: boolean }

/** Matches under `base` plus every folder between `base` and them, each with its dates, so the
 *  panel can draw and sort the filtered tree without listing those folders itself. */
async function searchTree(root: string, base: string, query: string): Promise<{ items: SearchItem[]; truncated: boolean }> {
  const { paths, truncated } = await search(root, base, query)
  const matches = new Set(paths)
  const all = new Set<string>(paths)
  const baseParts = base.split('/').filter(Boolean).length
  for (const rel of paths) {
    const parts = rel.split('/')
    for (let i = parts.length - 1; i > baseParts; i--) {
      all.add(parts.slice(0, i).join('/'))
    }
  }
  const list = [...all]
  const items: SearchItem[] = []
  const queue = list.slice()
  async function next(): Promise<void> {
    for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
      const entry = await statEntry(inside(root, rel))
      if (entry) {
        items.push({ ...entry, path: rel, match: matches.has(rel) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(32, queue.length) }, next))
  return { items, truncated }
}

/** Every path under `base` whose name contains `query` (case-insensitive), breadth first. */
async function search(root: string, base: string, query: string): Promise<{ paths: string[]; truncated: boolean }> {
  const needle = query.toLowerCase()
  const start = Date.now()
  const found: string[] = []
  let frontier = [inside(root, base)]
  while (frontier.length) {
    const nextFrontier: string[] = []
    for (const dir of frontier) {
      if (Date.now() - start > SEARCH_BUDGET_MS || found.length >= SEARCH_LIMIT) {
        return { paths: found, truncated: true }
      }
      let dirents: Dirent[]
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const d of dirents) {
        if (ALWAYS_HIDDEN.has(d.name)) {
          continue
        }
        const full = path.join(dir, d.name)
        if (d.name.toLowerCase().includes(needle)) {
          found.push(toRel(root, full))
          if (found.length >= SEARCH_LIMIT) {
            return { paths: found, truncated: true }
          }
        }
        if (d.isDirectory()) {
          nextFrontier.push(full)
        }
      }
    }
    frontier = nextFrontier
  }
  return { paths: found, truncated: false }
}

function run(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
  timeout = 0
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 4 * 1024 * 1024, timeout },
      (error, stdout, stderr) => {
        // A non-zero exit puts the exit code on error.code; a spawn failure puts a string there.
        const exit = (error as { code?: unknown } | null)?.code
        const code = error ? (typeof exit === 'number' ? exit : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

/** Moves each path to the OS trash. Returns the paths that could not be trashed. */
async function trash(paths: string[]): Promise<{ failed: { path: string; error: string }[] }> {
  if (paths.length === 0) {
    return { failed: [] }
  }
  if (process.platform === 'win32') {
    // One PowerShell for the whole batch; paths travel as JSON in an env var, never in the script.
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName Microsoft.VisualBasic',
      '$paths = $env:EXPLORER_PLUS_PATHS | ConvertFrom-Json',
      '$failed = @()',
      'foreach ($p in $paths) {',
      '  try {',
      '    if (Test-Path -LiteralPath $p -PathType Container) {',
      "      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
      '    } else {',
      "      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
      '    }',
      '  } catch { $failed += @{ path = $p; error = $_.Exception.Message } }',
      '}',
      'ConvertTo-Json -InputObject @($failed) -Compress'
    ].join('\n')
    const result = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { EXPLORER_PLUS_PATHS: JSON.stringify(paths) }
    )
    try {
      const parsed = JSON.parse(result.stdout.trim() || '[]')
      const list = Array.isArray(parsed) ? parsed : [parsed]
      return { failed: list.filter(Boolean).map((f: { path: string; error: string }) => ({ path: f.path, error: f.error })) }
    } catch {
      return { failed: paths.map((p) => ({ path: p, error: result.stderr.trim() || 'Recycle Bin is unavailable' })) }
    }
  }
  const failed: { path: string; error: string }[] = []
  for (const p of paths) {
    const result =
      process.platform === 'darwin'
        ? await run('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', '-e', 'end run', p])
        : await run('gio', ['trash', p])
    if (result.code !== 0) {
      failed.push({ path: p, error: result.stderr.trim() || 'Trash is unavailable' })
    }
  }
  return { failed }
}

async function reveal(abs: string): Promise<void> {
  if (process.platform === 'win32') {
    // explorer.exe exits 1 even when it worked, so the result is not checked.
    await run('explorer.exe', [`/select,${abs}`])
  } else if (process.platform === 'darwin') {
    await run('open', ['-R', abs])
  } else {
    await run('xdg-open', [path.dirname(abs)])
  }
}

async function moveOne(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error
    }
    await fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false })
    await fs.rm(src, { recursive: true, force: true })
  }
}

type HostWorkspace = {
  id: string
  name: string
  path: string
  kind: 'worktree' | 'folder'
  branch: string | null
  hostId: string | null
}

function publicWorkspace(w: HostWorkspace) {
  return { id: w.id, name: w.name, path: w.path, kind: w.kind, branch: w.branch }
}

function isLocalWorkspace(w: HostWorkspace): boolean {
  return w.hostId === null || w.hostId === 'local'
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const n = path.resolve(p).replace(/[\\/]+$/, '')
    return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n
  }
  return norm(a) === norm(b)
}

/** Orca's own CLI, shipped with the app; it answers which workspace a terminal belongs to. */
function orcaCli(): string {
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (resources) {
    return path.join(resources, 'bin', process.platform === 'win32' ? 'orca.exe' : 'orca')
  }
  return process.platform === 'win32' ? 'orca.exe' : 'orca'
}

/** Workers start with a trimmed environment; the CLI finds Orca's runtime through these. */
function cliEnv(): Record<string, string> {
  const home = os.homedir()
  const env: Record<string, string> = { HOME: process.env.HOME ?? home }
  if (process.platform === 'win32') {
    env.USERPROFILE = process.env.USERPROFILE ?? home
    env.APPDATA = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  }
  return env
}

const terminalFolders = new Map<string, string | null>()

async function terminalFolder(terminalId: string): Promise<string | null> {
  if (terminalFolders.has(terminalId)) {
    return terminalFolders.get(terminalId) ?? null
  }
  const result = await run(orcaCli(), ['terminal', 'show', '--terminal', terminalId, '--json'], cliEnv(), 8000)
  let folder: string | null = null
  try {
    const parsed = JSON.parse(result.stdout)
    const value = parsed?.result?.terminal?.worktreePath
    folder = typeof value === 'string' && value ? value : null
  } catch {
    folder = null
  }
  // Only successful answers are kept: a terminal never moves to another workspace.
  if (folder) {
    terminalFolders.set(terminalId, folder)
  }
  return folder
}

type WatchState = {
  watcher: FSWatcher | null
  lastPing: number
  pending: Set<string>
  timer: NodeJS.Timeout | null
}

export default function activate(orca: OrcaWorkerApi): void {
  const watches = new Map<string, WatchState>()

  function flush(root: string, state: WatchState): void {
    state.timer = null
    const dirs = [...state.pending]
    state.pending.clear()
    if (dirs.length) {
      orca.panels.post('fs.changed', { root, dirs: dirs.slice(0, 500), all: dirs.length > 500 })
    }
  }

  function startWatch(root: string): void {
    const existing = watches.get(root)
    if (existing) {
      existing.lastPing = Date.now()
      return
    }
    const state: WatchState = { watcher: null, lastPing: Date.now(), pending: new Set(), timer: null }
    watches.set(root, state)
    try {
      state.watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) {
          state.pending.add('')
        } else {
          const rel = String(filename).split(path.sep).join('/')
          const parts = rel.split('/')
          // Churn inside .git or node_modules never shows in the tree.
          if (parts.slice(0, -1).some((p) => ALWAYS_HIDDEN.has(p))) {
            return
          }
          state.pending.add(parts.slice(0, -1).join('/'))
          // A changed folder's own listing (its dates) may change too.
          state.pending.add(rel)
        }
        if (!state.timer) {
          state.timer = setTimeout(() => flush(root, state), CHANGE_DEBOUNCE_MS)
        }
      })
      state.watcher.on('error', (error) => {
        orca.log(`watch error on ${root}: ${error.message}`)
        stopWatch(root)
      })
    } catch (error) {
      orca.log(`cannot watch ${root}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function stopWatch(root: string): void {
    const state = watches.get(root)
    if (!state) {
      return
    }
    state.watcher?.close()
    if (state.timer) {
      clearTimeout(state.timer)
    }
    watches.delete(root)
  }

  // Watches nobody pings any more (panel closed or switched workspace) are dropped.
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [root, state] of watches) {
      if (now - state.lastPing > WATCH_IDLE_MS) {
        stopWatch(root)
      }
    }
  }, 30_000)
  sweeper.unref?.()

  // Orca's focus context names the workspace (often just its branch, so several can share it) and
  // lists its terminals. A terminal knows its workspace folder, so that settles which one it is;
  // name and branch are the fallback, and the panel asks when even they leave a tie.
  orca.panels.handle('ws.resolve', async (input) => {
    const { displayName, branch, terminalIds } = obj(input)
    const { workspaces } = await orca.host.call('workspace.list')
    const local = workspaces.filter(isLocalWorkspace)
    const ids = Array.isArray(terminalIds) ? terminalIds.filter((t): t is string => typeof t === 'string') : []
    for (const terminalId of ids.slice(0, 3)) {
      const folder = await terminalFolder(terminalId)
      const hit = folder ? local.find((w) => samePath(w.path, folder)) : undefined
      if (hit) {
        return { workspace: publicWorkspace(hit), candidates: [] }
      }
    }
    const byName = local.filter((w) => w.name === displayName)
    const byBoth = byName.filter((w) => (w.branch ?? '') === (typeof branch === 'string' ? branch : ''))
    const pool = byBoth.length ? byBoth : byName
    if (pool.length === 1) {
      return { workspace: publicWorkspace(pool[0]), candidates: [] }
    }
    if (pool.length === 0 && workspaces.some((w) => w.name === displayName && !isLocalWorkspace(w))) {
      return { workspace: null, candidates: [], remote: true }
    }
    return { workspace: null, candidates: pool.map(publicWorkspace) }
  })

  orca.panels.handle('ws.list', async () => {
    const { workspaces } = await orca.host.call('workspace.list')
    return workspaces.map(publicWorkspace)
  })

  // Listings go out as compact rows [name, flags, created, modified] (flags: 1 folder, 2 link),
  // in pages, because a panel answer is capped at 1 MiB. A huge folder's later pages come from
  // the listing taken for its first page.
  const pages = new Map<string, { entries: Entry[]; at: number }>()
  orca.panels.handle('fs.list', async (input) => {
    const { root, dir, offset } = obj(input)
    const r = str(root, 'root')
    const d = str(dir, 'dir')
    const start = typeof offset === 'number' && offset > 0 ? Math.floor(offset) : 0
    const key = `${r}\u0000${d}`
    let cached = start > 0 ? pages.get(key) : undefined
    if (!cached || Date.now() - cached.at > 60_000) {
      cached = { entries: await listDir(r, d), at: Date.now() }
    }
    const slice = cached.entries.slice(start, start + LIST_PAGE)
    const next = start + LIST_PAGE < cached.entries.length ? start + LIST_PAGE : null
    if (next === null) pages.delete(key)
    else pages.set(key, cached)
    return {
      e: slice.map((x) => [x.name, (x.dir ? 1 : 0) | (x.link ? 2 : 0), Math.round(x.created), Math.round(x.modified)]),
      next
    }
  })

  orca.panels.handle('fs.search', async (input) => {
    const { root, base, query } = obj(input)
    const q = str(query, 'query').trim()
    if (!q) {
      return { items: [], truncated: false }
    }
    return searchTree(str(root, 'root'), str(base, 'base'), q)
  })

  orca.panels.handle('fs.create', async (input) => {
    const { root, dir, name, kind } = obj(input)
    const r = str(root, 'root')
    const clean = validName(str(name, 'name'))
    const parent = inside(r, str(dir, 'dir'))
    const target = path.join(parent, clean)
    inside(r, toRel(r, target))
    if (await exists(target)) {
      fail(`'${clean}' already exists here.`, 'conflict')
    }
    if (kind === 'folder') {
      await fs.mkdir(target)
    } else {
      await fs.writeFile(target, '', { flag: 'wx' })
    }
    return { path: toRel(r, target) }
  })

  orca.panels.handle('fs.rename', async (input) => {
    const { root, from, name } = obj(input)
    const r = str(root, 'root')
    const src = inside(r, str(from, 'from'))
    if (src === path.resolve(r)) {
      fail('The workspace root cannot be renamed here.', 'invalid_params')
    }
    const clean = validName(str(name, 'name'))
    const dest = path.join(path.dirname(src), clean)
    if (dest === src) {
      return { path: toRel(r, dest) }
    }
    // Case-only renames on case-insensitive disks point at the same file; allow them.
    const caseOnly = dest.toLowerCase() === src.toLowerCase()
    if (!caseOnly && (await exists(dest))) {
      fail(`'${clean}' already exists here.`, 'conflict')
    }
    await fs.rename(src, dest)
    return { path: toRel(r, dest) }
  })

  orca.panels.handle('fs.move', async (input) => {
    const { root, paths, destDir } = obj(input)
    const r = str(root, 'root')
    const destAbs = inside(r, str(destDir, 'destDir'))
    const moved: { from: string; to: string }[] = []
    const failed: { path: string; error: string }[] = []
    for (const rel of strList(paths, 'paths')) {
      const src = inside(r, rel)
      const dest = path.join(destAbs, path.basename(src))
      const name = path.basename(src)
      if (path.dirname(src) === destAbs) {
        continue
      }
      const intoSelf = path.relative(src, destAbs)
      if (!intoSelf.startsWith('..') && !path.isAbsolute(intoSelf)) {
        failed.push({ path: rel, error: `Cannot move '${name}' into itself.` })
        continue
      }
      if (await exists(dest)) {
        failed.push({ path: rel, error: `'${name}' already exists in the destination.` })
        continue
      }
      try {
        await moveOne(src, dest)
        moved.push({ from: rel, to: toRel(r, dest) })
      } catch (error) {
        failed.push({ path: rel, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { moved, failed }
  })

  orca.panels.handle('fs.trash', async (input) => {
    const { root, paths } = obj(input)
    const r = str(root, 'root')
    const rels = strList(paths, 'paths')
    const abs = rels.map((rel) => inside(r, rel))
    if (abs.some((a) => a === path.resolve(r))) {
      fail('The workspace root cannot be deleted here.', 'invalid_params')
    }
    const { failed } = await trash(abs)
    return { failed: failed.map((f) => ({ path: toRel(r, f.path), error: f.error })) }
  })

  orca.panels.handle('fs.deletePermanently', async (input) => {
    const { root, paths } = obj(input)
    const r = str(root, 'root')
    const failed: { path: string; error: string }[] = []
    for (const rel of strList(paths, 'paths')) {
      const abs = inside(r, rel)
      if (abs === path.resolve(r)) {
        failed.push({ path: rel, error: 'The workspace root cannot be deleted here.' })
        continue
      }
      try {
        await fs.rm(abs, { recursive: true, force: true })
      } catch (error) {
        failed.push({ path: rel, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { failed }
  })

  orca.panels.handle('fs.reveal', async (input) => {
    const { root, path: rel } = obj(input)
    await reveal(inside(str(root, 'root'), str(rel, 'path')))
    return { ok: true }
  })

  orca.panels.handle('editor.open', async (input) => {
    const { workspaceId, root, path: rel } = obj(input)
    const r = str(root, 'root')
    // Orca takes the path relative to the workspace, '/' separated.
    const relPath = toRel(r, inside(r, str(rel, 'path')))
    await orca.host.call('editor.open', { workspaceId: str(workspaceId, 'workspaceId'), path: relPath })
    return { ok: true }
  })

  orca.panels.handle('watch.ping', async (input) => {
    const { root } = obj(input)
    // Keyed by the root exactly as the panel sent it, so its fs.changed posts match.
    const r = str(root, 'root')
    inside(r, '')
    startWatch(r)
    return { watching: Boolean(watches.get(r)?.watcher) }
  })
}

export function deactivate(): void {}
