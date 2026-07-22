import { useCallback, useEffect, useRef, useState } from 'react'
import OBSWebSocket from 'obs-websocket-js'
import type { OBSEventTypes } from 'obs-websocket-js'
import type { LayerInfo, MediaPlayState, MediaStatus, ObsState } from '../../shared/protocol'
import { MEDIA_INPUT } from './scenes'
import { OVERLAY_SCENE, RUNNING_TEXT_INPUT } from './overlay'

export type ObsStatus = 'idle' | 'connecting' | 'connected' | 'error'

export type ObsCall = (request: string, params?: Record<string, unknown>) => Promise<void>

/** Like ObsCall but returns the response — for UI that needs to read OBS (rejects on failure). */
export type ObsQuery = <T = unknown>(request: string, params?: Record<string, unknown>) => Promise<T>

/** Listen to raw OBS events; returns an unsubscribe function. */
export type ObsSubscribe = (events: readonly (keyof OBSEventTypes)[], handler: () => void) => () => void

export interface CallError {
  request: string
  message: string
  /** Monotonic id so identical back-to-back errors still retrigger effects */
  id: number
}

// Any of these events invalidates our snapshot, so we just rebuild it.
const REFRESH_EVENTS: (keyof OBSEventTypes)[] = [
  'CurrentProgramSceneChanged',
  'SceneListChanged',
  'SceneCreated',
  'SceneRemoved',
  'SceneNameChanged',
  'StreamStateChanged',
  'RecordStateChanged',
  'CurrentSceneCollectionChanged',
  'MediaInputPlaybackStarted',
  'MediaInputPlaybackEnded',
  'MediaInputActionTriggered',
  'SceneItemEnableStateChanged',
  'SceneItemCreated',
  'SceneItemRemoved',
  'SceneItemListReindexed',
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
  try {
    const [status, settings] = await Promise.all([
      obs.call('GetMediaInputStatus', { inputName: MEDIA_INPUT }),
      obs.call('GetInputSettings', { inputName: MEDIA_INPUT }),
    ])
    const file = settings.inputSettings['local_file']
    return {
      file: typeof file === 'string' && file ? file : null,
      state: MEDIA_STATE_MAP[String(status.mediaState)] ?? 'none',
      cursorMs: typeof status.mediaCursor === 'number' ? status.mediaCursor : 0,
      durationMs: typeof status.mediaDuration === 'number' ? status.mediaDuration : 0,
    }
  } catch {
    // the media input doesn't exist yet — setup incomplete
    return null
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
  const [sceneList, stream, record, media, layers, runningText] = await Promise.all([
    obs.call('GetSceneList'),
    obs.call('GetStreamStatus'),
    obs.call('GetRecordStatus'),
    mediaSnapshot(obs),
    layersSnapshot(obs),
    runningTextSnapshot(obs),
  ])

  return {
    currentScene: sceneList.currentProgramSceneName,
    scenes: sceneList.scenes.map((s) => String(s.sceneName)).reverse(),
    streaming: stream.outputActive,
    recording: record.outputActive,
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

  const refresh = useCallback(async () => {
    try {
      setState(await snapshot(obs))
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
      obs
        .call(request as never, params as never)
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
    (request, params) => obs.call(request as never, params as never) as Promise<never>,
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
  // once a second so progress mirrors to every screen.
  const mediaPlaying = state?.media?.state === 'playing'
  useEffect(() => {
    if (!mediaPlaying) return
    const timer = setInterval(() => void refresh(), 1000)
    return () => clearInterval(timer)
  }, [mediaPlaying, refresh])

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

  return { status, error, state, connect, call, query, subscribe, callError, clearCallError }
}
