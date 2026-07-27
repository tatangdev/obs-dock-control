import { useCallback, useEffect, useRef, useState } from 'react'
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js'
import type { OBSEventTypes } from 'obs-websocket-js'
import type {
  AudioTrack,
  LayerInfo,
  MediaPlayState,
  MediaSourceInfo,
  MediaStatus,
  ObsState,
} from '../../shared/protocol'
import { MEDIA_SCENE, PLAYABLE_KINDS } from './scenes'
import { AUDIO_INPUT, BACKGROUND_SCENE, OVERLAY_SCENE, RUNNING_TEXT_INPUT } from './overlay'

export type ObsStatus = 'idle' | 'connecting' | 'connected' | 'error'

export type ObsCall = (request: string, params?: Record<string, unknown>) => Promise<void>

/** Like ObsCall but returns the response — for UI that needs to read OBS (rejects on failure). */
export type ObsQuery = <T = unknown>(request: string, params?: Record<string, unknown>) => Promise<T>

/** Listen to raw OBS events; returns an unsubscribe function. */
export type ObsSubscribe = (events: readonly (keyof OBSEventTypes)[], handler: () => void) => () => void

/** Live peak level (dBFS) for one input; returns a stop function. */
export type ObsWatchMeters = (inputName: string, handler: (peakDb: number) => void) => () => void

export interface CallError {
  request: string
  message: string
  /** Monotonic id so identical back-to-back errors still retrigger effects */
  id: number
}

// obs-websocket-js has no request timeout: if OBS wedges, a call's promise
// hangs forever and the state mirror silently freezes. Bound every request.
const OBS_CALL_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${OBS_CALL_TIMEOUT_MS / 1000}s`)),
      OBS_CALL_TIMEOUT_MS,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

// Any of these events invalidates our snapshot, so we just rebuild it.
const REFRESH_EVENTS: (keyof OBSEventTypes)[] = [
  'CurrentProgramSceneChanged',
  'SceneListChanged',
  'SceneCreated',
  'SceneRemoved',
  'SceneNameChanged',
  'CurrentSceneCollectionChanged',
  'MediaInputPlaybackStarted',
  'MediaInputPlaybackEnded',
  'MediaInputActionTriggered',
  'SceneItemEnableStateChanged',
  'SceneItemCreated',
  'SceneItemRemoved',
  'SceneItemListReindexed',
  'InputVolumeChanged',
  'InputMuteStateChanged',
  // Not in obs-websocket-js 5.0 typings but emitted by obs-websocket >= 5.4;
  // keeps the running-text mirror fresh when it's edited inside OBS.
  'InputSettingsChanged' as keyof OBSEventTypes,
]

const MEDIA_STATE_MAP: Record<string, MediaPlayState> = {
  OBS_MEDIA_STATE_PLAYING: 'playing',
  OBS_MEDIA_STATE_OPENING: 'playing',
  OBS_MEDIA_STATE_BUFFERING: 'playing',
  OBS_MEDIA_STATE_PAUSED: 'paused',
  OBS_MEDIA_STATE_STOPPED: 'stopped',
  OBS_MEDIA_STATE_ENDED: 'ended',
}

async function mediaSnapshot(obs: OBSWebSocket): Promise<MediaStatus | null> {
  let items: Record<string, unknown>[]
  try {
    ;({ sceneItems: items } = await obs.call('GetSceneItemList', { sceneName: MEDIA_SCENE }))
  } catch {
    // no MEDIA scene — setup incomplete
    return null
  }
  // Every item except the nested overlay/background scenes is a media
  // candidate the operator can put on the media slots.
  const sources: MediaSourceInfo[] = items
    .filter((i) => i.sourceName !== OVERLAY_SCENE && i.sourceName !== BACKGROUND_SCENE)
    .map((i) => ({
      id: Number(i.sceneItemId),
      name: String(i.sourceName),
      kind: typeof i.inputKind === 'string' && i.inputKind ? i.inputKind : 'scene',
      visible: Boolean(i.sceneItemEnabled),
    }))
    .reverse() // OBS lists bottom-to-top; top-most (what renders on top) first

  const active = sources.find((s) => s.visible) ?? null
  const playable = active !== null && PLAYABLE_KINDS.has(active.kind)
  const base: MediaStatus = {
    sources,
    active: active?.name ?? null,
    playable,
    file: null,
    state: 'none',
    cursorMs: 0,
    durationMs: 0,
  }
  if (!playable || !active) return base

  try {
    const [status, settings] = await Promise.all([
      obs.call('GetMediaInputStatus', { inputName: active.name }),
      obs.call('GetInputSettings', { inputName: active.name }),
    ])
    const file = settings.inputSettings['local_file']
    return {
      ...base,
      file: typeof file === 'string' && file ? file : null,
      state: MEDIA_STATE_MAP[String(status.mediaState)] ?? 'none',
      cursorMs: typeof status.mediaCursor === 'number' ? status.mediaCursor : 0,
      durationMs: typeof status.mediaDuration === 'number' ? status.mediaDuration : 0,
    }
  } catch {
    return base
  }
}

async function layersSnapshot(obs: OBSWebSocket): Promise<LayerInfo[]> {
  try {
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: OVERLAY_SCENE })
    return sceneItems
      .map((item) => ({
        id: Number(item.sceneItemId),
        name: String(item.sourceName),
        enabled: Boolean(item.sceneItemEnabled),
      }))
      .reverse() // OBS lists bottom-to-top; show the top-most layer first
  } catch {
    // no OVERLAY scene — setup incomplete
    return []
  }
}

async function audioTrackSnapshot(obs: OBSWebSocket, inputName: string): Promise<AudioTrack | null> {
  try {
    const [volume, mute] = await Promise.all([
      obs.call('GetInputVolume', { inputName }),
      obs.call('GetInputMute', { inputName }),
    ])
    return { volumeDb: volume.inputVolumeDb, muted: mute.inputMuted }
  } catch {
    return null // input doesn't exist yet
  }
}

async function runningTextSnapshot(obs: OBSWebSocket): Promise<string | null> {
  try {
    const { inputSettings } = await obs.call('GetInputSettings', { inputName: RUNNING_TEXT_INPUT })
    const text = inputSettings['text']
    return typeof text === 'string' ? text : ''
  } catch {
    return null
  }
}

async function snapshot(obs: OBSWebSocket): Promise<ObsState> {
  const [sceneList, media, layers, runningText, audioIn] = await Promise.all([
    obs.call('GetSceneList'),
    mediaSnapshot(obs),
    layersSnapshot(obs),
    runningTextSnapshot(obs),
    audioTrackSnapshot(obs, AUDIO_INPUT),
  ])
  // The media fader follows whichever source is active in the MEDIA scene
  const mediaAudio = media?.active && media.playable ? await audioTrackSnapshot(obs, media.active) : null

  return {
    audio: { input: audioIn, media: mediaAudio },
    currentScene: sceneList.currentProgramSceneName,
    scenes: sceneList.scenes.map((s) => String(s.sceneName)).reverse(),
    layers,
    runningText,
    media,
  }
}

export function useObs() {
  const obsRef = useRef<OBSWebSocket | null>(null)
  if (!obsRef.current) obsRef.current = new OBSWebSocket()
  const obs = obsRef.current

  const [status, setStatus] = useState<ObsStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<ObsState | null>(null)
  const [callError, setCallError] = useState<CallError | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const callErrorId = useRef(0)

  // Snapshots overlap (events fire while one is in flight) and can resolve
  // out of order — a stale result must never overwrite a newer one, or the
  // wrong state mirrors out to every remote.
  const refreshSeq = useRef(0)
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current
    try {
      const snap = await withTimeout(snapshot(obs), 'OBS snapshot')
      if (seq === refreshSeq.current) setState(snap)
    } catch {
      // not connected or mid-shutdown; a later event will retrigger
    }
  }, [obs])

  // OBS fires bursts of events (volume drags especially) — coalesce refreshes
  const scheduleRefresh = useCallback(() => {
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => void refresh(), 120)
  }, [refresh])

  const connect = useCallback(
    async (url: string, password: string) => {
      setStatus('connecting')
      setError(null)
      try {
        await obs.connect(url, password || undefined)
        setStatus('connected')
        await refresh()
      } catch (e) {
        setStatus('error')
        // Connection failures often reject with an empty message — fall back
        // to something actionable instead of rendering nothing.
        const raw = e instanceof Error ? e.message.trim() : ''
        setError(
          raw ||
            `Could not reach OBS at ${url}. Make sure OBS is running and the WebSocket server is enabled (Tools → WebSocket Server Settings), then try again.`,
        )
      }
    },
    [obs, refresh],
  )

  const call = useCallback<ObsCall>(
    (request, params) =>
      withTimeout(obs.call(request as never, params as never), request)
        .then(() => scheduleRefresh())
        .catch((e: unknown) => {
          const raw = e instanceof Error ? e.message.trim() : ''
          const message = raw || (status === 'connected' ? 'Request failed' : 'Not connected to OBS')
          console.error(`OBS ${request} failed:`, message)
          setCallError({ request, message, id: ++callErrorId.current })
        }),
    [obs, scheduleRefresh, status],
  )

  const clearCallError = useCallback(() => setCallError(null), [])

  const query = useCallback<ObsQuery>(
    (request, params) => withTimeout(obs.call(request as never, params as never), request) as Promise<never>,
    [obs],
  )

  // Volume meters are a high-volume event stream, off by default — opt in
  // while at least one watcher is mounted (the Audio fader meter, the Setup
  // audio row), back out when the last one stops. Reference-counted: one
  // watcher unmounting must not kill the stream for the others.
  const meterWatchers = useRef(0)
  const watchMeters = useCallback<ObsWatchMeters>(
    (inputName, handler) => {
      if (++meterWatchers.current === 1) {
        void obs
          .reidentify({ eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters })
          .catch(() => {})
      }
      const onMeters = (data: { inputs: { inputName?: unknown; inputLevelsMul?: unknown }[] }): void => {
        const entry = data.inputs.find((i) => i.inputName === inputName)
        if (!entry || !Array.isArray(entry.inputLevelsMul)) return
        let peak = 0
        for (const channel of entry.inputLevelsMul as number[][]) {
          peak = Math.max(peak, channel[1] ?? channel[0] ?? 0)
        }
        handler(peak > 0 ? 20 * Math.log10(peak) : -100)
      }
      obs.on('InputVolumeMeters' as never, onMeters as never)
      return () => {
        obs.off('InputVolumeMeters' as never, onMeters as never)
        if (--meterWatchers.current === 0) {
          void obs.reidentify({ eventSubscriptions: EventSubscription.All }).catch(() => {})
        }
      }
    },
    [obs],
  )

  const subscribe = useCallback<ObsSubscribe>(
    (events, handler) => {
      for (const ev of events) obs.on(ev, handler)
      return () => {
        for (const ev of events) obs.off(ev, handler)
      }
    },
    [obs],
  )

  // While the video plays, the cursor advances without any OBS event — poll
  // once a second so progress mirrors to every screen. Media-status only:
  // a full snapshot every second for a 2-hour video is needless OBS load.
  const mediaPlaying = state?.media?.state === 'playing'
  const activeMedia = state?.media?.active ?? null
  useEffect(() => {
    if (!mediaPlaying || !activeMedia) return
    const timer = setInterval(() => {
      obs
        .call('GetMediaInputStatus', { inputName: activeMedia })
        .then((status) => {
          setState((prev) => {
            if (!prev?.media) return prev
            return {
              ...prev,
              media: {
                ...prev.media,
                state: MEDIA_STATE_MAP[String(status.mediaState)] ?? prev.media.state,
                cursorMs: typeof status.mediaCursor === 'number' ? status.mediaCursor : prev.media.cursorMs,
                durationMs: typeof status.mediaDuration === 'number' ? status.mediaDuration : prev.media.durationMs,
              },
            }
          })
        })
        .catch(() => {
          // input vanished mid-poll — the SceneItemRemoved event rebuilds
        })
    }, 1000)
    return () => clearInterval(timer)
  }, [mediaPlaying, activeMedia, obs])

  useEffect(() => {
    const onEvent = (): void => scheduleRefresh()
    for (const ev of REFRESH_EVENTS) obs.on(ev, onEvent)

    const onClosed = (): void => {
      setStatus((s) => (s === 'connected' ? 'idle' : s))
      setState(null)
    }
    obs.on('ConnectionClosed', onClosed)

    return () => {
      clearTimeout(timerRef.current)
      for (const ev of REFRESH_EVENTS) obs.off(ev, onEvent)
      obs.off('ConnectionClosed', onClosed)
    }
  }, [obs, scheduleRefresh])

  return { status, error, state, connect, call, query, subscribe, watchMeters, callError, clearCallError }
}
