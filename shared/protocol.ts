// Wire protocol shared by the relay server and both frontend modes.

export type MediaPlayState = 'playing' | 'paused' | 'stopped' | 'ended' | 'none'

export interface MediaStatus {
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
  streaming: boolean
  recording: boolean
  layers: LayerInfo[]
  /** Current content of the running-text overlay, null if the input is missing */
  runningText: string | null
  /** null when the media input doesn't exist (setup incomplete) */
  media: MediaStatus | null
}

export type ClientMessage =
  | { type: 'create'; name: string; pin: string }
  | { type: 'resume'; code: string; token: string }
  | { type: 'join'; code: string; pin: string }
  | { type: 'state'; state: ObsState }
  | { type: 'obs-status'; connected: boolean }
  | { type: 'command'; request: string; params?: Record<string, unknown> }
  | { type: 'command-error'; request: string; message: string }
  | { type: 'end' }

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
  | { type: 'error'; message: string }
