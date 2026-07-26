import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { OBSEventTypes } from 'obs-websocket-js'
import type { ObsQuery, ObsSubscribe } from '../lib/useObs'
import { COLLECTION_NAME, REQUIRED_SCENES, isSetupReady } from '../lib/scenes'
import { CAMERA_DEVICE_PROP, COLLECTION_FILE, PLATFORMS, PLATFORM_LABEL, platformFromObs } from '../lib/platform'
import type { Platform } from '../lib/platform'

const PLUGINS = [
  { name: 'Source Clone', url: 'https://obsproject.com/forum/resources/source-clone.1632/', key: 'sourceClone' },
  { name: 'Advanced Masks', url: 'https://obsproject.com/forum/resources/advanced-masks.1856/', key: 'masks' },
  { name: 'Move Transition', url: 'https://obsproject.com/forum/resources/move.913/', key: 'move' },
] as const

// Any of these means the checklist may be stale — re-run it automatically
const WATCH_EVENTS: readonly (keyof OBSEventTypes)[] = [
  'SceneCollectionListChanged',
  'CurrentSceneCollectionChanged',
  'SceneListChanged',
  'SceneCreated',
  'SceneRemoved',
]

interface Checks {
  sourceClone: boolean
  /** null = OBS too old to report filter kinds — can't verify */
  masks: boolean | null
  move: boolean
  collections: string[]
  currentCollection: string
  scenesPresent: number
  /** OS of the machine running OBS — decides which collection file fits */
  platform: Platform | null
}

interface SetupPanelProps {
  query: ObsQuery
  subscribe: ObsSubscribe
  scenes: string[]
  onClose: () => void
}

// Operator onboarding: verifies plugins, hands out the scene collection file,
// activates it once imported, and lets the operator pick cameras with live
// thumbnails — no OBS dialogs needed. Re-checks itself whenever OBS changes.
export default function SetupPanel({ query, subscribe, scenes, onClose }: SetupPanelProps) {
  const [checks, setChecks] = useState<Checks | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activating, setActivating] = useState(false)

  const runChecks = useCallback(async () => {
    try {
      const [kinds, transitions, collections, version] = await Promise.all([
        query<{ inputKinds: string[] }>('GetInputKindList'),
        query<{ transitions: { transitionKind: string }[] }>('GetSceneTransitionList'),
        query<{ currentSceneCollectionName: string; sceneCollections: string[] }>('GetSceneCollectionList'),
        query<{ platform: string }>('GetVersion'),
      ])
      let masks: boolean | null = null
      try {
        const filterKinds = await query<{ sourceFilterKinds: string[] }>('GetSourceFilterKindList')
        masks = filterKinds.sourceFilterKinds.some((k) => k.startsWith('advanced_masks'))
      } catch {
        // request needs obs-websocket >= 5.4 — leave as unknown
      }
      setChecks({
        sourceClone: kinds.inputKinds.includes('source-clone'),
        masks,
        move: transitions.transitions.some((t) => t.transitionKind === 'move_transition'),
        collections: collections.sceneCollections,
        currentCollection: collections.currentSceneCollectionName,
        scenesPresent: REQUIRED_SCENES.filter((name) => scenes.includes(name)).length,
        platform: platformFromObs(version.platform),
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error && e.message.trim() ? e.message : 'Could not read setup status from OBS')
    }
  }, [query, scenes])

  useEffect(() => {
    void runChecks()
  }, [runChecks])

  // The panel keeps itself current: importing a collection or switching one
  // in OBS re-runs the checklist without the operator touching Refresh.
  useEffect(() => subscribe(WATCH_EVENTS, () => void runChecks()), [subscribe, runChecks])

  async function activate(): Promise<void> {
    setActivating(true)
    setError(null)
    try {
      await query('SetCurrentSceneCollection', { sceneCollectionName: COLLECTION_NAME })
      await runChecks()
    } catch (e) {
      setError(e instanceof Error && e.message.trim() ? e.message : 'Could not switch scene collection')
    } finally {
      setActivating(false)
    }
  }

  const imported = checks?.collections.includes(COLLECTION_NAME) ?? false
  const isActive = checks?.currentCollection === COLLECTION_NAME
  // Core readiness — the checklist handles incremental additions (screens)
  const scenesReady = checks !== null && isSetupReady(scenes)

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-full w-full max-w-md animate-pop-in overflow-y-auto rounded-2xl border border-transparent bg-ios-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base sm:text-sm font-semibold">OBS setup</h3>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void runChecks()}
              className="rounded-md px-1.5 text-sm sm:text-xs text-ios-blue transition-colors hover:text-ios-blue-light"
            >
              Refresh
            </button>
            <button onClick={onClose} className="rounded-md px-1.5 text-ios-blue transition-colors hover:text-ios-blue-light">
              ✕
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-3 rounded-xl border border-transparent bg-ios-red/15 px-3 py-2 text-base sm:text-sm text-ios-red">
            {error}
          </div>
        )}

        {!checks ? (
          <p className="text-base sm:text-sm text-ios-label2">Checking OBS…</p>
        ) : (
          <div className="space-y-4">
            {scenesReady ? (
              <div className="animate-fade-in space-y-2">
                <div className="rounded-xl border border-transparent bg-ios-green/15 px-3 py-2 text-base sm:text-sm text-ios-green">
                  All {REQUIRED_SCENES.length} scenes are ready.
                </div>
                <div className="space-y-1 px-1">
                  <span className="text-sm sm:text-xs text-ios-label3">Setting up another machine?</span>
                  <CollectionDownload platform={checks.platform} compact />
                </div>
              </div>
            ) : (
              <>
                <Step n={1} title="Install plugins">
                  <div className="space-y-1">
                    {PLUGINS.map((p) => {
                      const ok = checks[p.key]
                      return (
                        <div key={p.key} className="flex items-center justify-between text-base sm:text-sm">
                          <span className="flex items-center gap-2">
                            <StatusDot ok={ok} />
                            {p.name}
                          </span>
                          {ok !== true && (
                            <a
                              href={p.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sm sm:text-xs text-ios-blue hover:text-ios-blue-light"
                            >
                              download ↗
                            </a>
                          )}
                        </div>
                      )
                    })}
                    {checks.masks === null && (
                      <p className="text-sm sm:text-xs text-ios-label3">
                        Advanced Masks can&apos;t be verified on this OBS version — make sure it&apos;s installed.
                      </p>
                    )}
                    {!checks.move && (
                      <p className="text-sm sm:text-xs text-ios-label3">
                        Move Transition is detected after the collection is active.
                      </p>
                    )}
                  </div>
                </Step>

                <Step n={2} title="Download the scene collection">
                  <CollectionDownload platform={checks.platform} />
                </Step>

                <Step n={3} title="Import it in OBS">
                  <p className="text-sm sm:text-xs text-ios-label2">
                    OBS menu → <span className="text-white">Scene Collection → Import</span> → choose the downloaded
                    file. This panel updates by itself when it&apos;s done.
                  </p>
                </Step>

                <Step n={4} title={`Activate "${COLLECTION_NAME}"`}>
                  {isActive ? (
                    <p className="flex items-center gap-2 text-base sm:text-sm text-white">
                      <StatusDot ok /> Active
                    </p>
                  ) : imported ? (
                    <button
                      onClick={() => void activate()}
                      disabled={activating}
                      className="rounded-xl bg-ios-blue px-3 py-1.5 text-sm sm:text-xs font-semibold text-white transition-all duration-200 ease-out hover:bg-ios-blue active:scale-[0.98] disabled:opacity-50"
                    >
                      {activating ? 'Switching…' : 'Switch to it now'}
                    </button>
                  ) : (
                    <p className="flex items-center gap-2 text-base sm:text-sm text-ios-label2">
                      <StatusDot ok={false} /> Not imported yet
                    </p>
                  )}
                </Step>
              </>
            )}

            {(isActive || scenesReady) && (
              <div className="animate-fade-in space-y-2">
                <div className="text-base sm:text-sm font-medium text-white">Cameras</div>
                <p className="text-sm sm:text-xs text-ios-label3">
                  Pick each camera — the thumbnail shows what it sees. Every layout follows automatically.
                </p>
                <CameraRow inputName="Main Cam 0" label="Camera 1 (Main)" query={query} />
                <CameraRow inputName="Second Cam 0" label="Camera 2 (Second)" query={query} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Platform-aware download: the camera capture kind differs per OS, so each
// platform gets its own collection file. When OBS told us its platform, offer
// that file directly; otherwise let the operator pick.
function CollectionDownload({ platform, compact = false }: { platform: Platform | null; compact?: boolean }) {
  const primaryCls = compact
    ? 'text-sm sm:text-xs text-ios-blue transition-colors hover:text-ios-blue-light'
    : 'inline-block rounded-xl bg-ios-fill px-3 py-1.5 text-sm sm:text-xs font-semibold text-ios-blue transition-all duration-200 ease-out hover:bg-ios-fill2 active:scale-[0.98]'

  if (platform) {
    const others = PLATFORMS.filter((p) => p !== platform)
    return (
      <div className="space-y-1">
        <a href={COLLECTION_FILE[platform]} download={`dock-control-${platform}.json`} className={primaryCls}>
          Download collection file ({PLATFORM_LABEL[platform]})
        </a>
        <p className="text-sm sm:text-xs text-ios-label3">
          Other OS:{' '}
          {others.map((p, i) => (
            <span key={p}>
              {i > 0 && ' · '}
              <a
                href={COLLECTION_FILE[p]}
                download={`dock-control-${p}.json`}
                className="text-ios-blue transition-colors hover:text-ios-blue-light"
              >
                {PLATFORM_LABEL[p]}
              </a>
            </span>
          ))}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <p className="text-sm sm:text-xs text-ios-label3">Pick the OS of the machine running OBS:</p>
      <div className="flex flex-wrap gap-2">
        {PLATFORMS.map((p) => (
          <a key={p} href={COLLECTION_FILE[p]} download={`dock-control-${p}.json`} className={primaryCls}>
            {PLATFORM_LABEL[p]}
          </a>
        ))}
      </div>
    </div>
  )
}

interface DeviceOption {
  name: string
  value: string
}

// One camera: device dropdown + a live thumbnail so the operator can see
// they picked the right one instead of guessing from device names.
function CameraRow({ inputName, label, query }: { inputName: string; label: string; query: ObsQuery }) {
  const [devices, setDevices] = useState<DeviceOption[]>([])
  const [current, setCurrent] = useState('')
  const [thumb, setThumb] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const [deviceProp, setDeviceProp] = useState<{ prop: string; nameProp?: string } | null>(null)

  const load = useCallback(async () => {
    try {
      // The device property name depends on the capture kind (per OS)
      const settings = await query<{ inputKind: string; inputSettings: Record<string, unknown> }>(
        'GetInputSettings',
        { inputName },
      )
      const propInfo = CAMERA_DEVICE_PROP[settings.inputKind] ?? { prop: 'device' }
      const props = await query<{ propertyItems: { itemName: string; itemValue: unknown; itemEnabled: boolean }[] }>(
        'GetInputPropertiesListPropertyItems',
        { inputName, propertyName: propInfo.prop },
      )
      setDeviceProp(propInfo)
      setDevices(props.propertyItems.filter((p) => p.itemEnabled).map((p) => ({ name: p.itemName, value: String(p.itemValue) })))
      setCurrent(String(settings.inputSettings[propInfo.prop] ?? ''))
      setRowError(null)
    } catch (e) {
      setRowError(e instanceof Error && e.message.trim() ? e.message : 'Could not list cameras')
    }
  }, [inputName, query])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      if (document.hidden) return // don't poll thumbnails from a background tab
      try {
        const shot = await query<{ imageData: string }>('GetSourceScreenshot', {
          sourceName: inputName,
          imageFormat: 'jpg',
          imageWidth: 320,
          imageCompressionQuality: 70,
        })
        if (alive) setThumb(shot.imageData)
      } catch {
        if (alive) setThumb(null)
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [inputName, query])

  async function pick(value: string): Promise<void> {
    const device = devices.find((d) => d.value === value)
    if (!device || !deviceProp) return
    setCurrent(value)
    try {
      await query('SetInputSettings', {
        inputName,
        inputSettings: {
          [deviceProp.prop]: device.value,
          ...(deviceProp.nameProp ? { [deviceProp.nameProp]: device.name } : {}),
        },
      })
      setRowError(null)
    } catch (e) {
      setRowError(e instanceof Error && e.message.trim() ? e.message : 'Could not set the camera')
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-xl bg-ios-fill/60 p-2">
      <div className="aspect-video w-24 shrink-0 overflow-hidden rounded-md border border-transparent bg-black">
        {thumb ? (
          <img src={thumb} alt={`${label} preview`} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-ios-label3">no signal</div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-sm sm:text-xs text-ios-label2">{label}</div>
        <select
          value={current}
          onChange={(e) => void pick(e.target.value)}
          className="w-full rounded-xl border border-transparent bg-ios-fill px-2 py-1.5 text-sm sm:text-xs text-white outline-none transition-colors duration-200 ease-out focus:border-ios-blue"
        >
          <option value="">— select camera —</option>
          {devices.map((d) => (
            <option key={d.value} value={d.value}>
              {d.name}
            </option>
          ))}
        </select>
        {rowError && <p className="mt-1 text-xs text-ios-red">{rowError}</p>}
      </div>
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ios-fill text-xs font-bold text-ios-label2">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="text-base sm:text-sm font-medium text-white">{title}</div>
        {children}
      </div>
    </div>
  )
}

function StatusDot({ ok }: { ok: boolean | null }) {
  const cls = ok === true ? 'bg-ios-green' : ok === false ? 'bg-ios-red' : 'bg-ios-orange'
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />
}
