import http from 'node:http'
import crypto from 'node:crypto'
import {
  accessSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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
// Backstop against session-spam filling memory and the data file
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 200)
// Wrong-PIN attempts allowed per connection before it is dropped
const MAX_PIN_ATTEMPTS = 5

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
    if (url.pathname === '/healthz') {
      // dataWritable false means a deploy would silently lose all sessions —
      // the persistence volume isn't mounted or isn't writable.
      let dataWritable = true
      try {
        mkdirSync(path.dirname(DATA_FILE), { recursive: true })
        accessSync(path.dirname(DATA_FILE), fsConstants.W_OK)
      } catch {
        dataWritable = false
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, sessions: sessions.size, connections: wss.clients.size, dataWritable }))
      return
    }
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
  obsConnected: boolean
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
  pinFailures: number
  ip: string
}

const sessions = new Map<string, Session>()
const meta = new WeakMap<WebSocket, SocketMeta>()

// Cross-connection brute-force guard: per-socket limits reset on reconnect,
// so failed join/resume attempts are also counted per IP over a window.
const AUTH_WINDOW_MS = 10 * 60_000
const AUTH_MAX_FAILURES = 30
const authFailures = new Map<string, { count: number; resetAt: number }>()

function authFailed(ip: string): void {
  const now = Date.now()
  const entry = authFailures.get(ip)
  if (!entry || entry.resetAt < now) authFailures.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS })
  else entry.count += 1
}

function authBlocked(ip: string): boolean {
  const entry = authFailures.get(ip)
  return entry !== undefined && entry.resetAt >= Date.now() && entry.count >= AUTH_MAX_FAILURES
}

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
      const session: Session = {
        ...record,
        dock: null,
        remotes: new Set(),
        state: null,
        obsConnected: true,
        expireTimer: null,
      }
      session.expireTimer = setTimeout(() => endSession(session), GRACE_MS)
      sessions.set(session.code, session)
    }
    if (records.length > 0)
      console.log(`restored ${records.length} session(s), docks have ${GRACE_MS / 1000}s to resume`)
  } catch (e) {
    console.error('could not restore sessions:', e)
  }
}

function send(ws: WebSocket | null, msg: ServerMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(session: Session, msg: ServerMessage): void {
  // Serialize once — state snapshots go to every remote, every second
  const json = JSON.stringify(msg)
  for (const remote of session.remotes) {
    if (remote.readyState === WebSocket.OPEN) remote.send(json)
  }
}

function endSession(session: Session): void {
  if (session.expireTimer) clearTimeout(session.expireTimer)
  sessions.delete(session.code)
  persist()
  console.log(`session ${session.code} ended (${sessions.size} active)`)
  broadcast(session, { type: 'ended' })
  for (const remote of session.remotes) remote.close()
  session.remotes.clear()
}

function handleMessage(ws: WebSocket, m: SocketMeta, msg: ClientMessage): void {
  switch (msg.type) {
    case 'create': {
      if (m.session) {
        send(ws, { type: 'error', message: 'This connection is already in a session', code: 'bad-request' })
        return
      }
      if (sessions.size >= MAX_SESSIONS) {
        send(ws, { type: 'error', message: 'The server is full — try again later', code: 'full' })
        return
      }
      const pin = String(msg.pin)
      if (!/^\d{4,8}$/.test(pin)) {
        send(ws, { type: 'error', message: 'PIN must be 4-8 digits', code: 'bad-request' })
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
        obsConnected: true,
        expireTimer: null,
      }
      sessions.set(session.code, session)
      m.role = 'dock'
      m.session = session
      persist()
      console.log(`session ${session.code} created (${sessions.size} active)`)
      send(ws, { type: 'created', code: session.code, token: session.token })
      break
    }

    case 'resume': {
      if (authBlocked(m.ip)) {
        send(ws, { type: 'error', message: 'Too many attempts — try again later', code: 'rate-limited' })
        ws.close(4001, 'rate limited')
        return
      }
      const session = sessions.get(String(msg.code).toUpperCase().trim())
      if (!session || session.token !== String(msg.token)) {
        authFailed(m.ip)
        send(ws, { type: 'error', message: 'Session expired or invalid', code: 'expired' })
        return
      }
      // A stale dock socket may still be attached (page reloaded, or a second
      // dock window is open). Tell it explicitly so it stops auto-resuming —
      // otherwise two live docks kick each other in an endless loop.
      const old = session.dock
      if (old && old !== ws) {
        const oldMeta = meta.get(old)
        if (oldMeta) oldMeta.session = null
        send(old, { type: 'superseded' })
        // Give the notice a moment to flush; the socket may also be dead
        setTimeout(() => old.terminate(), 1000)
      }
      if (session.expireTimer) {
        clearTimeout(session.expireTimer)
        session.expireTimer = null
      }
      session.dock = ws
      m.role = 'dock'
      m.session = session
      console.log(`session ${session.code} resumed by dock${old && old !== ws ? ' (superseded old socket)' : ''}`)
      send(ws, { type: 'resumed', code: session.code, name: session.name })
      broadcast(session, { type: 'dock-status', online: true })
      send(ws, { type: 'peers', count: session.remotes.size })
      break
    }

    case 'join': {
      if (m.session) {
        send(ws, { type: 'error', message: 'This connection is already in a session', code: 'bad-request' })
        return
      }
      if (authBlocked(m.ip)) {
        send(ws, { type: 'error', message: 'Too many attempts — try again later', code: 'rate-limited' })
        ws.close(4001, 'rate limited')
        return
      }
      const session = sessions.get(String(msg.code).toUpperCase().trim())
      if (!session) {
        authFailed(m.ip)
        send(ws, { type: 'error', message: 'Session not found', code: 'not-found' })
        return
      }
      if (session.pin !== String(msg.pin)) {
        m.pinFailures += 1
        authFailed(m.ip)
        send(ws, { type: 'error', message: 'Wrong PIN', code: 'wrong-pin' })
        if (m.pinFailures >= MAX_PIN_ATTEMPTS) ws.close(4001, 'too many PIN attempts')
        return
      }
      session.remotes.add(ws)
      m.role = 'remote'
      m.session = session
      send(ws, {
        type: 'joined',
        name: session.name,
        state: session.state,
        dockOnline: session.dock !== null,
        obsConnected: session.obsConnected,
      })
      send(session.dock, { type: 'peers', count: session.remotes.size })
      break
    }

    case 'state': {
      if (m.role !== 'dock' || !m.session) return
      // Shape-check before caching and fanning out: one malformed frame
      // must not render-crash every connected remote.
      const s = msg.state as ObsState | null | undefined
      if (
        !s ||
        typeof s !== 'object' ||
        typeof s.currentScene !== 'string' ||
        !Array.isArray(s.scenes) ||
        !Array.isArray(s.layers) ||
        typeof s.audio !== 'object'
      ) {
        return
      }
      m.session.state = s
      broadcast(m.session, { type: 'state', state: s })
      break
    }

    case 'obs-status': {
      if (m.role !== 'dock' || !m.session) return
      const connected = Boolean(msg.connected)
      if (m.session.obsConnected === connected) return
      m.session.obsConnected = connected
      broadcast(m.session, { type: 'obs-status', connected })
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

    case 'ping': {
      // App-level liveness: browsers auto-answer ws pings but can't send
      // them, so clients probe with this to detect half-open connections.
      send(ws, { type: 'pong' })
      break
    }
  }
}

// States are a few KB — a generous cap that still stops abusive frames from
// being stored per-session and rebroadcast to every remote.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 })

wss.on('connection', (ws, req) => {
  // Behind the reverse proxy the socket address is the proxy — prefer the
  // forwarded client address for the auth throttle.
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')[0]!
    .trim()
  const ip = forwarded || req.socket.remoteAddress || 'unknown'
  const m: SocketMeta = { isAlive: true, role: null, session: null, pinFailures: 0, ip }
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
      console.log(`session ${session.code}: dock disconnected, ${GRACE_MS / 1000}s grace`)
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
  // Expired throttle entries don't need to linger
  const now = Date.now()
  for (const [ip, entry] of authFailures) {
    if (entry.resetAt < now) authFailures.delete(ip)
  }
}, 30_000)

wss.on('error', (e) => {
  console.error('websocket server error:', e.message)
})

server.on('error', (e) => {
  console.error('server error:', e.message)
  process.exit(1)
})

// Graceful shutdown (every deploy sends SIGTERM): persist sessions, tell
// clients we're going away (they redial with backoff and resume), then exit.
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log('shutting down — persisting sessions and closing connections')
  persist()
  for (const ws of wss.clients) ws.close(1001, 'server restarting')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

restore()
server.listen(PORT, () => {
  console.log(`relay listening on http://localhost:${PORT} (ws path: /ws)`)
})
