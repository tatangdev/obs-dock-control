import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useObs } from '../lib/useObs'
import { useDockSession } from '../lib/useDockSession'
import { useMediaBehaviors } from '../lib/useMediaBehaviors'
import ControlPanel from '../components/ControlPanel'
import LayerPanel from '../components/LayerPanel'
import SetupChecklist from '../components/SetupChecklist'
import SetupPanel from '../components/SetupPanel'
import ShareCard, { QrIcon } from '../components/ShareCard'
import Shell from '../components/Shell'
import Toast from '../components/Toast'
import { isSetupReady } from '../lib/scenes'
import { storageGet, storageSet } from '../lib/storage'
import { inputCls, primaryBtnCls } from '../components/ui'

// The dock page: connects to OBS on the streaming PC, hosts the relay
// session remotes join, and renders the control surface. The session state
// machine lives in useDockSession; media automation in useMediaBehaviors.
export default function Dock() {
  const {
    status: obsStatus,
    error: obsError,
    state,
    connect,
    call,
    query,
    subscribe,
    watchMeters,
    callError,
    clearCallError,
  } = useObs()
  const obsConnected = obsStatus === 'connected'
  const [setupOpen, setSetupOpen] = useState(false)
  const obsReady = state === null || isSetupReady(state.scenes)

  const [obsUrl, setObsUrl] = useState(() => storageGet('obs-url') ?? 'ws://localhost:4455')
  const [obsPassword, setObsPassword] = useState(() => storageGet('obs-password') ?? '')
  const [pin, setPin] = useState('')

  const session = useDockSession({
    state,
    obsConnected,
    execute: useCallback((request, params) => void call(request, params), [call]),
  })
  const { prefs: mediaPrefs, updatePrefs: updateMediaPrefs } = useMediaBehaviors({
    state,
    obsConnected,
    call,
    query,
    subscribe,
  })

  const [qrOpen, setQrOpen] = useState(false)
  // Ending a session kicks every remote — never on a single tap
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [attentionCount, setAttentionCount] = useState(0)
  const onAttentionChange = useCallback((count: number) => setAttentionCount(count), [])
  const autoConnectTried = useRef(false)

  // Reconnect to OBS on load if we've connected successfully before, so page
  // reloads (dev hot reload, OBS restarts) go straight back to the panel
  // instead of the connect form.
  useEffect(() => {
    if (autoConnectTried.current) return
    autoConnectTried.current = true
    const url = storageGet('obs-url')
    if (url && storageGet('obs-auto-connect') === '1') {
      void connect(url, storageGet('obs-password') ?? '')
    }
  }, [connect])

  useEffect(() => {
    if (obsConnected) storageSet('obs-auto-connect', '1')
  }, [obsConnected])

  // If OBS drops mid-session (crash, restart), keep retrying — the relay
  // session survives and remotes wait on the obs-status flag, so recovery
  // should not depend on the operator noticing and clicking Connect.
  useEffect(() => {
    if (obsStatus === 'connected' || obsStatus === 'connecting') return
    if (session.status !== 'live' && session.status !== 'reconnecting') return
    const url = storageGet('obs-url')
    if (!url) return
    const timer = setInterval(() => {
      void connect(url, storageGet('obs-password') ?? '')
    }, 5000)
    return () => clearInterval(timer)
  }, [obsStatus, session.status, connect])

  // The invite card is the first thing needed at an event: open it whenever
  // the session is live with nobody connected, close it when the first remote
  // arrives. Manual toggling still works in between.
  const prevRemoteCount = useRef(0)
  useEffect(() => {
    if (session.status === 'live' && session.remoteCount === 0) setQrOpen(true)
    else if (session.remoteCount > 0 && prevRemoteCount.current === 0) setQrOpen(false)
    prevRemoteCount.current = session.remoteCount
  }, [session.status, session.remoteCount])

  // An armed end-session confirm disarms itself if left alone
  useEffect(() => {
    if (!confirmEnd) return
    const timer = setTimeout(() => setConfirmEnd(false), 5000)
    return () => clearTimeout(timer)
  }, [confirmEnd])

  // A failed OBS command: show it here and fan it out to the remotes, so the
  // person who pressed the button gets feedback wherever they are.
  const { sendCommandError } = session
  useEffect(() => {
    if (!callError) return
    sendCommandError(callError.request, callError.message)
    const timer = setTimeout(clearCallError, 5000)
    return () => clearTimeout(timer)
  }, [callError, clearCallError, sendCommandError])

  const toast = callError ? <Toast message={`${callError.request} failed: ${callError.message}`} /> : null

  function connectObs(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    storageSet('obs-url', obsUrl)
    storageSet('obs-password', obsPassword)
    void connect(obsUrl, obsPassword)
  }

  function startSession(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    session.start(session.name, pin)
  }

  function endSession(): void {
    setQrOpen(false)
    setConfirmEnd(false)
    session.end()
  }

  if (session.takenOver) {
    return (
      <Shell
        title="Session open in another window"
        subtitle="Another dock window (a second tab, or the dock inside OBS) resumed this session and is controlling it now."
      >
        <div className="space-y-3">
          <button onClick={session.reclaim} className={primaryBtnCls}>
            Use this window instead
          </button>
          <p className="text-center text-sm sm:text-xs text-ios-label3">
            Only one dock window can run the session — close the one you don&apos;t use.
          </p>
        </div>
      </Shell>
    )
  }

  if (!obsConnected) {
    return (
      <Shell title="Connect to OBS" subtitle="This page runs on the streaming PC and talks to OBS directly.">
        {session.code !== null && (
          <div className="mb-3 rounded-xl border animate-fade-in border-transparent bg-ios-orange/15 px-3 py-2 text-base sm:text-sm text-ios-orange">
            Session <span className="font-mono font-semibold">{session.code}</span> is still active — reconnecting to
            OBS automatically…
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
          <button disabled={obsStatus === 'connecting'} className={primaryBtnCls}>
            {obsStatus === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
        </form>
        {toast}
      </Shell>
    )
  }

  if (session.status === 'none' || session.status === 'connecting') {
    return (
      <Shell title="Start a session" subtitle="Remotes join with the session code and the PIN you set here.">
        <form onSubmit={startSession} className="space-y-3">
          <Field label="Session name">
            <input value={session.name} onChange={(e) => session.setName(e.target.value)} className={inputCls} />
          </Field>
          <Field label="PIN">
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              inputMode="numeric"
              className={inputCls}
              placeholder="e.g. 1234"
            />
            <p className="mt-1 text-sm sm:text-xs text-ios-label3">4–8 digits — remotes need it to join.</p>
          </Field>
          {session.error && <p className="text-base sm:text-sm text-ios-red">{session.error}</p>}
          <button disabled={pin.length < 4 || session.status === 'connecting'} className={primaryBtnCls}>
            {session.status === 'connecting' ? 'Starting…' : 'Start session'}
          </button>
        </form>
        {/* First-time OBS setup must not require inventing a session first */}
        <button
          onClick={() => setSetupOpen(true)}
          className={`mt-4 w-full text-center text-sm sm:text-xs ${
            obsReady ? 'text-ios-blue hover:text-ios-blue-light' : 'text-ios-orange hover:text-ios-orange/80'
          }`}
        >
          {obsReady ? 'OBS setup' : 'OBS setup — needs attention'}
        </button>
        {setupOpen && (
          <SetupPanel
            query={query}
            subscribe={subscribe}
            watchMeters={watchMeters}
            scenes={state?.scenes ?? []}
            onClose={() => setSetupOpen(false)}
          />
        )}
        {toast}
      </Shell>
    )
  }

  return (
    <div className="mx-auto max-w-3xl p-4">
      {session.status === 'reconnecting' && (
        <div className="mb-3 rounded-xl border animate-fade-in border-transparent bg-ios-orange/15 px-3 py-2 text-base sm:text-sm text-ios-orange">
          Relay connection lost — reconnecting… OBS control keeps working locally.
        </div>
      )}
      <div className="mb-4 flex items-center justify-between rounded-2xl border border-transparent bg-ios-card px-4 py-3">
        <div>
          <div className="text-sm sm:text-xs text-ios-label2">Session code</div>
          <div className="font-mono text-2xl sm:text-xl font-bold tracking-widest text-white">{session.code}</div>
        </div>
        <div className="text-right text-sm sm:text-xs text-ios-label2">
          <div>{session.name}</div>
          <div>
            {session.remoteCount} remote{session.remoteCount === 1 ? '' : 's'} connected
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            <button
              onClick={() => setQrOpen((v) => !v)}
              className={`inline-flex items-center gap-1 ${qrOpen ? 'text-white' : 'text-ios-blue hover:text-ios-blue-light'}`}
            >
              <QrIcon />
              Invite
            </button>
            <button
              onClick={() => setSetupOpen(true)}
              className={
                obsReady && attentionCount === 0
                  ? 'text-ios-blue hover:text-ios-blue-light'
                  : 'text-ios-orange hover:text-ios-orange/80'
              }
            >
              Setup
              {attentionCount > 0 && (
                <span className="ml-1 rounded-full bg-ios-orange/20 px-1.5 py-0.5 text-xs font-bold tabular-nums">
                  {attentionCount}
                </span>
              )}
            </button>
            {confirmEnd ? (
              <span className="inline-flex animate-fade-in items-center gap-2">
                <button
                  onClick={endSession}
                  className="rounded-lg bg-ios-red px-2 py-0.5 text-xs font-semibold text-white hover:bg-ios-red/80"
                >
                  End for everyone
                </button>
                <button onClick={() => setConfirmEnd(false)} className="text-ios-label2 hover:text-white">
                  Cancel
                </button>
              </span>
            ) : (
              <button onClick={() => setConfirmEnd(true)} className="text-ios-red hover:text-ios-red/80">
                End session
              </button>
            )}
          </div>
        </div>
      </div>
      {qrOpen && session.code !== null && <ShareCard code={session.code} pin={session.pin} />}
      {state && (
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-4">
          <div className="min-w-0 flex-1">
            <ControlPanel
              state={state}
              send={call}
              mediaPrefs={{ value: mediaPrefs, onChange: updateMediaPrefs }}
              watchMeters={watchMeters}
            />
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
              onItemsChange={onAttentionChange}
            />
          </div>
        </div>
      )}
      {setupOpen && (
        <SetupPanel
          query={query}
          subscribe={subscribe}
          watchMeters={watchMeters}
          scenes={state?.scenes ?? []}
          onClose={() => setSetupOpen(false)}
        />
      )}
      {toast}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm sm:text-xs text-ios-label2">{label}</span>
      {children}
    </label>
  )
}
