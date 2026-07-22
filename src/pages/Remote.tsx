import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { connectRelay } from '../lib/relay'
import type { RelayHandle } from '../lib/relay'
import ControlPanel from '../components/ControlPanel'
import LayerPanel from '../components/LayerPanel'
import Shell from '../components/Shell'
import Toast from '../components/Toast'
import type { ObsState } from '../../shared/protocol'
import { isSetupReady } from '../lib/scenes'

type Phase = 'form' | 'joining' | 'live' | 'ended'

export default function Remote() {
  const [code, setCode] = useState(() => localStorage.getItem('remote-code') ?? '')
  const [pin, setPin] = useState('')
  const [phase, setPhase] = useState<Phase>('form')
  const [error, setError] = useState<string | null>(null)
  const [sessionName, setSessionName] = useState('')
  const [state, setState] = useState<ObsState | null>(null)
  const [dockOnline, setDockOnline] = useState(true)
  const [obsConnected, setObsConnected] = useState(true)
  const [relayDown, setRelayDown] = useState(false)
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null)

  const relayRef = useRef<RelayHandle | null>(null)
  const phaseRef = useRef<Phase>(phase)
  phaseRef.current = phase
  const credsRef = useRef<{ code: string; pin: string } | null>(null)
  const toastId = useRef(0)

  // Auto-dismiss command failure notices
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])

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
            setObsConnected(msg.obsConnected)
            setRelayDown(false)
            setError(null)
            localStorage.setItem('remote-code', credsRef.current?.code ?? '')
            setPhase('live')
            break
          case 'state':
            setState(msg.state)
            break
          case 'dock-status':
            setDockOnline(msg.online)
            break
          case 'obs-status':
            setObsConnected(msg.connected)
            break
          case 'command-error':
            setToast({ text: `${msg.request} failed: ${msg.message}`, id: ++toastId.current })
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
        if (status !== 'closed') return
        if (phaseRef.current === 'live') setRelayDown(true)
        else if (phaseRef.current === 'joining') setError('Cannot reach the server — retrying…')
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
        <p className="mb-4 text-sm text-ios-label2">The session was closed or expired.</p>
        <button
          onClick={() => {
            setState(null)
            setPhase('form')
          }}
          className="w-full rounded-xl bg-ios-blue active:scale-[0.98] transition-all duration-200 ease-out px-3 py-2.5 text-sm font-semibold text-white hover:bg-ios-blue-light"
        >
          Join again
        </button>
      </Shell>
    )
  }

  if (phase !== 'live') {
    return (
      <Shell title="Join a session" subtitle="The code and PIN are shown in the dock on the streaming PC.">
        <form onSubmit={join} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-ios-label2">Session code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
              className={`${inputCls} font-mono text-lg tracking-widest`}
              placeholder="ABC123"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-ios-label2">PIN</span>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              inputMode="numeric"
              className={inputCls}
              placeholder="1234"
            />
          </label>
          {error && <p className="text-sm text-ios-red">{error}</p>}
          <button
            disabled={code.length < 6 || pin.length < 4 || phase === 'joining'}
            className="w-full rounded-xl bg-ios-blue active:scale-[0.98] transition-all duration-200 ease-out px-3 py-2.5 text-sm font-semibold text-white hover:bg-ios-blue-light disabled:opacity-50"
          >
            {phase === 'joining' ? 'Joining…' : 'Join'}
          </button>
        </form>
      </Shell>
    )
  }

  const blocked = relayDown || !dockOnline || !obsConnected
  const notice = relayDown
    ? 'Connection lost — reconnecting…'
    : !dockOnline
      ? 'The dock is offline — waiting for it to come back.'
      : !obsConnected
        ? 'OBS is disconnected on the streaming PC — controls resume when it comes back.'
        : null

  return (
    <div className="mx-auto max-w-3xl p-4">
      {notice && (
        <div className="mb-3 animate-fade-in rounded-xl border border-transparent bg-ios-orange/15 px-3 py-2 text-sm text-ios-orange">
          {notice}
        </div>
      )}
      <div className="mb-4 flex items-center justify-between rounded-2xl border border-transparent bg-ios-card px-4 py-3">
        <div>
          <div className="text-xs text-ios-label2">Connected to</div>
          <div className="font-semibold">{sessionName}</div>
        </div>
        <div className="flex items-center gap-2">
          {state !== null && !isSetupReady(state.scenes) && (
            <span className="animate-fade-in rounded-full bg-ios-orange/15 px-2.5 py-1 text-xs font-medium text-ios-orange">
              OBS setup needed
            </span>
          )}
          <span className="rounded-full bg-ios-fill px-2.5 py-1 text-xs font-medium text-ios-label2">Remote</span>
        </div>
      </div>
      {state ? (
        <div className={`flex items-start gap-4 ${blocked ? 'pointer-events-none opacity-50' : ''}`}>
          <div className="min-w-0 flex-1">
            <ControlPanel state={state} send={send} />
          </div>
          <LayerPanel
            layers={state.layers}
            runningText={state.runningText}
            currentScene={state.currentScene}
            scenes={state.scenes}
            send={send}
          />
        </div>
      ) : (
        <p className="text-sm text-ios-label2">Waiting for the dock to send its first state…</p>
      )}
      {toast && <Toast message={toast.text} />}
    </div>
  )
}

const inputCls =
  'w-full rounded-xl border border-transparent bg-ios-fill px-3 py-2 text-sm text-white outline-none focus:border-ios-blue'
