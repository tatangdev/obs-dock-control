// Wire protocol shared by the relay server and both frontend modes.

export type MediaPlayState = 'playing' | 'paused' | 'stopped' | 'ended' | 'none'

/** One candidate source inside the MEDIA scene (operators add these in OBS) */
export interface MediaSourceInfo {
  /** Scene item id within the MEDIA scene */
  id: number
  name: string
  /** OBS input kind, or 'scene' for a nested scene */
  kind: string
  visible: boolean
}

export interface MediaStatus {
  /** Every source found in the MEDIA scene, top-most first */
  sources: MediaSourceInfo[]
  /** Name of the source currently shown (top-most visible item), or null */
  active: string | null
  /** True when the active source supports playback control (video kinds) */
  playable: boolean
  /** Full path of the loaded file, or null when nothing is loaded */
  file: string | null
  state: MediaPlayState
  cursorMs: number
  durationMs: number
}

/** A global overlay layer (scene item of the OVERLAY scene), top-most first */
export interface LayerInfo {
  id: number
  name: string
  enabled: boolean
}

export interface AudioTrack {
  volumeDb: number
  muted: boolean
}

export interface ObsState {
  /** null per track when that input doesn't exist yet */
  audio: { input: AudioTrack | null; media: AudioTrack | null }
  currentScene: string
  scenes: string[]
  layers: LayerInfo[]
  /** Current content of the running-text overlay, null if the input is missing */
  runningText: string | null
  /** null when the media input doesn't exist (setup incomplete) */
  media: MediaStatus | null
}

/**
 * Machine-readable error kinds. Clients decide recoverability from the code,
 * never from the human-readable message: only 'expired' means a stored
 * session is definitively gone and its resume token may be discarded.
 */
export type ErrorCode = 'expired' | 'full' | 'not-found' | 'wrong-pin' | 'bad-request' | 'rate-limited'

export type ClientMessage =
  | { type: 'create'; name: string; pin: string }
  | { type: 'resume'; code: string; token: string }
  | { type: 'join'; code: string; pin: string }
  | { type: 'state'; state: ObsState }
  | { type: 'obs-status'; connected: boolean }
  | { type: 'command'; request: string; params?: Record<string, unknown> }
  | { type: 'command-error'; request: string; message: string }
  | { type: 'end' }
  /** Liveness probe — browsers can't detect half-open sockets on their own */
  | { type: 'ping' }

export type ServerMessage =
  | { type: 'created'; code: string; token: string }
  | { type: 'resumed'; code: string; name: string }
  | { type: 'joined'; name: string; state: ObsState | null; dockOnline: boolean; obsConnected: boolean }
  | { type: 'state'; state: ObsState }
  | { type: 'obs-status'; connected: boolean }
  | { type: 'command'; request: string; params?: Record<string, unknown> }
  | { type: 'command-error'; request: string; message: string }
  | { type: 'peers'; count: number }
  | { type: 'dock-status'; online: boolean }
  | { type: 'ended' }
  /** Another dock instance resumed this session — this connection is done */
  | { type: 'superseded' }
  | { type: 'pong' }
  | { type: 'error'; message: string; code?: ErrorCode }
