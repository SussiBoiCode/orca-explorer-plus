// Runs the Explorer+ panel in a normal browser against the real worker, outside Orca, for
// development and automated tests. Needs Node 23.6+ (it imports src/worker.ts with type stripping).
//
//   node tools/harness.mjs <folder to show> [--port 4870] [--theme dark|light]
//
// Then open http://localhost:4870/. The page gets a stand-in `window.orca` whose
// plugin.request calls the worker's handlers in this process; editor.open calls are recorded
// at /__state instead of opening anything.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const root = args.find((a) => !a.startsWith('--'))
const port = Number(args[args.indexOf('--port') + 1]) || 4870
const theme = args.includes('--theme') ? args[args.indexOf('--theme') + 1] : 'dark'
if (!root) {
  console.error('usage: node tools/harness.mjs <folder> [--port 4870] [--theme dark|light]')
  process.exit(2)
}
const ROOT = path.resolve(root)
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')

// Orca's default theme values for the frame variables.
const TOKENS = {
  dark: {
    background: '#0a0a0a', foreground: '#fafafa', card: '#171717', 'card-foreground': '#fafafa',
    popover: '#171717', 'popover-foreground': '#fafafa', primary: '#e5e5e5', 'primary-foreground': '#171717',
    secondary: '#262626', 'secondary-foreground': '#fafafa', muted: '#262626', 'muted-foreground': '#a1a1a1',
    accent: '#262626', 'accent-foreground': '#fafafa', destructive: '#ff6568', border: 'rgba(255,255,255,0.1)',
    input: 'rgba(255,255,255,0.15)', ring: '#737373', radius: '0.625rem'
  },
  light: {
    background: '#ffffff', foreground: '#0a0a0a', card: '#ffffff', 'card-foreground': '#0a0a0a',
    popover: '#ffffff', 'popover-foreground': '#0a0a0a', primary: '#171717', 'primary-foreground': '#fafafa',
    secondary: '#f5f5f5', 'secondary-foreground': '#171717', muted: '#f5f5f5', 'muted-foreground': '#737373',
    accent: '#f5f5f5', 'accent-foreground': '#171717', destructive: '#e40014', border: '#e5e5e5',
    input: '#e5e5e5', ring: '#a1a1a1', radius: '0.625rem'
  }
}

const state = { opened: [], logs: [] }
const handlers = new Map()
const clients = new Set()
const workspace = { id: 'ws-harness', name: 'harness', path: ROOT, kind: 'folder', branch: null, hostId: 'local' }

const orca = {
  api: { major: 1, minor: 4 },
  grantedCapabilities: ['workspace:read', 'workspace:write'],
  host: {
    has: () => true,
    async call(method, params) {
      if (method === 'workspace.list') return { workspaces: [workspace], truncated: false }
      if (method === 'workspace.readContext') return { branch: '', displayName: 'harness', terminals: [] }
      if (method === 'editor.open') {
        state.opened.push(params)
        return { opened: true }
      }
      throw Object.assign(new Error(`harness: ${method} is not mocked`), { code: 'unknown_method' })
    }
  },
  panels: {
    handle(name, handler) {
      handlers.set(name, handler)
      return { dispose: () => handlers.delete(name) }
    },
    post(event, payload) {
      const line = `data: ${JSON.stringify({ event, payload })}\n\n`
      for (const res of clients) res.write(line)
    }
  },
  commands: { register: () => ({ dispose() {} }) },
  events: { on: () => ({ dispose() {} }) },
  log: (message) => state.logs.push(message)
}

const worker = await import(new URL('../src/worker.ts', import.meta.url).href)
await worker.default(orca)

const mockScript = (t) => `
<script>
(() => {
  const tokens = ${JSON.stringify(TOKENS[t])};
  const rootEl = document.documentElement;
  rootEl.classList.add(${JSON.stringify(t)});
  for (const [k, v] of Object.entries(tokens)) rootEl.style.setProperty('--orca-' + k, v);
  const pluginListeners = new Map();
  const events = new EventSource('/__events');
  events.onmessage = (m) => {
    const { event, payload } = JSON.parse(m.data);
    for (const cb of pluginListeners.get(event) ?? []) cb(payload);
  };
  async function request(name, input) {
    const r = await fetch('/__req', { method: 'POST', body: JSON.stringify({ name, input }) }).then((x) => x.json());
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.output;
  }
  window.orca = Object.freeze({
    api: { major: 1, minor: 4 },
    locale: 'en',
    host: { has: () => true, call: async (m) => { throw Object.assign(new Error(m + ' not mocked'), { code: 'unknown_method' }) } },
    plugin: {
      request,
      on(event, cb) {
        if (!pluginListeners.has(event)) pluginListeners.set(event, new Set());
        pluginListeners.get(event).add(cb);
        return { dispose: () => pluginListeners.get(event).delete(cb) };
      }
    },
    on(event, cb) {
      if (event === 'workspace.changed') setTimeout(() => cb({ context: { branch: '', displayName: 'harness', terminals: [] } }), 0);
      return { dispose() {} };
    }
  });
})();
</script>`

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' }

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    try {
      if (url.pathname === '/__events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(': ok\n\n')
        clients.add(res)
        req.on('close', () => clients.delete(res))
        return
      }
      if (url.pathname === '/__req' && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        const { name, input } = JSON.parse(body)
        const handler = handlers.get(name)
        let out
        if (!handler) out = { error: { code: 'unknown_method', message: `no handler ${name}` } }
        else {
          try {
            out = { output: await handler(input, { panel: { id: 'harness', surface: 'panel', contributionId: 'explorer' }, signal: new AbortController().signal }) }
          } catch (error) {
            out = { error: { code: error.code ?? 'action_failed', message: error.message } }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out))
        return
      }
      if (url.pathname === '/__state') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(state))
        return
      }
      if (url.pathname === '/__reset') {
        state.opened = []
        res.end('ok')
        return
      }
      const rel = url.pathname === '/' ? 'panel/index.html' : `panel${decodeURIComponent(url.pathname)}`
      const file = path.resolve(pluginDir, rel)
      if (!file.startsWith(path.join(pluginDir, 'panel'))) {
        res.writeHead(404).end()
        return
      }
      let data = await readFile(file)
      if (rel === 'panel/index.html') {
        data = Buffer.from(String(data).replace('<head>', `<head>${mockScript(theme)}`))
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
      res.end(data)
    } catch (error) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end(String(error))
    }
  })
  .listen(port, () => console.log(`Explorer+ harness: http://localhost:${port}/ showing ${ROOT}`))
