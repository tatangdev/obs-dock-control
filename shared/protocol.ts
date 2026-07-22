// Wire protocol shared by the relay server and both frontend modes.

export interface AudioInput {
  name: string
  muted: boolean
  volumeDb: number
}

export interface ObsState {
  currentScene: string
  scenes: string[]
  streaming: boolean
  recording: boolean
  audio: AudioInput[]
}

export type ClientMessage =
  | { type: 'create'; name: string; pin: string }
  | { type: 'resume'; code: string; token: string }
  | { type: 'join'; code: string; pin: string }
  | { type: 'state'; state: ObsState }
  | { type: 'command'; request: string; params?: Record<string, unknown> }
  | { type: 'command-error'; request: string; message: string }
  | { type: 'end' }

export type ServerMessage =
  | { type: 'created'; code: string; token: string }
  | { type: 'resumed'; code: string; name: string }
  | { type: 'joined'; name: string; state: ObsState | null; dockOnline: boolean }
  | { type: 'state'; state: ObsState }
  | { type: 'command'; request: string; params?: Record<string, unknown> }
  | { type: 'command-error'; request: string; message: string }
  | { type: 'peers'; count: number }
  | { type: 'dock-status'; online: boolean }
  | { type: 'ended' }
  | { type: 'error'; message: string }
