import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { connectRelay } from '../lib/relay'
import type { RelayHandle } from '../lib/relay'
import ControlPanel from '../components/ControlPanel'
import LayerPanel from '../components/LayerPanel'
import Shell from '../components/Shell'
import Toast from '../components/Toast'
import type { ObsState } from '../../shared/protocol'
import { isSetupReady } from '../lib/scenes'
import { storageGet, storageSet } from '../lib/storage'
import { inputCls, primaryBtnCls } from '../components/ui'

type Phase = 'form' | 'joining' | 'live' | 'ended'

export default function Remote() {
  const [code, setCode] = useState(() => storageGet('remote-code') ?? '')
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

  const startJoin = useCallback((joinCode: string, joinPin: string): void => {
    credsRef.current = { code: joinCode, pin: joinPin }
    setPhase('joining')
    setError(null)
    relayRef.current?.close()
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
            storageSet('remote-code', credsRef.current?.code ?? '')
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
  }, [])

  function join(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    startJoin(code, pin)
  }

  // A scanned QR link arrives as /remote?code=…&pin=… — join straight away and
  // scrub the credentials from the address bar so they don't linger in history.
  const [searchParams, setSearchParams] = useSearchParams()
  const autoJoinTried = useRef(false)
  useEffect(() => {
    if (autoJoinTried.current) return
    autoJoinTried.current = true
    const qCode = (searchParams.get('code') ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6)
    const qPin = (searchParams.get('pin') ?? '').replace(/\D/g, '').slice(0, 8)
    if (!qCode) return
    setCode(qCode)
    setPin(qPin)
    setSearchParams({}, { replace: true })
    if (qCode.length === 6 && qPin.length >= 4) startJoin(qCode, qPin)
  }, [searchParams, setSearchParams, startJoin])

  useEffect(() => () => relayRef.current?.close(), [])

  const send = (request: string, params?: Record<string, unknown>): void => {
    relayRef.current?.send({ type: 'command', request, params })
  }

  if (phase === 'ended') {
    return (
      <Shell title="Session ended">
        <p className="mb-4 text-base sm:text-sm text-ios-label2">The session was closed or expired.</p>
        <button
          onClick={() => {
            setState(null)
            setPhase('form')
          }}
          className={primaryBtnCls}
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
            <span className="mb-1 block text-sm sm:text-xs text-ios-label2">Session code</span>
            <input
              value={code}
              onChange={(e) =>
                setCode(
                  e.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, '')
                    .slice(0, 6),
                )
              }
              className={`${inputCls} font-mono text-xl sm:text-lg tracking-widest`}
              placeholder="ABC123"
              autoFocus
            />
            <p className="mt-1 text-sm sm:text-xs text-ios-label3">6 characters, shown big in the dock.</p>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm sm:text-xs text-ios-label2">PIN</span>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              inputMode="numeric"
              className={inputCls}
              placeholder="1234"
            />
            <p className="mt-1 text-sm sm:text-xs text-ios-label3">4–8 digits, set when the session was started.</p>
          </label>
          {error && <p className="text-base sm:text-sm text-ios-red">{error}</p>}
          <button disabled={code.length < 6 || pin.length < 4 || phase === 'joining'} className={primaryBtnCls}>
            {phase === 'joining' ? 'Joining…' : 'Join'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm sm:text-xs text-ios-label3">
          Faster: press <span className="text-ios-label2">Invite</span> on the dock and scan the QR code — it joins with
          nothing to type.
        </p>
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
        <div className="mb-3 animate-fade-in rounded-xl border border-transparent bg-ios-orange/15 px-3 py-2 text-base sm:text-sm text-ios-orange">
          {notice}
        </div>
      )}
      <div className="mb-4 flex items-center justify-between rounded-2xl border border-transparent bg-ios-card px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm sm:text-xs text-ios-label2">Connected to</div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate font-semibold">{sessionName}</span>
            <span className="shrink-0 rounded-md bg-ios-fill px-1.5 py-0.5 font-mono text-xs text-ios-label2">
              {code}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state !== null && !isSetupReady(state.scenes) && (
            <span className="animate-fade-in rounded-full bg-ios-orange/15 px-2.5 py-1 text-sm sm:text-xs font-medium text-ios-orange">
              OBS setup needed
            </span>
          )}
          <span className="rounded-full bg-ios-fill px-2.5 py-1 text-sm sm:text-xs font-medium text-ios-label2">
            Remote
          </span>
          <button
            onClick={() => {
              teardown()
              setState(null)
              setPhase('form')
            }}
            className="text-sm sm:text-xs text-ios-red hover:text-ios-red/80"
          >
            Leave
          </button>
        </div>
      </div>
      {state ? (
        <div
          className={`flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-4 ${
            blocked ? 'pointer-events-none opacity-50' : ''
          }`}
        >
          <div className="min-w-0 flex-1">
            <ControlPanel state={state} send={send} />
          </div>
          <div className="w-full shrink-0 sm:w-52">
            <LayerPanel
              layers={state.layers}
              runningText={state.runningText}
              currentScene={state.currentScene}
              scenes={state.scenes}
              send={send}
            />
          </div>
        </div>
      ) : (
        <p className="text-base sm:text-sm text-ios-label2">Waiting for the dock to send its first state…</p>
      )}
      {toast && <Toast message={toast.text} />}
    </div>
  )
}
