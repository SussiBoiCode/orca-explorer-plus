// End-to-end test of Explorer+ in a headless Chromium browser (Edge by default) through
// tools/harness.mjs: the real panel and the real worker against a temporary fixture folder.
//
//   npm install && npm run test:e2e      (BROWSER_CHANNEL=chrome to use Chrome instead of Edge)
//
// The delete step moves one small fixture file to the Recycle Bin / Trash.
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, rm, utimes, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = path.join(os.tmpdir(), 'explorer-plus-e2e')
const FIX = path.join(SCRATCH, 'fixture')
const SHOTS = path.join(SCRATCH, 'shots')
const PORT = 4871
const URL_ = `http://localhost:${PORT}/`

let failures = 0
function check(cond, label, detail = '') {
  if (cond) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label} ${detail}`)
  }
}

// ---- fixture: creation order differs from name order and from modified order ----
await rm(FIX, { recursive: true, force: true })
await mkdir(FIX, { recursive: true })
await mkdir(SHOTS, { recursive: true })
const order = [
  ['zeta', 'dir'],
  ['b.txt', 'file'],
  ['alpha', 'dir'],
  ['file10.js', 'file'],
  ['Mid', 'dir'],
  ['file2.js', 'file'],
  ['.env', 'file'],
  ['node_modules', 'dir'],
  ['.git', 'dir']
]
for (const [name, kind] of order) {
  const p = path.join(FIX, name)
  if (kind === 'dir') await mkdir(p)
  else await writeFile(p, name)
  await sleep(60)
}
await writeFile(path.join(FIX, 'alpha', 'inner.md'), '# hi')
await mkdir(path.join(FIX, 'alpha', 'deep'))
await writeFile(path.join(FIX, 'alpha', 'deep', 'leaf.json'), '{}')
await writeFile(path.join(FIX, 'zeta', 'z1.txt'), 'z')
// Modified order: file2.js newest, b.txt oldest, file10.js middle; dirs: Mid newest, zeta oldest.
const now = Date.now() / 1000
await utimes(path.join(FIX, 'b.txt'), now, now - 3000)
await utimes(path.join(FIX, 'file10.js'), now, now - 2000)
await utimes(path.join(FIX, '.env'), now, now - 2500)
await utimes(path.join(FIX, 'file2.js'), now, now - 100)
await utimes(path.join(FIX, 'zeta'), now, now - 5000)
await utimes(path.join(FIX, 'alpha'), now, now - 4000)
await utimes(path.join(FIX, 'Mid'), now, now - 1000)

const created = {}
for (const [name] of order) created[name] = (await stat(path.join(FIX, name))).birthtimeMs

// ---- harness ----
const server = spawn(process.execPath, [path.join(PLUGIN, 'tools/harness.mjs'), FIX, '--port', String(PORT), '--record-reveal'], { stdio: ['ignore', 'pipe', 'pipe'] })
let serverErr = ''
server.stderr.on('data', (d) => (serverErr += d))
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('harness') && resolve())
  server.on('exit', (code) => reject(new Error(`harness exited ${code}: ${serverErr}`)))
})

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 300, height: 640 } })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()))

const names = () => page.$$eval('.row[data-path] .name', (els) => els.map((e) => e.textContent))
const paths = () => page.$$eval('.row[data-path]', (els) => els.map((e) => e.dataset.path))
const row = (p) => page.locator(`.row[data-path="${p}"]`)
const serverState = () => fetch(`${URL_}__state`).then((r) => r.json())
async function waitFor(fn, label, timeout = 4000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(50)
  }
  return false
}
async function menuPick(label) {
  await page.locator('.menu .menu-item', { hasText: new RegExp(`^${label}`) }).first().click()
}

try {
  await page.goto(URL_)
  await page.waitForSelector('.row[data-path]')

  console.log('render + hidden entries')
  const first = await names()
  check(!first.includes('.git') && !first.includes('node_modules'), '.git and node_modules hidden', first.join(','))
  check(first.includes('.env'), 'dotfiles shown')
  check(
    JSON.stringify(first) === JSON.stringify(['alpha', 'Mid', 'zeta', '.env', 'b.txt', 'file2.js', 'file10.js']),
    'name sort: folders first, natural, case-insensitive',
    first.join(',')
  )
  check((await page.textContent('#title')) === 'fixture', 'title is the folder name')
  check(await page.locator('#filter-clear').isHidden(), 'filter clear hidden when empty')
  await page.screenshot({ path: path.join(SHOTS, '01-initial.png') })

  console.log('sort menu')
  await page.click('#btn-sort')
  await page.waitForSelector('.menu')
  await page.screenshot({ path: path.join(SHOTS, '02-sort-menu.png') })
  await menuPick('Date Created')
  await sleep(150)
  const byCreated = await names()
  const expectCreated = (list) => list.slice().sort((a, b) => created[a] - created[b])
  check(
    JSON.stringify(byCreated) ===
      JSON.stringify([...expectCreated(['zeta', 'alpha', 'Mid']), ...expectCreated(['b.txt', 'file10.js', 'file2.js', '.env'])]),
    'date created ascending',
    byCreated.join(',')
  )
  await page.click('#btn-sort')
  await menuPick('Descending')
  await sleep(100)
  const byCreatedDesc = await names()
  check(
    JSON.stringify(byCreatedDesc) ===
      JSON.stringify([...expectCreated(['zeta', 'alpha', 'Mid']).reverse(), ...expectCreated(['b.txt', 'file10.js', 'file2.js', '.env']).reverse()]),
    'date created descending',
    byCreatedDesc.join(',')
  )
  await page.click('#btn-sort')
  await menuPick('Date Modified')
  await sleep(100)
  const byModDesc = await names()
  check(
    JSON.stringify(byModDesc) === JSON.stringify(['Mid', 'alpha', 'zeta', 'file2.js', 'file10.js', '.env', 'b.txt']),
    'date modified descending',
    byModDesc.join(',')
  )
  check((await page.getAttribute('#btn-sort', 'title')).includes('Date Modified'), 'sort button tooltip names the sort')
  await page.reload()
  await page.waitForSelector('.row[data-path]')
  check(JSON.stringify(await names()) === JSON.stringify(byModDesc), 'sort survives reload')

  console.log('expand + open')
  await row('alpha').click()
  await page.waitForSelector('.row[data-path="alpha/inner.md"]')
  check((await paths()).includes('alpha/deep'), 'folder expands')
  await row('alpha/inner.md').click()
  check(await waitFor(async () => (await serverState()).opened.some((o) => o.path === 'alpha/inner.md' && o.workspaceId === 'ws-harness'), 'open'), 'file click opens editor with relative path')
  await page.reload()
  await page.waitForSelector('.row[data-path="alpha/inner.md"]')
  check(true, 'expanded folder survives reload')

  console.log('multi-select')
  await row('b.txt').click()
  await row('file2.js').click({ modifiers: ['Control'] })
  check(await waitFor(async () => (await page.locator('.row[data-selected="true"]').count()) === 2), 'ctrl-click adds to selection')
  await row('zeta').click()
  await row('alpha').click({ modifiers: ['Shift'] })
  await sleep(100)
  const selCount = await page.locator('.row[data-selected="true"]').count()
  check(selCount >= 3, 'shift-click selects a range', String(selCount))
  // alpha collapsed by the zeta? no: zeta click toggled zeta; re-collapse zeta for later steps
  if ((await paths()).includes('zeta/z1.txt')) await row('zeta').click()

  console.log('focus mode')
  await row('alpha').click({ button: 'right' })
  await page.waitForSelector('.menu')
  await page.screenshot({ path: path.join(SHOTS, '03-context-menu.png') })
  await menuPick('Show Only This Folder')
  await page.waitForSelector('#crumbs:not([hidden])')
  const focused = await paths()
  check(focused.every((p) => p.startsWith('alpha/')), 'focus shows only that folder', focused.join(','))
  check((await page.textContent('#crumb-list')).includes('alpha'), 'breadcrumb shows the folder')
  await row('alpha/deep').click({ button: 'right' })
  await menuPick('Show Only This Folder')
  await page.waitForSelector('.row[data-path="alpha/deep/leaf.json"]')
  await page.screenshot({ path: path.join(SHOTS, '04-focus.png') })
  await page.reload()
  await page.waitForSelector('#crumbs:not([hidden])')
  check(JSON.stringify(await paths()) === JSON.stringify(['alpha/deep/leaf.json']), 'focus survives reload')
  await page.click('#btn-up')
  await sleep(100)
  check((await paths()).includes('alpha/deep') && (await paths()).every((p) => p.startsWith('alpha/')), 'up arrow goes one level up')
  await page.click('.crumb[data-crumb=""]')
  await sleep(100)
  check(await page.locator('#crumbs').isHidden(), 'root crumb returns to the full tree')
  await row('alpha').click({ button: 'right' })
  await menuPick('Show Only This Folder')
  await page.click('#btn-unfocus')
  await sleep(100)
  check((await paths()).includes('zeta'), 'close button shows the full tree')

  console.log('new file / folder')
  const tb = await page.locator('.tree').boundingBox()
  await page.mouse.click(tb.x + 150, tb.y + tb.height - 10)
  await sleep(100)
  check((await page.locator('.row[data-selected="true"]').count()) === 0, 'clicking empty space clears the selection')
  await page.click('#btn-new')
  await menuPick('New File')
  await page.waitForSelector('.row.inline input')
  await page.screenshot({ path: path.join(SHOTS, '05-inline-new.png') })
  await page.keyboard.type('created.txt')
  await page.keyboard.press('Enter')
  check(await waitFor(async () => (await readdir(FIX)).includes('created.txt'), 'disk'), 'new file is created on disk')
  check(await waitFor(async () => (await serverState()).opened.some((o) => o.path === 'created.txt'), 'open'), 'new file opens in the editor')
  check(await waitFor(async () => (await paths()).includes('created.txt'), 'row'), 'new file appears in the tree')
  await row('Mid').click({ button: 'right' })
  await menuPick('New Folder')
  await page.waitForSelector('.row.inline input')
  await page.keyboard.type('sub')
  await page.keyboard.press('Enter')
  check(await waitFor(async () => (await readdir(path.join(FIX, 'Mid'))).includes('sub'), 'disk'), 'new folder inside a folder from its context menu')

  console.log('rename')
  await row('created.txt').click({ button: 'right' })
  await menuPick('Rename')
  await page.waitForSelector('.row.inline input')
  const selected = await page.$eval('.row.inline input', (i) => i.value.slice(i.selectionStart, i.selectionEnd))
  check(selected === 'created', 'rename selects the name without extension', selected)
  await page.keyboard.type('renamed')
  await page.keyboard.press('Enter')
  check(await waitFor(async () => (await readdir(FIX)).includes('renamed.txt'), 'disk'), 'rename on disk')
  await row('renamed.txt').click()
  await page.keyboard.press('F2')
  await page.waitForSelector('.row.inline input')
  await page.keyboard.press('Control+A')
  await page.keyboard.type('b.txt')
  await page.keyboard.press('Enter')
  check(await waitFor(async () => (await page.locator('.inline-error').count()) > 0, 'err'), 'rename onto an existing name shows an error')
  await page.screenshot({ path: path.join(SHOTS, '06-rename-error.png') })
  await page.keyboard.press('Escape')
  check(await waitFor(async () => (await page.locator('.row.inline').count()) === 0, 'esc'), 'escape cancels rename')

  console.log('drag & drop')
  await row('renamed.txt').dragTo(row('zeta'))
  check(await waitFor(async () => (await readdir(path.join(FIX, 'zeta'))).includes('renamed.txt'), 'disk'), 'drag a file onto a folder moves it')
  check(await waitFor(async () => (await paths()).includes('zeta/renamed.txt'), 'row'), 'moved file is revealed in its new folder')
  await row('file2.js').click()
  await row('file10.js').click({ modifiers: ['Control'] })
  await row('file2.js').dragTo(row('Mid'))
  check(
    await waitFor(async () => {
      const inMid = await readdir(path.join(FIX, 'Mid'))
      return inMid.includes('file2.js') && inMid.includes('file10.js')
    }, 'disk'),
    'dragging a multi-selection moves all of it'
  )

  console.log('filter')
  await page.fill('#filter', 'leaf')
  check(await waitFor(async () => JSON.stringify(await paths()) === JSON.stringify(['alpha', 'alpha/deep', 'alpha/deep/leaf.json']), 'filter'), 'filter shows matches with their folders', (await paths()).join(','))
  await page.screenshot({ path: path.join(SHOTS, '07-filter.png') })
  await page.click('#filter-clear')
  check(await waitFor(async () => (await paths()).includes('zeta'), 'clear'), 'clearing the filter restores the tree')

  console.log('live refresh')
  await writeFile(path.join(FIX, 'from-agent.md'), 'x')
  check(await waitFor(async () => (await paths()).includes('from-agent.md'), 'live', 5000), 'a file created on disk appears by itself')
  await rm(path.join(FIX, 'from-agent.md'))
  check(await waitFor(async () => !(await paths()).includes('from-agent.md'), 'live', 5000), 'a file deleted on disk disappears by itself')

  console.log('delete')
  await row('b.txt').click()
  await page.keyboard.press('Delete')
  check(await waitFor(async () => !(await readdir(FIX)).includes('b.txt'), 'disk', 15000), 'Delete key moves the file to the Recycle Bin')
  check(await page.locator('.backdrop').count() === 0, 'no confirmation for a local delete')

  console.log('keyboard')
  await page.locator('.tree').focus()
  await row('alpha').click()
  await sleep(100)
  const visible = await paths()
  const expected = visible[visible.indexOf('alpha') + 1]
  await page.keyboard.press('ArrowDown')
  await sleep(100)
  const cursor = await page.$eval('.row[data-selected="true"]', (e) => e.dataset.path)
  check(cursor === expected, 'arrow down moves the selection to the next row', cursor + ' vs ' + expected)

  console.log('collapse all')
  await page.click('#btn-collapse')
  await sleep(100)
  check((await paths()).every((p) => !p.includes('/')), 'collapse all closes every folder')

  console.log('app font')
  const setFont = (family) => fetch(`${URL_}__font?family=${encodeURIComponent(family)}`, { method: 'POST' })
  const bodyFont = () => page.$eval('.row[data-path] .name', (e) => getComputedStyle(e).fontFamily)
  await setFont('Courier New')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  check(await waitFor(async () => (await bodyFont()).startsWith('"Courier New", Geist'), 'font'), "rows use Orca's app font with Orca's fallbacks", await bodyFont())
  check((await page.evaluate(() => localStorage.getItem('xp:font'))) === '"Courier New"', 'the font is remembered for the next start')
  await setFont('')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  check(await waitFor(async () => (await bodyFont()).startsWith('Geist, -apple-system'), 'font'), 'an unset app font falls back to Geist', await bodyFont())
  await setFont('Arial')
  check(await waitFor(async () => (await bodyFont()).startsWith('Arial'), 'font', 8000), 'a font change is picked up without focus (poll)', await bodyFont())
  await setFont('')

  console.log('alt+click reveal')
  await fetch(`${URL_}__reset`)
  await row('zeta').click({ modifiers: ['Alt'] })
  check(await waitFor(async () => (await serverState()).revealed.some((r) => r.path === 'zeta'), 'reveal'), 'alt+click a folder reveals it')
  check(!(await paths()).includes('zeta/z1.txt'), 'alt+click does not expand the folder')
  check(
    await waitFor(async () => (await page.$$eval('.row[data-selected="true"]', (els) => els.map((e) => e.dataset.path).join())) === 'zeta', 'sel'),
    'alt+click selects the row'
  )
  await row('.env').click({ modifiers: ['Alt'] })
  check(await waitFor(async () => (await serverState()).revealed.some((r) => r.path === '.env'), 'reveal'), 'alt+click a file reveals it')
  check(!(await serverState()).opened.some((o) => o.path === '.env'), 'alt+click does not open the file')
  await row('.env').click({ button: 'right' })
  const revealItem = page.locator('.menu .menu-item', { hasText: 'Reveal in' })
  check((await revealItem.locator('.shortcut').textContent()) === 'Alt+Click', 'the menu shows the Alt+Click shortcut')
  await revealItem.click()
  check(await waitFor(async () => (await serverState()).revealed.filter((r) => r.path === '.env').length === 2, 'reveal'), 'menu reveal still works')

  console.log('drop from the OS')
  // A drop as File Explorer makes it. Real OS folders come through webkitGetAsEntry, which a
  // synthetic DataTransfer lacks, so `dir` specs are handed to the panel as stand-in entries.
  await page.evaluate(() => {
    const toFile = (spec) =>
      new File([spec.size ? new Uint8Array(spec.size).map((_, i) => (i * 7) & 255) : spec.content ?? ''], spec.name)
    const toEntry = (spec) =>
      spec.dir
        ? {
            name: spec.name,
            isFile: false,
            isDirectory: true,
            createReader() {
              let done = false
              return {
                readEntries(ok) {
                  ok(done ? [] : spec.children.map(toEntry))
                  done = true
                }
              }
            }
          }
        : { name: spec.name, isFile: true, isDirectory: false, file: (ok) => ok(toFile(spec)) }
    window.__drop = (selector, specs) => {
      const target = document.querySelector(selector)
      const dt = new DataTransfer()
      const fakes = []
      for (const spec of specs) {
        dt.items.add(spec.dir ? new File([''], spec.name) : toFile(spec))
        fakes.push(spec.dir ? toEntry(spec) : null)
      }
      const real = DataTransferItem.prototype.webkitGetAsEntry
      let i = 0
      DataTransferItem.prototype.webkitGetAsEntry = function () {
        return fakes[i++]
      }
      const at = target.getBoundingClientRect()
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: at.left + 20, clientY: at.top + 8 }
      target.dispatchEvent(new DragEvent('dragenter', opts))
      target.dispatchEvent(new DragEvent('dragover', opts))
      const highlighted = document.querySelector('.slot.drop, .tree.drop-root') !== null
      target.dispatchEvent(new DragEvent('drop', opts))
      DataTransferItem.prototype.webkitGetAsEntry = real
      return highlighted
    }
  })
  const drop = (selector, specs) => page.evaluate(([sel, sp]) => window.__drop(sel, sp), [selector, specs])
  const zetaFile = (n) => readFile(path.join(FIX, 'zeta', n), 'utf8').catch(() => null)
  const dialog = () => page.locator('.backdrop .dialog')

  check(await drop('.row[data-path="zeta"]', [{ name: 'dropped.txt', content: 'hello' }]), 'an OS drag highlights the drop folder')
  check(await waitFor(async () => (await zetaFile('dropped.txt')) === 'hello', 'disk'), 'dropping a file onto a folder copies it there')
  check(await waitFor(async () => (await paths()).includes('zeta/dropped.txt'), 'row'), 'the copied file is revealed and selected')
  check(await waitFor(async () => (await page.locator('.toast.progress').count()) === 0, 'toast'), 'the progress toast goes away when done')

  const BIG = 1_300_000
  // A local copy is too quick to poll for, so the toast's text is caught as it changes.
  await page.evaluate(() => {
    window.__progress = []
    new MutationObserver(() => {
      const t = document.querySelector('.toast.progress .toast-text')?.textContent
      if (t && window.__progress.at(-1) !== t) window.__progress.push(t)
    }).observe(document.getElementById('toasts'), { subtree: true, childList: true, characterData: true })
  })
  await drop('#spacer', [{ name: 'big.bin', size: BIG }])
  check(
    await waitFor(async () => (await page.evaluate(() => window.__progress)).some((t) => t.startsWith('Copying 1 of 1: big.bin')), 'progress', 4000),
    'a copy shows a progress toast',
    JSON.stringify(await page.evaluate(() => window.__progress))
  )
  check(
    await waitFor(async () => {
      const b = await readFile(path.join(FIX, 'big.bin')).catch(() => null)
      return b !== null && b.length === BIG && b.every((v, i) => v === ((i * 7) & 255))
    }, 'disk', 15000),
    'a multi-chunk file arrives byte for byte'
  )

  await drop('#spacer', [
    {
      name: 'pack',
      dir: true,
      children: [
        { name: 'a.txt', content: 'A' },
        { name: 'sub', dir: true, children: [{ name: 'b.txt', content: 'B' }] },
        { name: 'empty', dir: true, children: [] }
      ]
    }
  ])
  check(
    await waitFor(async () => (await readFile(path.join(FIX, 'pack', 'sub', 'b.txt'), 'utf8').catch(() => null)) === 'B', 'disk'),
    'dropping a folder copies its whole tree'
  )
  check((await readdir(path.join(FIX, 'pack'))).includes('empty'), 'empty sub-folders are copied too')

  console.log('drop name clashes')
  await drop('.row[data-path="zeta"]', [{ name: 'dropped.txt', content: 'other' }])
  await dialog().waitFor()
  check((await dialog().locator('h2').textContent()).includes("'dropped.txt' already exists"), 'a clash asks what to do')
  check((await dialog().locator('[data-all]').count()) === 0, 'no "apply to all" for a single clash')
  await page.screenshot({ path: path.join(SHOTS, '10-clash.png') })
  await dialog().locator('[data-a="keep"]').click()
  const nameInput = page.locator('.dialog-input')
  await nameInput.waitFor()
  check((await nameInput.inputValue()) === 'dropped copy.txt', 'keep both suggests "name copy.ext"', await nameInput.inputValue())
  const sel = await nameInput.evaluate((i) => i.value.slice(i.selectionStart, i.selectionEnd))
  check(sel === 'dropped copy', 'the suggested name is selected without its extension', sel)
  await page.screenshot({ path: path.join(SHOTS, '11-keep-both-name.png') })
  await nameInput.fill('dropped.txt')
  await page.keyboard.press('Enter')
  check(await waitFor(async () => (await page.locator('.dialog-error:not([hidden])').count()) === 1, 'err'), 'an existing name is refused in the name box')
  await nameInput.fill('mine.txt')
  await page.keyboard.press('Enter')
  check(await waitFor(async () => (await zetaFile('mine.txt')) === 'other', 'disk'), 'keep both copies under the chosen name')
  check((await zetaFile('dropped.txt')) === 'hello', 'keep both leaves the original alone')

  await drop('.row[data-path="zeta"]', [{ name: 'dropped.txt', content: 'skipped' }])
  await dialog().waitFor()
  await dialog().locator('[data-a="skip"]').click()
  await sleep(400)
  check((await zetaFile('dropped.txt')) === 'hello', 'skip leaves the existing file')

  await drop('.row[data-path="zeta"]', [{ name: 'dropped.txt', content: 'v2' }])
  await dialog().waitFor()
  await dialog().locator('[data-a="replace"]').click()
  check(await waitFor(async () => (await zetaFile('dropped.txt')) === 'v2', 'disk', 15000), 'replace swaps in the dropped file')
  check(
    await waitFor(async () => !(await readdir(path.join(FIX, 'zeta'))).some((n) => n.endsWith('.tmp')), 'tmp', 4000),
    'no temporary file is left behind'
  )

  await drop('.row[data-path="zeta"]', [
    { name: 'dropped.txt', content: 'x' },
    { name: 'mine.txt', content: 'y' },
    { name: 'fresh.txt', content: 'z' }
  ])
  await dialog().waitFor()
  check((await dialog().locator('[data-all]').count()) === 1, 'several clashes offer "apply to all"')
  await dialog().locator('[data-all]').check()
  await dialog().locator('[data-a="keep"]').click()
  check(
    await waitFor(
      async () => (await zetaFile('dropped copy.txt')) === 'x' && (await zetaFile('mine copy.txt')) === 'y' && (await zetaFile('fresh.txt')) === 'z',
      'disk'
    ),
    'keep both for all names every copy without asking'
  )
  check((await page.locator('.dialog-input').count()) === 0, 'no name box with "apply to all"')

  await drop('.row[data-path="zeta"]', [{ name: 'fresh.txt', content: 'never' }])
  await dialog().waitFor()
  await page.keyboard.press('Escape')
  await sleep(300)
  check((await page.locator('.backdrop').count()) === 0 && (await zetaFile('fresh.txt')) === 'z', 'escape cancels the whole drop')

  console.log('big folder')
  await mkdir(path.join(FIX, 'big'))
  for (let b = 0; b < 12000; b += 500) await Promise.all(Array.from({ length: 500 }, (_, i) => writeFile(path.join(FIX, 'big', `f${b + i}.txt`), '')))
  await page.click('#btn-refresh')
  await page.waitForSelector('.row[data-path="big"]')
  await page.click('#btn-sort')
  await menuPick('Name')
  await page.click('#btn-sort')
  await menuPick('Ascending')
  const t0 = Date.now()
  await row('big').click()
  const loaded = await waitFor(async () => (await page.$eval('#spacer', (e) => parseInt(e.style.height, 10))) > 12000 * 24, 'big', 20000)
  const ms = Date.now() - t0
  check(loaded, `12,000-file folder expands (${ms} ms)`)
  check(ms < 5000, 'big folder loads in under 5 s', `${ms} ms`)
  const slotCount = await page.locator('.slot').count()
  check(slotCount < 120, 'only visible rows are drawn', String(slotCount))
  await page.$eval('#tree', (e) => (e.scrollTop = e.scrollHeight))
  check(await waitFor(async () => (await paths()).includes('big/f11999.txt'), 'bottom'), 'scrolling to the end shows the last file')
  const t1 = Date.now()
  for (let i = 0; i < 20; i++) await page.$eval('#tree', (e, y) => (e.scrollTop = y), i * 9000)
  check(Date.now() - t1 < 2000, 'scrolling stays fast', `${Date.now() - t1} ms`)
  await page.$eval('#tree', (e) => (e.scrollTop = 0))
  await row('big').click()

  await page.screenshot({ path: path.join(SHOTS, '08-final.png') })
} finally {
  check(pageErrors.length === 0, 'no page errors', pageErrors.join(' | '))
  await browser.close()
  server.kill()
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
