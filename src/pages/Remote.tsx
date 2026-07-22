import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { connectRelay } from '../lib/relay'
import type { RelayHandle } from '../lib/relay'
import ControlPanel from '../components/ControlPanel'
import type { ObsState } from '../../shared/protocol'

type Phase = 'form' | 'joining' | 'live' | 'ended'

export default function Remote() {
  const [code, setCode] = useState(() => localStorage.getItem('remote-code') ?? '')
  const [pin, setPin] = useState('')
  const [phase, setPhase] = useState<Phase>('form')
  const [error, setError] = useState<string | null>(null)
  const [sessionName, setSessionName] = useState('')
  const [state, setState] = useState<ObsState | null>(null)
  const [dockOnline, setDockOnline] = useState(true)
  const [relayDown, setRelayDown] = useState(false)

  const relayRef = useRef<RelayHandle | null>(null)
  const phaseRef = useRef<Phase>(phase)
  phaseRef.current = phase
  const credsRef = useRef<{ code: string; pin: string } | null>(null)

  function teardown(): void {
    relayRef.current?.close()
    relayRef.current = null
  }

  function join(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    credsRef.current = { code, pin }
    setPhase('joining')
    setError(null)
    teardown()
    relayRef.current = connectRelay({
      onOpen: () => {
        // Fires on every (re)connect, so a dropped remote rejoins by itself
        const creds = credsRef.current
        if (creds) relayRef.current?.send({ type: 'join', code: creds.code, pin: creds.pin })
      },
      onMessage: (msg) => {
        switch (msg.type) {
          case 'joined':
            setSessionName(msg.name)
            setState(msg.state)
            setDockOnline(msg.dockOnline)
            setRelayDown(false)
            localStorage.setItem('remote-code', credsRef.current?.code ?? '')
            setPhase('live')
            break
          case 'state':
            setState(msg.state)
            break
          case 'dock-status':
            setDockOnline(msg.online)
            break
          case 'ended':
            teardown()
            setPhase('ended')
            break
          case 'error':
            teardown()
            if (phaseRef.current === 'live') {
              // session died while we were reconnecting
              setPhase('ended')
            } else {
              setError(msg.message)
              setPhase('form')
            }
            break
          default:
            break
        }
      },
      onStatus: (status) => {
        if (status === 'closed' && phaseRef.current === 'live') setRelayDown(true)
      },
    })
  }

  useEffect(() => () => relayRef.current?.close(), [])

  const send = (request: string, params?: Record<string, unknown>): void => {
    relayRef.current?.send({ type: 'command', request, params })
  }

  if (phase === 'ended') {
    return (
      <Shell title="Session ended">
        <p className="mb-4 text-sm text-zinc-400">The session was closed or expired.</p>
        <button
          onClick={() => {
            setState(null)
            setPhase('form')
          }}
          className="w-full rounded-lg bg-sky-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-sky-500"
        >
          Join again
        </button>
      </Shell>
    )
  }

  if (phase !== 'live') {
    return (
      <Shell title="Join a session">
        <form onSubmit={join} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">Session code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
              className={`${inputCls} font-mono text-lg tracking-widest`}
              placeholder="ABC123"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">PIN</span>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              inputMode="numeric"
              className={inputCls}
              placeholder="1234"
            />
          </label>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            disabled={code.length < 6 || pin.length < 4 || phase === 'joining'}
            className="w-full rounded-lg bg-sky-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {phase === 'joining' ? 'Joining…' : 'Join'}
          </button>
        </form>
      </Shell>
    )
  }

  const blocked = relayDown || !dockOnline

  return (
    <div className="mx-auto max-w-lg p-4">
      {relayDown && (
        <div className="mb-3 rounded-lg border border-amber-700/50 bg-amber-950/50 px-3 py-2 text-sm text-amber-400">
          Connection lost — reconnecting…
        </div>
      )}
      {!relayDown && !dockOnline && (
        <div className="mb-3 rounded-lg border border-amber-700/50 bg-amber-950/50 px-3 py-2 text-sm text-amber-400">
          The dock is offline — waiting for it to come back.
        </div>
      )}
      <div className="mb-4 flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
        <div>
          <div className="text-xs text-zinc-400">Connected to</div>
          <div className="font-semibold">{sessionName}</div>
        </div>
        <span className="rounded-full bg-sky-600/20 px-2.5 py-1 text-xs font-medium text-sky-400">Remote</span>
      </div>
      {state ? (
        <div className={blocked ? 'pointer-events-none opacity-50' : undefined}>
          <ControlPanel state={state} send={send} />
        </div>
      ) : (
        <p className="text-sm text-zinc-400">Waiting for the dock to send its first state…</p>
      )}
    </div>
  )
}

const inputCls =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500'

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-sm p-4 pt-10">
      <h1 className="mb-4 text-lg font-semibold">{title}</h1>
      {children}
    </div>
  )
}
