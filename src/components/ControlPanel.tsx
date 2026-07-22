import { useRef, useState } from 'react'
import type { AudioInput, ObsState } from '../../shared/protocol'

export type SendCommand = (request: string, params?: Record<string, unknown>) => void

interface ControlPanelProps {
  state: ObsState
  send: SendCommand
}

// Shared between dock and remote. `state` is the OBS snapshot, `send(request,
// params)` executes an obs-websocket request — directly in the dock, via the
// relay in the remote. Both UIs stay in sync because the dock re-broadcasts
// state after every OBS event.
export default function ControlPanel({ state, send }: ControlPanelProps) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2">
        <ToggleButton
          active={state.streaming}
          activeLabel="Stop Streaming"
          idleLabel="Start Streaming"
          onClick={() => send('ToggleStream')}
        />
        <ToggleButton
          active={state.recording}
          activeLabel="Stop Recording"
          idleLabel="Start Recording"
          onClick={() => send('ToggleRecord')}
        />
      </div>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Scenes</h3>
        <div className="grid grid-cols-2 gap-2">
          {state.scenes.map((name) => (
            <button
              key={name}
              onClick={() => send('SetCurrentProgramScene', { sceneName: name })}
              className={`truncate rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                name === state.currentScene
                  ? 'bg-emerald-600 text-white'
                  : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      </section>

      {state.audio.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Audio</h3>
          <div className="space-y-2">
            {state.audio.map((input) => (
              <AudioRow key={input.name} input={input} send={send} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

interface ToggleButtonProps {
  active: boolean
  activeLabel: string
  idleLabel: string
  onClick: () => void
}

function ToggleButton({ active, activeLabel, idleLabel, onClick }: ToggleButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
        active ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
      }`}
    >
      {active ? activeLabel : idleLabel}
    </button>
  )
}

function AudioRow({ input, send }: { input: AudioInput; send: SendCommand }) {
  // Keep the slider under local control while dragging so state echoes coming
  // back from the dock don't fight the user's finger.
  const [drag, setDrag] = useState<number | null>(null)
  const lastSent = useRef(0)
  const value = drag ?? Math.max(-60, Math.min(0, input.volumeDb))

  function onSlide(e: React.ChangeEvent<HTMLInputElement>): void {
    const v = Number(e.target.value)
    setDrag(v)
    const now = performance.now()
    if (now - lastSent.current > 50) {
      lastSent.current = now
      send('SetInputVolume', { inputName: input.name, inputVolumeDb: v })
    }
  }

  function onRelease(): void {
    if (drag !== null) send('SetInputVolume', { inputName: input.name, inputVolumeDb: drag })
    setDrag(null)
  }

  return (
    <div className="flex items-center gap-3 rounded-lg bg-zinc-800/60 px-3 py-2">
      <button
        onClick={() => send('ToggleInputMute', { inputName: input.name })}
        className={`w-14 shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${
          input.muted ? 'bg-red-600/80 text-white' : 'bg-zinc-700 text-zinc-200'
        }`}
      >
        {input.muted ? 'Muted' : 'Live'}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-zinc-300">{input.name}</div>
        <input
          type="range"
          min={-60}
          max={0}
          step={0.5}
          value={value}
          onChange={onSlide}
          onPointerUp={onRelease}
          onKeyUp={onRelease}
          className="w-full"
        />
      </div>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-zinc-400">
        {value <= -60 ? '-inf' : value.toFixed(1)} dB
      </span>
    </div>
  )
}
