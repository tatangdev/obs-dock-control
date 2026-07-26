// Single source of truth for the global overlay layers (the OVERLAY scene).
//
// Consumed by two sides that must never drift:
//   - scripts/gen-collection.ts bakes these specs into the importable
//     scene collection, so fresh imports have every layer
//   - SetupChecklist reconciles a live OBS against this list and creates
//     whatever is missing, so existing installs upgrade with one click
//
// To add a layer: append a spec here, run `npm run gen:collection`, done.

export const OVERLAY_SCENE = 'OVERLAY'

export interface OverlayTransform {
  positionX: number
  positionY: number
  /** Fit-inside box; omit for the source's natural size */
  bounds?: { width: number; height: number }
}

export interface OverlayFilterSpec {
  name: string
  kind: string
  settings: Record<string, unknown>
}

export interface OverlayLayerSpec {
  name: string
  /** Input kind as used in collection JSON (unversioned) */
  kind: string
  /** Versioned kind, used for CreateInput and versioned_id (defaults to kind) */
  versionedKind?: string
  settings: Record<string, unknown>
  transform: OverlayTransform
  filters?: OverlayFilterSpec[]
}

/** Bottom → top */
export const OVERLAY_LAYERS: readonly OverlayLayerSpec[] = [
  {
    name: 'Logo',
    kind: 'image_source',
    settings: {},
    transform: { positionX: 1620, positionY: 60, bounds: { width: 240, height: 140 } },
  },
  {
    name: 'Running Text',
    kind: 'text_ft2_source',
    versionedKind: 'text_ft2_source_v2',
    settings: {
      text: '',
      font: { face: 'Arial', size: 56, flags: 0, style: 'Regular' },
      color1: 4294967295,
      color2: 4294967295,
      outline: true,
    },
    transform: { positionX: 60, positionY: 980 },
    filters: [{ name: 'Scroll', kind: 'scroll_filter', settings: { speed_x: 100.0 } }],
  },
]

export const LOGO_INPUT = 'Logo'
export const RUNNING_TEXT_INPUT = 'Running Text'

// The shared background: one image source in a nested BACKGROUND scene that
// sits at the *bottom* of every program scene — swap the image once and every
// layout follows. Without it, split layouts show black behind the tiles.
export const BACKGROUND_SCENE = 'BACKGROUND'
export const BACKGROUND_INPUT = 'Background'

// The audio input (soundcard / mixer feed) lives in the BACKGROUND scene too,
// so it is active on every program scene. Empty settings = system default
// device — events should pick the actual soundcard in Setup.
export const AUDIO_INPUT = 'Audio Input'

type Query = <T = unknown>(request: string, params?: Record<string, unknown>) => Promise<T>

// Create the audio input inside the BACKGROUND scene of a live OBS
export async function createAudioInput(query: Query, audioKind: string): Promise<void> {
  await query('CreateInput', {
    sceneName: BACKGROUND_SCENE,
    inputName: AUDIO_INPUT,
    inputKind: audioKind,
    inputSettings: {},
    sceneItemEnabled: true,
  })
}

// Create the BACKGROUND scene in a live OBS and slot it beneath every given
// program scene. Reuses the Background input if it already exists.
export async function createBackgroundSetup(query: Query, programScenes: readonly string[]): Promise<void> {
  await query('CreateScene', { sceneName: BACKGROUND_SCENE })
  let sceneItemId: number
  try {
    ;({ sceneItemId } = await query<{ sceneItemId: number }>('CreateInput', {
      sceneName: BACKGROUND_SCENE,
      inputName: BACKGROUND_INPUT,
      inputKind: 'image_source',
      inputSettings: {},
      sceneItemEnabled: true,
    }))
  } catch {
    ;({ sceneItemId } = await query<{ sceneItemId: number }>('CreateSceneItem', {
      sceneName: BACKGROUND_SCENE,
      sourceName: BACKGROUND_INPUT,
      sceneItemEnabled: true,
    }))
  }
  await query('SetSceneItemTransform', {
    sceneName: BACKGROUND_SCENE,
    sceneItemId,
    sceneItemTransform: {
      positionX: 0,
      positionY: 0,
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsAlignment: 0,
      boundsWidth: 1920,
      boundsHeight: 1080,
    },
  })
  for (const sceneName of programScenes) {
    const { sceneItemId: nestedId } = await query<{ sceneItemId: number }>('CreateSceneItem', {
      sceneName,
      sourceName: BACKGROUND_SCENE,
      sceneItemEnabled: true,
    })
    await query('SetSceneItemIndex', { sceneName, sceneItemId: nestedId, sceneItemIndex: 0 })
  }
}

// Create the given layers in a live OBS: input + transform + filters, hidden,
// pushed to the bottom of the overlay stack. Creating in reverse keeps the
// blueprint's relative order among the newly added layers.
export async function createOverlayLayers(query: Query, specs: readonly OverlayLayerSpec[]): Promise<void> {
  for (const spec of [...specs].reverse()) {
    const { sceneItemId } = await query<{ sceneItemId: number }>('CreateInput', {
      sceneName: OVERLAY_SCENE,
      inputName: spec.name,
      inputKind: spec.versionedKind ?? spec.kind,
      inputSettings: spec.settings,
      sceneItemEnabled: false,
    })
    await query('SetSceneItemTransform', {
      sceneName: OVERLAY_SCENE,
      sceneItemId,
      sceneItemTransform: {
        positionX: spec.transform.positionX,
        positionY: spec.transform.positionY,
        ...(spec.transform.bounds
          ? {
              boundsType: 'OBS_BOUNDS_SCALE_INNER',
              boundsAlignment: 0,
              boundsWidth: spec.transform.bounds.width,
              boundsHeight: spec.transform.bounds.height,
            }
          : {}),
      },
    })
    await query('SetSceneItemIndex', { sceneName: OVERLAY_SCENE, sceneItemId, sceneItemIndex: 0 })
    for (const filter of spec.filters ?? []) {
      await query('CreateSourceFilter', {
        sourceName: spec.name,
        filterName: filter.name,
        filterKind: filter.kind,
        filterSettings: filter.settings,
      })
    }
  }
}
