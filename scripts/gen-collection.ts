// Generates public/scene-collection.json — the importable "Dock Control" OBS
// scene collection: 3 sources (Main cam, Second cam, Media) x 4 split styles
// + fullscreen scenes, camera/media clone chains with Advanced Mask filters,
// and the OVERLAY scene built from the shared blueprint in src/lib/overlay.ts.
//
// Run with: npm run gen:collection
/* eslint-disable @typescript-eslint/no-explicit-any */

import { writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKGROUND_INPUT, BACKGROUND_SCENE, OVERLAY_LAYERS, OVERLAY_SCENE } from '../src/lib/overlay'
import type { OverlayLayerSpec } from '../src/lib/overlay'
import { SCREENS } from '../src/lib/scenes'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'scene-collection.json')

const CANVAS = '6c69626f-6273-4c00-9d88-c5136d61696e'
const PREV_VER = 536936450

// Deterministic UUIDs for generated entries so regenerating doesn't churn the file
const uuidFor = (label: string): string => {
  const h = createHash('md5').update(label).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

const sourceBoilerplate = (mixers: number, hotkeys: Record<string, unknown[]>): Record<string, any> => ({
  prev_ver: PREV_VER,
  mixers,
  sync: 0,
  flags: 0,
  volume: 1.0,
  balance: 0.5,
  enabled: true,
  muted: false,
  'push-to-mute': false,
  'push-to-mute-delay': 0,
  'push-to-talk': false,
  'push-to-talk-delay': 0,
  hotkeys,
  deinterlace_mode: 0,
  deinterlace_field_order: 0,
  monitoring_type: 0,
  private_settings: {},
})

const camHotkeys = { 'libobs.mute': [], 'libobs.unmute': [], 'libobs.push-to-mute': [], 'libobs.push-to-talk': [] }

function maskFilter(uuid: string, settings: Record<string, number>): Record<string, any> {
  return {
    prev_ver: PREV_VER,
    name: 'Advanced Mask',
    uuid,
    id: 'advanced_masks_filter',
    versioned_id: 'advanced_masks_filter_v2',
    settings: {
      rectangle_corner_type: 1,
      shape_feather_type: 1,
      mask_source_width: 1920,
      mask_source_height: 1080,
      ...settings,
      shape_center_x: 960.0,
      shape_center_y: 540.0,
      position_x: 960.0,
      position_y: 540.0,
      mask_gradient_position: 960.0,
    },
    ...sourceBoilerplate(0, {}),
  }
}

// Real capture inputs — device intentionally blank (operator picks in OBS)
function camera(name: string, uuid: string, filterUuid: string, maskSettings: Record<string, number>) {
  return {
    prev_ver: PREV_VER,
    name,
    uuid,
    id: 'macos-avcapture',
    versioned_id: 'macos-avcapture',
    settings: {},
    ...sourceBoilerplate(255, camHotkeys),
    filters: [maskFilter(filterUuid, maskSettings)],
  }
}

function clone(
  name: string,
  uuid: string,
  cloneOf: string,
  sameClones: string | null,
  filterUuid: string,
  maskSettings: Record<string, number>,
) {
  const settings = sameClones ? { clone: cloneOf, same_clones: sameClones } : { clone: cloneOf }
  return {
    prev_ver: PREV_VER,
    name,
    uuid,
    id: 'source-clone',
    versioned_id: 'source-clone',
    settings,
    ...sourceBoilerplate(255, camHotkeys),
    filters: [maskFilter(filterUuid, maskSettings)],
  }
}

interface ItemOpts {
  visible?: boolean
  boundsType?: number
  bounds?: [number, number]
}

function item(
  name: string,
  sourceUuid: string,
  id: number,
  pos: [number, number],
  posRelV: [number, number],
  scale: [number, number],
  opts: ItemOpts = {},
): Record<string, any> {
  const bounds = opts.bounds ?? [0.0, 0.0]
  return {
    name,
    source_uuid: sourceUuid,
    visible: opts.visible ?? true,
    locked: false,
    rot: 0.0,
    scale_ref: { x: 1920.0, y: 1080.0 },
    align: 5,
    bounds_type: opts.boundsType ?? 0,
    bounds_align: 0,
    bounds_crop: false,
    crop_left: 0,
    crop_top: 0,
    crop_right: 0,
    crop_bottom: 0,
    id,
    group_item_backup: false,
    pos: { x: pos[0], y: pos[1] },
    pos_rel: { x: posRelV[0], y: posRelV[1] },
    scale: { x: scale[0], y: scale[1] },
    scale_rel: { x: scale[0], y: scale[1] },
    bounds: { x: bounds[0], y: bounds[1] },
    bounds_rel: { x: bounds[0], y: bounds[1] },
    scale_filter: 'disable',
    blend_method: 'default',
    blend_type: 'normal',
    show_transition: { duration: 300 },
    hide_transition: { duration: 300 },
    private_settings: {},
  }
}

function scene(name: string, uuid: string, idCounter: number, items: Record<string, any>[]): Record<string, any> {
  const hotkeys: Record<string, unknown[]> = { 'OBSBasic.SelectScene': [] }
  for (const it of items) {
    hotkeys[`libobs.show_scene_item.${it.id}`] = []
    hotkeys[`libobs.hide_scene_item.${it.id}`] = []
  }
  return {
    prev_ver: PREV_VER,
    name,
    uuid,
    id: 'scene',
    versioned_id: 'scene',
    settings: { id_counter: idCounter, custom_size: false, items },
    ...sourceBoilerplate(0, hotkeys),
    canvas_uuid: CANVAS,
  }
}

// --- source uuids -----------------------------------------------------------
const U = {
  mainCam: [
    'dfb324e4-acb4-42b0-8ac9-4b5fbb72a457', '82e5bf5b-f57f-4dd1-92a1-7f9cd836dc8d',
    '0a4f13f8-12de-4347-818e-971fc0e81b0e', '3049f457-f0be-49f7-ab3a-e80071e0e024',
    '5df82f7a-1755-461f-85d1-25d3b63e3edb', '182d9a3b-4a1f-4d0d-9e77-8abf168beb58',
  ],
  secondCam: [
    '9b8cc805-4911-4cb8-935e-27e0d3acb7c7', '73ba30d8-8a24-47df-b749-c226d2777f2a',
    '1a81c583-ebc8-4a74-bfc2-9dea4e44442d', 'd3083ca0-3356-4881-ac70-0c0a71b9f435',
    '328b0bff-0bf6-4015-9c74-74a3d857dcb1', 'eb641d3a-1796-42a3-b6c1-2cd26387bde6',
  ],
  media: Array.from({ length: 6 }, (_, i) => uuidFor(`source:Media ${i}`)),
}

const MASKS: Record<string, (Record<string, number> | null)[]> & { cam0: Record<string, number> } = {
  cam0: { rectangle_width: 1920.0, rectangle_height: 1920.0 },
  main: [
    null,
    { rectangle_corner_radius: 66.0, rectangle_width: 1920.0, rectangle_height: 1080.0 },
    { rectangle_corner_radius: 56.0, rectangle_width: 1920.0, rectangle_height: 1080.0 },
    { rectangle_corner_radius: 46.0, rectangle_width: 764.0, rectangle_height: 1080.0 },
    { rectangle_corner_radius: 38.0, rectangle_width: 1920.0, rectangle_height: 1080.0 },
    { rectangle_corner_radius: 134.0, rectangle_width: 1000.0, rectangle_height: 1080.0 },
  ],
  second: [
    null,
    { rectangle_corner_radius: 66.0, rectangle_width: 1920.0, rectangle_height: 1080.0 },
    { rectangle_corner_radius: 46.0, rectangle_width: 764.0, rectangle_height: 1080.0 },
    { rectangle_corner_radius: 46.0, rectangle_width: 1920.0, rectangle_height: 1080.0 },
    { rectangle_corner_radius: 134.0, rectangle_width: 1000.0, rectangle_height: 1080.0 },
    { rectangle_corner_radius: 38.0, rectangle_width: 1920.0, rectangle_height: 1080.0 },
  ],
} as any

const FILTER_UUIDS = {
  main: [
    '89bcf2ee-ebcf-42c8-9b5f-36552d4274fe', '034bc06b-0fe6-4b0e-8a46-0ddb4ef813b0',
    'bd0efbad-adc0-4518-8292-14604753a219', '0870eb3b-c909-4adb-a397-819bc872ae09',
    '11e78cfb-4cae-45e0-b928-40c49adcd90d', 'be152a59-c24e-43a8-992f-06b8c95c30e0',
  ],
  second: [
    'edb03ef0-7031-4d97-889c-6ce703f8fd6a', 'ef3192e3-7520-49e8-92df-4cbe8b3bc249',
    'd709e9de-749b-4b3e-8c97-e2bf4ac0b1f5', '79718489-249b-456d-b834-3b9f511105b1',
    '3a6c89ab-13a6-40a0-a7aa-258edcd58c40', '5ed76cee-16d3-4c4f-9688-8e492fa862e3',
  ],
}

const SAME_CLONES: Record<string, (string | null)[]> = {
  main: [null, null, 'Main Cam 1\nMain Cam 3', 'Main Cam 1', 'Main Cam 1\nMain Cam 3\nMain Cam 2', 'Main Cam 1\nMain Cam 3\nMain Cam 2\nMain Cam 4'],
  second: [null, null, 'Second Cam 1\nSecond Cam 3', 'Second Cam 1', 'Second Cam 1\nSecond Cam 3\nSecond Cam 2', 'Second Cam 1\nSecond Cam 3\nSecond Cam 2\nSecond Cam 4'],
  media: [null, null, 'Media 1\nMedia 3', 'Media 1', 'Media 1\nMedia 3\nMedia 2', 'Media 1\nMedia 3\nMedia 2\nMedia 4'],
}

function camChain(prefix: string, uuids: string[], filterUuids: string[], masks: (Record<string, number> | null)[]) {
  const key = prefix === 'Main Cam' ? 'main' : 'second'
  const out = [camera(`${prefix} 0`, uuids[0]!, filterUuids[0]!, MASKS.cam0)]
  for (let i = 1; i <= 5; i++) {
    out.push(clone(`${prefix} ${i}`, uuids[i]!, `${prefix} 0`, SAME_CLONES[key]![i]!, filterUuids[i]!, masks[i]!))
  }
  return out
}

function mediaChain() {
  const { hotkeys, ...rest } = sourceBoilerplate(255, camHotkeys)
  const player = {
    prev_ver: PREV_VER,
    name: 'Media 0',
    uuid: U.media[0],
    id: 'ffmpeg_source',
    versioned_id: 'ffmpeg_source',
    // File intentionally unset — the operator loads the video in OBS.
    // Auto-play is app-driven (per-mode preferences in the dock), so the
    // OBS-side restart_on_activate stays off; keeping the last frame on end
    // avoids a black flash.
    settings: { looping: false, restart_on_activate: false, clear_on_media_end: false },
    ...rest,
    hotkeys,
  }
  const out: Record<string, any>[] = [player]
  for (let i = 1; i <= 5; i++) {
    out.push(clone(`Media ${i}`, U.media[i]!, 'Media 0', SAME_CLONES.media![i]!, uuidFor(`filter:Media ${i}`), MASKS.main![i]!))
  }
  return out
}

// --- scene layout data ------------------------------------------------------
const posRel = ([x, y]: [number, number]): [number, number] => [(x - 960) / 540, (y - 540) / 540]

const FULL = { pos: [0.0, 0.0] as [number, number], posRel: [-1.7777777910232544, -1.0] as [number, number], scale: [1.0, 1.0] as [number, number] }
const EQ_L = { pos: [60.0, 296.0] as [number, number], posRel: [-1.6666666269302368, -0.45185184478759766] as [number, number] }
const LG_SCALE: [number, number] = [0.6473958492279053, 0.6472222208976746]
const CARD_SCALE: [number, number] = [0.40625, 0.40648147463798523]

type Token = 'MAIN' | 'SECOND' | 'MEDIA'
type Role = 'eq' | 'lgFull' | 'lgNarrow' | 'big' | 'card' | 'full'

interface SlotGeom {
  role: Role
  pos: [number, number]
  scale: [number, number]
}

const SLOT_GEOM: Record<string, [SlotGeom, SlotGeom]> = {
  '': [
    { role: 'eq', pos: [60.0, 296.0], scale: [0.45260417461395264, 0.45277777314186096] },
    { role: 'eq', pos: [990.0, 296.0], scale: [0.453125, 0.45277777314186096] },
  ],
  ' 2': [
    { role: 'lgFull', pos: [60.0, 190.0], scale: LG_SCALE },
    { role: 'lgNarrow', pos: [988.0, 190.0], scale: LG_SCALE },
  ],
  ' 3': [
    { role: 'big', pos: [60.0, 60.0], scale: [0.78125, 0.7814815044403076] },
    { role: 'card', pos: [1264.0, 581.0], scale: CARD_SCALE },
  ],
  ' 4': [
    { role: 'full', pos: [0.0, 0.0], scale: [1.0, 1.0] },
    { role: 'card', pos: [1264.0, 321.0], scale: CARD_SCALE },
  ],
}

// Chains are historically asymmetric: each assigns clone indices to roles
const ROLE_IDX: Record<Token, Record<Role, number>> = {
  MAIN: { eq: 1, lgFull: 2, lgNarrow: 3, big: 4, card: 5, full: 0 },
  SECOND: { eq: 1, lgFull: 3, lgNarrow: 2, big: 5, card: 4, full: 0 },
  MEDIA: { eq: 1, lgFull: 2, lgNarrow: 3, big: 4, card: 5, full: 0 },
}

const CHAINS: Record<Token, { prefix: string; uuids: string[] }> = {
  MAIN: { prefix: 'Main Cam', uuids: U.mainCam },
  SECOND: { prefix: 'Second Cam', uuids: U.secondCam },
  MEDIA: { prefix: 'Media', uuids: U.media },
}

function slotItem(token: Token, geom: SlotGeom, id: number) {
  const idx = ROLE_IDX[token][geom.role]
  const chain = CHAINS[token]
  return item(`${chain.prefix} ${idx}`, chain.uuids[idx]!, id, geom.pos, posRel(geom.pos), geom.scale)
}

function comboScene(featured: Token, secondary: Token, suffix: string) {
  const name = `${featured} ${secondary}${suffix}`
  const [geomA, geomB] = SLOT_GEOM[suffix]!
  return scene(name, uuidFor(`scene:${name}`), 2, [slotItem(featured, geomA, 1), slotItem(secondary, geomB, 2)])
}

const mc = (i: number): string => U.mainCam[i]!
const sc = (i: number): string => U.secondCam[i]!

const scenes = [
  scene('MAIN', '5615da7b-c9a9-4d27-8095-d04b6b0c9086', 1, [
    item('Main Cam 0', mc(0), 1, FULL.pos, FULL.posRel, FULL.scale),
  ]),
  scene('SECOND', 'eb00bb5c-e8bf-4a06-b54d-77c56cf1642c', 1, [
    item('Second Cam 0', sc(0), 1, FULL.pos, FULL.posRel, FULL.scale),
  ]),
  scene('MAIN SECOND', '59d377d1-f945-46bd-84c8-aa1a5d192f5f', 2, [
    item('Second Cam 1', sc(1), 2, [990.0, 296.0], [0.0555555559694767, -0.45185184478759766], [0.453125, 0.45277777314186096]),
    item('Main Cam 1', mc(1), 1, EQ_L.pos, EQ_L.posRel, [0.45260417461395264, 0.45277777314186096]),
  ]),
  scene('SECOND MAIN', 'ad549da8-204a-4e4f-8101-f2c449b9309d', 2, [
    item('Second Cam 1', sc(1), 2, EQ_L.pos, EQ_L.posRel, [0.453125, 0.45277777314186096]),
    item('Main Cam 1', mc(1), 1, [991.0, 296.0], [0.05740740895271301, -0.45185184478759766], [0.45260417461395264, 0.45277777314186096]),
  ]),
  scene('MAIN SECOND 2', 'c23e1ceb-22f3-457f-a2fa-7da27c080295', 4, [
    item('Second Cam 2', sc(2), 4, [988.0, 190.0], [0.051851850003004074, -0.6481481790542603], LG_SCALE),
    item('Main Cam 2', mc(2), 3, [60.0, 190.0], [-1.6666666269302368, -0.6481481790542603], LG_SCALE),
  ]),
  scene('SECOND MAIN 2', 'f6afb9b0-5a1b-419f-a279-dab5af7e7a73', 5, [
    item('Second Cam 3', sc(3), 5, [60.0, 190.0], [-1.6666666269302368, -0.6481481790542603], LG_SCALE),
    item('Main Cam 3', mc(3), 4, [988.0, 190.0], [0.051851850003004074, -0.6481481790542603], LG_SCALE),
  ]),
  scene('MAIN SECOND 3', 'a1a9310b-531c-40a7-b208-8b73356742f7', 2, [
    item('Main Cam 4', mc(4), 1, [60.0, 60.0], [-1.6666666269302368, -0.8888888955116272], [0.78125, 0.7814815044403076]),
    item('Second Cam 4', sc(4), 2, [1264.0, 581.0], [0.5629629492759705, 0.07592594623565674], CARD_SCALE),
  ]),
  scene('SECOND MAIN 3', '78033523-309d-4331-959e-6c0d34284eb7', 2, [
    item('Second Cam 5', sc(5), 2, [60.0, 60.0], [-1.6666666269302368, -0.8888888955116272], [0.78125, 0.7814815044403076]),
    item('Main Cam 5', mc(5), 1, [1264.0, 581.0], [0.5629629492759705, 0.07592594623565674], CARD_SCALE),
  ]),
  scene('MAIN SECOND 4', '02713452-13d7-490c-8da0-9fc7ced04c7f', 2, [
    item('Main Cam 0', mc(0), 1, FULL.pos, FULL.posRel, FULL.scale),
    item('Second Cam 4', sc(4), 2, [1264.0, 321.0], [0.5629629492759705, -0.4055555462837219], CARD_SCALE),
  ]),
  scene('SECOND MAIN 4', '425c4eb7-ec40-45a3-b7e9-2912dd88a719', 2, [
    item('Second Cam 0', sc(0), 1, FULL.pos, FULL.posRel, FULL.scale),
    item('Main Cam 5', mc(5), 2, [1264.0, 371.0], [0.5629629492759705, -0.31296294927597046], CARD_SCALE),
  ]),
]

const mediaScenes = [
  scene('MEDIA', uuidFor('scene:MEDIA'), 1, [item('Media 0', U.media[0]!, 1, FULL.pos, FULL.posRel, FULL.scale)]),
]
for (const suffix of ['', ' 2', ' 3', ' 4']) {
  for (const [f, s] of [
    ['MAIN', 'MEDIA'],
    ['MEDIA', 'MAIN'],
    ['SECOND', 'MEDIA'],
    ['MEDIA', 'SECOND'],
  ] as [Token, Token][]) {
    mediaScenes.push(comboScene(f, s, suffix))
  }
}

// --- OVERLAY scene, built from the shared blueprint --------------------------
function overlaySourceJson(spec: OverlayLayerSpec): Record<string, any> {
  const base = {
    prev_ver: PREV_VER,
    name: spec.name,
    uuid: uuidFor(`source:${spec.name}`),
    id: spec.kind,
    versioned_id: spec.versionedKind ?? spec.kind,
    settings: spec.settings,
    ...sourceBoilerplate(0, {}),
  }
  if (!spec.filters?.length) return base
  return {
    ...base,
    filters: spec.filters.map((f) => ({
      prev_ver: PREV_VER,
      name: f.name,
      uuid: uuidFor(`filter:${spec.name} ${f.name}`),
      id: f.kind,
      versioned_id: f.kind,
      settings: f.settings,
      ...sourceBoilerplate(0, {}),
    })),
  }
}

function overlayItem(spec: OverlayLayerSpec, id: number): Record<string, any> {
  const pos: [number, number] = [spec.transform.positionX, spec.transform.positionY]
  return item(spec.name, uuidFor(`source:${spec.name}`), id, pos, posRel(pos), [1.0, 1.0], {
    visible: false,
    ...(spec.transform.bounds ? { boundsType: 2, bounds: [spec.transform.bounds.width, spec.transform.bounds.height] } : {}),
  })
}

const OVERLAY_UUID = uuidFor(`scene:${OVERLAY_SCENE}`)
const overlaySources = OVERLAY_LAYERS.map(overlaySourceJson)
const overlayScene = scene(
  OVERLAY_SCENE,
  OVERLAY_UUID,
  OVERLAY_LAYERS.length,
  OVERLAY_LAYERS.map((spec, i) => overlayItem(spec, i + 1)),
)

// --- dedicated event screens: WAITING / REST / ENDING ------------------------
const screenSources = SCREENS.map((spec) => ({
  prev_ver: PREV_VER,
  name: spec.input,
  uuid: uuidFor(`source:${spec.input}`),
  id: 'image_source',
  versioned_id: 'image_source',
  settings: {}, // operator sets the designed 1920x1080 image in OBS
  ...sourceBoilerplate(0, {}),
}))

const screenScenes = SCREENS.map((spec) =>
  scene(spec.scene, uuidFor(`scene:${spec.scene}`), 1, [
    item(spec.input, uuidFor(`source:${spec.input}`), 1, [0.0, 0.0], posRel([0.0, 0.0]), [1.0, 1.0], {
      boundsType: 2,
      bounds: [1920.0, 1080.0],
    }),
  ]),
)

// --- shared background: one image, nested beneath every program scene --------
const BACKGROUND_UUID = uuidFor(`scene:${BACKGROUND_SCENE}`)
const backgroundSource = {
  prev_ver: PREV_VER,
  name: BACKGROUND_INPUT,
  uuid: uuidFor(`source:${BACKGROUND_INPUT}`),
  id: 'image_source',
  versioned_id: 'image_source',
  settings: {}, // operator sets the shared 1920x1080 background in OBS, once
  ...sourceBoilerplate(0, {}),
}
const backgroundScene = scene(BACKGROUND_SCENE, BACKGROUND_UUID, 1, [
  item(BACKGROUND_INPUT, uuidFor(`source:${BACKGROUND_INPUT}`), 1, [0.0, 0.0], posRel([0.0, 0.0]), [1.0, 1.0], {
    boundsType: 2,
    bounds: [1920.0, 1080.0],
  }),
])

// Nest the OVERLAY scene as the top-most item and the BACKGROUND scene as the
// bottom-most item of every program scene
function addOverlayTo(programScene: Record<string, any>): void {
  const id = programScene.settings.id_counter + 1
  programScene.settings.id_counter = id
  programScene.settings.items.push(item(OVERLAY_SCENE, OVERLAY_UUID, id, [0.0, 0.0], posRel([0.0, 0.0]), [1.0, 1.0]))
  programScene.hotkeys[`libobs.show_scene_item.${id}`] = []
  programScene.hotkeys[`libobs.hide_scene_item.${id}`] = []
}
function addBackgroundTo(programScene: Record<string, any>): void {
  const id = programScene.settings.id_counter + 1
  programScene.settings.id_counter = id
  programScene.settings.items.unshift(
    item(BACKGROUND_SCENE, BACKGROUND_UUID, id, [0.0, 0.0], posRel([0.0, 0.0]), [1.0, 1.0]),
  )
  programScene.hotkeys[`libobs.show_scene_item.${id}`] = []
  programScene.hotkeys[`libobs.hide_scene_item.${id}`] = []
}
for (const s of [...scenes, ...mediaScenes, ...screenScenes]) {
  addBackgroundTo(s)
  addOverlayTo(s)
}

// --- assemble ----------------------------------------------------------------
const collection = {
  name: 'Dock Control',
  groups: [],
  scene_order: [
    'MAIN', 'SECOND', 'MAIN SECOND', 'SECOND MAIN', 'MAIN SECOND 2', 'SECOND MAIN 2',
    'MAIN SECOND 3', 'SECOND MAIN 3', 'MAIN SECOND 4', 'SECOND MAIN 4',
    ...mediaScenes.map((s) => s.name as string),
    ...SCREENS.map((s) => s.scene),
    BACKGROUND_SCENE,
    OVERLAY_SCENE,
  ].map((name) => ({ name })),
  current_scene: 'MAIN',
  current_program_scene: 'MAIN',
  canvases: [],
  current_transition: 'Move',
  transition_duration: 750,
  transitions: [
    { name: 'Move', id: 'move_transition', settings: { transition_match: 'None', transition_in: 'None', transition_out: 'None', position_in: 2, position_out: 2 } },
    { name: 'Move Left', id: 'move_transition', settings: { transition_match: 'None', transition_in: 'None', transition_out: 'None', position_out: 6 } },
    { name: 'Stinger', id: 'obs_stinger_transition', settings: {} },
  ],
  quick_transitions: [
    { name: 'Cut', duration: 300, hotkeys: [], id: 3, fade_to_black: false },
    { name: 'Move', duration: 750, hotkeys: [], id: 4, fade_to_black: false },
    { name: 'Fade', duration: 300, hotkeys: [], id: 5, fade_to_black: true },
  ],
  saved_projectors: [],
  preview_locked: false,
  scaling_enabled: false,
  scaling_level: -5,
  scaling_off_x: 0.0,
  scaling_off_y: 0.0,
  'virtual-camera': { type2: 3 },
  modules: {
    'scripts-tool': [],
    'output-timer': {
      streamTimerHours: 0, streamTimerMinutes: 0, streamTimerSeconds: 0,
      recordTimerHours: 0, recordTimerMinutes: 0, recordTimerSeconds: 0,
      autoStartStreamTimer: false, autoStartRecordTimer: false, pauseRecordTimer: false,
    },
    'auto-scene-switcher': {
      interval: 300, non_matching_scene: '', switch_if_not_matching: false, active: false, switches: [],
    },
  },
  resolution: { x: 1920, y: 1080 },
  version: 2,
  sources: [
    scenes[0],
    ...camChain('Main Cam', U.mainCam, FILTER_UUIDS.main, MASKS.main!),
    scenes[2], scenes[4], scenes[6], scenes[8],
    scenes[1],
    ...camChain('Second Cam', U.secondCam, FILTER_UUIDS.second, MASKS.second!),
    scenes[3], scenes[5], scenes[7], scenes[9],
    ...mediaChain(),
    ...mediaScenes,
    ...screenSources,
    ...screenScenes,
    backgroundSource,
    backgroundScene,
    ...overlaySources,
    overlayScene,
  ],
}

mkdirSync(path.dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(collection, null, 4))
const sceneCount = collection.sources.filter((s: any) => s.id === 'scene').length
console.log(`written ${OUT}: sources = ${collection.sources.length}, scenes = ${sceneCount}`)
