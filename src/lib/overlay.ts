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

type Query = <T = unknown>(request: string, params?: Record<string, unknown>) => Promise<T>

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
