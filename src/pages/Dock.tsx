import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useObs } from '../lib/useObs'
import { connectRelay } from '../lib/relay'
import type { RelayHandle } from '../lib/relay'
import ControlPanel from '../components/ControlPanel'
import LayerPanel from '../components/LayerPanel'
import SetupChecklist from '../components/SetupChecklist'
import SetupPanel from '../components/SetupPanel'
import Shell from '../components/Shell'
import Toast from '../components/Toast'
import type { ObsState } from '../../shared/protocol'
import { MEDIA_INPUT, isSetupReady, parseScene } from '../lib/scenes'
import type { Selection } from '../lib/scenes'
import type { MediaPrefs } from '../components/MediaPanel'

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

const DEFAULT_MEDIA_PREFS: MediaPrefs = { autoPlayFullscreen: true, autoPlayPip: false, autoReturn: true }

function loadMediaPrefs(): MediaPrefs {
  try {
    const raw = localStorage.getItem('media-prefs')
    if (raw) return { ...DEFAULT_MEDIA_PREFS, ...(JSON.parse(raw) as Partial<MediaPrefs>) }
  } catch {
    // fall through
  }
  // migrate the old single auto-return flag
  return { ...DEFAULT_MEDIA_PREFS, autoReturn: localStorage.getItem('media-auto-return') !== '0' }
}

/** How media appears in the given selection, if at all */
function mediaRole(sel: Selection | null): 'fullscreen' | 'pip' | null {
  if (!sel) return null
  if (sel.mode === 'fullscreen') return sel.source === 'media' ? 'fullscreen' : null
  if (sel.mode === 'split') return sel.featured === 'media' || sel.secondary === 'media' ? 'pip' : null
  return null
}

export default function Dock() {
  const { status: obsStatus, error: obsError, state, connect, call, query, subscribe, callError, clearCallError } =
    useObs()
  const [setupOpen, setSetupOpen] = useState(false)
  const obsReady = state === null || isSetupReady(state.scenes)

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
  const autoConnectTried = useRef(false)
  // JSON of the last state broadcast, so unchanged snapshots aren't re-sent
  const lastSentState = useRef('')
  const createRef = useRef<{ name: string; pin: string } | null>(null)
  const liveRef = useRef(false)
  const callRef = useRef(call)
  callRef.current = call
  const stateRef = useRef<ObsState | null>(state)
  stateRef.current = state
  const obsConnectedRef = useRef(false)
  obsConnectedRef.current = obsStatus === 'connected'
  const [mediaPrefs, setMediaPrefs] = useState<MediaPrefs>(loadMediaPrefs)
  const mediaPrefsRef = useRef(mediaPrefs)
  mediaPrefsRef.current = mediaPrefs
  const prevLayoutRef = useRef<string | null>(null)
  const lastSceneRef = useRef<string | null>(null)
  const mediaNormalizedRef = useRef(false)

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
            if (stateRef.current) {
              lastSentState.current = JSON.stringify(stateRef.current)
              relayRef.current?.send({ type: 'state', state: stateRef.current })
            }
            relayRef.current?.send({ type: 'obs-status', connected: obsConnectedRef.current })
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
            lastSentState.current = ''
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
        if (status === 'open') {
          setRelayError(null)
        } else if (status === 'closed') {
          if (liveRef.current) setSessionStatus('reconnecting')
          else setRelayError('Cannot reach the server — retrying…')
        }
      },
    })
  }, [])

  // Reconnect to OBS on load if we've connected successfully before, so page
  // reloads (dev hot reload, OBS restarts) go straight back to the panel
  // instead of the connect form.
  useEffect(() => {
    if (autoConnectTried.current) return
    autoConnectTried.current = true
    const url = localStorage.getItem('obs-url')
    if (url && localStorage.getItem('obs-auto-connect') === '1') {
      void connect(url, localStorage.getItem('obs-password') ?? '')
    }
  }, [connect])

  useEffect(() => {
    if (obsStatus === 'connected') localStorage.setItem('obs-auto-connect', '1')
  }, [obsStatus])

  // If OBS drops mid-session (crash, restart), keep retrying — the relay
  // session survives and remotes wait on the obs-status flag, so recovery
  // should not depend on the operator noticing and clicking Connect.
  useEffect(() => {
    if (obsStatus === 'connected' || obsStatus === 'connecting') return
    if (sessionStatus !== 'live' && sessionStatus !== 'reconnecting') return
    const url = localStorage.getItem('obs-url')
    if (!url) return
    const timer = setInterval(() => {
      void connect(url, localStorage.getItem('obs-password') ?? '')
    }, 5000)
    return () => clearInterval(timer)
  }, [obsStatus, sessionStatus, connect])

  // A session from a previous page load auto-resumes once OBS is connected
  useEffect(() => {
    if (obsStatus === 'connected' && storedRef.current && !relayRef.current) startRelay()
  }, [obsStatus, startRelay])

  // Remember the last non-media layout, and jump back to it when the media
  // video finishes playing on the fullscreen MEDIA scene (wedding flow: the
  // video ends and the stream lands back on the couple automatically).
  useEffect(() => {
    if (!state) return
    const sel = parseScene(state.currentScene)
    if (sel && !(sel.mode === 'fullscreen' && sel.source === 'media')) {
      prevLayoutRef.current = state.currentScene
    }
  }, [state])

  useEffect(
    () =>
      subscribe(['MediaInputPlaybackEnded'], () => {
        if (!mediaPrefsRef.current.autoReturn || !prevLayoutRef.current) return
        const sel = stateRef.current ? parseScene(stateRef.current.currentScene) : null
        if (sel?.mode === 'fullscreen' && sel.source === 'media') {
          void callRef.current('SetCurrentProgramScene', { sceneName: prevLayoutRef.current })
        }
      }),
    [subscribe],
  )

  // App-driven auto-play: when a scene change brings media onto program (and
  // the previous scene didn't show it), restart from 0:00 if that mode's
  // preference says so. Moving between pip and fullscreen keeps playing.
  useEffect(() => {
    if (!state) return
    const prev = lastSceneRef.current
    lastSceneRef.current = state.currentScene
    if (prev === null || prev === state.currentScene) return
    const nowRole = mediaRole(parseScene(state.currentScene))
    const prevRole = mediaRole(parseScene(prev))
    if (!nowRole || prevRole) return
    const enabled = nowRole === 'fullscreen' ? mediaPrefsRef.current.autoPlayFullscreen : mediaPrefsRef.current.autoPlayPip
    if (!enabled || !stateRef.current?.media?.file) return
    void callRef.current('TriggerMediaInputAction', {
      inputName: MEDIA_INPUT,
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    })
  }, [state])

  // Auto-play is app-driven now — make sure the OBS-side flag from older
  // collections is off so it can't double-trigger or play when unwanted.
  useEffect(() => {
    if (mediaNormalizedRef.current || obsStatus !== 'connected' || !state?.media) return
    mediaNormalizedRef.current = true
    void query<{ inputSettings: Record<string, unknown> }>('GetInputSettings', { inputName: MEDIA_INPUT })
      .then((r) => {
        if (r.inputSettings['restart_on_activate'] !== false) {
          return query('SetInputSettings', {
            inputName: MEDIA_INPUT,
            inputSettings: { restart_on_activate: false },
          }).then(() => undefined)
        }
        return undefined
      })
      .catch(() => {
        mediaNormalizedRef.current = false // retry on a later state change
      })
  }, [obsStatus, state, query])

  function updateMediaPrefs(patch: Partial<MediaPrefs>): void {
    setMediaPrefs((prev) => {
      const next = { ...prev, ...patch }
      localStorage.setItem('media-prefs', JSON.stringify(next))
      return next
    })
  }

  // Tell remotes when OBS itself drops or comes back on this machine
  useEffect(() => {
    if (sessionStatus !== 'live') return
    relayRef.current?.send({ type: 'obs-status', connected: obsStatus === 'connected' })
  }, [obsStatus, sessionStatus])

  // Mirror OBS state changes out to the remotes, skipping identical snapshots
  useEffect(() => {
    if (sessionStatus !== 'live' || !state) return
    const packed = JSON.stringify(state)
    if (packed === lastSentState.current) return
    lastSentState.current = packed
    relayRef.current?.send({ type: 'state', state })
  }, [state, sessionStatus])

  useEffect(() => () => relayRef.current?.close(), [])

  // A failed OBS command: show it here and fan it out to the remotes, so the
  // person who pressed the button gets feedback wherever they are.
  useEffect(() => {
    if (!callError) return
    relayRef.current?.send({ type: 'command-error', request: callError.request, message: callError.message })
    const timer = setTimeout(clearCallError, 5000)
    return () => clearTimeout(timer)
  }, [callError, clearCallError])

  const toast = callError ? <Toast message={`${callError.request} failed: ${callError.message}`} /> : null

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
    lastSentState.current = ''
    setCode(null)
    setRemoteCount(0)
    setSessionStatus('none')
  }

  if (obsStatus !== 'connected') {
    return (
      <Shell title="Connect to OBS" subtitle="This page runs on the streaming PC and talks to OBS directly.">
        {code !== null && (
          <div className="mb-3 rounded-xl border animate-fade-in border-transparent bg-ios-orange/15 px-3 py-2 text-base sm:text-sm text-ios-orange">
            Session <span className="font-mono font-semibold">{code}</span> is still active — reconnecting to OBS
            automatically…
          </div>
        )}
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
            <div className="rounded-xl border border-transparent bg-ios-red/15 px-3 py-2 text-base sm:text-sm text-ios-red">
              {obsError ?? 'Could not connect to OBS.'}
            </div>
          )}
          <button
            disabled={obsStatus === 'connecting'}
            className="w-full rounded-xl bg-ios-blue active:scale-[0.98] transition-all duration-200 ease-out px-3 py-2.5 text-base sm:text-sm font-semibold text-white hover:bg-ios-blue-light disabled:opacity-50"
          >
            {obsStatus === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
        </form>
        {toast}
      </Shell>
    )
  }

  if (sessionStatus === 'none' || sessionStatus === 'connecting') {
    return (
      <Shell title="Start a session" subtitle="Remotes join with the session code and the PIN you set here.">
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
          {relayError && <p className="text-base sm:text-sm text-ios-red">{relayError}</p>}
          <button
            disabled={pin.length < 4 || sessionStatus === 'connecting'}
            className="w-full rounded-xl bg-ios-blue active:scale-[0.98] transition-all duration-200 ease-out px-3 py-2.5 text-base sm:text-sm font-semibold text-white hover:bg-ios-blue-light disabled:opacity-50"
          >
            {sessionStatus === 'connecting' ? 'Starting…' : 'Start session'}
          </button>
        </form>
      </Shell>
    )
  }

  return (
    <div className="mx-auto max-w-3xl p-4">
      {sessionStatus === 'reconnecting' && (
        <div className="mb-3 rounded-xl border animate-fade-in border-transparent bg-ios-orange/15 px-3 py-2 text-base sm:text-sm text-ios-orange">
          Relay connection lost — reconnecting… OBS control keeps working locally.
        </div>
      )}
      <div className="mb-4 flex items-center justify-between rounded-2xl border border-transparent bg-ios-card px-4 py-3">
        <div>
          <div className="text-sm sm:text-xs text-ios-label2">Session code</div>
          <div className="font-mono text-2xl sm:text-xl font-bold tracking-widest text-white">{code}</div>
        </div>
        <div className="text-right text-sm sm:text-xs text-ios-label2">
          <div>{sessionName}</div>
          <div>
            {remoteCount} remote{remoteCount === 1 ? '' : 's'} connected
          </div>
          <div className="mt-1 flex justify-end gap-3">
            <button
              onClick={() => setSetupOpen(true)}
              className={obsReady ? 'text-ios-blue hover:text-ios-blue-light' : 'text-ios-orange hover:text-ios-orange/80'}
            >
              Setup
            </button>
            <button onClick={endSession} className="text-ios-red hover:text-ios-red/80">
              End session
            </button>
          </div>
        </div>
      </div>
      {state && (
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-4">
          <div className="min-w-0 flex-1">
            <ControlPanel state={state} send={call} mediaPrefs={{ value: mediaPrefs, onChange: updateMediaPrefs }} />
          </div>
          <div className="flex w-full shrink-0 flex-col gap-5 sm:w-52">
            <LayerPanel
              layers={state.layers}
              runningText={state.runningText}
              currentScene={state.currentScene}
              scenes={state.scenes}
              send={call}
            />
            <SetupChecklist
              query={query}
              subscribe={subscribe}
              scenes={state.scenes}
              media={state.media}
              layers={state.layers}
              runningText={state.runningText}
              onOpenSetup={() => setSetupOpen(true)}
            />
          </div>
        </div>
      )}
      {setupOpen && (
        <SetupPanel
          query={query}
          subscribe={subscribe}
          scenes={state?.scenes ?? []}
          onClose={() => setSetupOpen(false)}
        />
      )}
      {toast}
    </div>
  )
}

const inputCls =
  'w-full rounded-xl border border-transparent bg-ios-fill px-3 py-2 text-base sm:text-sm text-white outline-none focus:border-ios-blue'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm sm:text-xs text-ios-label2">{label}</span>
      {children}
    </label>
  )
}
