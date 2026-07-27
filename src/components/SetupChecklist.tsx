import { useCallback, useEffect, useRef, useState } from 'react'
import type { OBSEventTypes } from 'obs-websocket-js'
import type { LayerInfo, MediaStatus } from '../../shared/protocol'
import type { ObsQuery, ObsSubscribe } from '../lib/useObs'
import {
  MEDIA_CLONES,
  SCREENS,
  createScreenScenes,
  SPLIT_BOXES,
  alignLayouts,
  isSetupReady,
  parseScene,
  syncMediaClones,
} from '../lib/scenes'
import {
  BACKGROUND_INPUT,
  BACKGROUND_SCENE,
  LOGO_INPUT,
  AUDIO_INPUT,
  OVERLAY_LAYERS,
  OVERLAY_SCENE,
  createBackgroundSetup,
  createAudioInput,
  createOverlayLayers,
} from '../lib/overlay'
import { AUDIO_KIND, CAMERA_KIND, PLATFORM_LABEL, platformFromObs } from '../lib/platform'

interface Guide {
  title: string
  steps: string[]
}

interface Item {
  key: string
  label: string
  problem: string
  guide: Guide
  /** This item is fixed through the Setup panel rather than OBS dialogs */
  setupAction?: boolean
  /** This item can be fixed right here with one click */
  fix?: { label: string; run: () => Promise<void> }
}

const WATCH_EVENTS: readonly (keyof OBSEventTypes)[] = [
  'CurrentSceneCollectionChanged',
  'SceneListChanged',
  'SceneItemEnableStateChanged',
  // emitted by obs-websocket >= 5.4; missing from the 5.0 typings
  'InputSettingsChanged' as keyof OBSEventTypes,
]

// Which settings key holds the picked device depends on the capture kind
const DEVICE_KEYS = ['device', 'video_device_id', 'device_id']

async function inputExists(query: ObsQuery, inputName: string): Promise<boolean> {
  try {
    await query('GetInputSettings', { inputName })
    return true
  } catch {
    return false
  }
}

async function inputKindOf(query: ObsQuery, inputName: string): Promise<string | null> {
  try {
    const { inputKind } = await query<{ inputKind: string }>('GetInputSettings', { inputName })
    return inputKind
  } catch {
    return null
  }
}

async function inputHasSetting(query: ObsQuery, inputName: string, keys: readonly string[]): Promise<boolean | null> {
  try {
    const { inputSettings } = await query<{ inputSettings: Record<string, unknown> }>('GetInputSettings', {
      inputName,
    })
    return keys.some((k) => typeof inputSettings[k] === 'string' && inputSettings[k] !== '')
  } catch {
    return null // input missing or OBS unreachable — don't false-alarm
  }
}

// Await a bag of named probes in parallel. Replaces a positional
// Promise.all destructure where adding one probe silently shifted the rest.
async function probeAll<T extends Record<string, Promise<unknown>>>(
  probes: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(probes) as (keyof T)[]
  const values = await Promise.all(Object.values(probes))
  const out = {} as { [K in keyof T]: Awaited<T[K]> }
  keys.forEach((key, i) => {
    out[key] = values[i] as (typeof out)[typeof key]
  })
  return out
}

interface SetupChecklistProps {
  query: ObsQuery
  subscribe: ObsSubscribe
  scenes: string[]
  media: MediaStatus | null
  layers: LayerInfo[]
  runningText: string | null
  onOpenSetup: () => void
  /** Reports how many rows need attention (for badges elsewhere) */
  onItemsChange?: (count: number) => void
}

// Dock-only "needs attention" card: each row is something not configured yet,
// with a ? guide explaining exactly where to fix it in OBS. Rows disappear on
// their own as things get set up.
export default function SetupChecklist({
  query,
  subscribe,
  scenes,
  media,
  layers,
  runningText,
  onOpenSetup,
  onItemsChange,
}: SetupChecklistProps) {
  const [items, setItems] = useState<Item[]>([])
  const [guide, setGuide] = useState<Item | null>(null)
  const [fixing, setFixing] = useState<string | null>(null)
  const [fixError, setFixError] = useState<string | null>(null)
  // Distinguishes "no problems found" from "checks haven't run yet"
  const [ran, setRan] = useState(false)

  const scenesReady = isSetupReady(scenes)
  // A media row is warranted when nothing can show in the media slots: no
  // visible source in the MEDIA scene, or a video source without a file.
  // (media === null means the scene itself is missing — the collection row
  // covers that.)
  const mediaProblem =
    media === null
      ? null
      : media.active === null
        ? media.sources.length === 0
          ? 'The MEDIA scene has no media sources — Media mode stays locked.'
          : 'No media source is visible — Media mode stays locked.'
        : media.playable && media.file === null
          ? 'No video file loaded — Media mode stays locked.'
          : null
  const mediaActive = media?.active ?? null
  const runningTextEmpty = runningText !== null && runningText.trim() === ''
  // Reconcile the live OVERLAY scene against the blueprint. An empty layer
  // list means the fetch itself failed, so don't diagnose from it.
  const missingLayers =
    layers.length > 0 ? OVERLAY_LAYERS.filter((spec) => !layers.some((l) => l.name === spec.name)) : []
  const missingLayersKey = missingLayers.map((s) => s.name).join(',')
  // Event screens are dedicated scenes — older collections lack them
  const missingScreens = SCREENS.filter((s) => !scenes.includes(s.scene))
  const missingScreensKey = missingScreens.map((s) => s.scene).join(',')
  // Migration leftovers: screens that still sit in the OVERLAY scene from
  // before they became dedicated scenes
  const screenLeftovers = layers.filter((l) => SCREENS.some((s) => s.input === l.name))
  const screenLeftoversKey = screenLeftovers.map((l) => l.id).join(',')
  const backgroundMissing = !scenes.includes(BACKGROUND_SCENE)

  // Checks fire from events and dep changes and overlap freely — only the
  // newest run may publish, or a stale sweep resurrects already-fixed rows.
  const checksSeq = useRef(0)
  const runChecks = useCallback(async () => {
    const seq = ++checksSeq.current
    const report = (list: Item[]): void => {
      if (seq !== checksSeq.current) return
      setItems(list)
      setRan(true)
      onItemsChange?.(list.length)
    }
    const found: Item[] = []

    if (!scenesReady) {
      found.push({
        key: 'collection',
        label: 'Scene collection',
        problem: 'The Dock Control scenes are not active in OBS.',
        setupAction: true,
        guide: {
          title: 'Import the scene collection',
          steps: [
            'Open Setup and download the collection file.',
            'In OBS: Scene Collection menu → Import → choose the downloaded file.',
            'Back in Setup, press "Switch to it now" when it appears.',
          ],
        },
      })
      report(found)
      return // source checks are meaningless until the collection is in
    }

    const c = await probeAll({
      mainCam: inputHasSetting(query, 'Main Cam 0', DEVICE_KEYS),
      secondCam: inputHasSetting(query, 'Second Cam 0', DEVICE_KEYS),
      logoSet: inputHasSetting(query, LOGO_INPUT, ['file']),
      backgroundSet: inputHasSetting(query, BACKGROUND_INPUT, ['file']),
      audioExists: inputExists(query, AUDIO_INPUT),
      audioDeviceSet: inputHasSetting(query, AUDIO_INPUT, ['device_id']),
      camKind: inputKindOf(query, 'Main Cam 0'),
      version: query<{ platform: string }>('GetVersion').catch(() => null),
      // Layouts must match the derived grid exactly. Two cheap probes catch
      // every known off-spec install: media items must be fit-inside boxes of
      // the full canvas (old fixed-scale imports, mis-scaled bounds), and cam
      // slots must be cover boxes of the exact grid rect (hand-composited
      // drift, pre-grid imports).
      layoutOffGrid: Promise.all([
        query<{
          sceneItems: { sourceName: string; sceneItemTransform: Record<string, unknown> }[]
        }>('GetSceneItemList', { sceneName: 'MEDIA' })
          .then((r) => {
            const candidates = r.sceneItems.filter(
              (i) => i.sourceName !== OVERLAY_SCENE && i.sourceName !== BACKGROUND_SCENE,
            )
            const t = (candidates.find((i) => i.sourceName === 'Media 0') ?? candidates[0])?.sceneItemTransform
            if (!t) return null
            return t['boundsType'] !== 'OBS_BOUNDS_SCALE_INNER' || t['boundsWidth'] !== 1920
          })
          .catch(() => null),
        query<{
          sceneItems: { sourceName: string; sceneItemTransform: Record<string, unknown> }[]
        }>('GetSceneItemList', { sceneName: 'MAIN SECOND' })
          .then((r) => {
            const t = r.sceneItems.find((i) => i.sourceName === 'Main Cam 1')?.sceneItemTransform
            if (!t) return null
            const want = SPLIT_BOXES.equal[0]
            return (
              t['boundsType'] !== 'OBS_BOUNDS_SCALE_OUTER' ||
              Math.abs(Number(t['boundsWidth']) - want.w) > 0.01 ||
              Math.abs(Number(t['positionX']) - want.x) > 0.01
            )
          })
          .catch(() => null),
      ]).then((probes) => probes.some((p) => p === true)),
      // Split slots render clones — each must point at the source the MEDIA
      // scene shows, or fullscreen and PiP show different media (a partial
      // selectMediaSource failure leaves exactly this drift behind).
      mediaCloneDrift:
        mediaActive === null
          ? Promise.resolve(false)
          : Promise.all(
              MEDIA_CLONES.map((clone) =>
                query<{ inputSettings: Record<string, unknown> }>('GetInputSettings', { inputName: clone })
                  .then((r) => String(r.inputSettings['clone'] ?? ''))
                  .catch(() => null),
              ),
            ).then((targets) => targets.some((t) => t !== null && t !== '' && t !== mediaActive)),
      screens: Promise.all(SCREENS.map((s) => inputHasSetting(query, s.input, ['file']))),
    })
    if (seq !== checksSeq.current) return

    // A collection built for another OS has camera kinds this OBS can't run —
    // no device can ever be picked. Catch it before the confusing symptoms.
    const platform = c.version ? platformFromObs(c.version.platform) : null
    if (platform && c.camKind !== null && c.camKind !== CAMERA_KIND[platform]) {
      found.push({
        key: 'wrong-platform',
        label: 'Collection is for another OS',
        problem: `The camera sources don't work on ${PLATFORM_LABEL[platform]} — cameras can never be detected.`,
        setupAction: true,
        guide: {
          title: `Re-import the ${PLATFORM_LABEL[platform]} collection`,
          steps: [
            'In OBS: Scene Collection → switch to any other collection, then Remove "Dock Control".',
            `Open Setup here and download the collection — it now offers the ${PLATFORM_LABEL[platform]} file automatically.`,
            'Import it (Scene Collection → Import), switch to it, then pick cameras and audio in Setup.',
          ],
        },
      })
      report(found)
      return // device checks are meaningless on wrong-kind sources
    }

    if (c.mainCam === false) {
      found.push({
        key: 'main-cam',
        label: 'Camera 1 (Main)',
        problem: 'No device selected — source 1 is blank in every layout.',
        guide: {
          title: 'Pick the Main camera',
          steps: [
            'In OBS, open the MAIN scene.',
            'Double-click the "Main Cam 0" source.',
            'Choose your camera in the Device dropdown and press OK.',
            'Every layout that uses source 1 follows automatically.',
          ],
        },
      })
    }
    if (c.secondCam === false) {
      found.push({
        key: 'second-cam',
        label: 'Camera 2 (Second)',
        problem: 'No device selected — source 2 is blank in every layout.',
        guide: {
          title: 'Pick the Second camera',
          steps: [
            'In OBS, open the SECOND scene.',
            'Double-click the "Second Cam 0" source.',
            'Choose your camera in the Device dropdown and press OK.',
            'Every layout that uses source 2 follows automatically.',
          ],
        },
      })
    }

    if (mediaProblem !== null) {
      found.push({
        key: 'media',
        label: 'Media source',
        problem: mediaProblem,
        guide: {
          title: 'Set up the media source',
          steps: [
            'In OBS, open the MEDIA scene.',
            'Double-click a media source (e.g. "Media 0") and browse to its video file.',
            'More sources can be added to the scene — video, image, browser — anything.',
            'With several sources in the scene, the Media panel here lists them: tap one to put it on the media slots everywhere.',
          ],
        },
      })
    }

    if (c.logoSet === false) {
      found.push({
        key: 'logo',
        label: 'Logo image',
        problem: 'No image set — the Logo layer would show nothing.',
        guide: {
          title: 'Set the logo image',
          steps: [
            'In OBS, open the OVERLAY scene.',
            'Double-click the "Logo" source.',
            'Browse to your logo (PNG with transparency looks best) and press OK.',
            'It appears top-right on every layout when the Logo layer is on.',
          ],
        },
      })
    }

    if (missingLayers.length > 0) {
      found.push({
        key: 'overlay-update',
        label: 'New overlay layers available',
        problem: `This collection predates: ${missingLayers.map((s) => s.name).join(', ')}.`,
        fix: {
          label: 'Add layers',
          run: () => createOverlayLayers(query, missingLayers),
        },
        guide: {
          title: 'Add the new overlay layers',
          steps: [
            'Press "Add layers" — the dock creates the missing sources in the OVERLAY scene directly, keeping all your existing setup.',
            'They appear in the Layers panel immediately, switched off.',
            'Set each screen’s image when the rows appear below.',
            'Alternative: remove the old collection in OBS and re-import the latest file from Setup (cameras and media must then be re-picked).',
          ],
        },
      })
    }

    if (missingScreens.length > 0) {
      found.push({
        key: 'screens-update',
        label: 'Event screens available',
        problem: `This collection predates the ${missingScreens.map((s) => s.scene).join(', ')} scene${missingScreens.length > 1 ? 's' : ''}.`,
        fix: {
          label: 'Add scenes',
          run: async () => {
            await createScreenScenes(query, missingScreens)
            // Migration: these used to live as overlay layers — remove the
            // leftovers so they don't linger in the Layers panel
            for (const leftover of layers.filter((l) => SCREENS.some((s) => s.input === l.name))) {
              await query('RemoveSceneItem', { sceneName: OVERLAY_SCENE, sceneItemId: leftover.id })
            }
          },
        },
        guide: {
          title: 'Add the event screens',
          steps: [
            'Press "Add scenes" — the dock creates the WAITING, REST and ENDING scenes in OBS directly, keeping your existing setup.',
            'They appear as Screens buttons in the control panel.',
            'Set each screen’s image when the rows appear below.',
          ],
        },
      })
    }

    if (backgroundMissing) {
      found.push({
        key: 'background-update',
        label: 'Shared background available',
        problem: 'Split layouts show black behind the tiles — one image can fill every scene.',
        fix: {
          label: 'Add background',
          run: () =>
            createBackgroundSetup(
              query,
              scenes.filter((name) => parseScene(name) !== null),
            ),
        },
        guide: {
          title: 'Add the shared background',
          steps: [
            'Press "Add background" — the dock creates a BACKGROUND scene and slots it beneath every layout.',
            'Set the image once: in OBS, open the BACKGROUND scene, double-click "Background", and pick the 1920×1080 design.',
            'Every layout — fullscreen, splits, media — shows it automatically. Change it once, everything follows.',
          ],
        },
      })
    } else if (c.backgroundSet === false) {
      found.push({
        key: 'background',
        label: 'Background image',
        problem: 'No image set — split layouts show black behind the tiles.',
        guide: {
          title: 'Set the shared background',
          steps: [
            'In OBS, open the BACKGROUND scene.',
            'Double-click the "Background" source.',
            'Browse to the 1920×1080 background design and press OK.',
            'Every layout shows it — change it here once and everything follows.',
          ],
        },
      })
    }

    if (c.mediaCloneDrift === true && mediaActive !== null) {
      found.push({
        key: 'media-clones',
        label: 'Media slots out of sync',
        problem: 'Split layouts would show a different media source than fullscreen.',
        fix: {
          label: 'Sync media slots',
          run: () => syncMediaClones(query, mediaActive),
        },
        guide: {
          title: 'Sync the media slots',
          steps: [
            'The split layouts show media through clone sources (Media 1–5).',
            `They must point at the source the MEDIA scene shows ("${mediaActive}").`,
            'Press "Sync media slots" to repoint them all — or pick the source again in the Media panel.',
          ],
        },
      })
    }

    if (c.layoutOffGrid === true) {
      found.push({
        key: 'layout-align',
        label: 'Layout alignment fix available',
        problem: 'Slot sizes and positions drift from the exact grid — layouts can be a pixel or two off.',
        fix: {
          label: 'Align layouts',
          run: () => alignLayouts(query, scenes),
        },
        guide: {
          title: 'Pixel-align the layouts',
          steps: [
            'Press "Align layouts" — every slot is re-placed on the exact layout grid (60px margins and gutters, exact aspect ratios).',
            'Cameras fill their slots edge-to-edge; media fits inside, so any resolution shows completely.',
            'Sources, images and audio are untouched — only sizes and positions change, at most by a few pixels.',
          ],
        },
      })
    }

    if (!backgroundMissing && !c.audioExists) {
      found.push({
        key: 'audio-update',
        label: 'Audio input available',
        problem: 'No audio input in the scenes — the stream carries no sound.',
        fix: {
          label: 'Add audio input',
          run: async () => {
            const version = await query<{ platform: string }>('GetVersion')
            await createAudioInput(query, AUDIO_KIND[platformFromObs(version.platform) ?? 'macos'])
          },
        },
        guide: {
          title: 'Add the audio input',
          steps: [
            'Press "Add audio input" — the dock creates an input that is live on every layout.',
            'Then pick the soundcard/mixer device in Setup — the Audio section shows the devices with a live level meter.',
            'A volume fader appears in the Audio section of the control panel.',
          ],
        },
      })
    } else if (c.audioExists && c.audioDeviceSet === false) {
      found.push({
        key: 'audio-device',
        label: 'Audio input device',
        problem: 'Using the system default device — pick the soundcard so the stream carries the mixer feed.',
        setupAction: true,
        guide: {
          title: 'Pick the soundcard',
          steps: [
            'Open Setup — the Audio section lists the input devices with a live level meter.',
            'Pick the soundcard/interface that carries the mixer feed.',
            'Confirm the meter moves when the desk sends audio.',
          ],
        },
      })
    }

    if (missingScreens.length === 0 && screenLeftovers.length > 0) {
      found.push({
        key: 'screen-leftovers',
        label: 'Old screen layers',
        problem: 'Waiting/Rest/Ending are scenes now — these overlay copies are leftovers.',
        fix: {
          label: 'Remove leftovers',
          run: async () => {
            for (const leftover of screenLeftovers) {
              await query('RemoveSceneItem', { sceneName: OVERLAY_SCENE, sceneItemId: leftover.id })
            }
          },
        },
        guide: {
          title: 'Remove the old screen layers',
          steps: [
            'The event screens used to live as overlay layers; they moved to dedicated scenes.',
            'Press "Remove leftovers" — the copies are removed from the OVERLAY scene.',
            'The image sources themselves stay, so the WAITING/REST/ENDING scenes keep their images.',
          ],
        },
      })
    }

    SCREENS.forEach((spec, i) => {
      if (missingScreens.includes(spec)) return
      if (c.screens[i] !== false) return
      found.push({
        key: `screen-${spec.key}`,
        label: spec.input,
        problem: 'No image set — this screen would show nothing.',
        guide: {
          title: `Set the ${spec.input} image`,
          steps: [
            `In OBS, open the ${spec.scene} scene.`,
            `Double-click the "${spec.input}" source.`,
            'Browse to the designed 1920×1080 image and press OK.',
            `Press "${spec.label}" in Screens to put it on the stream.`,
          ],
        },
      })
    })

    if (runningTextEmpty) {
      found.push({
        key: 'running-text',
        label: 'Running text',
        problem: 'No text set — the Running Text layer would show nothing.',
        guide: {
          title: 'Write the running text',
          steps: [
            'In the Layers panel on the right, find "Running Text".',
            'Press Edit, type the announcement, and press Apply.',
            'Toggle the layer on when it should appear on the stream.',
            'It can also be edited from any remote — no OBS needed.',
          ],
        },
      })
    }

    report(found)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- missing lists are keyed by their joined strings
  }, [
    query,
    onItemsChange,
    scenesReady,
    mediaProblem,
    mediaActive,
    runningTextEmpty,
    missingLayersKey,
    missingScreensKey,
    screenLeftoversKey,
    backgroundMissing,
  ])

  // OBS fires event bursts (imports, one-click fixes touch many items) —
  // coalesce into one sweep instead of a full query volley per event.
  const checksTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scheduleChecks = useCallback(() => {
    clearTimeout(checksTimer.current)
    checksTimer.current = setTimeout(() => void runChecks(), 200)
  }, [runChecks])

  useEffect(() => {
    scheduleChecks()
    return () => clearTimeout(checksTimer.current)
  }, [scheduleChecks])

  useEffect(() => subscribe(WATCH_EVENTS, scheduleChecks), [subscribe, scheduleChecks])

  if (items.length === 0) {
    // Show a positive state once checks have actually run, so "all good" is
    // distinguishable from "checks never happened" for a first-time operator.
    if (!ran) return null
    return (
      <section className="animate-fade-in space-y-2">
        <h3 className="text-sm sm:text-xs font-semibold uppercase tracking-wider text-ios-label2">Setup status</h3>
        <div className="flex items-center gap-2 rounded-2xl bg-ios-card px-3 py-2.5 text-sm sm:text-xs text-ios-green">
          <span className="h-2 w-2 shrink-0 rounded-full bg-ios-green" />
          Everything is set — all checks passed.
        </div>
      </section>
    )
  }

  return (
    <section className="animate-fade-in space-y-2">
      <h3 className="text-sm sm:text-xs font-semibold uppercase tracking-wider text-ios-orange">Needs attention</h3>
      <div className="divide-y divide-ios-sep/60 overflow-hidden rounded-2xl bg-ios-card">
        {items.map((item) => (
          <div key={item.key} className="space-y-1 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-ios-orange/90" />
              <span className="min-w-0 flex-1 truncate text-sm sm:text-xs font-medium text-white">{item.label}</span>
              <button
                title={`How to fix: ${item.label}`}
                onClick={() => setGuide(item)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ios-fill text-sm sm:text-xs font-bold text-ios-blue transition-all duration-150 ease-out hover:bg-ios-fill2 active:scale-90"
              >
                ?
              </button>
            </div>
            <p className="text-xs leading-snug text-ios-label3">{item.problem}</p>
            {item.setupAction && (
              <button
                onClick={onOpenSetup}
                className="mt-1 w-full rounded-xl bg-ios-blue px-3 py-1.5 text-sm sm:text-xs font-semibold text-white transition-all duration-200 ease-out hover:bg-ios-blue-light active:scale-[0.98]"
              >
                Open setup
              </button>
            )}
            {item.fix && (
              <button
                disabled={fixing !== null}
                onClick={() => {
                  setFixing(item.key)
                  setFixError(null)
                  item.fix
                    ?.run()
                    .then(() => runChecks())
                    .catch((e: unknown) => {
                      setFixError(e instanceof Error && e.message.trim() ? e.message : 'Could not apply the fix')
                    })
                    .finally(() => setFixing(null))
                }}
                className="mt-1 w-full rounded-xl bg-ios-blue px-3 py-1.5 text-sm sm:text-xs font-semibold text-white transition-all duration-200 ease-out hover:bg-ios-blue-light active:scale-[0.98] disabled:opacity-50"
              >
                {fixing === item.key ? 'Adding…' : item.fix.label}
              </button>
            )}
          </div>
        ))}
      </div>
      {fixError && <p className="text-xs text-ios-red">{fixError}</p>}

      {guide && (
        <div
          className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/60 p-4"
          onClick={() => setGuide(null)}
        >
          <div
            className="w-full max-w-sm animate-pop-in rounded-2xl bg-ios-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base sm:text-sm font-semibold">{guide.guide.title}</h3>
              <button
                onClick={() => setGuide(null)}
                className="rounded-md px-1.5 text-ios-blue transition-colors hover:text-ios-blue-light"
              >
                ✕
              </button>
            </div>
            <ol className="space-y-2">
              {guide.guide.steps.map((step, i) => (
                <li key={i} className="flex gap-3 text-base sm:text-sm text-ios-label2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ios-fill text-xs font-bold text-white">
                    {i + 1}
                  </span>
                  <span className="min-w-0">{step}</span>
                </li>
              ))}
            </ol>
            {guide.setupAction && (
              <button
                onClick={() => {
                  setGuide(null)
                  onOpenSetup()
                }}
                className="mt-4 w-full rounded-xl bg-ios-blue px-3 py-2 text-base sm:text-sm font-semibold text-white transition-all duration-200 ease-out hover:bg-ios-blue-light active:scale-[0.98]"
              >
                Open setup
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
