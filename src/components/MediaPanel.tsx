import { useEffect, useRef, useState } from 'react'
import type { MediaStatus } from '../../shared/protocol'
import { MEDIA_CLONES, selectMediaSource } from '../lib/scenes'
import type { SendCommand } from '../lib/scenes'
import type { MediaPrefs } from '../lib/useMediaBehaviors'

const ACTION = {
  play: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
  pause: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
  restart: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
} as const

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

interface MediaPanelProps {
  media: MediaStatus
  send: SendCommand
  /** Provided by the dock only — the dock executes these behaviors */
  prefs?: { value: MediaPrefs; onChange: (patch: Partial<MediaPrefs>) => void }
  /** Media is on the stream right now — playback actions are audience-visible */
  onAir?: boolean
  /** The media channel is muted by the operator — cue must not unmute it */
  muted?: boolean
}

// Transport controls for the media video. Mirrored like everything else: state
// comes from the dock's snapshots, actions go through `send` (direct on the
// dock, via the relay on remotes). The file itself is set in OBS on Media 0.
export default function MediaPanel({ media, send, prefs, onAir = false, muted = false }: MediaPanelProps) {
  // Slider stays under local control while scrubbing so 1s state polls don't
  // fight the operator's finger. The ref mirrors the latest value because a
  // quick click fires input+pointerup before state flushes — committing from
  // state alone seeks to a stale position.
  const [scrub, setScrub] = useState<number | null>(null)
  const scrubRef = useRef<number | null>(null)
  // After release, keep showing the target until OBS confirms it — otherwise
  // the thumb snaps back to the pre-seek position for up to a second.
  const [pendingSeek, setPendingSeek] = useState<number | null>(null)

  const hasFile = media.file !== null
  // An inactive media source may report no duration even for a good file —
  // the scrubber appears once OBS opens it (Cue/Play does that).
  const hasDuration = media.durationMs > 0
  const playing = media.state === 'playing'
  const cursor = scrub ?? pendingSeek ?? Math.min(media.cursorMs, media.durationMs)
  // Transport targets whichever source is shown in the MEDIA scene
  const inputName = media.active

  // Release the optimistic position once OBS reports a cursor near the
  // target, or give up after a beat if the seek was ignored.
  useEffect(() => {
    if (pendingSeek === null) return
    if (Math.abs(media.cursorMs - pendingSeek) < 1500) {
      setPendingSeek(null)
      return
    }
    const timer = setTimeout(() => setPendingSeek(null), 3000)
    return () => clearTimeout(timer)
  }, [pendingSeek, media.cursorMs])

  const trigger = (action: string): void => send('TriggerMediaInputAction', { inputName, mediaAction: action })

  function cue(): void {
    // An open source rewinds silently in place: pause first (immediate, and
    // obs-websocket handles requests in order), then move the cursor — no
    // restart, so not a frame of audio leaks out.
    if (media.state === 'playing' || media.state === 'paused') {
      trigger(ACTION.pause)
      seek(0)
      return
    }
    // A stopped/ended source ignores cursor changes — only restart wakes it,
    // and restart *plays*. Gate the audio until the pause lands: the source
    // itself and every clone, because clones mix their own audio and ignore
    // the original's mute flag.
    const gated = [inputName, ...MEDIA_CLONES]
    for (const name of gated) send('SetInputMute', { inputName: name, inputMuted: true })
    trigger(ACTION.restart)
    setTimeout(() => trigger(ACTION.pause), 200)
    setTimeout(() => {
      // Leave everything muted if the operator muted the media channel
      if (muted) return
      for (const name of gated) send('SetInputMute', { inputName: name, inputMuted: false })
    }, 600)
  }

  function seek(ms: number): void {
    send('SetMediaInputCursor', { inputName, mediaCursor: ms })
  }

  function commitScrub(): void {
    const target = scrubRef.current
    scrubRef.current = null
    setScrub(null)
    if (target === null) return
    setPendingSeek(target)
    if (media.state === 'ended' || media.state === 'stopped') {
      // OBS only honors cursor changes while playing or paused — wake the
      // source first, then jump to the target.
      trigger(ACTION.restart)
      setTimeout(() => seek(target), 250)
    } else {
      seek(target)
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm sm:text-xs font-semibold uppercase tracking-wider text-ios-label2">Media</h3>
        {onAir && (
          <span
            title="Media is visible on the stream — playback changes are live for the audience"
            className="inline-flex animate-fade-in items-center gap-1 rounded-full bg-ios-red/20 px-2 py-0.5 text-xs font-bold tracking-wide text-ios-red"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ios-red" />
            ON AIR
          </span>
        )}
      </div>
      <div className="space-y-3 rounded-2xl border border-transparent bg-ios-card p-3">
        {media.sources.length > 1 && (
          <div className="divide-y divide-ios-sep/60 overflow-hidden rounded-xl bg-ios-fill/50">
            {media.sources.map((s) => {
              const active = s.name === media.active
              return (
                <button
                  key={s.id}
                  onClick={() => selectMediaSource(send, media, s.name)}
                  title={active ? `${s.name} is shown in the media slots` : `Show ${s.name} in the media slots`}
                  className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm sm:text-xs transition-colors duration-200 ease-out ${
                    active ? 'text-white' : 'text-ios-label2 hover:bg-ios-fill'
                  }`}
                >
                  <span className="min-w-0 truncate">{s.name}</span>
                  {active && (
                    <span className="shrink-0 rounded-full bg-ios-blue/20 px-2 py-0.5 text-xs font-semibold text-ios-blue">
                      Showing
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {media.active === null ? (
          <p className="text-sm sm:text-xs text-ios-label3">
            {media.sources.length === 0
              ? 'The MEDIA scene has no media sources — add one in OBS (any video, image, or browser source) and it appears here.'
              : 'No media source is visible — tap one above to show it.'}
          </p>
        ) : !media.playable ? (
          <p className="text-sm sm:text-xs text-ios-label3">
            <span className="text-ios-label2">{media.active}</span> is on the media slots. Playback controls apply to
            video sources only.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm sm:text-xs text-ios-label2">
                {media.file ? baseName(media.file) : 'No video loaded'}
              </span>
              {hasFile && <span className="shrink-0 text-sm sm:text-xs text-ios-label3 capitalize">{media.state}</span>}
            </div>

            {hasFile ? (
              <>
                {hasDuration && (
                  <div className="flex items-center gap-2">
                    <span className="w-10 shrink-0 text-right text-sm sm:text-xs tabular-nums text-ios-label2">
                      {formatTime(cursor)}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={media.durationMs}
                      step={100}
                      value={cursor}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        scrubRef.current = v
                        setScrub(v)
                      }}
                      onPointerUp={commitScrub}
                      onPointerCancel={commitScrub}
                      onKeyUp={commitScrub}
                      onBlur={commitScrub}
                      aria-label="Playback position"
                      className="min-w-0 flex-1"
                    />
                    <span className="w-10 shrink-0 text-sm sm:text-xs tabular-nums text-ios-label2">
                      {formatTime(media.durationMs)}
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={cue}
                    title="Cue: rewind to 0:00 and hold paused, armed for the moment — switch to Media and press Play when it's time"
                    className="rounded-xl bg-ios-fill px-3 py-2 text-sm sm:text-xs font-semibold text-ios-blue transition-all duration-200 ease-out hover:bg-ios-fill2 active:scale-[0.98]"
                  >
                    Cue
                  </button>
                  <button
                    onClick={() => trigger(playing ? ACTION.pause : ACTION.play)}
                    title={
                      playing
                        ? 'Pause: freeze the video on the current frame — Play resumes from here'
                        : media.state === 'ended'
                          ? 'Replay: the video finished — play it again from the beginning'
                          : 'Play: start or resume playback from the current position'
                    }
                    className={`rounded-xl px-3 py-2 text-sm sm:text-xs font-semibold transition-all duration-200 ease-out active:scale-[0.98] ${
                      playing
                        ? 'bg-ios-fill2 text-white hover:bg-[#48484a]'
                        : 'bg-ios-blue text-white hover:bg-ios-blue-light'
                    }`}
                  >
                    {playing ? 'Pause' : media.state === 'ended' ? 'Replay' : 'Play'}
                  </button>
                  <button
                    onClick={() => trigger(ACTION.restart)}
                    title="Restart: play immediately from 0:00 — use while the video is live on stream and needs to start over"
                    className="rounded-xl bg-ios-fill px-3 py-2 text-sm sm:text-xs font-semibold text-ios-blue transition-all duration-200 ease-out hover:bg-ios-fill2 active:scale-[0.98]"
                  >
                    Restart
                  </button>
                </div>
                <p className="text-xs text-ios-label3">
                  Cue rewinds to 0:00 and holds paused, ready for the moment. Restart plays from 0:00 immediately.
                </p>
              </>
            ) : (
              <p className="text-sm sm:text-xs text-ios-label3">
                Load a video on the <span className="text-ios-label2">{media.active}</span> source in OBS.
              </p>
            )}
          </>
        )}

        {!prefs && media.playable && (
          <p className="text-xs text-ios-label3">Auto-play and auto-return behavior is set on the dock.</p>
        )}

        {prefs && (
          <div className="space-y-1.5">
            <label className="flex cursor-pointer items-center gap-2 text-sm sm:text-xs text-ios-label2">
              <input
                type="checkbox"
                checked={prefs.value.autoPlayFullscreen}
                onChange={(e) => prefs.onChange({ autoPlayFullscreen: e.target.checked })}
                className="accent-ios-blue"
              />
              Auto-play when Media goes fullscreen
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm sm:text-xs text-ios-label2">
              <input
                type="checkbox"
                checked={prefs.value.autoPlayPip}
                onChange={(e) => prefs.onChange({ autoPlayPip: e.target.checked })}
                className="accent-ios-blue"
              />
              Auto-play in Picture in Picture
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm sm:text-xs text-ios-label2">
              <input
                type="checkbox"
                checked={prefs.value.autoReturn}
                onChange={(e) => prefs.onChange({ autoReturn: e.target.checked })}
                className="accent-ios-blue"
              />
              Return to the previous layout when the video ends
            </label>
          </div>
        )}
      </div>
    </section>
  )
}
