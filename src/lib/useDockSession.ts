import { useCallback, useEffect, useRef, useState } from 'react'
import { connectRelay } from './relay'
import type { RelayHandle } from './relay'
import type { ObsState } from '../../shared/protocol'
import { storageGet, storageRemove, storageSet } from './storage'

// The dock's relay session state machine: create/resume with a persisted
// token, mirror OBS state to remotes, execute their commands (outputs
// blocked), and survive reloads, relay restarts and competing dock windows.

interface StoredSession {
  code: string
  token: string
  /** Kept so the QR join link survives dock reloads (absent on old sessions) */
  pin?: string
}

function loadStoredSession(): StoredSession | null {
  try {
    const raw = storageGet('dock-session')
    return raw ? (JSON.parse(raw) as StoredSession) : null
  } catch {
    return null
  }
}

export type SessionStatus = 'none' | 'connecting' | 'live' | 'reconnecting'

// The dock must never touch OBS outputs — block these even if a remote sends
// them through the generic command channel.
const BLOCKED_REQUESTS = new Set([
  'ToggleStream',
  'StartStream',
  'StopStream',
  'ToggleRecord',
  'StartRecord',
  'StopRecord',
  'ToggleRecordPause',
  'PauseRecord',
  'ResumeRecord',
  'StartReplayBuffer',
  'StopReplayBuffer',
  'ToggleReplayBuffer',
  'StartVirtualCam',
  'StopVirtualCam',
  'ToggleVirtualCam',
])
// Categorical backstop: an output-ish request added in a future obs-websocket
// version must not slip past the hand-enumerated list above.
const OUTPUT_REQUEST_PATTERN = /stream|record|replay|virtualcam|output/i

const isBlocked = (request: string): boolean => BLOCKED_REQUESTS.has(request) || OUTPUT_REQUEST_PATTERN.test(request)

export interface DockSessionArgs {
  /** Latest mirrored OBS state (null before the first snapshot) */
  state: ObsState | null
  obsConnected: boolean
  /** Executes a remote-issued OBS request on this machine */
  execute: (request: string, params?: Record<string, unknown>) => void
}

export interface DockSession {
  status: SessionStatus
  code: string | null
  pin: string | null
  name: string
  setName: (name: string) => void
  remoteCount: number
  error: string | null
  /** Another dock window resumed this session and owns it now */
  takenOver: boolean
  start: (name: string, pin: string) => void
  end: () => void
  /** After being superseded: deliberately take the session back into this window */
  reclaim: () => void
  /** Fan a failed command out to every remote */
  sendCommandError: (request: string, message: string) => void
}

export function useDockSession({ state, obsConnected, execute }: DockSessionArgs): DockSession {
  const [status, setStatus] = useState<SessionStatus>('none')
  const [code, setCode] = useState<string | null>(null)
  const [pin, setPin] = useState<string | null>(null)
  const [name, setName] = useState(() => storageGet('session-name') ?? 'My Stream')
  const [remoteCount, setRemoteCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [takenOver, setTakenOver] = useState(false)

  const relayRef = useRef<RelayHandle | null>(null)
  const storedRef = useRef<StoredSession | null>(loadStoredSession())
  const createRef = useRef<{ name: string; pin: string } | null>(null)
  const liveRef = useRef(false)
  // JSON of the last state message, so unchanged snapshots aren't re-sent
  const lastSent = useRef('')
  const executeRef = useRef(execute)
  executeRef.current = execute
  const stateRef = useRef(state)
  stateRef.current = state
  const obsConnectedRef = useRef(obsConnected)
  obsConnectedRef.current = obsConnected

  const resetSession = useCallback(() => {
    liveRef.current = false
    lastSent.current = ''
    relayRef.current?.close()
    relayRef.current = null
    setRemoteCount(0)
    setStatus('none')
  }, [])

  const startRelay = useCallback(() => {
    setStatus('connecting')
    setError(null)
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
            storedRef.current = { code: msg.code, token: msg.token, pin: createRef.current?.pin }
            storageSet('dock-session', JSON.stringify(storedRef.current))
            setCode(msg.code)
            setPin(createRef.current?.pin ?? null)
            liveRef.current = true
            setStatus('live')
            break
          case 'resumed':
            setCode(msg.code)
            setPin(storedRef.current?.pin ?? null)
            setName(msg.name)
            liveRef.current = true
            setStatus('live')
            // Remotes may have joined while we were away — refresh them
            if (stateRef.current) {
              lastSent.current = JSON.stringify({ type: 'state', state: stateRef.current })
              relayRef.current?.sendRaw(lastSent.current)
            }
            relayRef.current?.send({ type: 'obs-status', connected: obsConnectedRef.current })
            break
          case 'peers':
            setRemoteCount(msg.count)
            break
          case 'command':
            if (isBlocked(msg.request)) {
              relayRef.current?.send({
                type: 'command-error',
                request: msg.request,
                message: 'Output control is disabled — start or stop the stream in OBS itself',
              })
              break
            }
            executeRef.current(msg.request, msg.params)
            break
          case 'superseded':
            // The other window owns the session now; keep the token so
            // reclaim() can take it back deliberately.
            resetSession()
            setTakenOver(true)
            break
          case 'error':
            // Only a definitive 'expired' invalidates the stored session —
            // transient server errors must never destroy a recoverable one.
            if (storedRef.current && msg.code === 'expired') {
              storedRef.current = null
              storageRemove('dock-session')
              setError('Previous session expired — start a new one.')
            } else {
              setError(msg.message)
            }
            resetSession()
            break
          default:
            break
        }
      },
      onStatus: (relayStatus) => {
        if (relayStatus === 'open') {
          setError(null)
        } else if (relayStatus === 'closed') {
          if (liveRef.current) setStatus('reconnecting')
          else setError('Cannot reach the server — retrying…')
        }
      },
    })
  }, [resetSession])

  // A session from a previous page load resumes immediately — NOT gated on
  // OBS. If OBS takes longer than the server grace period to come back
  // (PC reboot, updates), the session must not die while the dock page is
  // open: remotes wait on the obs-status flag instead.
  useEffect(() => {
    if (storedRef.current && !relayRef.current) startRelay()
  }, [startRelay])

  // Tell remotes when OBS itself drops or comes back on this machine
  useEffect(() => {
    if (status !== 'live') return
    relayRef.current?.send({ type: 'obs-status', connected: obsConnected })
  }, [obsConnected, status])

  // Mirror OBS state changes out to the remotes, skipping identical
  // snapshots. The dedupe string is the wire payload — encoded exactly once.
  useEffect(() => {
    if (status !== 'live' || !state) return
    const packed = JSON.stringify({ type: 'state', state })
    if (packed === lastSent.current) return
    lastSent.current = packed
    relayRef.current?.sendRaw(packed)
  }, [state, status])

  useEffect(() => () => relayRef.current?.close(), [])

  const start = useCallback(
    (sessionName: string, sessionPin: string) => {
      storageSet('session-name', sessionName)
      setName(sessionName)
      createRef.current = { name: sessionName, pin: sessionPin }
      storedRef.current = null
      startRelay()
    },
    [startRelay],
  )

  const end = useCallback(() => {
    relayRef.current?.send({ type: 'end' })
    storedRef.current = null
    createRef.current = null
    storageRemove('dock-session')
    setCode(null)
    setPin(null)
    resetSession()
  }, [resetSession])

  const reclaim = useCallback(() => {
    setTakenOver(false)
    startRelay()
  }, [startRelay])

  const sendCommandError = useCallback((request: string, message: string) => {
    relayRef.current?.send({ type: 'command-error', request, message })
  }, [])

  return { status, code, pin, name, setName, remoteCount, error, takenOver, start, end, reclaim, sendCommandError }
}
