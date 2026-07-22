import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useObs } from '../lib/useObs'
import { connectRelay } from '../lib/relay'
import type { RelayHandle } from '../lib/relay'
import ControlPanel from '../components/ControlPanel'
import type { ObsState } from '../../shared/protocol'

interface StoredSession {
  code: string
  token: string
}

function loadStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem('dock-session')
    return raw ? (JSON.parse(raw) as StoredSession) : null
  } catch {
    return null
  }
}

type SessionStatus = 'none' | 'connecting' | 'live' | 'reconnecting'

export default function Dock() {
  const { status: obsStatus, error: obsError, state, connect, call } = useObs()

  const [obsUrl, setObsUrl] = useState(() => localStorage.getItem('obs-url') ?? 'ws://localhost:4455')
  const [obsPassword, setObsPassword] = useState(() => localStorage.getItem('obs-password') ?? '')
  const [sessionName, setSessionName] = useState(() => localStorage.getItem('session-name') ?? 'My Stream')
  const [pin, setPin] = useState('')

  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('none')
  const [code, setCode] = useState<string | null>(null)
  const [remoteCount, setRemoteCount] = useState(0)
  const [relayError, setRelayError] = useState<string | null>(null)

  const relayRef = useRef<RelayHandle | null>(null)
  const storedRef = useRef<StoredSession | null>(loadStoredSession())
  const createRef = useRef<{ name: string; pin: string } | null>(null)
  const liveRef = useRef(false)
  const callRef = useRef(call)
  callRef.current = call
  const stateRef = useRef<ObsState | null>(state)
  stateRef.current = state

  const startRelay = useCallback(() => {
    setSessionStatus('connecting')
    setRelayError(null)
    relayRef.current?.close()
    relayRef.current = connectRelay({
      onOpen: () => {
        // Fires on every (re)connect: reclaim our session if we have one,
        // otherwise create the one the user just asked for.
        const stored = storedRef.current
        if (stored) relayRef.current?.send({ type: 'resume', code: stored.code, token: stored.token })
        else if (createRef.current) relayRef.current?.send({ type: 'create', ...createRef.current })
      },
      onMessage: (msg) => {
        switch (msg.type) {
          case 'created':
            storedRef.current = { code: msg.code, token: msg.token }
            localStorage.setItem('dock-session', JSON.stringify(storedRef.current))
            setCode(msg.code)
            liveRef.current = true
            setSessionStatus('live')
            break
          case 'resumed':
            setCode(msg.code)
            setSessionName(msg.name)
            liveRef.current = true
            setSessionStatus('live')
            // Remotes may have joined while we were away — refresh them
            if (stateRef.current) relayRef.current?.send({ type: 'state', state: stateRef.current })
            break
          case 'peers':
            setRemoteCount(msg.count)
            break
          case 'command':
            void callRef.current(msg.request, msg.params)
            break
          case 'error':
            if (storedRef.current) {
              storedRef.current = null
              localStorage.removeItem('dock-session')
              setRelayError('Previous session expired — start a new one.')
            } else {
              setRelayError(msg.message)
            }
            liveRef.current = false
            relayRef.current?.close()
            relayRef.current = null
            setRemoteCount(0)
            setSessionStatus('none')
            break
          default:
            break
        }
      },
      onStatus: (status) => {
        if (status === 'closed' && liveRef.current) setSessionStatus('reconnecting')
      },
    })
  }, [])

  // A session from a previous page load auto-resumes once OBS is connected
  useEffect(() => {
    if (obsStatus === 'connected' && storedRef.current && !relayRef.current) startRelay()
  }, [obsStatus, startRelay])

  // Mirror every OBS state change out to the remotes
  useEffect(() => {
    if (sessionStatus === 'live' && state) {
      relayRef.current?.send({ type: 'state', state })
    }
  }, [state, sessionStatus])

  useEffect(() => () => relayRef.current?.close(), [])

  function connectObs(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    localStorage.setItem('obs-url', obsUrl)
    localStorage.setItem('obs-password', obsPassword)
    void connect(obsUrl, obsPassword)
  }

  function startSession(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    localStorage.setItem('session-name', sessionName)
    createRef.current = { name: sessionName, pin }
    storedRef.current = null
    startRelay()
  }

  function endSession(): void {
    relayRef.current?.send({ type: 'end' })
    relayRef.current?.close()
    relayRef.current = null
    storedRef.current = null
    createRef.current = null
    localStorage.removeItem('dock-session')
    liveRef.current = false
    setCode(null)
    setRemoteCount(0)
    setSessionStatus('none')
  }

  if (obsStatus !== 'connected') {
    return (
      <Shell title="Connect to OBS">
        <form onSubmit={connectObs} className="space-y-3">
          <Field label="OBS WebSocket URL">
            <input value={obsUrl} onChange={(e) => setObsUrl(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Password (Tools → WebSocket Server Settings)">
            <input
              type="password"
              value={obsPassword}
              onChange={(e) => setObsPassword(e.target.value)}
              className={inputCls}
              placeholder="leave empty if auth is disabled"
            />
          </Field>
          {obsStatus === 'error' && (
            <div className="rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-2 text-sm text-red-400">
              {obsError ?? 'Could not connect to OBS.'}
            </div>
          )}
          <button
            disabled={obsStatus === 'connecting'}
            className="w-full rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {obsStatus === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </Shell>
    )
  }

  if (sessionStatus === 'none' || sessionStatus === 'connecting') {
    return (
      <Shell title="Start a session">
        <form onSubmit={startSession} className="space-y-3">
          <Field label="Session name">
            <input value={sessionName} onChange={(e) => setSessionName(e.target.value)} className={inputCls} />
          </Field>
          <Field label="PIN (4-8 digits)">
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              inputMode="numeric"
              className={inputCls}
              placeholder="e.g. 1234"
            />
          </Field>
          {relayError && <p className="text-sm text-red-400">{relayError}</p>}
          <button
            disabled={pin.length < 4 || sessionStatus === 'connecting'}
            className="w-full rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {sessionStatus === 'connecting' ? 'Starting…' : 'Start session'}
          </button>
        </form>
      </Shell>
    )
  }

  return (
    <div className="mx-auto max-w-lg p-4">
      {sessionStatus === 'reconnecting' && (
        <div className="mb-3 rounded-lg border border-amber-700/50 bg-amber-950/50 px-3 py-2 text-sm text-amber-400">
          Relay connection lost — reconnecting… OBS control keeps working locally.
        </div>
      )}
      <div className="mb-4 flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
        <div>
          <div className="text-xs text-zinc-400">Session code</div>
          <div className="font-mono text-xl font-bold tracking-widest text-emerald-400">{code}</div>
        </div>
        <div className="text-right text-xs text-zinc-400">
          <div>{sessionName}</div>
          <div>
            {remoteCount} remote{remoteCount === 1 ? '' : 's'} connected
          </div>
          <button onClick={endSession} className="mt-1 text-red-400 hover:text-red-300">
            End session
          </button>
        </div>
      </div>
      {state && <ControlPanel state={state} send={call} />}
    </div>
  )
}

const inputCls =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500'

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-sm p-4 pt-10">
      <h1 className="mb-4 text-lg font-semibold">{title}</h1>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-zinc-400">{label}</span>
      {children}
    </label>
  )
}
