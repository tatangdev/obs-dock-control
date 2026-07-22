import http from 'node:http'
import crypto from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientMessage, ObsState, ServerMessage } from '../shared/protocol'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, '..', 'dist')
const DATA_FILE = process.env.DATA_FILE ?? path.join(__dirname, '..', 'data', 'sessions.json')
const PORT = Number(process.env.PORT ?? 8787)
// How long a session survives without its dock (covers reloads, network blips,
// and relay restarts) before it is ended for good.
const GRACE_MS = Number(process.env.SESSION_GRACE_MS ?? 10 * 60_000)

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// ---------------------------------------------------------------------------
// Static file serving (production: serves the built frontend with SPA fallback)
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    let filePath = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)))
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403).end()
      return
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = path.join(DIST, 'index.html')
    }
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Frontend not built. Run `npm run build` first, or use `npm run dev`.')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' })
    const stream = createReadStream(filePath)
    stream.on('error', (e) => {
      console.error(`failed streaming ${filePath}:`, e.message)
      res.destroy()
    })
    stream.pipe(res)
  } catch (e) {
    console.error('http handler error:', e instanceof Error ? e.message : e)
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Internal server error')
  }
})

// ---------------------------------------------------------------------------
// Relay: sessions keyed by short code. One dock per session, many remotes.
// The relay never talks to OBS — it only checks credentials and forwards
// messages. Sessions are persisted to disk so they survive relay restarts;
// the dock proves ownership with a token and can resume within GRACE_MS.
// ---------------------------------------------------------------------------
interface Session {
  code: string
  name: string
  pin: string
  token: string
  dock: WebSocket | null
  remotes: Set<WebSocket>
  state: ObsState | null
  expireTimer: NodeJS.Timeout | null
}

interface PersistedSession {
  code: string
  name: string
  pin: string
  token: string
}

interface SocketMeta {
  isAlive: boolean
  role: 'dock' | 'remote' | null
  session: Session | null
}

const sessions = new Map<string, Session>()
const meta = new WeakMap<WebSocket, SocketMeta>()

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function genCode(): string {
  let code: string
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS.charAt(crypto.randomInt(CODE_CHARS.length))).join('')
  } while (sessions.has(code))
  return code
}

function persist(): void {
  try {
    const records: PersistedSession[] = [...sessions.values()].map(({ code, name, pin, token }) => ({
      code,
      name,
      pin,
      token,
    }))
    mkdirSync(path.dirname(DATA_FILE), { recursive: true })
    writeFileSync(DATA_FILE, JSON.stringify(records))
  } catch (e) {
    // Persistence is best-effort: losing restart-survival must never take
    // down live sessions.
    console.error('could not persist sessions:', e instanceof Error ? e.message : e)
  }
}

function restore(): void {
  if (!existsSync(DATA_FILE)) return
  try {
    const records = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as PersistedSession[]
    for (const record of records) {
      const session: Session = { ...record, dock: null, remotes: new Set(), state: null, expireTimer: null }
      session.expireTimer = setTimeout(() => endSession(session), GRACE_MS)
      sessions.set(session.code, session)
    }
    if (records.length > 0) console.log(`restored ${records.length} session(s), docks have ${GRACE_MS / 1000}s to resume`)
  } catch (e) {
    console.error('could not restore sessions:', e)
  }
}

function send(ws: WebSocket | null, msg: ServerMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(session: Session, msg: ServerMessage): void {
  for (const remote of session.remotes) send(remote, msg)
}

function endSession(session: Session): void {
  if (session.expireTimer) clearTimeout(session.expireTimer)
  sessions.delete(session.code)
  persist()
  broadcast(session, { type: 'ended' })
  for (const remote of session.remotes) remote.close()
  session.remotes.clear()
}

function handleMessage(ws: WebSocket, m: SocketMeta, msg: ClientMessage): void {
  switch (msg.type) {
    case 'create': {
      if (m.session) {
        send(ws, { type: 'error', message: 'This connection is already in a session' })
        return
      }
      const pin = String(msg.pin)
      if (!/^\d{4,8}$/.test(pin)) {
        send(ws, { type: 'error', message: 'PIN must be 4-8 digits' })
        return
      }
      const session: Session = {
        code: genCode(),
        name: String(msg.name || 'Untitled').slice(0, 60),
        pin,
        token: crypto.randomUUID(),
        dock: ws,
        remotes: new Set(),
        state: null,
        expireTimer: null,
      }
      sessions.set(session.code, session)
      m.role = 'dock'
      m.session = session
      persist()
      send(ws, { type: 'created', code: session.code, token: session.token })
      break
    }

    case 'resume': {
      const session = sessions.get(String(msg.code).toUpperCase().trim())
      if (!session || session.token !== String(msg.token)) {
        send(ws, { type: 'error', message: 'Session expired or invalid' })
        return
      }
      // A stale dock socket may still be attached (e.g. the dock page reloaded
      // before the old connection timed out) — detach and drop it.
      const old = session.dock
      if (old && old !== ws) {
        const oldMeta = meta.get(old)
        if (oldMeta) oldMeta.session = null
        old.terminate()
      }
      if (session.expireTimer) {
        clearTimeout(session.expireTimer)
        session.expireTimer = null
      }
      session.dock = ws
      m.role = 'dock'
      m.session = session
      send(ws, { type: 'resumed', code: session.code, name: session.name })
      broadcast(session, { type: 'dock-status', online: true })
      send(ws, { type: 'peers', count: session.remotes.size })
      break
    }

    case 'join': {
      if (m.session) {
        send(ws, { type: 'error', message: 'This connection is already in a session' })
        return
      }
      const session = sessions.get(String(msg.code).toUpperCase().trim())
      if (!session) {
        send(ws, { type: 'error', message: 'Session not found' })
        return
      }
      if (session.pin !== String(msg.pin)) {
        send(ws, { type: 'error', message: 'Wrong PIN' })
        return
      }
      session.remotes.add(ws)
      m.role = 'remote'
      m.session = session
      send(ws, { type: 'joined', name: session.name, state: session.state, dockOnline: session.dock !== null })
      send(session.dock, { type: 'peers', count: session.remotes.size })
      break
    }

    case 'state': {
      if (m.role !== 'dock' || !m.session) return
      m.session.state = msg.state
      broadcast(m.session, { type: 'state', state: msg.state })
      break
    }

    case 'command': {
      if (m.role !== 'remote' || !m.session) return
      if (!m.session.dock) {
        send(ws, { type: 'command-error', request: msg.request, message: 'The dock is offline' })
        return
      }
      send(m.session.dock, { type: 'command', request: msg.request, params: msg.params })
      break
    }

    case 'command-error': {
      // The dock reports a command that OBS rejected — fan it out so remotes
      // get feedback instead of a button that silently does nothing.
      if (m.role !== 'dock' || !m.session) return
      broadcast(m.session, { type: 'command-error', request: String(msg.request), message: String(msg.message) })
      break
    }

    case 'end': {
      if (m.role !== 'dock' || !m.session) return
      const session = m.session
      m.session = null
      endSession(session)
      break
    }
  }
}

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws) => {
  const m: SocketMeta = { isAlive: true, role: null, session: null }
  meta.set(ws, m)

  ws.on('pong', () => {
    m.isAlive = true
  })

  ws.on('message', (data) => {
    let msg: unknown
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (typeof msg !== 'object' || msg === null || typeof (msg as { type?: unknown }).type !== 'string') return
    handleMessage(ws, m, msg as ClientMessage)
  })

  ws.on('close', () => {
    const session = m.session
    if (!session) return
    if (m.role === 'dock') {
      if (session.dock !== ws) return
      // Don't end the session — give the dock GRACE_MS to come back.
      session.dock = null
      broadcast(session, { type: 'dock-status', online: false })
      session.expireTimer = setTimeout(() => endSession(session), GRACE_MS)
    } else {
      session.remotes.delete(ws)
      send(session.dock, { type: 'peers', count: session.remotes.size })
    }
  })
})

// Keepalive: terminate dead connections, and keep proxies from idling us out
setInterval(() => {
  for (const ws of wss.clients) {
    const m = meta.get(ws)
    if (!m) continue
    if (!m.isAlive) {
      ws.terminate()
      continue
    }
    m.isAlive = false
    ws.ping()
  }
}, 30_000)

wss.on('error', (e) => {
  console.error('websocket server error:', e.message)
})

server.on('error', (e) => {
  console.error('server error:', e.message)
  process.exit(1)
})

restore()
server.listen(PORT, () => {
  console.log(`relay listening on http://localhost:${PORT} (ws path: /ws)`)
})
