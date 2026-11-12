// Explorer+ panel. Draws a virtualized file tree for the focused Orca workspace, sorted by name,
// date created or date modified, with a "show only this folder" focus. All disk access goes
// through the plugin's own worker (src/worker.ts) via orca.plugin.request.
import { ICONS, FILE_ICON_BY_EXTENSION, FILE_ICON_BY_NAME, COMPOUND_EXTENSIONS } from './icons.js'

const orca = window.orca
const ROW_H = 24
const OVERSCAN = 12
const PING_MS = 20_000
const DRAG_MIME = 'application/x-explorer-plus'
const IS_MAC = navigator.userAgent.includes('Mac')
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

// ---------- storage (per viewer, per plugin; survives restarts) ----------

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage unavailable: the setting just lasts for this run.
  }
}

// ---------- state ----------

const SORT_KEYS = ['name', 'created', 'modified']
const savedSort = load('xp:sort', null)
const state = {
  ws: null, // { id, name, path }
  status: 'loading', // loading | ready | none | error
  statusText: '',
  sort:
    savedSort && SORT_KEYS.includes(savedSort.key) && (savedSort.dir === 'asc' || savedSort.dir === 'desc')
      ? savedSort
      : { key: 'name', dir: 'asc' },
  expanded: new Set(),
  focus: '',
  cache: new Map(), // dir rel -> { entries, sorted, sortSig, loading, error }
  inflight: new Map(),
  selection: new Set(),
  anchor: null,
  cursor: null,
  filter: '',
  filterSeq: 0,
  filterResult: null, // { items: Map<rel, item>, children: Map<rel, item[]>, truncated }
  filterLoading: false,
  inline: null, // { mode: 'new'|'rename', kind: 'file'|'folder', dir, path, depth, error }
  rows: [],
  rowIndex: new Map(), // path -> index in rows
  candidates: [], // workspaces to pick from when Orca's context is ambiguous
  drag: null // { paths, overDir, hoverPath, hoverTimer }
}

// ---------- helpers ----------

function icon(name, extraClass = '') {
  const body = ICONS[name] ?? ICONS.File
  return `<svg class="icon ${extraClass}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function parentOf(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

function baseName(rel) {
  return rel.slice(rel.lastIndexOf('/') + 1)
}

function join(dir, name) {
  return dir ? `${dir}/${name}` : name
}

function isUnder(rel, dir) {
  return dir === '' ? rel !== '' : rel.startsWith(`${dir}/`)
}

function fileIconName(name) {
  const lower = name.toLowerCase()
  if (Object.hasOwn(FILE_ICON_BY_NAME, lower)) {
    return FILE_ICON_BY_NAME[lower]
  }
  if (lower === '.env' || lower.startsWith('.env.')) return 'FileLock'
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'FileCog'
  if (lower === 'makefile' || lower.startsWith('makefile.')) return 'FileTerminal'
  const compound = COMPOUND_EXTENSIONS.find((ext) => lower.endsWith(`.${ext}`))
  let ext = compound ?? ''
  if (!ext) {
    const dot = name.lastIndexOf('.')
    ext = dot <= 0 || dot === name.length - 1 ? '' : lower.slice(dot + 1)
  }
  return Object.hasOwn(FILE_ICON_BY_EXTENSION, ext) ? FILE_ICON_BY_EXTENSION[ext] : 'File'
}

/** The workspace folder's own name, which Orca's explorer shows as its title. */
function folderName(p) {
  const trimmed = p.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || trimmed
}

function isWindowsPath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

function absPath(rel) {
  const root = state.ws.path
  if (!rel) return root
  const sep = isWindowsPath(root) ? '\\' : '/'
  const trimmed = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root
  return trimmed + sep + rel.split('/').join(sep)
}

function trashName() {
  return isWindowsPath(state.ws?.path ?? '') ? 'Recycle Bin' : 'Trash'
}

async function request(name, input, timeoutMs = 30_000) {
  return orca.plugin.request(name, input, { timeoutMs })
}

function errorText(error) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
}

// ---------- persistence per workspace ----------

function wsKey(suffix) {
  return `xp:${suffix}:${state.ws.path}`
}

function saveExpanded() {
  if (state.ws) save(wsKey('expanded'), [...state.expanded])
}

function saveFocus() {
  if (state.ws) save(wsKey('focus'), state.focus)
}

// ---------- sorting ----------

function sortSig() {
  return `${state.sort.key}:${state.sort.dir}`
}

function compareEntries(a, b) {
  if (a.dir !== b.dir) return a.dir ? -1 : 1
  const m = state.sort.dir === 'asc' ? 1 : -1
  if (state.sort.key === 'name') {
    return m * collator.compare(a.name, b.name) || m * (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  }
  const field = state.sort.key === 'created' ? 'created' : 'modified'
  return m * (a[field] - b[field]) || collator.compare(a.name, b.name)
}

function sortedChildren(dir) {
  const entry = state.cache.get(dir)
  if (!entry || !entry.entries) return null
  if (entry.sortSig !== sortSig()) {
    entry.sorted = entry.entries.slice().sort(compareEntries)
    entry.sortSig = sortSig()
  }
  return entry.sorted
}

// ---------- loading ----------

function loadDir(dir, { force = false } = {}) {
  if (!state.ws) return Promise.resolve()
  const existing = state.cache.get(dir)
  if (!force && existing && (existing.entries || existing.loading)) {
    return state.inflight.get(dir) ?? Promise.resolve()
  }
  const root = state.ws.path
  const entry = existing ?? { entries: null, sorted: null, sortSig: '', loading: false, error: null }
  entry.loading = !entry.entries
  state.cache.set(dir, entry)
  const promise = listAll(root, dir)
    .then((entries) => {
      if (!state.ws || state.ws.path !== root) return
      entry.entries = entries
      entry.sortSig = ''
      entry.error = null
      pruneMissing(dir, entries)
    })
    .catch((error) => {
      if (!state.ws || state.ws.path !== root) return
      entry.entries = null
      entry.error = errorText(error)
      if (dir === state.focus && dir !== '') {
        // The focused folder is gone (deleted or renamed outside): fall back to the full tree.
        setFocus('')
      }
    })
    .finally(() => {
      entry.loading = false
      state.inflight.delete(dir)
      scheduleRender()
    })
  state.inflight.set(dir, promise)
  scheduleRender()
  return promise
}

/** A folder's whole listing; the worker sends big folders in pages of compact rows. */
async function listAll(root, dir) {
  const entries = []
  let offset = 0
  for (;;) {
    const { e, next } = await request('fs.list', { root, dir, offset })
    for (const [name, flags, created, modified] of e) {
      entries.push({ name, dir: (flags & 1) !== 0, link: (flags & 2) !== 0, created, modified })
    }
    if (next === null || next === undefined) return entries
    offset = next
  }
}

/** Drops cached folders, expansions and selections under a folder's children that vanished. */
function pruneMissing(dir, entries) {
  const names = new Set(entries.map((e) => e.name))
  const dirNames = new Set(entries.filter((e) => e.dir).map((e) => e.name))
  for (const key of [...state.cache.keys()]) {
    if (key !== dir && parentOf(key) === dir && !dirNames.has(baseName(key))) {
      for (const k of [...state.cache.keys()]) {
        if (k === key || isUnder(k, key)) state.cache.delete(k)
      }
    }
  }
  for (const sel of [...state.selection]) {
    if (parentOf(sel) === dir && !names.has(baseName(sel))) state.selection.delete(sel)
  }
}

function reloadAll() {
  for (const dir of [...state.cache.keys()]) {
    loadDir(dir, { force: true })
  }
  if (state.filter) runFilter()
}

// ---------- rows ----------

function buildRows() {
  const rows = []
  const base = state.focus
  const inline = state.inline
  const pushInlineNew = (dir, depth) => {
    if (inline && inline.mode === 'new' && inline.dir === dir) {
      rows.push({ type: 'inline', depth, kind: inline.kind, dir })
    }
  }
  const walk = (dir, depth) => {
    pushInlineNew(dir, depth)
    const filtered = state.filterResult
    let children
    if (filtered && !(filtered.items.get(dir)?.match)) {
      children = (filtered.children.get(dir) ?? []).slice().sort(compareEntries)
    } else {
      children = sortedChildren(dir)
      if (!children) {
        if (!state.cache.get(dir)) loadDir(dir)
        return
      }
    }
    for (const child of children) {
      const path = join(dir, child.name)
      const fromFilter = filtered && filtered.items.has(path) && !filtered.items.get(path).match
      const expanded = child.dir && (fromFilter ? true : state.expanded.has(path))
      const cached = state.cache.get(path)
      rows.push({
        type: 'node',
        path,
        name: child.name,
        dir: child.dir,
        link: child.link,
        depth,
        expanded,
        loading: Boolean(expanded && !fromFilter && cached?.loading),
        error: expanded && !fromFilter ? (cached?.error ?? null) : null,
        match: filtered ? Boolean(filtered.items.get(path)?.match) : false
      })
      if (expanded) walk(path, depth + 1)
    }
  }
  walk(base, 0)
  state.rows = rows
  state.rowIndex = new Map()
  rows.forEach((r, i) => r.type === 'node' && state.rowIndex.set(r.path, i))
}

// ---------- rendering ----------

const $ = (id) => document.getElementById(id)
const treeEl = $('tree')
const spacerEl = $('spacer')
const msgEl = $('tree-msg')
let renderQueued = false
let movingInline = false
let inlineInput = null

function scheduleRender() {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    render()
  })
}

/** Writes HTML only when it changed, so elements under the pointer survive re-renders. */
function setHtml(el, html) {
  if (el.__html !== html) {
    el.innerHTML = html
    el.__html = html
  }
}

function render() {
  renderChrome()
  if (state.status !== 'ready') {
    clearSlots()
    spacerEl.style.height = '0px'
    setHtml(msgEl, statusHtml())
    return
  }
  buildRows()
  renderRows()
}

function statusHtml() {
  if (state.status === 'loading') return '<div class="empty">Loading…</div>'
  if (state.status === 'none') {
    return '<div class="empty"><strong>No workspace</strong>Open a workspace in Orca to see its files here.</div>'
  }
  if (state.status === 'pick') {
    const items = state.candidates
      .map(
        (c, i) =>
          `<button class="menu-item pick" type="button" data-pick="${i}" title="${esc(c.path)}">${icon('Folder')}<span>${esc(c.path)}</span></button>`
      )
      .join('')
    return `<div class="empty"><strong>Which workspace is this?</strong>Several workspaces are named '${esc(
      state.candidates[0]?.name ?? ''
    )}'. Pick the one you have open.</div><div class="picks">${items}</div>`
  }
  return `<div class="empty"><strong>Can't show this workspace</strong>${esc(state.statusText)}</div>`
}

function renderChrome() {
  $('title').textContent = state.ws ? folderName(state.ws.path) : 'Explorer+'
  $('title').title = state.ws?.path ?? ''
  const sortLabel = { name: 'Name', created: 'Date Created', modified: 'Date Modified' }[state.sort.key]
  const btnSort = $('btn-sort')
  btnSort.title = `Sort: ${sortLabel}, ${state.sort.dir === 'asc' ? 'ascending' : 'descending'}`
  $('btn-collapse').setAttribute('aria-disabled', String(state.expanded.size === 0))
  $('filter-clear').hidden = !state.filter
  setHtml($('filter-busy'), state.filterLoading ? icon('Loader2', 'spin') : '')
  renderCrumbs()
}

function renderCrumbs() {
  const crumbs = $('crumbs')
  if (!state.ws || !state.focus) {
    crumbs.hidden = true
    return
  }
  crumbs.hidden = false
  const parts = state.focus.split('/')
  const html = [
    `<button class="crumb" data-crumb="" type="button" title="${esc(state.ws.path)}">${esc(folderName(state.ws.path))}</button>`
  ]
  parts.forEach((part, i) => {
    const rel = parts.slice(0, i + 1).join('/')
    const current = i === parts.length - 1
    html.push(`<span class="crumb-sep">›</span>`)
    html.push(
      `<button class="crumb${current ? ' current' : ''}" data-crumb="${esc(rel)}" type="button" title="${esc(rel)}">${esc(part)}</button>`
    )
  })
  setHtml($('crumb-list'), html.join(''))
}

// Visible rows keep their element (keyed by path) across renders: a click that lands while
// a watcher refresh re-renders still reaches the row it started on.
const slots = new Map() // key -> { el, html, cls, top, inline }
const INLINE_NEW_KEY = '\u0000new'

function clearSlots() {
  for (const s of slots.values()) s.el.remove()
  slots.clear()
  removeInlineError()
}

function renderRows() {
  const rows = state.rows
  spacerEl.style.height = `${rows.length * ROW_H}px`
  if (rows.length === 0) {
    clearSlots()
    const entry = state.cache.get(state.focus)
    let msg = ''
    if (state.filter) msg = state.filterLoading ? 'Searching…' : `No files match '${esc(state.filter)}'.`
    else if (entry?.loading || !entry) msg = 'Loading…'
    else if (entry?.error) msg = esc(entry.error)
    else msg = 'This folder is empty.'
    setHtml(msgEl, `<div class="empty">${msg}</div>`)
    return
  }
  setHtml(msgEl, '')
  const top = treeEl.scrollTop
  const height = treeEl.clientHeight || 600
  const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((top + height) / ROW_H) + OVERSCAN)
  const dropDir = state.drag?.overDir ?? null
  const seen = new Set()
  const ordered = []
  let inlineSlot = null
  for (let i = first; i < last; i++) {
    const row = rows[i]
    const isInline = row.type === 'inline' || (state.inline?.mode === 'rename' && row.path === state.inline.path)
    const key = row.type === 'inline' ? INLINE_NEW_KEY : row.path
    seen.add(key)
    let s = slots.get(key)
    if (!s) {
      const el = document.createElement('div')
      spacerEl.appendChild(el)
      s = { el, html: null, cls: null, top: -1, inline: false }
      slots.set(key, s)
    }
    ordered.push(s.el)
    const y = i * ROW_H
    if (s.top !== y) {
      s.el.style.top = `${y}px`
      s.top = y
    }
    const inDrop = dropDir !== null && dropDir !== state.focus && row.type === 'node' && (row.path === dropDir || isUnder(row.path, dropDir))
    const cls = `slot${inDrop ? ' drop' : ''}`
    if (s.cls !== cls) {
      s.el.className = cls
      s.cls = cls
    }
    if (isInline) {
      if (!s.inline) {
        s.el.textContent = ''
        s.html = null
        s.inline = true
        mountInline(s.el, row)
      }
      inlineSlot = s
    } else {
      const html = rowHtml(row)
      if (s.inline || s.html !== html) {
        s.el.innerHTML = html
        s.html = html
        s.inline = false
      }
    }
  }
  for (const [key, s] of slots) {
    if (!seen.has(key)) {
      s.el.remove()
      slots.delete(key)
    }
  }
  // Keep document order = screen order (screen readers, Tab), moving only what is out of place;
  // a moved element is the same node, so a click in progress still lands.
  const inlineFocused = inlineInput !== null && document.activeElement === inlineInput
  const selStart = inlineFocused ? inlineInput.selectionStart : null
  const selEnd = inlineFocused ? inlineInput.selectionEnd : null
  movingInline = true
  let cursorEl = spacerEl.firstElementChild
  for (const el of ordered) {
    while (cursorEl && !cursorEl.classList.contains('slot')) cursorEl = cursorEl.nextElementSibling
    if (cursorEl !== el) spacerEl.insertBefore(el, cursorEl)
    else cursorEl = cursorEl.nextElementSibling
  }
  movingInline = false
  if (inlineFocused && document.activeElement !== inlineInput) {
    // Moving the name box's row blurs it; give focus and the text cursor back.
    inlineInput.focus()
    if (selStart !== null) inlineInput.setSelectionRange(selStart, selEnd)
  }
  treeEl.classList.toggle('drop-root', dropDir === state.focus && state.drag !== null)
  renderInlineError(inlineSlot)
}

function rowHtml(row) {
  const pad = row.depth * 16 + 8
  const selected = state.selection.has(row.path)
  let lead
  if (row.dir) {
    const folderIcon = row.loading
      ? icon('Loader2', 'ficon spin')
      : row.error
        ? icon('CircleAlert', 'err')
        : icon(row.expanded ? 'FolderOpen' : 'Folder', 'ficon')
    lead = icon('ChevronRight', `chev${row.expanded ? ' open' : ''}`) + folderIcon
  } else {
    lead = `<span style="width:12px;flex-shrink:0"></span>${row.link ? icon('Link', 'ficon') : icon(fileIconName(row.name), 'ficon')}`
  }
  const note = row.error ? `<span class="note" title="${esc(row.error)}">${esc(row.error)}</span>` : ''
  return `<div class="row" role="treeitem" draggable="true" data-path="${esc(row.path)}"${
    selected ? ' data-selected="true" aria-selected="true"' : ''
  }${state.cursor === row.path ? ' data-cursor="true"' : ''}${row.dir ? ` aria-expanded="${row.expanded}"` : ''} style="padding-left:${pad}px" title="${esc(row.path)}">${lead}<span class="name">${esc(row.name)}</span>${note}</div>`
}

// ---------- inline new / rename ----------

/** Puts the inline name box in its slot. The input is created once per edit and moved, never
 *  rebuilt, so what the person typed and their cursor survive scrolling and re-renders. */
function mountInline(slot, row) {
  const inline = state.inline
  const kind = row.type === 'inline' ? row.kind : row.dir ? 'folder' : 'file'
  const fresh = !inlineInput
  if (fresh) {
    inlineInput = document.createElement('input')
    inlineInput.type = 'text'
    inlineInput.spellcheck = false
    inlineInput.autocomplete = 'off'
    inlineInput.setAttribute('aria-label', inline.mode === 'rename' ? 'New name' : kind === 'folder' ? 'Folder name' : 'File name')
    inlineInput.value = inline.mode === 'rename' ? row.name : ''
    inlineInput.addEventListener('keydown', onInlineKey)
    inlineInput.addEventListener('blur', onInlineBlur)
    inlineInput.addEventListener('input', () => {
      if (state.inline?.error) {
        state.inline.error = null
        renderInlineError(null)
      }
    })
  }
  const hadFocus = document.activeElement === inlineInput
  const selStart = inlineInput.selectionStart
  const selEnd = inlineInput.selectionEnd
  const wrap = document.createElement('div')
  wrap.className = 'row inline'
  wrap.style.paddingLeft = `${row.depth * 16 + 8}px`
  wrap.innerHTML =
    `<span style="width:12px;flex-shrink:0"></span>` +
    (kind === 'folder' ? icon('Folder', 'ficon') : icon(inline.mode === 'rename' ? fileIconName(row.name) : 'File', 'ficon'))
  movingInline = true
  wrap.appendChild(inlineInput)
  slot.appendChild(wrap)
  movingInline = false
  if (fresh) {
    inlineInput.focus()
    const dot = inlineInput.value.lastIndexOf('.')
    if (inline.mode === 'rename' && kind === 'file' && dot > 0) inlineInput.setSelectionRange(0, dot)
    else inlineInput.select()
  } else if (hadFocus || document.activeElement === document.body) {
    // Scrolled back into view: the input returns with its text and cursor.
    inlineInput.focus()
    if (selStart !== null) inlineInput.setSelectionRange(selStart, selEnd)
  }
}

function removeInlineError() {
  spacerEl.querySelector('.inline-error')?.remove()
}

function renderInlineError(slot) {
  const error = state.inline?.error ?? null
  inlineInput?.toggleAttribute('aria-invalid', Boolean(error))
  if (!error || !slot) {
    removeInlineError()
    return
  }
  let el = spacerEl.querySelector('.inline-error')
  if (!el) {
    el = document.createElement('div')
    el.className = 'inline-error'
    el.setAttribute('role', 'alert')
    spacerEl.appendChild(el)
  }
  el.style.top = `${slot.top + ROW_H}px`
  if (el.textContent !== error) el.textContent = error
}

function startInline(mode, opts) {
  cancelInline()
  if (mode === 'new') {
    const dir = opts.dir
    if (dir !== state.focus && !isUnder(dir, state.focus)) return
    if (dir) {
      state.expanded.add(dir)
      saveExpanded()
    }
    loadDir(dir)
    state.inline = { mode, kind: opts.kind, dir, path: null, error: null }
  } else {
    state.inline = { mode, kind: opts.dir ? 'folder' : 'file', dir: parentOf(opts.path), path: opts.path, error: null }
  }
  render()
  scrollInlineIntoView()
}

function scrollInlineIntoView() {
  const index = state.rows.findIndex(
    (r) => r.type === 'inline' || (state.inline?.mode === 'rename' && r.path === state.inline.path)
  )
  if (index >= 0) scrollRowIntoView(index)
  render()
}

function cancelInline() {
  if (!state.inline) return
  state.inline = null
  if (inlineInput) {
    const el = inlineInput
    inlineInput = null
    el.removeEventListener('blur', onInlineBlur)
    el.remove()
  }
  scheduleRender()
}

let committing = false
async function commitInline() {
  const inline = state.inline
  if (!inline || committing || !inlineInput) return
  const value = inlineInput.value.trim()
  const root = state.ws.path
  if (!value || (inline.mode === 'rename' && value === baseName(inline.path))) {
    cancelInline()
    treeEl.focus()
    return
  }
  committing = true
  try {
    if (inline.mode === 'new') {
      const { path } = await request('fs.create', { root, dir: inline.dir, name: value, kind: inline.kind })
      cancelInline()
      await loadDir(inline.dir, { force: true })
      selectOnly(path)
      revealPath(path)
      if (inline.kind === 'file') openFile(path)
      else treeEl.focus()
    } else {
      const { path } = await request('fs.rename', { root, from: inline.path, name: value })
      cancelInline()
      renamePaths(inline.path, path)
      await loadDir(parentOf(path), { force: true })
      selectOnly(path)
      revealPath(path)
      treeEl.focus()
    }
  } catch (error) {
    if (state.inline === inline) {
      inline.error = errorText(error)
      render()
    }
  } finally {
    committing = false
  }
}

function onInlineKey(event) {
  event.stopPropagation()
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault()
    commitInline()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancelInline()
    treeEl.focus()
  }
}

function onInlineBlur() {
  if (movingInline || committing) return
  // A blur from clicking elsewhere commits, like Orca's explorer; an empty name just cancels.
  setTimeout(() => {
    if (state.inline && document.activeElement !== inlineInput) commitInline()
  }, 0)
}

/** Keeps expansions, focus, selection and cache keys pointing at a renamed or moved path. */
function renamePaths(from, to) {
  const remap = (p) => (p === from ? to : isUnder(p, from) ? to + p.slice(from.length) : p)
  state.expanded = new Set([...state.expanded].map(remap))
  saveExpanded()
  if (state.focus && (state.focus === from || isUnder(state.focus, from))) {
    state.focus = remap(state.focus)
    saveFocus()
  }
  state.selection = new Set([...state.selection].map(remap))
  if (state.cursor) state.cursor = remap(state.cursor)
  if (state.anchor) state.anchor = remap(state.anchor)
  const moved = []
  for (const [k, v] of state.cache) {
    if (k === from || isUnder(k, from)) moved.push([k, v])
  }
  for (const [k, v] of moved) {
    state.cache.delete(k)
    state.cache.set(remap(k), v)
  }
}

// ---------- selection & navigation ----------

function selectOnly(path) {
  state.selection = new Set(path ? [path] : [])
  state.anchor = path
  state.cursor = path
  scheduleRender()
}

function revealPath(path) {
  // Expand every folder between the focus and the path, then scroll to it.
  let dir = parentOf(path)
  let changed = false
  while (dir && dir !== state.focus && isUnder(dir, state.focus)) {
    if (!state.expanded.has(dir)) {
      state.expanded.add(dir)
      changed = true
    }
    dir = parentOf(dir)
  }
  if (changed) saveExpanded()
  buildRows()
  const index = state.rows.findIndex((r) => r.path === path)
  if (index >= 0) scrollRowIntoView(index)
  scheduleRender()
}

function scrollRowIntoView(index) {
  const top = index * ROW_H
  const bottom = top + ROW_H
  if (top < treeEl.scrollTop) treeEl.scrollTop = top
  else if (bottom > treeEl.scrollTop + treeEl.clientHeight) treeEl.scrollTop = bottom - treeEl.clientHeight
}

function rowByPath(path) {
  const index = state.rowIndex.get(path)
  return index === undefined ? null : state.rows[index]
}

function toggleDir(path, open) {
  const isOpen = state.expanded.has(path)
  const next = open ?? !isOpen
  if (next === isOpen) return
  if (next) {
    state.expanded.add(path)
    loadDir(path)
  } else {
    state.expanded.delete(path)
  }
  saveExpanded()
  scheduleRender()
}

function rangeSelect(toPath, additive) {
  const nodes = state.rows.filter((r) => r.type === 'node')
  const a = nodes.findIndex((r) => r.path === state.anchor)
  const b = nodes.findIndex((r) => r.path === toPath)
  if (a < 0 || b < 0) {
    selectOnly(toPath)
    return
  }
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const range = nodes.slice(lo, hi + 1).map((r) => r.path)
  state.selection = additive ? new Set([...state.selection, ...range]) : new Set(range)
  state.cursor = toPath
  scheduleRender()
}

async function openFile(path) {
  try {
    await request('editor.open', { workspaceId: state.ws.id, root: state.ws.path, path })
  } catch (error) {
    toast(`Couldn't open '${baseName(path)}': ${errorText(error)}`, true)
  }
}

function setFocus(path) {
  state.focus = path
  saveFocus()
  if (state.filter) {
    state.filter = ''
    $('filter').value = ''
    state.filterResult = null
  }
  cancelInline()
  treeEl.scrollTop = 0
  if (path) {
    state.expanded.add(path)
    saveExpanded()
  }
  loadDir(path)
  render()
}

// ---------- mutations ----------

/** The selected paths a command should act on, outermost only (a selected folder covers its children). */
function actionPaths(path) {
  const paths = path && !state.selection.has(path) ? [path] : [...state.selection]
  return paths.filter((p) => !paths.some((q) => q !== p && isUnder(p, q)))
}

async function deletePaths(paths) {
  if (paths.length === 0) return
  const root = state.ws.path
  try {
    const { failed } = await request('fs.trash', { root, paths }, 120_000)
    afterRemoval(paths.filter((p) => !failed.some((f) => f.path === p)))
    for (const f of failed) {
      const ok = await confirmDialog({
        title: `Couldn't move '${baseName(f.path)}' to the ${trashName()}. Delete it permanently?`,
        body: `${f.error}\n\nThis cannot be undone.`,
        confirm: 'Delete Permanently'
      })
      if (ok) {
        const res = await request('fs.deletePermanently', { root, paths: [f.path] }, 120_000)
        if (res.failed.length) toast(`Failed to delete '${baseName(f.path)}': ${res.failed[0].error}`, true)
        else afterRemoval([f.path])
      }
    }
  } catch (error) {
    toast(`Failed to move to the ${trashName()}: ${errorText(error)}`, true)
  }
  for (const dir of new Set(paths.map(parentOf))) loadDir(dir, { force: true })
}

function afterRemoval(paths) {
  for (const p of paths) {
    for (const s of [...state.selection]) if (s === p || isUnder(s, p)) state.selection.delete(s)
    for (const e of [...state.expanded]) if (e === p || isUnder(e, p)) state.expanded.delete(e)
    for (const k of [...state.cache.keys()]) if (k === p || isUnder(k, p)) state.cache.delete(k)
    if (state.focus && (state.focus === p || isUnder(state.focus, p))) setFocus(parentOf(p))
  }
  saveExpanded()
  scheduleRender()
}

async function movePaths(paths, destDir) {
  const root = state.ws.path
  const valid = paths.filter((p) => parentOf(p) !== destDir && p !== destDir && !isUnder(destDir, p))
  if (valid.length === 0) return
  try {
    const { moved, failed } = await request('fs.move', { root, paths: valid, destDir }, 120_000)
    for (const m of moved) renamePaths(m.from, m.to)
    for (const f of failed) toast(f.error, true)
    const dirs = new Set([destDir, ...valid.map(parentOf)])
    await Promise.all([...dirs].map((d) => loadDir(d, { force: true })))
    if (moved.length) {
      if (destDir) {
        state.expanded.add(destDir)
        saveExpanded()
      }
      state.selection = new Set(moved.map((m) => m.to))
      state.cursor = moved[0].to
      state.anchor = moved[0].to
      revealPath(moved[0].to)
    }
  } catch (error) {
    toast(`Move failed: ${errorText(error)}`, true)
  }
}

// ---------- copying in files dropped from the OS ----------
// The frame never learns where a dropped file lives on disk, so each one is read here and sent to
// the worker in chunks. Folders come through the File System Entry API.

const CHUNK_BYTES = 512 * 1024 // ~700 KB as base64: well under the request cap
let importQueue = Promise.resolve()

/** The dropped top-level items: { name, entry } (a file or folder) or { name, file } (no entry API). */
function droppedItems(dataTransfer) {
  const items = []
  for (const item of dataTransfer.items ?? []) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry?.() ?? null
    if (entry) {
      items.push({ name: entry.name, dir: entry.isDirectory, entry })
    } else {
      const file = item.getAsFile()
      if (file) items.push({ name: file.name, dir: false, file })
    }
  }
  if (items.length === 0) {
    for (const file of dataTransfer.files ?? []) items.push({ name: file.name, dir: false, file })
  }
  return items
}

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function readAllEntries(dirEntry) {
  const reader = dirEntry.createReader()
  const all = []
  // readEntries hands back at most ~100 at a time; an empty batch means done.
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
    if (batch.length === 0) return all
    all.push(...batch)
  }
}

/** Flattens one dropped item into ordered steps: folders before what they hold. */
async function planItem(item, destRel, steps) {
  if (!item.entry) {
    steps.push({ kind: 'file', rel: destRel, file: item.file })
    return
  }
  if (item.entry.isFile) {
    steps.push({ kind: 'file', rel: destRel, file: await entryFile(item.entry) })
    return
  }
  steps.push({ kind: 'dir', rel: destRel })
  for (const child of await readAllEntries(item.entry)) {
    await planItem({ name: child.name, dir: child.isDirectory, entry: child }, join(destRel, child.name), steps)
  }
}

function blobBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'))
    reader.readAsDataURL(blob)
  })
}

/** A toast that stays up and can be rewritten; `close` removes it. */
function progressToast(message) {
  const el = document.createElement('div')
  el.className = 'toast progress'
  el.innerHTML = '<span class="toast-text"></span><span class="toast-bar"><span></span></span>'
  $('toasts').appendChild(el)
  const text = el.querySelector('.toast-text')
  const bar = el.querySelector('.toast-bar > span')
  const update = (msg, fraction) => {
    text.textContent = msg
    bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`
  }
  update(message, 0)
  return { update, close: () => el.remove() }
}

function importDropped(items, destDir) {
  importQueue = importQueue.then(() => runImport(items, destDir)).catch(() => {})
  return importQueue
}

async function runImport(items, destDir) {
  if (!state.ws) return
  const root = state.ws.path
  const ws = state.ws
  let names
  try {
    const { conflicts } = await request('fs.conflicts', { root, dir: destDir, names: items.map((i) => i.name) })
    names = new Map(conflicts.map((c) => [c.name, c]))
  } catch (error) {
    toast(`Copy failed: ${errorText(error)}`, true)
    return
  }

  // Settle every name clash first, so the copy then runs without stopping.
  const plan = [] // { item, name, replace }
  let applyAll = null // the choice made with "apply to all"
  const clashes = items.filter((i) => names.has(i.name)).length
  let clashIndex = 0
  for (const item of items) {
    const clash = names.get(item.name)
    if (!clash) {
      plan.push({ item, name: item.name, replace: false })
      continue
    }
    clashIndex++
    let choice = applyAll
    if (!choice) {
      const answer = await clashDialog({
        name: item.name,
        dir: item.dir,
        existingDir: clash.dir,
        folderLabel: destDir ? baseName(destDir) : state.ws.name,
        remaining: clashes - clashIndex
      })
      if (state.ws !== ws) return
      if (answer.cancel) return
      choice = answer.choice
      if (answer.all) applyAll = choice
    }
    if (choice === 'skip') continue
    if (choice === 'replace') {
      plan.push({ item, name: item.name, replace: true })
      continue
    }
    // Keep both: ask for the name, unless "apply to all" picks it.
    let free
    try {
      free = (await request('fs.freeName', { root, dir: destDir, name: item.name, isDir: item.dir })).name
    } catch (error) {
      toast(errorText(error), true)
      continue
    }
    if (applyAll) {
      plan.push({ item, name: free, replace: false })
      continue
    }
    const chosen = await nameDialog({ name: item.name, suggested: free, dir: item.dir, destDir })
    if (state.ws !== ws) return
    if (chosen === null) continue
    plan.push({ item, name: chosen, replace: false })
  }
  if (plan.length === 0) return

  const progress = progressToast('Preparing to copy…')
  const done = []
  try {
    // A replacement is copied under a temporary name first; only once it is complete does the old
    // item go to the Recycle Bin / Trash. So a failed copy loses nothing, and dropping a file onto
    // its own folder (source = the item being replaced) still works.
    const steps = []
    for (const p of plan) {
      p.top = join(destDir, p.replace ? `.${p.name}.explorer-plus-${Date.now().toString(36)}.tmp` : p.name)
      const start = steps.length
      try {
        await planItem(p.item, p.top, steps)
      } catch (error) {
        steps.length = start
        p.top = null
        toast(`Couldn't read '${p.item.name}': ${errorText(error)}`, true)
      }
    }
    const files = steps.filter((s) => s.kind === 'file')
    const totalBytes = files.reduce((n, s) => n + s.file.size, 0) || 1
    let sentBytes = 0
    let fileNo = 0
    const failedTops = new Set()
    for (const step of steps) {
      if (state.ws !== ws) throw new Error('the workspace changed')
      const top = plan.find((p) => p.top && (step.rel === p.top || isUnder(step.rel, p.top)))
      if (top && failedTops.has(top.top)) continue
      try {
        if (step.kind === 'dir') {
          await request('fs.mkdir', { root, path: step.rel })
          continue
        }
        fileNo++
        const file = step.file
        const label = `Copying ${fileNo} of ${files.length}: ${baseName(top && step.rel === top.top ? top.name : step.rel)}`
        progress.update(label, sentBytes / totalBytes)
        if (file.size === 0) {
          await request('fs.write', { root, path: step.rel, data: '', append: false })
        }
        for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
          const data = await blobBase64(file.slice(offset, offset + CHUNK_BYTES))
          try {
            await request('fs.write', { root, path: step.rel, data, append: offset > 0 }, 60_000)
          } catch (error) {
            // A half-written file is worse than none.
            if (offset > 0) await request('fs.deletePermanently', { root, paths: [step.rel] }).catch(() => {})
            throw error
          }
          sentBytes += Math.min(CHUNK_BYTES, file.size - offset)
          progress.update(label, sentBytes / totalBytes)
        }
      } catch (error) {
        toast(`Couldn't copy '${baseName(step.rel === top?.top ? top.name : step.rel)}': ${errorText(error)}`, true)
        // A replacement must arrive whole, or the old item stays.
        if (top && (step.rel === top.top || top.replace)) failedTops.add(top.top)
      }
    }
    for (const p of plan) {
      if (!p.top) continue
      if (failedTops.has(p.top)) {
        if (p.replace) await request('fs.deletePermanently', { root, paths: [p.top] }).catch(() => {})
        continue
      }
      if (p.replace) {
        const final = join(destDir, p.name)
        try {
          const { failed } = await request('fs.trash', { root, paths: [final] }, 120_000)
          if (failed.length) throw new Error(failed[0].error)
          await request('fs.rename', { root, from: p.top, name: p.name })
        } catch (error) {
          await request('fs.deletePermanently', { root, paths: [p.top] }).catch(() => {})
          toast(`Couldn't replace '${p.name}': ${errorText(error)}`, true)
          continue
        }
        done.push(final)
      } else {
        done.push(p.top)
      }
    }
  } catch (error) {
    toast(`Copy stopped: ${errorText(error)}`, true)
  } finally {
    progress.close()
  }
  if (state.ws !== ws || done.length === 0) return
  await loadDir(destDir, { force: true })
  if (destDir) {
    state.expanded.add(destDir)
    saveExpanded()
  }
  state.selection = new Set(done)
  state.cursor = done[0]
  state.anchor = done[0]
  revealPath(done[0])
  toast(done.length === 1 ? `Copied '${baseName(done[0])}'.` : `Copied ${done.length} items.`)
}

/** Replace / Keep both / Skip for one name clash. Resolves { choice, all } or { cancel: true }. */
function clashDialog({ name, dir, existingDir, folderLabel, remaining }) {
  return new Promise((resolve) => {
    const back = document.createElement('div')
    back.className = 'backdrop'
    const what = existingDir ? 'A folder' : 'A file'
    const replaceNote = `The existing ${existingDir ? 'folder' : 'file'} goes to the ${trashName()}.`
    back.innerHTML = `<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-b">
      <h2 id="dlg-t">${esc(`'${name}' already exists`)}</h2>
      <p id="dlg-b">${esc(`${what} with this name is already in '${folderLabel}'. ${replaceNote}`)}</p>
      ${remaining > 0 ? `<label class="check-row"><input type="checkbox" data-all /> <span>${esc(`Do this for the next ${remaining} clash${remaining === 1 ? '' : 'es'} too`)}</span></label>` : ''}
      <div class="actions stack"><button class="btn primary" data-a="keep" type="button">Keep both</button><button class="btn" data-a="replace" type="button">Replace</button><button class="btn" data-a="skip" type="button">Skip</button><button class="btn ghost" data-a="cancel" type="button">Cancel</button></div></div>`
    const done = (value) => {
      back.remove()
      treeEl.focus()
      resolve(value)
    }
    const all = () => Boolean(back.querySelector('[data-all]')?.checked)
    back.addEventListener('click', (event) => {
      const a = event.target.closest('[data-a]')?.dataset.a
      if (a === 'cancel' || event.target === back) done({ cancel: true })
      else if (a === 'skip') done({ choice: 'skip', all: all() })
      else if (a === 'keep') done({ choice: 'keep', all: all() })
      else if (a === 'replace') done({ choice: 'replace', all: all() })
    })
    back.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Escape') done({ cancel: true })
    })
    document.body.appendChild(back)
    back.querySelector('[data-a="keep"]').focus()
  })
}

/** Asks the name for a kept copy, pre-filled with `suggested`. Resolves the name, or null to skip. */
function nameDialog({ name, suggested, dir, destDir }) {
  return new Promise((resolve) => {
    const back = document.createElement('div')
    back.className = 'backdrop'
    back.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
      <h2 id="dlg-t">${esc(`Name for the copy of '${name}'`)}</h2>
      <input class="dialog-input" type="text" spellcheck="false" autocomplete="off" aria-label="New name" />
      <div class="dialog-error" hidden></div>
      <div class="actions"><button class="btn" data-a="skip" type="button">Skip</button><button class="btn primary" data-a="ok" type="button">Copy</button></div></div>`
    const input = back.querySelector('input')
    const errorEl = back.querySelector('.dialog-error')
    input.value = suggested
    let busy = false
    const done = (value) => {
      back.remove()
      treeEl.focus()
      resolve(value)
    }
    const showError = (message) => {
      errorEl.textContent = message
      errorEl.hidden = false
      input.focus()
    }
    const submit = async () => {
      if (busy) return
      const value = input.value.trim()
      if (!value) return showError('A name must be provided.')
      if (/[\\/]/.test(value)) return showError('A name cannot contain / or \\.')
      if (isWindowsPath(state.ws?.path ?? '') && /[<>:"|?*]/.test(value)) {
        return showError('A name cannot contain < > : " | ? or *.')
      }
      busy = true
      try {
        const { conflicts } = await request('fs.conflicts', { root: state.ws.path, dir: destDir, names: [value] })
        if (conflicts.length) return showError(`'${value}' already exists here.`)
        done(value)
      } catch (error) {
        showError(errorText(error))
      } finally {
        busy = false
      }
    }
    back.addEventListener('click', (event) => {
      const a = event.target.closest('[data-a]')?.dataset.a
      if (a === 'ok') submit()
      else if (a === 'skip' || event.target === back) done(null)
    })
    back.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Escape') done(null)
      else if (event.key === 'Enter') {
        event.preventDefault()
        submit()
      }
    })
    input.addEventListener('input', () => {
      errorEl.hidden = true
    })
    document.body.appendChild(back)
    input.focus()
    // Select the name without its extension, as rename does.
    const dot = dir ? -1 : suggested.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : suggested.length)
  })
}

function copyText(text) {
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  if (!ok) toast('Copying is not available here.', true)
}

async function reveal(path) {
  try {
    await request('fs.reveal', { root: state.ws.path, path })
  } catch (error) {
    toast(`Couldn't reveal '${baseName(path) || state.ws.name}': ${errorText(error)}`, true)
  }
}

/** Folder a "new file" goes into for this row: the folder itself, or a file's parent. */
function targetDirFor(path) {
  if (path === null || path === undefined) return state.focus
  const row = rowByPath(path)
  return row?.dir ? path : parentOf(path)
}

// ---------- filter ----------

let filterTimer = null
function onFilterInput(value) {
  state.filter = value.trim()
  clearTimeout(filterTimer)
  if (!state.filter) {
    state.filterResult = null
    state.filterLoading = false
    state.filterSeq++
    scheduleRender()
    return
  }
  state.filterLoading = true
  scheduleRender()
  filterTimer = setTimeout(runFilter, 200)
}

async function runFilter() {
  if (!state.ws || !state.filter) return
  const seq = ++state.filterSeq
  state.filterLoading = true
  scheduleRender()
  try {
    const { items, truncated } = await request('fs.search', { root: state.ws.path, base: state.focus, query: state.filter }, 60_000)
    if (seq !== state.filterSeq) return
    const map = new Map()
    const children = new Map()
    for (const item of items) {
      map.set(item.path, item)
      const parent = parentOf(item.path)
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(item)
    }
    state.filterResult = { items: map, children, truncated }
    if (truncated) toast('Showing the first matches only; type more to narrow the filter.')
  } catch (error) {
    if (seq === state.filterSeq) toast(`Filter failed: ${errorText(error)}`, true)
  } finally {
    if (seq === state.filterSeq) {
      state.filterLoading = false
      scheduleRender()
    }
  }
}

// ---------- menus ----------

let openMenu = null

function closeMenu() {
  if (!openMenu) return
  openMenu.el.remove()
  openMenu.anchor?.setAttribute('aria-expanded', 'false')
  openMenu = null
}

/** items: { label, icon?, shortcut?, checked?, destructive?, disabled?, run } | 'sep' | { heading } */
function showMenu(items, x, y, { anchor = null, wide = false } = {}) {
  closeMenu()
  const el = document.createElement('div')
  el.className = `menu${wide ? ' wide' : ''}`
  el.setAttribute('role', 'menu')
  const actions = []
  for (const item of items) {
    if (item === 'sep') {
      el.insertAdjacentHTML('beforeend', '<div class="menu-sep" role="separator"></div>')
      continue
    }
    if (item.heading) {
      el.insertAdjacentHTML('beforeend', `<div class="menu-label">${esc(item.heading)}</div>`)
      continue
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `menu-item${item.destructive ? ' destructive' : ''}`
    btn.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox')
    if (item.checked !== undefined) btn.setAttribute('aria-checked', String(item.checked))
    if (item.disabled) btn.setAttribute('aria-disabled', 'true')
    const lead =
      item.checked !== undefined
        ? item.checked
          ? icon('Check', 'check')
          : '<span class="check"></span>'
        : item.icon
          ? icon(item.icon)
          : ''
    btn.innerHTML = `${lead}<span>${esc(item.label)}</span>${item.shortcut ? `<span class="shortcut">${esc(item.shortcut)}</span>` : ''}`
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      if (item.disabled) return
      closeMenu()
      item.run()
    })
    el.appendChild(btn)
    actions.push(btn)
  }
  document.body.appendChild(el)
  const rect = el.getBoundingClientRect()
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))
  const top = y + rect.height > window.innerHeight - 4 ? Math.max(4, y - rect.height) : y
  el.style.left = `${left}px`
  el.style.top = `${top}px`
  anchor?.setAttribute('aria-expanded', 'true')
  openMenu = { el, anchor, actions }
  el.addEventListener('keydown', (event) => {
    const enabled = actions.filter((a) => a.getAttribute('aria-disabled') !== 'true')
    const i = enabled.indexOf(document.activeElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      enabled[(i + 1) % enabled.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      enabled[(i - 1 + enabled.length) % enabled.length]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      const back = openMenu?.anchor
      closeMenu()
      ;(back ?? treeEl).focus()
    } else if (event.key === 'Tab') {
      event.preventDefault()
    }
  })
  return el
}

function menuForButton(btn, items) {
  if (openMenu?.anchor === btn) {
    closeMenu()
    return
  }
  const r = btn.getBoundingClientRect()
  const el = showMenu(items, r.right, r.bottom + 4, { anchor: btn })
  // Align the menu's right edge with the button, like a dropdown with align="end".
  const w = el.getBoundingClientRect().width
  el.style.left = `${Math.max(4, Math.min(r.right - w, window.innerWidth - w - 4))}px`
  el.querySelector('.menu-item')?.focus()
}

function sortMenuItems() {
  const set = (patch) => {
    state.sort = { ...state.sort, ...patch }
    save('xp:sort', state.sort)
    render()
  }
  return [
    { heading: 'Sort by' },
    { label: 'Name', checked: state.sort.key === 'name', run: () => set({ key: 'name' }) },
    { label: 'Date Created', checked: state.sort.key === 'created', run: () => set({ key: 'created' }) },
    { label: 'Date Modified', checked: state.sort.key === 'modified', run: () => set({ key: 'modified' }) },
    'sep',
    { label: 'Ascending', checked: state.sort.dir === 'asc', run: () => set({ dir: 'asc' }) },
    { label: 'Descending', checked: state.sort.dir === 'desc', run: () => set({ dir: 'desc' }) }
  ]
}

function newMenuItems(dir) {
  return [
    { label: 'New File', icon: 'FilePlus', run: () => startInline('new', { kind: 'file', dir }) },
    { label: 'New Folder', icon: 'FolderPlus', run: () => startInline('new', { kind: 'folder', dir }) }
  ]
}

function rowMenuItems(row) {
  const paths = actionPaths(row.path)
  const many = paths.length > 1
  const dir = targetDirFor(row.path)
  const items = [...newMenuItems(dir), 'sep']
  items.push({
    label: many ? 'Copy Paths' : 'Copy Path',
    icon: 'Copy',
    run: () => copyText(paths.map(absPath).join('\n'))
  })
  items.push({
    label: many ? 'Copy Relative Paths' : 'Copy Relative Path',
    icon: 'Copy',
    run: () => copyText(paths.join('\n'))
  })
  items.push('sep')
  if (row.dir) {
    items.push({ label: 'Show Only This Folder', icon: 'Focus', run: () => setFocus(row.path) })
  }
  items.push({
    label: IS_MAC ? 'Reveal in Finder' : isWindowsPath(state.ws.path) ? 'Reveal in File Explorer' : 'Open Containing Folder',
    icon: 'ExternalLink',
    shortcut: IS_MAC ? '⌥Click' : 'Alt+Click',
    run: () => reveal(row.path)
  })
  items.push('sep')
  items.push({
    label: 'Rename',
    icon: 'Pencil',
    shortcut: IS_MAC ? '↩' : 'Enter',
    run: () => startInline('rename', { path: row.path, dir: row.dir })
  })
  items.push({
    label: 'Delete',
    icon: 'Trash2',
    shortcut: IS_MAC ? '⌘⌫' : 'Del',
    destructive: true,
    run: () => deletePaths(paths)
  })
  return items
}

function backgroundMenuItems() {
  const items = [...newMenuItems(state.focus), 'sep']
  if (state.focus) {
    items.push({ label: 'Show Full Tree', icon: 'Maximize2', run: () => setFocus('') })
  }
  items.push({ label: 'Collapse All', icon: 'ListCollapse', disabled: state.expanded.size === 0, run: collapseAll })
  items.push({ label: 'Refresh Explorer', icon: 'RefreshCw', run: reloadAll })
  items.push({
    label: IS_MAC ? 'Reveal in Finder' : isWindowsPath(state.ws.path) ? 'Reveal in File Explorer' : 'Open Containing Folder',
    icon: 'ExternalLink',
    run: () => reveal(state.focus)
  })
  return items
}

function collapseAll() {
  state.expanded = new Set(state.focus ? [state.focus] : [])
  saveExpanded()
  render()
}

// ---------- dialogs & toasts ----------

function confirmDialog({ title, body, confirm }) {
  return new Promise((resolve) => {
    const back = document.createElement('div')
    back.className = 'backdrop'
    back.innerHTML = `<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t"><h2 id="dlg-t">${esc(title)}</h2>${
      body ? `<p>${esc(body)}</p>` : ''
    }<div class="actions"><button class="btn" data-a="cancel" type="button">Cancel</button><button class="btn destructive" data-a="ok" type="button">${esc(confirm)}</button></div></div>`
    const done = (value) => {
      back.remove()
      treeEl.focus()
      resolve(value)
    }
    back.addEventListener('click', (event) => {
      const a = event.target.closest('[data-a]')?.dataset.a
      if (a === 'ok') done(true)
      else if (a === 'cancel' || event.target === back) done(false)
    })
    back.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Escape') done(false)
    })
    document.body.appendChild(back)
    back.querySelector('[data-a="cancel"]').focus()
  })
}

function toast(message, isError = false) {
  const el = document.createElement('div')
  el.className = `toast${isError ? ' error' : ''}`
  el.textContent = message
  $('toasts').appendChild(el)
  setTimeout(() => el.remove(), isError ? 6000 : 3500)
}

// ---------- events: tree ----------

function rowFromEvent(event) {
  const el = event.target.closest?.('.row[data-path]')
  if (!el) return null
  return rowByPath(el.dataset.path)
}

treeEl.addEventListener('scroll', () => {
  closeMenu()
  if (state.status === 'ready') renderRows()
})
new ResizeObserver(() => state.status === 'ready' && renderRows()).observe(treeEl)

treeEl.addEventListener('click', (event) => {
  const pick = event.target.closest?.('[data-pick]')
  if (pick && state.status === 'pick') {
    const chosen = state.candidates[Number(pick.dataset.pick)]
    if (chosen) setWorkspace(chosen, 'ready')
    return
  }
  const row = rowFromEvent(event)
  if (!row || row.type !== 'node') {
    if (event.target === treeEl || event.target === spacerEl) selectOnly(null)
    return
  }
  treeEl.focus({ preventScroll: true })
  // Alt+click: select the row and show it in the OS file manager, without opening or toggling it.
  if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    selectOnly(row.path)
    reveal(row.path)
    return
  }
  const mod = IS_MAC ? event.metaKey : event.ctrlKey
  if (event.shiftKey && state.anchor) {
    rangeSelect(row.path, mod)
    return
  }
  if (mod) {
    if (state.selection.has(row.path)) state.selection.delete(row.path)
    else state.selection.add(row.path)
    state.anchor = row.path
    state.cursor = row.path
    scheduleRender()
    return
  }
  selectOnly(row.path)
  if (row.dir) toggleDir(row.path)
  else openFile(row.path)
})

treeEl.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  if (state.status !== 'ready') return
  const row = rowFromEvent(event)
  if (row && row.type === 'node') {
    if (!state.selection.has(row.path)) selectOnly(row.path)
    else state.cursor = row.path
    render()
    showMenu(rowMenuItems(row), event.clientX, event.clientY, { wide: true })
  } else {
    showMenu(backgroundMenuItems(), event.clientX, event.clientY, { wide: true })
  }
})

treeEl.addEventListener('keydown', (event) => {
  if (state.status !== 'ready' || state.inline) return
  const nodes = state.rows.filter((r) => r.type === 'node')
  if (nodes.length === 0) return
  const cur = nodes.findIndex((r) => r.path === state.cursor)
  const curRow = cur >= 0 ? nodes[cur] : null
  const move = (index) => {
    const target = nodes[Math.max(0, Math.min(nodes.length - 1, index))]
    if (event.shiftKey) {
      if (!state.anchor) state.anchor = state.cursor ?? target.path
      rangeSelect(target.path, false)
    } else {
      selectOnly(target.path)
    }
    scrollRowIntoView(state.rows.indexOf(target))
  }
  const mod = IS_MAC ? event.metaKey : event.ctrlKey
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      move(cur < 0 ? 0 : cur + 1)
      break
    case 'ArrowUp':
      event.preventDefault()
      move(cur < 0 ? 0 : cur - 1)
      break
    case 'Home':
      event.preventDefault()
      move(0)
      break
    case 'End':
      event.preventDefault()
      move(nodes.length - 1)
      break
    case 'PageDown':
      event.preventDefault()
      move((cur < 0 ? 0 : cur) + Math.floor(treeEl.clientHeight / ROW_H))
      break
    case 'PageUp':
      event.preventDefault()
      move((cur < 0 ? 0 : cur) - Math.floor(treeEl.clientHeight / ROW_H))
      break
    case 'ArrowRight':
      event.preventDefault()
      if (curRow?.dir) {
        if (!curRow.expanded) toggleDir(curRow.path, true)
        else if (nodes[cur + 1] && parentOf(nodes[cur + 1].path) === curRow.path) move(cur + 1)
      }
      break
    case 'ArrowLeft':
      event.preventDefault()
      if (curRow?.dir && curRow.expanded) toggleDir(curRow.path, false)
      else if (curRow) {
        const parent = parentOf(curRow.path)
        const pIndex = nodes.findIndex((r) => r.path === parent)
        if (pIndex >= 0) move(pIndex)
      }
      break
    case ' ':
      event.preventDefault()
      if (curRow?.dir) toggleDir(curRow.path)
      else if (curRow) openFile(curRow.path)
      break
    case 'Enter':
    case 'F2':
      event.preventDefault()
      if (curRow) startInline('rename', { path: curRow.path, dir: curRow.dir })
      break
    case 'Delete':
      event.preventDefault()
      deletePaths(actionPaths(null))
      break
    case 'Backspace':
      if (IS_MAC && event.metaKey) {
        event.preventDefault()
        deletePaths(actionPaths(null))
      }
      break
    case 'Escape':
      selectOnly(null)
      break
    case 'a':
    case 'A':
      if (mod) {
        event.preventDefault()
        state.selection = new Set(nodes.map((r) => r.path))
        scheduleRender()
      }
      break
  }
})

// ---------- events: drag & drop ----------

function dropDirFor(event) {
  const row = rowFromEvent(event)
  if (!row || row.type !== 'node') return state.focus
  return row.dir ? row.path : parentOf(row.path)
}

treeEl.addEventListener('dragstart', (event) => {
  const row = rowFromEvent(event)
  if (!row || row.type !== 'node' || state.inline) {
    event.preventDefault()
    return
  }
  if (!state.selection.has(row.path)) selectOnly(row.path)
  const paths = actionPaths(row.path)
  state.drag = { paths, overDir: null, hoverPath: null, hoverTimer: null }
  event.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths))
  event.dataTransfer.setData('text/plain', paths.map(absPath).join('\n'))
  event.dataTransfer.effectAllowed = 'move'
  if (paths.length > 1) {
    const ghost = document.createElement('div')
    ghost.className = 'drag-ghost'
    ghost.textContent = `${paths.length} items`
    document.body.appendChild(ghost)
    event.dataTransfer.setDragImage(ghost, 12, 12)
    setTimeout(() => ghost.remove(), 0)
  }
})

/** Files dragged in from outside Orca (File Explorer, Finder, the desktop). */
function isOsFileDrag(event) {
  return !state.drag && state.status === 'ready' && [...(event.dataTransfer?.types ?? [])].includes('Files')
}

treeEl.addEventListener('dragover', (event) => {
  if (isOsFileDrag(event)) {
    state.drag = { paths: [], external: true, overDir: null, hoverPath: null, hoverTimer: null }
  }
  if (!state.drag) return
  const dest = dropDirFor(event)
  const invalid = state.drag.paths.some((p) => dest === p || isUnder(dest, p))
  if (invalid) {
    event.dataTransfer.dropEffect = 'none'
    setDragOver(null)
    return
  }
  event.preventDefault()
  event.dataTransfer.dropEffect = state.drag.external ? 'copy' : 'move'
  setDragOver(dest)
  // Hovering a closed folder opens it, as in Orca's explorer.
  const row = rowFromEvent(event)
  const hoverPath = row?.dir && !row.expanded ? row.path : null
  if (hoverPath !== state.drag.hoverPath) {
    clearTimeout(state.drag.hoverTimer)
    state.drag.hoverPath = hoverPath
    if (hoverPath) state.drag.hoverTimer = setTimeout(() => toggleDir(hoverPath, true), 600)
  }
  // Edge auto-scroll.
  const rect = treeEl.getBoundingClientRect()
  if (event.clientY < rect.top + ROW_H) treeEl.scrollTop -= 8
  else if (event.clientY > rect.bottom - ROW_H) treeEl.scrollTop += 8
})

function setDragOver(dir) {
  if (!state.drag || state.drag.overDir === dir) return
  state.drag.overDir = dir
  renderRows()
}

treeEl.addEventListener('dragleave', (event) => {
  if (!state.drag || treeEl.contains(event.relatedTarget)) return
  // An OS drag gets no dragend here, so leaving the tree ends it.
  if (state.drag.external) endDrag()
  else setDragOver(null)
})

treeEl.addEventListener('drop', (event) => {
  if (!state.drag) return
  event.preventDefault()
  const dest = dropDirFor(event)
  const { paths, external } = state.drag
  if (external) {
    // Entries must be taken while the drop event runs; the DataTransfer empties after it.
    const dropped = droppedItems(event.dataTransfer)
    endDrag()
    if (dropped.length) importDropped(dropped, dest)
    return
  }
  endDrag()
  if (!paths.some((p) => dest === p || isUnder(dest, p))) movePaths(paths, dest)
})

// A file dropped outside the tree must not navigate the frame to it.
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (event) => {
    if (!treeEl.contains(event.target) && [...(event.dataTransfer?.types ?? [])].includes('Files')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'none'
    }
  })
}

treeEl.addEventListener('dragend', endDrag)

function endDrag() {
  if (!state.drag) return
  clearTimeout(state.drag.hoverTimer)
  state.drag = null
  treeEl.classList.remove('drop-root')
  scheduleRender()
}

// ---------- events: chrome ----------

$('btn-sort').innerHTML = icon('ArrowUpDown')
$('btn-new').innerHTML = icon('Plus')
$('btn-collapse').innerHTML = icon('ListCollapse')
$('btn-refresh').innerHTML = icon('RefreshCw')
$('btn-up').innerHTML = icon('ArrowLeft')
$('btn-unfocus').innerHTML = icon('X')
$('filter-icon').innerHTML = icon('ListFilter')
$('filter-clear').innerHTML = icon('X')
$('btn-up').title = 'Up one level'
$('btn-unfocus').title = 'Show full tree'
$('btn-collapse').title = 'Collapse All'
$('btn-refresh').title = 'Refresh Explorer'
$('btn-new').title = 'New File or Folder'

$('btn-sort').addEventListener('click', (event) => {
  event.stopPropagation()
  menuForButton(event.currentTarget, sortMenuItems())
})
$('btn-new').addEventListener('click', (event) => {
  event.stopPropagation()
  if (state.status !== 'ready') return
  const target = state.cursor && state.selection.has(state.cursor) ? targetDirFor(state.cursor) : state.focus
  menuForButton(event.currentTarget, newMenuItems(target))
})
$('btn-collapse').addEventListener('click', () => state.expanded.size && collapseAll())
$('btn-refresh').addEventListener('click', () => state.status === 'ready' && reloadAll())
$('btn-up').addEventListener('click', () => setFocus(parentOf(state.focus)))
$('btn-unfocus').addEventListener('click', () => setFocus(''))
$('crumb-list').addEventListener('click', (event) => {
  const crumb = event.target.closest('[data-crumb]')
  if (crumb && !crumb.classList.contains('current')) setFocus(crumb.dataset.crumb)
})
$('filter').addEventListener('input', (event) => onFilterInput(event.target.value))
$('filter').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.target.value = ''
    onFilterInput('')
  } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
    event.preventDefault()
    treeEl.focus()
    const first = state.rows.find((r) => r.type === 'node' && (!state.filterResult || r.match))
    if (first) {
      selectOnly(first.path)
      revealPath(first.path)
    }
  }
})
$('filter-clear').addEventListener('click', (event) => {
  event.preventDefault()
  $('filter').value = ''
  onFilterInput('')
  $('filter').focus()
})

document.addEventListener('mousedown', (event) => {
  if (openMenu && !openMenu.el.contains(event.target) && event.target !== openMenu.anchor && !openMenu.anchor?.contains(event.target)) {
    closeMenu()
  }
})
window.addEventListener('blur', closeMenu)
window.addEventListener('resize', closeMenu)

// ---------- workspace tracking ----------

let pingTimer = null
let resolveSeq = 0

async function onContext(context) {
  const seq = ++resolveSeq
  if (!context) {
    setWorkspace(null, 'none')
    return
  }
  try {
    const { workspace, candidates, remote } = await request('ws.resolve', {
      displayName: context.displayName,
      branch: context.branch,
      terminalIds: context.terminals.map((t) => t.id)
    })
    if (seq !== resolveSeq) return
    if (workspace) {
      if (state.ws && state.ws.path === workspace.path && state.ws.id === workspace.id) return
      setWorkspace(workspace, 'ready')
    } else if (remote) {
      setWorkspace(null, 'error', 'Explorer+ only shows workspaces on this computer, not SSH or remote hosts.')
    } else if (candidates.length > 1) {
      // Same name and branch, and no terminal to tell them apart: let the person pick.
      if (state.ws && candidates.some((c) => c.path === state.ws.path)) return
      setWorkspace(null, 'pick')
      state.candidates = candidates
      render()
    } else {
      setWorkspace(null, 'error', `Explorer+ couldn't find the folder of '${context.displayName}'.`)
    }
  } catch (error) {
    if (seq === resolveSeq) setWorkspace(null, 'error', errorText(error))
  }
}

function setWorkspace(ws, status, text = '') {
  cancelInline()
  closeMenu()
  state.ws = ws
  state.status = status
  state.statusText = text
  state.cache = new Map()
  state.inflight = new Map()
  state.selection = new Set()
  state.anchor = null
  state.cursor = null
  state.filterResult = null
  state.filterSeq++
  if (state.filter) {
    state.filter = ''
    $('filter').value = ''
  }
  clearInterval(pingTimer)
  if (ws) {
    state.expanded = new Set(load(wsKey('expanded'), []))
    state.focus = load(wsKey('focus'), '')
    if (typeof state.focus !== 'string') state.focus = ''
    treeEl.scrollTop = 0
    loadDir(state.focus)
    const ping = () => request('watch.ping', { root: ws.path }).catch(() => {})
    ping()
    pingTimer = setInterval(ping, PING_MS)
  } else {
    state.expanded = new Set()
    state.focus = ''
  }
  render()
}

orca.plugin.on('fs.changed', ({ root, dirs, all }) => {
  if (!state.ws || root !== state.ws.path) return
  if (all) {
    reloadAll()
    return
  }
  for (const dir of dirs) {
    if (state.cache.has(dir)) loadDir(dir, { force: true })
  }
  if (state.filter) {
    clearTimeout(filterTimer)
    filterTimer = setTimeout(runFilter, 400)
  }
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.status === 'ready') reloadAll()
})

// ---------- Orca's app font ----------
// Frames get no font from Orca, so the worker reads Settings → Appearance → app font and the
// panel builds the same stack Orca's window uses (src/renderer/.../app-font-family.ts).

const FONT_POLL_MS = 5000
const DEFAULT_APP_FONT = 'Geist'
const APP_FONT_FALLBACKS = [DEFAULT_APP_FONT, '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif']
const CSS_FONT_KEYWORDS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'blinkmacsystemfont'])

function buildAppFontFamily(family) {
  const trimmed = family?.trim() || DEFAULT_APP_FONT
  const lower = trimmed.toLowerCase()
  const parts = [trimmed, ...APP_FONT_FALLBACKS.filter((f) => f.toLowerCase() !== lower)]
  return parts.map((f) => (f.startsWith('-') || CSS_FONT_KEYWORDS.has(f.toLowerCase()) ? f : JSON.stringify(f))).join(', ')
}

let appFont = null
function applyAppFont(family) {
  if (family === appFont) return
  appFont = family
  document.documentElement.style.setProperty('--app-font', buildAppFontFamily(family))
  save('xp:font', family)
}

async function syncAppFont() {
  try {
    const { family } = await request('app.font')
    if (typeof family === 'string') applyAppFont(family)
  } catch {
    // Keep the last known font.
  }
}

// The last font seen, at once, so the panel doesn't flash Geist before the worker answers.
const savedFont = load('xp:font', null)
if (typeof savedFont === 'string') applyAppFont(savedFont)
syncAppFont()
setInterval(() => document.visibilityState === 'visible' && syncAppFont(), FONT_POLL_MS)
window.addEventListener('focus', syncAppFont)
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncAppFont())

orca.on('workspace.changed', ({ context }) => onContext(context))
render()
