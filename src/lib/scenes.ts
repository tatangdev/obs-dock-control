// Maps UI selections onto the scene names of the "Dock Control" collection
// and back. Naming convention: fullscreen scenes are a single source token
// ("MAIN", "MEDIA"); splits are "<FEATURED> <SECONDARY>[ N]" where the first
// token owns the featured slot and the numeric suffix picks the split style
// (no suffix = equal split). Example: "MEDIA SECOND 4" = media video fullscreen
// with the Second cam floating in the corner card.

export type SplitKey = 'equal' | 'large' | 'big-small' | 'overlay'
export type SourceKey = 'main' | 'second' | 'media'

/** Name of the importable collection served at /scene-collection.json */
export const COLLECTION_NAME = 'Dock Control'

import { BACKGROUND_INPUT, BACKGROUND_SCENE, LOGO_INPUT, OVERLAY_SCENE } from './overlay'
import type { MediaStatus } from '../../shared/protocol'

/** The fullscreen media scene — operators drop extra media sources into it */
export const MEDIA_SCENE = 'MEDIA'

/**
 * The Source Clone inputs the split scenes render media through. Whatever
 * source is shown in the MEDIA scene, these must clone the same source or
 * fullscreen and PiP would show different media.
 */
export const MEDIA_CLONES = ['Media 1', 'Media 2', 'Media 3', 'Media 4', 'Media 5'] as const

/** Input kinds the transport (play/pause/seek) can drive */
export const PLAYABLE_KINDS: ReadonlySet<string> = new Set(['ffmpeg_source', 'vlc_source'])

export const SOURCES: readonly SourceKey[] = ['main', 'second', 'media']

const TOKEN: Record<SourceKey, string> = { main: 'MAIN', second: 'SECOND', media: 'MEDIA' }
const KEY: Record<string, SourceKey> = { MAIN: 'main', SECOND: 'second', MEDIA: 'media' }

const STYLE_TO_SUFFIX: Record<SplitKey, string> = {
  equal: '',
  large: ' 2',
  'big-small': ' 3',
  overlay: ' 4',
}

/** Inverse of STYLE_TO_SUFFIX (keys are trimmed suffixes; also used by the collection generator) */
export const SUFFIX_TO_STYLE: Record<string, SplitKey> = {
  '': 'equal',
  '2': 'large',
  '3': 'big-small',
  '4': 'overlay',
}

export type ScreenKey = 'waiting' | 'rest' | 'ending'

export interface ScreenSpec {
  key: ScreenKey
  /** Dedicated program scene */
  scene: string
  /** The full-screen image source inside that scene */
  input: string
  label: string
}

/** Standalone event screens — dedicated scenes, not overlays */
export const SCREENS: readonly ScreenSpec[] = [
  { key: 'waiting', scene: 'WAITING', input: 'Waiting Screen', label: 'Waiting' },
  { key: 'rest', scene: 'REST', input: 'Rest Screen', label: 'Rest' },
  { key: 'ending', scene: 'ENDING', input: 'Ending Screen', label: 'Ending' },
]

export type Selection =
  | { mode: 'fullscreen'; source: SourceKey }
  | { mode: 'split'; style: SplitKey; featured: SourceKey; secondary: SourceKey }
  | { mode: 'screen'; screen: ScreenKey }

/** How media appears in the given selection, if at all */
export function mediaRole(sel: Selection | null): 'fullscreen' | 'pip' | null {
  if (!sel) return null
  if (sel.mode === 'fullscreen') return sel.source === 'media' ? 'fullscreen' : null
  if (sel.mode === 'split') return sel.featured === 'media' || sel.secondary === 'media' ? 'pip' : null
  return null
}

export function sceneFor(sel: Selection): string {
  if (sel.mode === 'fullscreen') return TOKEN[sel.source]
  if (sel.mode === 'screen') return SCREENS.find((s) => s.key === sel.screen)?.scene ?? 'WAITING'
  return `${TOKEN[sel.featured]} ${TOKEN[sel.secondary]}${STYLE_TO_SUFFIX[sel.style]}`
}

export function parseScene(name: string): Selection | null {
  const screen = SCREENS.find((s) => s.scene === name)
  if (screen) return { mode: 'screen', screen: screen.key }
  const match = /^(MAIN|SECOND|MEDIA)(?: (MAIN|SECOND|MEDIA))?(?: ([234]))?$/.exec(name)
  if (!match) return null
  const featured = KEY[match[1] ?? '']
  if (!featured) return null
  const secondary = match[2] ? KEY[match[2]] : undefined
  if (!secondary) {
    // a bare source token with a style suffix ("MAIN 2") is not a real scene
    return match[3] ? null : { mode: 'fullscreen', source: featured }
  }
  if (featured === secondary) return null
  const style = SUFFIX_TO_STYLE[match[3] ?? '']
  if (!style) return null
  return { mode: 'split', style, featured, secondary }
}

const SPLIT_KEYS: readonly SplitKey[] = ['equal', 'large', 'big-small', 'overlay']

/** The scenes the app cannot function without (layouts + overlay host) */
const CORE_SCENES: readonly string[] = [
  ...SOURCES.map((s) => TOKEN[s]),
  ...SPLIT_KEYS.flatMap((style) =>
    SOURCES.flatMap((featured) =>
      SOURCES.filter((s) => s !== featured).map((secondary) => sceneFor({ mode: 'split', style, featured, secondary })),
    ),
  ),
  OVERLAY_SCENE,
]

/** Everything a fresh import ships — core plus the event screens and background */
export const REQUIRED_SCENES: readonly string[] = [...CORE_SCENES, ...SCREENS.map((s) => s.scene), BACKGROUND_SCENE]

// Core only: older-but-working installs shouldn't be flagged as broken —
// the checklist offers the missing screens as an incremental one-click add.
export function isSetupReady(scenes: readonly string[]): boolean {
  return CORE_SCENES.every((name) => scenes.includes(name))
}

// --- slot geometry -------------------------------------------------------
// Every layout rect derives from one grid spec. The original hand-composited
// values drifted by a pixel or two (twin slots 869 vs 870 wide, 61px gap
// between 60px margins, the two overlay-style cards 50px apart) — deriving
// keeps every margin, gutter and aspect mathematically exact, and cams and
// media in the same slot share the identical rect.

export interface MediaBox {
  x: number
  y: number
  w: number
  h: number
}

export const CANVAS = { w: 1920, h: 1080 } as const
/** Outer margin and inter-slot gutter of the layout grid */
export const GRID_MARGIN = 60
/** The floating corner card: a CARD_MASK_WIDTH×1080 masked crop at this scale */
const CARD_SCALE = 0.40625
/** Source-space width of the card's rounded crop mask */
export const CARD_MASK_WIDTH = 1000

export const MEDIA_FULL_BOX: MediaBox = { x: 0, y: 0, w: CANVAS.w, h: CANVAS.h }

const box = (x: number, y: number, w: number, h: number): MediaBox => ({ x, y, w, h })
const centerY = (h: number): number => (CANVAS.h - h) / 2

/** Per split style: [featured slot box, secondary slot box] — exact, in canvas px */
export const SPLIT_BOXES: Record<SplitKey, [MediaBox, MediaBox]> = (() => {
  const M = GRID_MARGIN
  // equal: two identical 16:9 slots, margins and gutter all M, centered
  const eqW = (CANVAS.w - 3 * M) / 2
  const eqH = (eqW * 9) / 16
  const eqY = centerY(eqH)
  // large: 700-tall 16:9 featured slot + a narrow crop filling the remainder
  const lgH = 700
  const lgY = centerY(lgH)
  const lgW = (lgH * 16) / 9
  const narrowX = M + lgW + M
  const narrowW = CANVAS.w - M - narrowX
  // card: rounded crop of the source, bottom/right-aligned to the margins
  const cardW = CARD_MASK_WIDTH * CARD_SCALE
  const cardH = CANVAS.h * CARD_SCALE
  const cardX = CANVAS.w - M - cardW
  // big-small: large 16:9 canvas top-left, card bottom-right
  const bigW = 1500
  const bigH = (bigW * 9) / 16
  return {
    equal: [box(M, eqY, eqW, eqH), box(M + eqW + M, eqY, eqW, eqH)],
    large: [box(M, lgY, lgW, lgH), box(narrowX, lgY, narrowW, lgH)],
    'big-small': [box(M, M, bigW, bigH), box(cardX, CANVAS.h - M - cardH, cardW, cardH)],
    overlay: [MEDIA_FULL_BOX, box(cardX, centerY(cardH), cardW, cardH)],
  }
})()

/**
 * Source-space width of the large-split narrow slot's crop mask: exactly the
 * region a cover-scaled 16:9 source shows inside the narrow box, so the
 * mask's rounded corners land on the visible edges.
 */
export const NARROW_MASK_WIDTH = (() => {
  const narrow = SPLIT_BOXES.large[1]
  return (narrow.w * CANVAS.h) / narrow.h
})()

export function mediaBoxFor(sel: Selection): MediaBox | null {
  if (sel.mode === 'fullscreen') return sel.source === 'media' ? MEDIA_FULL_BOX : null
  if (sel.mode === 'split') {
    if (sel.featured === 'media') return SPLIT_BOXES[sel.style][0]
    if (sel.secondary === 'media') return SPLIT_BOXES[sel.style][1]
  }
  return null
}

type Query = <T = unknown>(request: string, params?: Record<string, unknown>) => Promise<T>

/** Fire-and-forget command sender — the dock's direct OBS call and the remote's relayed send both fit */
export type SendCommand = (request: string, params?: Record<string, unknown>) => void

/**
 * Scene-item transform for a fit-inside bounds box: the whole source is
 * always visible at any resolution, letterboxed when the aspect differs.
 * Single source of truth — the bounds_rel bug came from hand-copied variants.
 */
export function fitTransform(box: MediaBox): Record<string, unknown> {
  return {
    positionX: box.x,
    positionY: box.y,
    boundsType: 'OBS_BOUNDS_SCALE_INNER',
    boundsAlignment: 0,
    boundsWidth: box.w,
    boundsHeight: box.h,
  }
}

/**
 * Scene-item transform for a fill/cover bounds box: the source scales up
 * until the box is covered, cropping the overflow centered. Used for camera
 * slots — the rendered rect equals the box exactly, no scale arithmetic.
 */
export function coverTransform(box: MediaBox): Record<string, unknown> {
  return {
    positionX: box.x,
    positionY: box.y,
    boundsType: 'OBS_BOUNDS_SCALE_OUTER',
    boundsAlignment: 0,
    boundsWidth: box.w,
    boundsHeight: box.h,
  }
}

/**
 * Show one source in the MEDIA scene and hide the rest, then repoint the
 * split-scene clones at it so every layout shows the same media. Fire-and-
 * forget: works with the dock's direct call and the remote's relayed send.
 */
export function selectMediaSource(send: SendCommand, media: MediaStatus, name: string): void {
  const target = media.sources.find((s) => s.name === name)
  if (!target) return
  for (const s of media.sources) {
    const show = s.name === name
    if (s.visible !== show) {
      send('SetSceneItemEnabled', { sceneName: MEDIA_SCENE, sceneItemId: s.id, sceneItemEnabled: show })
    }
  }
  // A source dropped into the scene by hand sits at its native size — pin it
  // to the full-frame fit box so any resolution shows completely.
  send('SetSceneItemTransform', {
    sceneName: MEDIA_SCENE,
    sceneItemId: target.id,
    sceneItemTransform: fitTransform(MEDIA_FULL_BOX),
  })
  for (const cloneName of MEDIA_CLONES) {
    send('SetInputSettings', { inputName: cloneName, inputSettings: { clone: name } })
  }
}

/**
 * Repoint every split-slot clone at the source the MEDIA scene shows.
 * Recovery path for a partially-failed selectMediaSource (fire-and-forget
 * commands have no rollback) — safe to re-run, missing clones are skipped.
 */
export async function syncMediaClones(query: Query, activeName: string): Promise<void> {
  for (const cloneName of MEDIA_CLONES) {
    await query('SetInputSettings', { inputName: cloneName, inputSettings: { clone: activeName } }).catch(
      () => undefined,
    )
  }
}

async function setFitBox(query: Query, sceneName: string, sceneItemId: number, box: MediaBox): Promise<void> {
  await query('SetSceneItemTransform', { sceneName, sceneItemId, sceneItemTransform: fitTransform(box) })
}

/** Which slot's box an item occupies in the given selection, if any */
function slotBoxFor(sel: Selection, sourceName: string): { box: MediaBox; kind: 'cam' | 'media' } | null {
  const token: SourceKey | null = sourceName.startsWith('Main Cam')
    ? 'main'
    : sourceName.startsWith('Second Cam')
      ? 'second'
      : sourceName.startsWith('Media')
        ? 'media'
        : null
  if (!token) return null
  const kind = token === 'media' ? 'media' : 'cam'
  if (sel.mode === 'fullscreen') return sel.source === token ? { box: MEDIA_FULL_BOX, kind } : null
  if (sel.mode === 'split') {
    if (sel.featured === token) return { box: SPLIT_BOXES[sel.style][0], kind }
    if (sel.secondary === token) return { box: SPLIT_BOXES[sel.style][1], kind }
  }
  return null
}

/**
 * Pixel-align every layout to the derived grid: crop masks get their exact
 * source-space sizes, and every slot item is re-placed with a bounds box —
 * cams cover (fill + crop), media fits (letterbox). Repairs hand-composited
 * drift, old fixed-scale imports and mis-scaled bounds alike. Safe to re-run.
 */
export async function alignLayouts(query: Query, scenes: readonly string[]): Promise<void> {
  // Media clone masks stay full-frame (rounded corners only, never crop a
  // letterboxed video); the cam narrow-slot masks crop to exactly the region
  // a cover-scaled source shows, so the rounded corners land on the edges.
  for (const sourceName of ['Media 3', 'Media 5']) {
    await query('SetSourceFilterSettings', {
      sourceName,
      filterName: 'Advanced Mask',
      filterSettings: { rectangle_width: 1920.0, rectangle_height: 1080.0 },
    }).catch(() => undefined) // clone may not exist on partial installs
  }
  for (const sourceName of ['Main Cam 3', 'Second Cam 2']) {
    await query('SetSourceFilterSettings', {
      sourceName,
      filterName: 'Advanced Mask',
      filterSettings: { rectangle_width: NARROW_MASK_WIDTH, rectangle_height: 1080.0 },
    }).catch(() => undefined)
  }

  for (const sceneName of scenes) {
    const sel = parseScene(sceneName)
    if (!sel || sel.mode === 'screen') continue
    const { sceneItems } = await query<{ sceneItems: { sceneItemId: number; sourceName: string }[] }>(
      'GetSceneItemList',
      { sceneName },
    )
    for (const item of sceneItems) {
      const sourceName = String(item.sourceName)
      // The MEDIA scene holds arbitrary operator-added sources — fit them all
      const slot =
        sceneName === MEDIA_SCENE && sourceName !== OVERLAY_SCENE && sourceName !== BACKGROUND_SCENE
          ? ({ box: MEDIA_FULL_BOX, kind: 'media' } as const)
          : slotBoxFor(sel, sourceName)
      if (!slot) continue
      await query('SetSceneItemTransform', {
        sceneName,
        sceneItemId: item.sceneItemId,
        sceneItemTransform: slot.kind === 'media' ? fitTransform(slot.box) : coverTransform(slot.box),
      })
    }
  }

  // Non-slot fitted items carry the same bounds fields — repair them too
  const fitted: { scene: string; source: string; box: MediaBox }[] = [
    { scene: BACKGROUND_SCENE, source: BACKGROUND_INPUT, box: MEDIA_FULL_BOX },
    { scene: OVERLAY_SCENE, source: LOGO_INPUT, box: { x: 1620, y: 60, w: 240, h: 140 } },
    ...SCREENS.map((s) => ({ scene: s.scene, source: s.input, box: MEDIA_FULL_BOX })),
  ]
  for (const { scene, source, box: fitBox } of fitted) {
    const list = await query<{ sceneItems: { sceneItemId: number; sourceName: string }[] }>('GetSceneItemList', {
      sceneName: scene,
    }).catch(() => null)
    const item = list?.sceneItems.find((i) => i.sourceName === source)
    if (item) await setFitBox(query, scene, item.sceneItemId, fitBox).catch(() => undefined)
  }
}

// Create missing screen scenes in a live OBS: scene + full-screen image
// source + the OVERLAY nested on top (so ticker/logo keep working over them).
// If the image input already exists (e.g. migrated from an overlay layer),
// it is reused — any image the operator already set is preserved.
export async function createScreenScenes(query: Query, missing: readonly ScreenSpec[]): Promise<void> {
  for (const spec of missing) {
    await query('CreateScene', { sceneName: spec.scene })
    let sceneItemId: number
    try {
      ;({ sceneItemId } = await query<{ sceneItemId: number }>('CreateInput', {
        sceneName: spec.scene,
        inputName: spec.input,
        inputKind: 'image_source',
        inputSettings: {},
        sceneItemEnabled: true,
      }))
    } catch {
      // input already exists — just add it to the new scene
      ;({ sceneItemId } = await query<{ sceneItemId: number }>('CreateSceneItem', {
        sceneName: spec.scene,
        sourceName: spec.input,
        sceneItemEnabled: true,
      }))
    }
    await query('SetSceneItemTransform', {
      sceneName: spec.scene,
      sceneItemId,
      sceneItemTransform: fitTransform(MEDIA_FULL_BOX),
    })
    await query('CreateSceneItem', { sceneName: spec.scene, sourceName: OVERLAY_SCENE, sceneItemEnabled: true })
  }
}
