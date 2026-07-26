import { useEffect, useRef, useState } from 'react'
import type { LayerInfo } from '../../shared/protocol'
import type { SendCommand } from './ControlPanel'
import { OVERLAY_SCENE, RUNNING_TEXT_INPUT, LOGO_INPUT } from '../lib/overlay'
import { SCREENS, parseScene } from '../lib/scenes'

interface LayerPanelProps {
  layers: LayerInfo[]
  runningText: string | null
  currentScene: string
  scenes: string[]
  send: SendCommand
}

// Right sidebar, like a broadcast dashboard's layer switches:
//  - the global overlays (logo, running text) — toggled over any layout
//  - the event screens (waiting/rest/ending) — dedicated scenes; switching
//    one on puts it on program, switching it off returns to the last layout
// Everything derives from the mirrored state, so dock and remotes stay in sync.
export default function LayerPanel({ layers, runningText, currentScene, scenes, send }: LayerPanelProps) {
  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState('')

  // Where "off" returns to: the last real layout that was on program
  const lastLayout = useRef('MAIN')
  useEffect(() => {
    const sel = parseScene(currentScene)
    if (sel && sel.mode !== 'screen') lastLayout.current = currentScene
  }, [currentScene])

  const screenRows = SCREENS.filter((s) => scenes.includes(s.scene))

  const toggleLayer = (layer: LayerInfo): void =>
    send('SetSceneItemEnabled', {
      sceneName: OVERLAY_SCENE,
      sceneItemId: layer.id,
      sceneItemEnabled: !layer.enabled,
    })

  const setScene = (sceneName: string): void => send('SetCurrentProgramScene', { sceneName })

  function applyText(): void {
    send('SetInputSettings', { inputName: RUNNING_TEXT_INPUT, inputSettings: { text: draft } })
    setEditorOpen(false)
  }

  if (layers.length === 0 && screenRows.length === 0) {
    return (
      <aside className="space-y-2">
        <h3 className="text-sm sm:text-xs font-semibold uppercase tracking-wider text-ios-label2">Layers</h3>
        <p className="text-sm sm:text-xs text-ios-label3">
          No layers — run Setup to import the collection with the OVERLAY scene.
        </p>
      </aside>
    )
  }

  return (
    <aside className="space-y-2">
      <h3 className="text-sm sm:text-xs font-semibold uppercase tracking-wider text-ios-label2">Layers</h3>
      <div className="divide-y divide-ios-sep/60 overflow-hidden rounded-2xl bg-ios-card">
        {layers.map((layer) => {
          const isText = layer.name === RUNNING_TEXT_INPUT
          return (
            <div key={layer.id} className="px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className={`min-w-0 truncate text-sm sm:text-xs ${layer.enabled ? 'text-white' : 'text-ios-label3'}`}>
                  {layer.name}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  {isText && runningText !== null && (
                    <button
                      title="Edit the running text"
                      onClick={() => {
                        setDraft(runningText)
                        setEditorOpen((v) => !v)
                      }}
                      className="text-sm sm:text-xs text-ios-blue transition-colors hover:text-ios-blue-light"
                    >
                      Edit
                    </button>
                  )}
                  <Switch on={layer.enabled} label={`Toggle ${layer.name}`} onToggle={() => toggleLayer(layer)} />
                </div>
              </div>
              {isText && runningText !== null && !editorOpen && runningText.trim() !== '' && (
                <p className="mt-1 truncate text-xs text-ios-label3">{runningText}</p>
              )}
              {isText && editorOpen && (
                <div className="mt-2 animate-fade-in space-y-1.5">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                    placeholder="Announcement text…"
                    className="w-full resize-none rounded-xl border border-transparent bg-ios-fill px-2 py-1.5 text-sm sm:text-xs text-white outline-none transition-colors duration-200 ease-out focus:border-ios-blue"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setEditorOpen(false)}
                      className="text-sm sm:text-xs text-ios-label2 transition-colors hover:text-white"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={applyText}
                      className="rounded-xl bg-ios-blue px-3 py-1 text-sm sm:text-xs font-semibold text-white transition-all duration-200 ease-out hover:bg-ios-blue-light active:scale-[0.98]"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              )}
              {layer.name === LOGO_INPUT && layer.enabled && (
                <p className="mt-1 text-xs text-ios-label3">Image is set in OBS on the Logo source.</p>
              )}
            </div>
          )
        })}

        {screenRows.map((spec) => {
          const on = currentScene === spec.scene
          return (
            <div key={spec.key} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className={`min-w-0 truncate text-sm sm:text-xs ${on ? 'text-white' : 'text-ios-label3'}`}>
                {spec.input}
              </span>
              <Switch
                on={on}
                label={on ? `Return to the previous layout` : `Show the ${spec.input} on the stream`}
                onToggle={() => setScene(on ? lastLayout.current : spec.scene)}
              />
            </div>
          )
        })}
      </div>
    </aside>
  )
}

function Switch({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      title={label}
      onClick={onToggle}
      className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors duration-200 ease-out ${
        on ? 'bg-ios-green' : 'bg-ios-fill2'
      }`}
    >
      <span
        className={`block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ease-out ${
          on ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}
