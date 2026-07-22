import { useCallback, useEffect, useRef, useState } from 'react'
import OBSWebSocket from 'obs-websocket-js'
import type { OBSEventTypes } from 'obs-websocket-js'
import type { AudioInput, ObsState } from '../../shared/protocol'

export type ObsStatus = 'idle' | 'connecting' | 'connected' | 'error'

export type ObsCall = (request: string, params?: Record<string, unknown>) => Promise<void>

// Any of these events invalidates our snapshot, so we just rebuild it.
const REFRESH_EVENTS: (keyof OBSEventTypes)[] = [
  'CurrentProgramSceneChanged',
  'SceneListChanged',
  'SceneCreated',
  'SceneRemoved',
  'SceneNameChanged',
  'StreamStateChanged',
  'RecordStateChanged',
  'InputMuteStateChanged',
  'InputVolumeChanged',
  'InputCreated',
  'InputRemoved',
  'InputNameChanged',
]

async function snapshot(obs: OBSWebSocket): Promise<ObsState> {
  const [sceneList, stream, record, inputList] = await Promise.all([
    obs.call('GetSceneList'),
    obs.call('GetStreamStatus'),
    obs.call('GetRecordStatus'),
    obs.call('GetInputList'),
  ])

  const audio: AudioInput[] = []
  for (const input of inputList.inputs) {
    const inputName = String(input.inputName)
    try {
      const [{ inputMuted }, { inputVolumeDb }] = await Promise.all([
        obs.call('GetInputMute', { inputName }),
        obs.call('GetInputVolume', { inputName }),
      ])
      audio.push({ name: inputName, muted: inputMuted, volumeDb: inputVolumeDb })
    } catch {
      // input has no audio track — skip it
    }
  }

  return {
    currentScene: sceneList.currentProgramSceneName,
    scenes: sceneList.scenes.map((s) => String(s.sceneName)).reverse(),
    streaming: stream.outputActive,
    recording: record.outputActive,
    audio,
  }
}

export function useObs() {
  const obsRef = useRef<OBSWebSocket | null>(null)
  if (!obsRef.current) obsRef.current = new OBSWebSocket()
  const obs = obsRef.current

  const [status, setStatus] = useState<ObsStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<ObsState | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

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
        setError(e instanceof Error ? e.message : 'Could not connect to OBS')
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
          console.error(`OBS ${request} failed:`, e instanceof Error ? e.message : e)
        }),
    [obs, scheduleRefresh],
  )

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

  return { status, error, state, connect, call }
}
