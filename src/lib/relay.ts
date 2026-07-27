import type { ClientMessage, ServerMessage } from '../../shared/protocol'

export type RelayStatus = 'connecting' | 'open' | 'closed'

export interface RelayHandle {
  send(msg: ClientMessage): void
  /** Send an already-encoded message — for hot paths that JSON.stringify anyway (state dedupe) */
  sendRaw(json: string): void
  close(): void
}

interface RelayOptions {
  /** Called on every (re)connect — re-send create/resume/join here. */
  onOpen: () => void
  onMessage: (msg: ServerMessage) => void
  onStatus?: (status: RelayStatus) => void
}

const HEARTBEAT_TICK_MS = 5_000
/** Quiet this long → ask the server for proof of life */
const PING_AFTER_MS = 12_000
/** Still quiet → the socket is half-open (venue wifi died) — drop and redial */
const DEAD_AFTER_MS = 25_000

// Thin wrapper around the relay websocket with automatic reconnect
// (exponential backoff with jitter, capped at 10s) and an app-level
// heartbeat. Browsers auto-answer server pings but never *detect* a dead
// server themselves — without the heartbeat a half-open connection looks
// "connected" for minutes while every message silently vanishes.
// Same-origin `/ws` works in dev (vite proxies it to the relay) and in
// production (relay serves the app).
export function connectRelay({ onOpen, onMessage, onStatus }: RelayOptions): RelayHandle {
  let ws: WebSocket | null = null
  let closed = false
  let attempts = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let lastSeen = 0

  function teardownSocket(): void {
    clearInterval(heartbeat)
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    try {
      ws.close()
    } catch {
      // already closing
    }
    ws = null
  }

  function scheduleRedial(): void {
    if (closed) return
    onStatus?.('closed')
    // ±30% jitter spreads the reconnect stampede after a relay restart
    const backoff = Math.min(10_000, 1000 * 2 ** attempts++)
    retryTimer = setTimeout(dial, backoff * (0.7 + Math.random() * 0.6))
  }

  function dial(): void {
    if (closed) return
    onStatus?.('connecting')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const sock = new WebSocket(`${proto}://${location.host}/ws`)
    ws = sock

    sock.onopen = () => {
      attempts = 0
      lastSeen = Date.now()
      heartbeat = setInterval(() => {
        if (sock.readyState !== WebSocket.OPEN) return
        const quiet = Date.now() - lastSeen
        if (quiet > DEAD_AFTER_MS) {
          teardownSocket()
          scheduleRedial()
        } else if (quiet > PING_AFTER_MS) {
          sock.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage))
        }
      }, HEARTBEAT_TICK_MS)
      onStatus?.('open')
      onOpen()
    }
    sock.onmessage = (e: MessageEvent) => {
      lastSeen = Date.now()
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(e.data)) as ServerMessage
      } catch {
        return // ignore malformed frames
      }
      if (msg.type === 'pong') return // heartbeat answer — not for the app
      onMessage(msg)
    }
    sock.onclose = () => {
      clearInterval(heartbeat)
      if (closed) return
      scheduleRedial()
    }
  }

  dial()

  return {
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    },
    sendRaw(json) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(json)
    },
    close() {
      closed = true
      clearTimeout(retryTimer)
      teardownSocket()
    },
  }
}
