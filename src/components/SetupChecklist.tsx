import { useCallback, useEffect, useState } from 'react'
import type { OBSEventTypes } from 'obs-websocket-js'
import type { LayerInfo, MediaStatus } from '../../shared/protocol'
import type { ObsQuery, ObsSubscribe } from '../lib/useObs'
import { SCREENS, createScreenScenes, isSetupReady } from '../lib/scenes'
import { LOGO_INPUT, OVERLAY_LAYERS, OVERLAY_SCENE, createOverlayLayers } from '../lib/overlay'

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

interface SetupChecklistProps {
  query: ObsQuery
  subscribe: ObsSubscribe
  scenes: string[]
  media: MediaStatus | null
  layers: LayerInfo[]
  runningText: string | null
  onOpenSetup: () => void
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
}: SetupChecklistProps) {
  const [items, setItems] = useState<Item[]>([])
  const [guide, setGuide] = useState<Item | null>(null)
  const [fixing, setFixing] = useState<string | null>(null)
  const [fixError, setFixError] = useState<string | null>(null)

  const scenesReady = isSetupReady(scenes)
  const mediaFileSet = media !== null && media.file !== null
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

  const runChecks = useCallback(async () => {
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
      setItems(found)
      return // source checks are meaningless until the collection is in
    }

    const [mainCam, secondCam, logoSet, ...screenResults] = await Promise.all([
      inputHasSetting(query, 'Main Cam 0', DEVICE_KEYS),
      inputHasSetting(query, 'Second Cam 0', DEVICE_KEYS),
      inputHasSetting(query, LOGO_INPUT, ['file']),
      ...SCREENS.map((s) => inputHasSetting(query, s.input, ['file'])),
    ])

    if (mainCam === false) {
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
    if (secondCam === false) {
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

    if (!mediaFileSet) {
      found.push({
        key: 'media',
        label: 'SDE video',
        problem: 'No video file loaded — Media mode stays locked.',
        guide: {
          title: 'Load the SDE video',
          steps: [
            'In OBS, open the MEDIA scene.',
            'Double-click the "Media 0" source.',
            'Browse to the exported SDE file and press OK.',
            'Playback controls appear in the Media panel here.',
          ],
        },
      })
    }

    if (logoSet === false) {
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
      if (screenResults[i] !== false) return
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

    setItems(found)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- missing lists are keyed by their joined strings
  }, [query, scenesReady, mediaFileSet, runningTextEmpty, missingLayersKey, missingScreensKey, screenLeftoversKey])

  useEffect(() => {
    void runChecks()
  }, [runChecks])

  useEffect(() => subscribe(WATCH_EVENTS, () => void runChecks()), [subscribe, runChecks])

  if (items.length === 0) return null

  return (
    <section className="animate-fade-in space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-ios-orange">Needs attention</h3>
      <div className="divide-y divide-ios-sep/60 overflow-hidden rounded-2xl bg-ios-card">
        {items.map((item) => (
          <div key={item.key} className="space-y-1 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-ios-orange/90" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-white">{item.label}</span>
              <button
                title={`How to fix: ${item.label}`}
                onClick={() => setGuide(item)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ios-fill text-xs font-bold text-ios-blue transition-all duration-150 ease-out hover:bg-ios-fill2 active:scale-90"
              >
                ?
              </button>
            </div>
            <p className="text-[11px] leading-snug text-ios-label3">{item.problem}</p>
            {item.setupAction && (
              <button
                onClick={onOpenSetup}
                className="mt-1 w-full rounded-xl bg-ios-blue px-3 py-1.5 text-xs font-semibold text-white transition-all duration-200 ease-out hover:bg-ios-blue-light active:scale-[0.98]"
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
                    .catch((e: unknown) => {
                      setFixError(e instanceof Error && e.message.trim() ? e.message : 'Could not apply the fix')
                    })
                    .finally(() => setFixing(null))
                }}
                className="mt-1 w-full rounded-xl bg-ios-blue px-3 py-1.5 text-xs font-semibold text-white transition-all duration-200 ease-out hover:bg-ios-blue-light active:scale-[0.98] disabled:opacity-50"
              >
                {fixing === item.key ? 'Adding…' : item.fix.label}
              </button>
            )}
          </div>
        ))}
      </div>
      {fixError && <p className="text-[11px] text-ios-red">{fixError}</p>}

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
              <h3 className="text-sm font-semibold">{guide.guide.title}</h3>
              <button
                onClick={() => setGuide(null)}
                className="rounded-md px-1.5 text-ios-blue transition-colors hover:text-ios-blue-light"
              >
                ✕
              </button>
            </div>
            <ol className="space-y-2">
              {guide.guide.steps.map((step, i) => (
                <li key={i} className="flex gap-3 text-sm text-ios-label2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ios-fill text-[10px] font-bold text-white">
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
                className="mt-4 w-full rounded-xl bg-ios-blue px-3 py-2 text-sm font-semibold text-white transition-all duration-200 ease-out hover:bg-ios-blue-light active:scale-[0.98]"
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
