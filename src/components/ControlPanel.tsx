import { useEffect, useRef, useState } from 'react'
import type { AudioTrack, ObsState } from '../../shared/protocol'
import { MEDIA_INPUT, SOURCES, parseScene, sceneFor } from '../lib/scenes'
import type { SourceKey, SplitKey } from '../lib/scenes'
import { AUDIO_INPUT } from '../lib/overlay'
import MediaPanel from './MediaPanel'
import type { MediaPrefs } from './MediaPanel'

export type SendCommand = (request: string, params?: Record<string, unknown>) => void

const MODES = [
  { key: 'fullscreen', label: 'Full Screen' },
  { key: 'pip', label: 'Picture in Picture' },
  { key: 'media', label: 'Media' },
] as const

type ModeKey = (typeof MODES)[number]['key']

// Layout rects in % of the canvas, derived from the scene collection
// (1920x1080, item pos/scale + Advanced Mask crops).
interface Rect {
  l: number
  t: number
  w: number
  h: number
}

const SPLIT_STYLES = [
  {
    key: 'equal',
    label: 'Equal Split',
    rects: [
      { l: 3.1, t: 27.4, w: 45.3, h: 45.3 },
      { l: 51.6, t: 27.4, w: 45.3, h: 45.3 },
    ],
  },
  {
    key: 'large',
    label: 'Large Split',
    rects: [
      { l: 3.1, t: 17.6, w: 64.7, h: 64.7 },
      { l: 70.9, t: 17.6, w: 25.8, h: 64.7 },
    ],
  },
  {
    key: 'big-small',
    label: 'Big + Small',
    rects: [
      { l: 3.1, t: 5.6, w: 78.1, h: 78.1 },
      { l: 75.6, t: 53.8, w: 21.2, h: 40.6 },
    ],
  },
  {
    key: 'overlay',
    label: 'Overlay',
    rects: [
      { l: 0, t: 0, w: 100, h: 100 },
      { l: 75.6, t: 29.7, w: 21.2, h: 40.6 },
    ],
  },
] as const satisfies readonly { key: SplitKey; label: string; rects: readonly Rect[] }[]

interface SplitConfig {
  style: SplitKey
  featured: SourceKey
  secondary: SourceKey
}

// The three source pairings a split can show. Order-insensitive — Swap
// controls which member is featured. 3 pairs x 2 orientations x 4 styles
// map exactly onto the 24 split scenes in the collection.
const PAIRS = [
  { key: '1-2', a: 'main', b: 'second', label: '1 + 2', title: 'Camera 1 + Camera 2', needsMedia: false },
  { key: '1-m', a: 'main', b: 'media', label: '1 + M', title: 'Camera 1 + Media', needsMedia: true },
  { key: '2-m', a: 'second', b: 'media', label: '2 + M', title: 'Camera 2 + Media', needsMedia: true },
] as const satisfies readonly { key: string; a: SourceKey; b: SourceKey; label: string; title: string; needsMedia: boolean }[]

type Pair = (typeof PAIRS)[number]

const pairMatches = (pair: Pair, featured: SourceKey, secondary: SourceKey): boolean =>
  (pair.a === featured && pair.b === secondary) || (pair.a === secondary && pair.b === featured)

const isSource = (v: unknown): v is SourceKey => v === 'main' || v === 'second' || v === 'media'

function loadLastSplit(): SplitConfig {
  try {
    const raw = localStorage.getItem('last-split')
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SplitConfig>
      if (
        SPLIT_STYLES.some((s) => s.key === parsed.style) &&
        isSource(parsed.featured) &&
        isSource(parsed.secondary) &&
        parsed.featured !== parsed.secondary
      ) {
        return { style: parsed.style as SplitKey, featured: parsed.featured, secondary: parsed.secondary }
      }
    }
  } catch {
    // fall through to the default
  }
  return { style: 'overlay', featured: 'main', secondary: 'second' }
}

interface ControlPanelProps {
  state: ObsState
  send: SendCommand
  /** Dock-only: media behavior preferences, threaded to the media panel */
  mediaPrefs?: { value: MediaPrefs; onChange: (patch: Partial<MediaPrefs>) => void }
}

// Shared between dock and remote. OBS is the source of truth: the highlighted
// mode/layout is *derived* from state.currentScene (mirrored to remotes by
// the dock), and every interaction just switches the program scene.
export default function ControlPanel({ state, send, mediaPrefs }: ControlPanelProps) {
  const selection = parseScene(state.currentScene)
  const [pickerOpen, setPickerOpen] = useState(false)
  // Remembered so mode switches have sensible targets
  const [lastSplit, setLastSplit] = useState<SplitConfig>(loadLastSplit)
  const [lastCam, setLastCam] = useState<'main' | 'second'>('main')

  useEffect(() => {
    if (selection?.mode === 'split') {
      const cfg: SplitConfig = { style: selection.style, featured: selection.featured, secondary: selection.secondary }
      setLastSplit(cfg)
      localStorage.setItem('last-split', JSON.stringify(cfg))
    } else if (selection?.mode === 'fullscreen' && selection.source !== 'media') {
      setLastCam(selection.source)
    }
  }, [state.currentScene]) // eslint-disable-line react-hooks/exhaustive-deps -- selection derives from currentScene

  const displaySplit: SplitConfig = selection?.mode === 'split' ? selection : lastSplit
  const selectedStyle = SPLIT_STYLES.find((s) => s.key === displaySplit.style) ?? SPLIT_STYLES[3]
  // Media is only offerable as a source once a video file is set — never let
  // anyone put an empty media slot on the stream. (File presence, not
  // duration: an inactive source reports no duration even for a good file.)
  const mediaLoaded = state.media !== null && state.media.file !== null
  const availableSources = mediaLoaded ? SOURCES : SOURCES.filter((s) => s !== 'media')

  // Which cam to show when jumping to fullscreen: the one on screen, if any
  const camForFullscreen: 'main' | 'second' =
    selection?.mode === 'fullscreen' && selection.source !== 'media'
      ? selection.source
      : selection?.mode === 'split' && selection.featured !== 'media'
        ? selection.featured
        : selection?.mode === 'split' && selection.secondary !== 'media'
          ? selection.secondary
          : lastCam

  const setScene = (sceneName: string): void => send('SetCurrentProgramScene', { sceneName })
  const setSplit = (cfg: SplitConfig): void => setScene(sceneFor({ mode: 'split', ...cfg }))

  const tileActive = (key: ModeKey): boolean => {
    if (!selection) return false
    if (key === 'fullscreen') return selection.mode === 'fullscreen' && selection.source !== 'media'
    if (key === 'pip') return selection.mode === 'split'
    return selection.mode === 'fullscreen' && selection.source === 'media'
  }

  const selectMode = (key: ModeKey): void => {
    if (key === 'fullscreen') setScene(sceneFor({ mode: 'fullscreen', source: camForFullscreen }))
    else if (key === 'pip') setSplit(displaySplit)
    else setScene(sceneFor({ mode: 'fullscreen', source: 'media' }))
  }

  const swap = (): void => {
    if (selection?.mode === 'fullscreen' && selection.source !== 'media') {
      setScene(sceneFor({ mode: 'fullscreen', source: selection.source === 'main' ? 'second' : 'main' }))
    } else {
      setSplit({ style: displaySplit.style, featured: displaySplit.secondary, secondary: displaySplit.featured })
    }
  }

  // Tap a slot in the preview: cycle it to the next source, skipping whatever
  // the other slot is showing. With only two sources available there is
  // nothing to cycle to — swap the slots instead so the tap always responds.
  const cycleSlot = (slot: 0 | 1): void => {
    const own = slot === 0 ? displaySplit.featured : displaySplit.secondary
    const other = slot === 0 ? displaySplit.secondary : displaySplit.featured
    const order = availableSources
    const idx = order.indexOf(own)
    const next = order[(idx + 1) % order.length] ?? 'main'
    const chosen = next === other ? (order[(idx + 2) % order.length] ?? 'main') : next
    if (chosen === own) {
      swap()
      return
    }
    setSplit({
      style: displaySplit.style,
      featured: slot === 0 ? chosen : displaySplit.featured,
      secondary: slot === 1 ? chosen : displaySplit.secondary,
    })
  }

  // Switch pairs while keeping the picture stable: whichever current source
  // survives into the new pair keeps its slot, only the other slot changes.
  // (Any two pairs share a member, so this rule always applies.)
  const selectPair = (pair: Pair): void => {
    const { style, featured, secondary } = displaySplit
    let nextFeatured: SourceKey
    let nextSecondary: SourceKey
    if (featured === pair.a || featured === pair.b) {
      nextFeatured = featured
      nextSecondary = featured === pair.a ? pair.b : pair.a
    } else {
      nextSecondary = secondary === pair.a || secondary === pair.b ? secondary : pair.b
      nextFeatured = nextSecondary === pair.a ? pair.b : pair.a
    }
    setSplit({ style, featured: nextFeatured, secondary: nextSecondary })
  }

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-sm sm:text-xs font-semibold uppercase tracking-wider text-ios-label2">Layout</h3>
        <div className="grid grid-cols-3 gap-2">
          {MODES.map((m) => {
            const active = tileActive(m.key)
            const disabled = m.key === 'media' && !mediaLoaded
            return (
              <div
                key={m.key}
                onClick={disabled ? undefined : () => selectMode(m.key)}
                title={disabled ? 'Load a video in the Media panel first' : undefined}
                className={`group transition-transform duration-150 ease-out ${
                  disabled ? 'cursor-default opacity-40' : 'cursor-pointer active:scale-[0.97]'
                }`}
              >
                <div
                  className={`relative aspect-video overflow-hidden rounded-xl border p-1.5 transition-all duration-200 ease-out ${
                    active
                      ? 'border-ios-blue bg-ios-blue/10'
                      : 'border-transparent bg-ios-card group-hover:border-ios-sep'
                  }`}
                >
                  {m.key === 'pip' ? (
                    // Slot taps only arm once split mode is active — before
                    // that, a tap anywhere on the tile switches to it.
                    <RectsPreview
                      rects={selectedStyle.rects}
                      sources={[displaySplit.featured, displaySplit.secondary]}
                      onSlotTap={selection?.mode === 'split' ? cycleSlot : undefined}
                    />
                  ) : (
                    <FullscreenPreview source={m.key === 'media' ? 'media' : camForFullscreen} />
                  )}
                </div>
                <div
                  className={`mt-1.5 truncate text-center text-sm sm:text-xs font-medium transition-colors duration-200 ease-out ${
                    active ? 'text-ios-blue' : 'text-ios-label2'
                  }`}
                >
                  {m.label}
                </div>
              </div>
            )
          })}
        </div>

        {selection?.mode === 'fullscreen' && selection.source !== 'media' && (
          <div className="flex animate-fade-in items-center justify-center gap-3 pt-1">
            <span className="text-sm sm:text-xs text-ios-label3">Source</span>
            <div className="flex overflow-hidden rounded-xl border border-transparent">
              {(['main', 'second'] as const).map((source) => (
                <button
                  key={source}
                  title={`Show source ${source === 'main' ? 1 : 2} fullscreen`}
                  onClick={() => setScene(sceneFor({ mode: 'fullscreen', source }))}
                  className={`px-4 py-1.5 text-sm sm:text-xs font-bold transition-colors duration-200 ease-out ${
                    selection.source === source
                      ? 'bg-ios-blue text-white'
                      : 'bg-ios-fill text-ios-label2 hover:bg-ios-fill2'
                  }`}
                >
                  {source === 'main' ? '1' : '2'}
                </button>
              ))}
            </div>
          </div>
        )}

        {selection?.mode === 'split' && (
          <div className="animate-fade-in space-y-1.5 pt-1">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <PairSelector
                featured={displaySplit.featured}
                secondary={displaySplit.secondary}
                mediaLoaded={mediaLoaded}
                onSelect={selectPair}
              />
              <button
                onClick={swap}
                className="flex items-center gap-1.5 rounded-xl bg-ios-fill px-3 py-1.5 text-sm sm:text-xs font-semibold text-ios-blue transition-all duration-200 ease-out hover:bg-ios-fill2 active:scale-[0.98]"
              >
                <SwapIcon />
                Swap
              </button>
              <button
                onClick={() => setPickerOpen(true)}
                className="flex items-center gap-1.5 rounded-xl bg-ios-fill px-3 py-1.5 text-sm sm:text-xs font-semibold text-ios-blue transition-all duration-200 ease-out hover:bg-ios-fill2 active:scale-[0.98]"
              >
                <GridIcon />
                Layout
              </button>
            </div>
            <p className="text-center text-xs text-ios-label3">Tap a box in the preview to change its source.</p>
          </div>
        )}
      </section>

      {(state.audio.input || state.audio.media) && (
        <section className="space-y-2">
          <h3 className="text-sm sm:text-xs font-semibold uppercase tracking-wider text-ios-label2">Audio</h3>
          <div className="space-y-2">
            {state.audio.input && <AudioRow label="Audio Input" inputName={AUDIO_INPUT} track={state.audio.input} send={send} />}
            {state.audio.media && (
              <AudioRow label="Media" inputName={MEDIA_INPUT} track={state.audio.media} send={send} />
            )}
          </div>
        </section>
      )}

      {state.media && <MediaPanel media={state.media} send={send} prefs={mediaPrefs} />}

      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/60 p-4"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="w-full max-w-md animate-pop-in rounded-2xl border border-transparent bg-ios-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base sm:text-sm font-semibold">Split screen layout</h3>
              <button
                onClick={() => setPickerOpen(false)}
                className="rounded-md px-1.5 text-ios-blue transition-colors hover:text-ios-blue-light"
              >
                ✕
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {SPLIT_STYLES.map((s) => {
                const active = selection?.mode === 'split' && displaySplit.style === s.key
                return (
                  <div
                    key={s.key}
                    onClick={() => {
                      setSplit({ style: s.key, featured: displaySplit.featured, secondary: displaySplit.secondary })
                      setPickerOpen(false)
                    }}
                    className="group cursor-pointer transition-transform duration-150 ease-out active:scale-[0.97]"
                  >
                    <div
                      className={`aspect-video overflow-hidden rounded-xl border p-1 transition-all duration-200 ease-out ${
                        active ? 'border-ios-blue bg-ios-blue/10' : 'border-transparent group-hover:border-ios-sep'
                      }`}
                    >
                      <RectsPreview rects={s.rects} sources={[displaySplit.featured, displaySplit.secondary]} />
                    </div>
                    <div
                      className={`mt-1 text-center text-sm sm:text-xs font-medium transition-colors duration-200 ease-out ${
                        active ? 'text-ios-blue' : 'text-ios-label2'
                      }`}
                    >
                      {s.label}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="mt-3 flex justify-center">
              <PairSelector
                featured={displaySplit.featured}
                secondary={displaySplit.secondary}
                mediaLoaded={mediaLoaded}
                onSelect={selectPair}
              />
            </div>

            <button
              onClick={swap}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-ios-fill px-3 py-2 text-sm sm:text-xs font-semibold text-ios-blue transition-all duration-200 ease-out hover:bg-ios-fill2 active:scale-[0.98]"
            >
              <SwapIcon />
              Swap slots
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Segmented control for choosing which two sources share the split
function PairSelector({
  featured,
  secondary,
  mediaLoaded,
  onSelect,
}: {
  featured: SourceKey
  secondary: SourceKey
  mediaLoaded: boolean
  onSelect: (pair: Pair) => void
}) {
  return (
    <div className="flex overflow-hidden rounded-xl">
      {PAIRS.map((pair) => {
        const active = pairMatches(pair, featured, secondary)
        const disabled = pair.needsMedia && !mediaLoaded
        return (
          <button
            key={pair.key}
            disabled={disabled}
            title={disabled ? 'Load a video on Media 0 in OBS first' : pair.title}
            onClick={() => onSelect(pair)}
            className={`px-3 py-1.5 text-sm sm:text-xs font-bold transition-colors duration-200 ease-out disabled:opacity-40 ${
              active ? 'bg-ios-blue text-white' : 'bg-ios-fill text-ios-label2 hover:bg-ios-fill2'
            }`}
          >
            {pair.label}
          </button>
        )
      })}
    </div>
  )
}

function sourceClasses(source: SourceKey): string {
  if (source === 'main') return 'bg-neutral-600/90 text-white'
  if (source === 'second') return 'bg-neutral-200/90 text-neutral-800'
  return 'bg-ios-purple/60 text-white'
}

function SourceGlyph({ source }: { source: SourceKey }) {
  if (source === 'media') {
    return (
      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 fill-current">
        <path d="M8 5v14l11-7z" />
      </svg>
    )
  }
  return <span className="text-xs leading-none font-bold">{source === 'main' ? '1' : '2'}</span>
}

function SwapIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
      <path d="M7 7h10.17l-1.58-1.59L17 4l4 4-4 4-1.41-1.41L17.17 9H7V7zm10 10H6.83l1.58 1.59L7 20l-4-4 4-4 1.41 1.41L6.83 15H17v2z" />
    </svg>
  )
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
      <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
    </svg>
  )
}

// Draws a layout schematic positioned exactly like the real scene items on
// the 16:9 canvas, each slot showing its source glyph (1 / 2 / play icon).
// With onSlotTap, tapping a slot cycles its source.
function RectsPreview({
  rects,
  sources,
  onSlotTap,
}: {
  rects: readonly Rect[]
  sources: readonly [SourceKey, SourceKey]
  onSlotTap?: (slot: 0 | 1) => void
}) {
  return (
    <div className="relative h-full w-full overflow-hidden rounded-sm bg-ios-fill/60">
      {rects.map((r, i) => {
        const slot = i === 0 ? 0 : 1
        const source = sources[slot]
        return (
          <div
            key={i}
            onClick={
              onSlotTap
                ? (e) => {
                    e.stopPropagation()
                    onSlotTap(slot)
                  }
                : undefined
            }
            className={`absolute flex items-center justify-center rounded-sm transition-all duration-300 ease-out ${sourceClasses(source)} ${
              onSlotTap ? 'cursor-pointer hover:ring-1 hover:ring-white/60' : ''
            }`}
            style={{ left: `${r.l}%`, top: `${r.t}%`, width: `${r.w}%`, height: `${r.h}%` }}
          >
            <SourceGlyph source={source} />
          </div>
        )
      })}
    </div>
  )
}

// Full-frame fill colored by whichever source is fullscreen
function FullscreenPreview({ source }: { source: SourceKey }) {
  return (
    <div
      className={`flex h-full w-full items-center justify-center rounded-sm transition-colors duration-300 ease-out ${sourceClasses(source)}`}
    >
      <SourceGlyph source={source} />
    </div>
  )
}

// Mute button + dB fader. The slider stays under local control while
// dragging (state echoes would fight the finger); sends are throttled during
// the drag and committed on release.
function AudioRow({
  label,
  inputName,
  track,
  send,
}: {
  label: string
  inputName: string
  track: AudioTrack
  send: SendCommand
}) {
  const [drag, setDrag] = useState<number | null>(null)
  const dragRef = useRef<number | null>(null)
  const lastSent = useRef(0)
  const value = drag ?? Math.max(-60, Math.min(0, track.volumeDb))

  const commit = (): void => {
    const v = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (v !== null) send('SetInputVolume', { inputName, inputVolumeDb: v })
  }

  return (
    <div className="flex items-center gap-3 rounded-2xl bg-ios-card px-3 py-2.5">
      <button
        onClick={() => send('ToggleInputMute', { inputName })}
        title={track.muted ? `Unmute ${label}` : `Mute ${label}`}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors duration-200 ease-out ${
          track.muted ? 'bg-ios-red/20 text-ios-red' : 'bg-ios-fill text-ios-label2 hover:bg-ios-fill2'
        }`}
      >
        {track.muted ? (
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
            <path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.45 2.45c.03-.2.05-.42.05-.65zM3 9v6h4l5 5V4L7 9H3zm13.6 11L4.4 7.8 5.8 6.4 18 18.6 16.6 20z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z" />
          </svg>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center justify-between text-sm sm:text-xs">
          <span className={track.muted ? 'text-ios-label3' : 'text-ios-label2'}>
            {label}
            {track.muted ? ' — muted' : ''}
          </span>
          <span className="tabular-nums text-ios-label3">{value <= -60 ? '-inf' : value.toFixed(1)} dB</span>
        </div>
        <input
          type="range"
          min={-60}
          max={0}
          step={0.5}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value)
            dragRef.current = v
            setDrag(v)
            const now = performance.now()
            if (now - lastSent.current > 80) {
              lastSent.current = now
              send('SetInputVolume', { inputName, inputVolumeDb: v })
            }
          }}
          onPointerUp={commit}
          onPointerCancel={commit}
          onKeyUp={commit}
          onBlur={commit}
          className="w-full"
        />
      </div>
    </div>
  )
}

