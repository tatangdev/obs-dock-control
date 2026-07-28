import { describe, expect, it } from 'vitest'
import {
  GRID_MARGIN,
  MEDIA_CLONES,
  NARROW_MASK_WIDTH,
  SCREENS,
  SOURCES,
  SPLIT_BOXES,
  mediaBoxFor,
  parseScene,
  sceneFor,
  selectMediaSource,
} from '../src/lib/scenes'
import type { Selection, SplitKey } from '../src/lib/scenes'
import type { MediaStatus } from '../shared/protocol'

const SPLIT_KEYS: SplitKey[] = ['equal', 'large', 'big-small', 'overlay']

describe('scene name mapping', () => {
  it('round-trips every fullscreen selection', () => {
    for (const source of SOURCES) {
      const sel: Selection = { mode: 'fullscreen', source }
      expect(parseScene(sceneFor(sel))).toEqual(sel)
    }
  })

  it('round-trips every split selection (4 styles x 3 pairs x 2 orientations)', () => {
    for (const style of SPLIT_KEYS) {
      for (const featured of SOURCES) {
        for (const secondary of SOURCES) {
          if (featured === secondary) continue
          const sel: Selection = { mode: 'split', style, featured, secondary }
          expect(parseScene(sceneFor(sel))).toEqual(sel)
        }
      }
    }
  })

  it('round-trips the event screens', () => {
    for (const screen of SCREENS) {
      const sel: Selection = { mode: 'screen', screen: screen.key }
      expect(sceneFor(sel)).toBe(screen.scene)
      expect(parseScene(screen.scene)).toEqual(sel)
    }
  })

  it('rejects names that are not real scenes', () => {
    expect(parseScene('MAIN 2')).toBeNull() // style suffix without a pair
    expect(parseScene('MAIN MAIN')).toBeNull() // same source twice
    expect(parseScene('MAIN SECOND 5')).toBeNull() // unknown style
    expect(parseScene('Scene 1')).toBeNull()
    expect(parseScene('OVERLAY')).toBeNull()
    expect(parseScene('')).toBeNull()
  })
})

describe('media fit boxes', () => {
  it('gives media the full frame when fullscreen and the right slot in splits', () => {
    expect(mediaBoxFor({ mode: 'fullscreen', source: 'media' })).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
    expect(mediaBoxFor({ mode: 'fullscreen', source: 'main' })).toBeNull()
    for (const style of SPLIT_KEYS) {
      expect(mediaBoxFor({ mode: 'split', style, featured: 'media', secondary: 'main' })).toEqual(SPLIT_BOXES[style][0])
      expect(mediaBoxFor({ mode: 'split', style, featured: 'main', secondary: 'media' })).toEqual(SPLIT_BOXES[style][1])
      expect(mediaBoxFor({ mode: 'split', style, featured: 'main', secondary: 'second' })).toBeNull()
    }
  })
})

describe('derived slot geometry', () => {
  const M = GRID_MARGIN

  it('equal: identical 16:9 twins, symmetric margins, exact gutter, centered', () => {
    const [a, b] = SPLIT_BOXES.equal
    expect(a.w).toBe(b.w)
    expect(a.h).toBe(b.h)
    expect(a.y).toBe(b.y)
    expect(a.x).toBe(M)
    expect(b.x - (a.x + a.w)).toBe(M) // gutter
    expect(b.x + b.w).toBe(1920 - M) // right margin
    expect(a.w / a.h).toBeCloseTo(16 / 9, 10)
    expect(a.y).toBeCloseTo((1080 - a.h) / 2, 10) // vertically centered
  })

  it('large: 16:9 featured, narrow fills the remainder, margins exact', () => {
    const [a, b] = SPLIT_BOXES.large
    expect(a.x).toBe(M)
    expect(a.h).toBe(b.h)
    expect(a.y).toBe(b.y)
    expect(a.w / a.h).toBeCloseTo(16 / 9, 10)
    expect(b.x - (a.x + a.w)).toBeCloseTo(M, 10)
    expect(b.x + b.w).toBeCloseTo(1920 - M, 10)
    expect(a.y).toBeCloseTo((1080 - a.h) / 2, 10)
    // narrow mask crops exactly the region a cover-scaled source shows
    expect(NARROW_MASK_WIDTH).toBeCloseTo((b.w * 1080) / b.h, 10)
  })

  it('big-small: 16:9 big at the top-left margin, card on the bottom/right margins', () => {
    const [a, b] = SPLIT_BOXES['big-small']
    expect([a.x, a.y]).toEqual([M, M])
    expect(a.w / a.h).toBeCloseTo(16 / 9, 10)
    expect(b.x + b.w).toBe(1920 - M)
    expect(b.y + b.h).toBe(1080 - M)
  })

  it('overlay: full frame + the same card, vertically centered — matches big-small card', () => {
    const [a, b] = SPLIT_BOXES.overlay
    const [, card] = SPLIT_BOXES['big-small']
    expect(a).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
    expect(b.w).toBe(card.w)
    expect(b.h).toBe(card.h)
    expect(b.x).toBe(card.x)
    expect(b.y).toBeCloseTo((1080 - b.h) / 2, 10)
    // the card's 1000px source mask maps exactly onto its rendered box
    expect((b.w * 1080) / b.h).toBeCloseTo(1000, 10)
  })
})

describe('selectMediaSource', () => {
  const media: MediaStatus = {
    sources: [
      { id: 1, name: 'Media 0', kind: 'ffmpeg_source', visible: true },
      { id: 7, name: 'Video B', kind: 'ffmpeg_source', visible: false },
    ],
    active: 'Media 0',
    playable: true,
    file: '/videos/a.mp4',
    state: 'stopped',
    cursorMs: 0,
    durationMs: 0,
  }

  function record(): {
    calls: { request: string; params?: Record<string, unknown> }[]
    send: (r: string, p?: Record<string, unknown>) => void
  } {
    const calls: { request: string; params?: Record<string, unknown> }[] = []
    return { calls, send: (request, params) => calls.push({ request, params }) }
  }

  it('shows the target, hides the rest, fits it, and repoints every clone', () => {
    const { calls, send } = record()
    selectMediaSource(send, media, 'Video B')

    const enables = calls.filter((c) => c.request === 'SetSceneItemEnabled')
    expect(enables).toEqual([
      { request: 'SetSceneItemEnabled', params: { sceneName: 'MEDIA', sceneItemId: 1, sceneItemEnabled: false } },
      { request: 'SetSceneItemEnabled', params: { sceneName: 'MEDIA', sceneItemId: 7, sceneItemEnabled: true } },
    ])

    const transform = calls.find((c) => c.request === 'SetSceneItemTransform')
    expect(transform?.params).toMatchObject({ sceneName: 'MEDIA', sceneItemId: 7 })

    const repoints = calls.filter((c) => c.request === 'SetInputSettings')
    expect(repoints.map((c) => c.params?.['inputName'])).toEqual([...MEDIA_CLONES])
    // audio: true — clones are video-only by default, which muted split layouts
    for (const c of repoints) expect(c.params?.['inputSettings']).toEqual({ clone: 'Video B', audio: true })
  })

  it('does nothing for an unknown source name', () => {
    const { calls, send } = record()
    selectMediaSource(send, media, 'Nope')
    expect(calls).toEqual([])
  })

  it('skips redundant visibility toggles when re-selecting the active source', () => {
    const { calls, send } = record()
    selectMediaSource(send, media, 'Media 0')
    // already visible / already hidden — no enable calls, but fit + clones still run
    expect(calls.filter((c) => c.request === 'SetSceneItemEnabled')).toEqual([])
    expect(calls.filter((c) => c.request === 'SetInputSettings')).toHaveLength(MEDIA_CLONES.length)
  })
})
