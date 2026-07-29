import { useCallback, useEffect, useRef, useState } from 'react'
import type { ObsState } from '../../shared/protocol'
import { mediaRole, parseScene, syncMediaClones } from './scenes'
import type { ObsCall, ObsQuery, ObsSubscribe } from './useObs'
import { storageGet, storageSet } from './storage'

// Dock-side media automation: auto-play on scene entry, auto-return when the
// video ends fullscreen, and normalizing OBS's restart_on_activate flag off.
// All behavior is app-driven so the per-mode preferences below stay in charge.

export interface MediaPrefs {
  /** Restart from 0:00 when a MEDIA fullscreen scene goes to program */
  autoPlayFullscreen: boolean
  /** Restart from 0:00 when media enters a split (PiP) slot on program */
  autoPlayPip: boolean
  /** Return to the previous layout when the video finishes on fullscreen */
  autoReturn: boolean
}

const DEFAULT_MEDIA_PREFS: MediaPrefs = { autoPlayFullscreen: true, autoPlayPip: false, autoReturn: true }

function loadMediaPrefs(): MediaPrefs {
  try {
    const raw = storageGet('media-prefs')
    if (raw) return { ...DEFAULT_MEDIA_PREFS, ...(JSON.parse(raw) as Partial<MediaPrefs>) }
  } catch {
    // fall through
  }
  // migrate the old single auto-return flag
  return { ...DEFAULT_MEDIA_PREFS, autoReturn: storageGet('media-auto-return') !== '0' }
}

export interface MediaBehaviorsArgs {
  state: ObsState | null
  obsConnected: boolean
  call: ObsCall
  query: ObsQuery
  subscribe: ObsSubscribe
}

export function useMediaBehaviors({ state, obsConnected, call, query, subscribe }: MediaBehaviorsArgs): {
  prefs: MediaPrefs
  updatePrefs: (patch: Partial<MediaPrefs>) => void
} {
  const [prefs, setPrefs] = useState<MediaPrefs>(loadMediaPrefs)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const stateRef = useRef(state)
  stateRef.current = state
  const callRef = useRef(call)
  callRef.current = call
  const prevLayoutRef = useRef<string | null>(null)
  const lastSceneRef = useRef<string | null>(null)
  const normalizedRef = useRef(new Set<string>())

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
      subscribe(['MediaInputPlaybackEnded'], (data) => {
        if (!prefsRef.current.autoReturn || !prevLayoutRef.current) return
        // Only the source that is actually on air may trigger the return — a
        // background deck video reaching its end must not yank the program
        // away mid-playback of the active one.
        const ended = (data as { inputName?: string } | undefined)?.inputName
        if (!ended || ended !== stateRef.current?.media?.active) return
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
    const enabled = nowRole === 'fullscreen' ? prefsRef.current.autoPlayFullscreen : prefsRef.current.autoPlayPip
    const m = stateRef.current?.media
    if (!enabled || !m?.active || !m.playable || !m.file) return
    void callRef.current('TriggerMediaInputAction', {
      inputName: m.active,
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    })
  }, [state])

  // When the deck switches sources (or the dock starts), repoint the slot
  // clones and the audio clone at the new source — heals any partial
  // selectMediaSource failure without waiting for the checklist. On a real
  // switch (not the dock's first look), honor the auto-play preference for
  // the layout on air: without it the stream freezes on the new source's
  // stopped frame until someone presses Play.
  const syncedActiveRef = useRef<string | null>(null)
  useEffect(() => {
    const active = state?.media?.active ?? null
    if (!obsConnected || active === null || active === syncedActiveRef.current) return
    const isSwitch = syncedActiveRef.current !== null
    syncedActiveRef.current = active
    void syncMediaClones(query, active)
    if (!isSwitch) return
    const role = mediaRole(stateRef.current ? parseScene(stateRef.current.currentScene) : null)
    const enabled = role === 'fullscreen' ? prefsRef.current.autoPlayFullscreen : prefsRef.current.autoPlayPip
    const m = stateRef.current?.media
    if (role === null || !enabled || !m?.playable || !m.file) return
    void callRef.current('TriggerMediaInputAction', {
      inputName: active,
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    })
  }, [obsConnected, state, query])

  // Single-audio-path invariant: deck sources emit nothing directly — the
  // 'Media Audio' clone (which taps their audio before mute) is the only
  // audible media source, so transitions can never double the soundtrack.
  // Every input kind is attempted (browser sources and captures carry audio
  // too, not just video players); kinds without audio reject the call and
  // are simply remembered as done. Nested scenes can't be muted — skipped.
  // Gated on the unified channel existing (state.audio.media mirrors it), so
  // an unmigrated collection keeps its sound until the repair runs.
  const mutedDeckRef = useRef(new Set<string>())
  useEffect(() => {
    if (!obsConnected || !state?.media || state.audio.media === null) return
    for (const source of state.media.sources) {
      if (source.kind === 'scene' || mutedDeckRef.current.has(source.name)) continue
      mutedDeckRef.current.add(source.name)
      void query('SetInputMute', { inputName: source.name, inputMuted: true }).catch(() => undefined)
    }
  }, [obsConnected, state, query])

  // Auto-play is app-driven — keep the OBS-side restart_on_activate off on
  // every video source in the MEDIA scene, so it can't double-trigger or play
  // when unwanted. Freshly added sources default the flag on, so this runs
  // once per source name as they appear.
  useEffect(() => {
    if (!obsConnected || !state?.media) return
    for (const source of state.media.sources) {
      if (source.kind !== 'ffmpeg_source' || normalizedRef.current.has(source.name)) continue
      normalizedRef.current.add(source.name)
      const inputName = source.name
      void query<{ inputSettings: Record<string, unknown> }>('GetInputSettings', { inputName })
        .then((r) => {
          if (r.inputSettings['restart_on_activate'] !== false) {
            return query('SetInputSettings', {
              inputName,
              inputSettings: { restart_on_activate: false },
            }).then(() => undefined)
          }
          return undefined
        })
        .catch(() => {
          normalizedRef.current.delete(inputName) // retry on a later state change
        })
    }
  }, [obsConnected, state, query])

  const updatePrefs = useCallback((patch: Partial<MediaPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      storageSet('media-prefs', JSON.stringify(next))
      return next
    })
  }, [])

  return { prefs, updatePrefs }
}
