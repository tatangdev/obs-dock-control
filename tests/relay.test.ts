// Integration test for the relay server: spawns the real server process and
// drives the session lifecycle over actual websockets — create, join, command
// forwarding, state fan-out and validation, heartbeat, dock loss + grace,
// resume, supersede, end.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PORT = 18700 + Math.floor(Math.random() * 800)
const BASE = `http://127.0.0.1:${PORT}`

let server: ChildProcess

// A valid-enough ObsState for the server's shape check
const STATE = {
  audio: { input: null, media: null },
  currentScene: 'MAIN',
  scenes: ['MAIN', 'SECOND'],
  layers: [],
  runningText: '',
  media: null,
}

interface TestClient {
  send(msg: unknown): void
  /** Next message of the given type; other messages stay queued */
  next(type: string, timeoutMs?: number): Promise<Record<string, unknown>>
  /** Assert nothing of the given type arrives within the window */
  silence(type: string, windowMs?: number): Promise<void>
  close(): void
}

function connect(): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const queue: Record<string, unknown>[] = []
    ws.on('message', (data) => {
      try {
        queue.push(JSON.parse(String(data)) as Record<string, unknown>)
      } catch {
        // ignore
      }
    })
    ws.on('error', reject)
    ws.on('open', () =>
      resolve({
        send: (msg) => ws.send(JSON.stringify(msg)),
        next: (type, timeoutMs = 5000) =>
          new Promise((res, rej) => {
            const deadline = Date.now() + timeoutMs
            const poll = setInterval(() => {
              const idx = queue.findIndex((m) => m['type'] === type)
              if (idx >= 0) {
                clearInterval(poll)
                res(queue.splice(idx, 1)[0]!)
              } else if (Date.now() > deadline) {
                clearInterval(poll)
                rej(
                  new Error(
                    `timed out waiting for "${type}" (queued: ${queue.map((m) => m['type']).join(', ') || 'none'})`,
                  ),
                )
              }
            }, 10)
          }),
        silence: (type, windowMs = 400) =>
          new Promise((res, rej) => {
            setTimeout(() => {
              const hit = queue.find((m) => m['type'] === type)
              if (hit) rej(new Error(`expected no "${type}" but got one`))
              else res()
            }, windowMs)
          }),
        close: () => ws.close(),
      }),
    )
  })
}

beforeAll(async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'relay-test-'))
  server = spawn('./node_modules/.bin/tsx', ['server/index.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_FILE: path.join(dataDir, 'sessions.json'),
      SESSION_GRACE_MS: '60000',
    },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('relay server did not come up')
    await new Promise((r) => setTimeout(r, 200))
  }
}, 30_000)

afterAll(() => {
  server?.kill('SIGKILL')
})

describe('relay server', () => {
  it('reports health', async () => {
    const res = await fetch(`${BASE}/healthz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['ok']).toBe(true)
    expect(body['dataWritable']).toBe(true)
  })

  it('rejects a malformed PIN with a coded error', async () => {
    const dock = await connect()
    dock.send({ type: 'create', name: 'Bad', pin: '12' })
    const err = await dock.next('error')
    expect(err['code']).toBe('bad-request')
    dock.close()
  })

  it('answers heartbeat pings', async () => {
    const client = await connect()
    client.send({ type: 'ping' })
    await client.next('pong')
    client.close()
  })

  it('runs the full session lifecycle', async () => {
    // --- create ---------------------------------------------------------
    const dockA = await connect()
    dockA.send({ type: 'create', name: 'Wedding', pin: '1234' })
    const created = await dockA.next('created')
    const code = String(created['code'])
    const token = String(created['token'])
    expect(code).toHaveLength(6)

    // --- join: wrong PIN is coded, right PIN gets the cached state ------
    const remote = await connect()
    remote.send({ type: 'join', code, pin: '9999' })
    expect((await remote.next('error'))['code']).toBe('wrong-pin')

    remote.send({ type: 'join', code, pin: '1234' })
    const joined = await remote.next('joined')
    expect(joined['name']).toBe('Wedding')
    expect(joined['dockOnline']).toBe(true)
    await dockA.next('peers')

    // --- command forwarding: remote → dock ------------------------------
    remote.send({ type: 'command', request: 'SetCurrentProgramScene', params: { sceneName: 'SECOND' } })
    const cmd = await dockA.next('command')
    expect(cmd['request']).toBe('SetCurrentProgramScene')

    // --- state fan-out: valid mirrors, malformed is dropped -------------
    dockA.send({ type: 'state', state: STATE })
    const mirrored = await remote.next('state')
    expect((mirrored['state'] as Record<string, unknown>)['currentScene']).toBe('MAIN')

    dockA.send({ type: 'state', state: { foo: 1 } })
    await remote.silence('state')

    // --- dock drop: remotes told, session survives ----------------------
    dockA.close()
    const status = await remote.next('dock-status')
    expect(status['online']).toBe(false)

    // --- resume with the token ------------------------------------------
    const dockB = await connect()
    dockB.send({ type: 'resume', code, token })
    const resumed = await dockB.next('resumed')
    expect(resumed['code']).toBe(code)
    expect((await remote.next('dock-status'))['online']).toBe(true)

    // --- a second dock resuming supersedes the first ---------------------
    const dockC = await connect()
    dockC.send({ type: 'resume', code, token })
    await dockC.next('resumed')
    await dockB.next('superseded')

    // commands now land on the winning dock
    remote.send({ type: 'command', request: 'GetVersion' })
    expect((await dockC.next('command'))['request']).toBe('GetVersion')

    // --- resume with a bad token is a definitive 'expired' ---------------
    const impostor = await connect()
    impostor.send({ type: 'resume', code, token: 'wrong-token' })
    expect((await impostor.next('error'))['code']).toBe('expired')
    impostor.close()

    // --- end: everyone is told -------------------------------------------
    dockC.send({ type: 'end' })
    await remote.next('ended')
    dockB.close()
    dockC.close()
    remote.close()
  }, 20_000)
})
