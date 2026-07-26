// Per-OS pieces of the OBS setup. The only platform-specific part of the
// scene collection is the camera capture kind — everything else (media,
// images, text, filters, plugins) is cross-platform.

export type Platform = 'macos' | 'windows' | 'linux'

export const PLATFORMS: readonly Platform[] = ['macos', 'windows', 'linux']

export const PLATFORM_LABEL: Record<Platform, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
}

export const CAMERA_KIND: Record<Platform, string> = {
  macos: 'macos-avcapture',
  windows: 'dshow_input',
  linux: 'v4l2_input',
}

export const AUDIO_KIND: Record<Platform, string> = {
  macos: 'coreaudio_input_capture',
  windows: 'wasapi_input_capture',
  linux: 'pulse_input_capture',
}

/** Which input-settings key holds the picked device, per capture kind */
export const CAMERA_DEVICE_PROP: Record<string, { prop: string; nameProp?: string }> = {
  'macos-avcapture': { prop: 'device', nameProp: 'device_name' },
  av_capture_input: { prop: 'device', nameProp: 'device_name' }, // pre-28 macOS kind
  dshow_input: { prop: 'video_device_id' },
  v4l2_input: { prop: 'device_id' },
}

export const COLLECTION_FILE: Record<Platform, string> = {
  macos: '/scene-collection-macos.json',
  windows: '/scene-collection-windows.json',
  linux: '/scene-collection-linux.json',
}

/** Map obs-websocket GetVersion.platform to ours */
export function platformFromObs(obsPlatform: string): Platform | null {
  if (obsPlatform === 'osx' || obsPlatform === 'macos') return 'macos'
  if (obsPlatform === 'windows') return 'windows'
  if (obsPlatform === 'linux') return 'linux'
  return null
}
