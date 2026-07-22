import type { ClientMessage, ServerMessage } from '../../shared/protocol'

export type RelayStatus = 'connecting' | 'open' | 'closed'

export interface RelayHandle {
  send(msg: ClientMessage): void
  close(): void
}

interface RelayOptions {
  /** Called on every (re)connect — re-send create/resume/join here. */
  onOpen: () => void
  onMessage: (msg: ServerMessage) => void
  onStatus?: (status: RelayStatus) => void
}

// Thin wrapper around the relay websocket with automatic reconnect
// (exponential backoff, capped at 10s). Same-origin `/ws` works in dev
// (vite proxies it to the relay) and in production (relay serves the app).
export function connectRelay({ onOpen, onMessage, onStatus }: RelayOptions): RelayHandle {
  let ws: WebSocket | null = null
  let closed = false
  let attempts = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  function dial(): void {
    if (closed) return
    onStatus?.('connecting')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws`)

    ws.onopen = () => {
      attempts = 0
      onStatus?.('open')
      onOpen()
    }
    ws.onmessage = (e: MessageEvent) => {
      try {
        onMessage(JSON.parse(String(e.data)) as ServerMessage)
      } catch {
        // ignore malformed frames
      }
    }
    ws.onclose = () => {
      if (closed) return
      onStatus?.('closed')
      retryTimer = setTimeout(dial, Math.min(10_000, 1000 * 2 ** attempts++))
    }
  }

  dial()

  return {
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    },
    close() {
      closed = true
      clearTimeout(retryTimer)
      if (ws) {
        ws.onclose = null
        ws.close()
      }
    },
  }
}
