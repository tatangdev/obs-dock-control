import { useEffect, useRef, useState } from 'react'
import type { MediaStatus } from '../../shared/protocol'
import type { SendCommand } from './ControlPanel'
import { MEDIA_INPUT } from '../lib/scenes'

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

export interface MediaPrefs {
  /** Restart from 0:00 when a MEDIA fullscreen scene goes to program */
  autoPlayFullscreen: boolean
  /** Restart from 0:00 when media enters a split (PiP) slot on program */
  autoPlayPip: boolean
  /** Return to the previous layout when the video finishes on fullscreen */
  autoReturn: boolean
}

interface MediaPanelProps {
  media: MediaStatus
  send: SendCommand
  /** Provided by the dock only — the dock executes these behaviors */
  prefs?: { value: MediaPrefs; onChange: (patch: Partial<MediaPrefs>) => void }
}

// Transport controls for the media video. Mirrored like everything else: state
// comes from the dock's snapshots, actions go through `send` (direct on the
// dock, via the relay on remotes). The file itself is set in OBS on Media 0.
export default function MediaPanel({ media, send, prefs }: MediaPanelProps) {
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

  const trigger = (action: string): void => send('TriggerMediaInputAction', { inputName: MEDIA_INPUT, mediaAction: action })

  function cue(): void {
    // restart puts the video at 0:00 playing; the pause right after holds it
    // there so switching to a MEDIA scene starts clean from the top
    trigger(ACTION.restart)
    setTimeout(() => trigger(ACTION.pause), 200)
  }

  function seek(ms: number): void {
    send('SetMediaInputCursor', { inputName: MEDIA_INPUT, mediaCursor: ms })
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
      <h3 className="text-sm sm:text-xs font-semibold uppercase tracking-wider text-ios-label2">Media</h3>
      <div className="space-y-3 rounded-2xl border border-transparent bg-ios-card p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-sm sm:text-xs text-ios-label2">
            {media.file ? baseName(media.file) : 'No video loaded'}
          </span>
          {hasFile && (
            <span className="shrink-0 text-sm sm:text-xs text-ios-label3 capitalize">{media.state}</span>
          )}
        </div>

        {hasFile ? (
          <>
            {hasDuration && (
            <div className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-right text-sm sm:text-xs tabular-nums text-ios-label2">{formatTime(cursor)}</span>
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
                className="min-w-0 flex-1"
              />
              <span className="w-10 shrink-0 text-sm sm:text-xs tabular-nums text-ios-label2">{formatTime(media.durationMs)}</span>
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
                  playing ? 'bg-ios-fill2 text-white hover:bg-[#48484a]' : 'bg-ios-blue text-white hover:bg-ios-blue-light'
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
          </>
        ) : (
          <p className="text-sm sm:text-xs text-ios-label3">
            Load a video on the <span className="text-ios-label2">{MEDIA_INPUT}</span> source in OBS.
          </p>
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
