# OBS Dock Control

Control OBS from anywhere. One webapp, two modes:

- **Dock (server)** — runs inside OBS as a custom browser dock. Connects directly to
  obs-websocket on `localhost` and hosts a session (code + PIN).
- **Remote (client)** — runs on any device. Joins a session with the code and PIN and
  mirrors the dock's UI. Commands are relayed through the server to the dock, which
  executes them against OBS; OBS events flow back so both sides stay in sync.

```
OBS ◄─ws─ Dock ─wss─► Relay ◄─wss─ Remote(s)
```

The relay never talks to OBS — it only validates credentials and forwards messages.

Everything is strict TypeScript, with the wire protocol shared between server and
frontend in [shared/protocol.ts](shared/protocol.ts).

## Persistence

Sessions survive disconnects and relay restarts:

- The dock gets a secret **token** when it creates a session and stores it in
  localStorage. On reload or reconnect it resumes the *same* session code.
- If the dock drops, remotes see "dock offline" and the session stays alive for a
  grace period (`SESSION_GRACE_MS`, default 10 min) before being ended.
- The relay persists session records to `data/sessions.json` (override with
  `DATA_FILE`), so a relay restart keeps sessions — docks and remotes reconnect
  automatically with exponential backoff.
- "End session" in the dock kills the session for good.

## Development

```sh
npm install
npm run dev        # vite on :5173, relay on :8787 (proxied at /ws)
```

## Production

```sh
npm run build
npm start          # relay serves the built frontend + /ws on $PORT (default 8787)
```

Deploy anywhere that supports persistent WebSockets (VPS, Fly.io, Railway, Render).
HTTPS is required in production so remotes connect over `wss://` — the dock can still
reach `ws://localhost:4455` because browsers exempt localhost from mixed-content rules.

## OBS setup

1. Tools → WebSocket Server Settings → Enable, note the password.
2. Docks → Custom Browser Docks → add `https://your-app/dock`.
3. In the dock: connect to OBS, then start a session with a name and PIN.
4. On your phone: open `https://your-app/remote`, enter the session code and PIN.
