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

import { BACKGROUND_SCENE, OVERLAY_SCENE } from './overlay'

/** The OBS media input that plays the media video (SDE, highlight reel, anything) */
export const MEDIA_INPUT = 'Media 0'

export const SOURCES: readonly SourceKey[] = ['main', 'second', 'media']

const TOKEN: Record<SourceKey, string> = { main: 'MAIN', second: 'SECOND', media: 'MEDIA' }
const KEY: Record<string, SourceKey> = { MAIN: 'main', SECOND: 'second', MEDIA: 'media' }

const STYLE_TO_SUFFIX: Record<SplitKey, string> = {
  equal: '',
  large: ' 2',
  'big-small': ' 3',
  overlay: ' 4',
}

const SUFFIX_TO_STYLE: Record<string, SplitKey> = {
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
      SOURCES.filter((s) => s !== featured).map((secondary) =>
        sceneFor({ mode: 'split', style, featured, secondary }),
      ),
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

type Query = <T = unknown>(request: string, params?: Record<string, unknown>) => Promise<T>

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
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        boundsAlignment: 0,
        boundsWidth: 1920,
        boundsHeight: 1080,
      },
    })
    await query('CreateSceneItem', { sceneName: spec.scene, sourceName: OVERLAY_SCENE, sceneItemEnabled: true })
  }
}
