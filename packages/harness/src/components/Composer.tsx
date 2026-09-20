import { For, type Component } from "solid-js"
import type { ModelInfo } from "@opencode-ai/client"

type ComposerProps = {
  value: string
  sending: boolean
  models: ModelInfo[]
  modelKey: string | undefined
  auto: boolean
  onInput: (value: string) => void
  onSend: () => void
  onModelChange: (key: string) => void
  onToggleAuto: () => void
}

export const Composer: Component<ComposerProps> = (props) => (
  <footer class="oh-composer">
    <div class="oh-composer-chips">
      <span class="oh-chip">Local</span>
      <span class="oh-chip">Sin carpeta</span>
    </div>
    <div class="oh-composer-row">
      <textarea
        class="oh-input"
        rows={1}
        placeholder="Describe una tarea o haz una pregunta"
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            props.onSend()
          }
        }}
      />
      <button
        class="oh-send"
        type="button"
        onClick={props.onSend}
        disabled={props.sending || props.value.trim().length === 0}
      >
        Enviar
      </button>
    </div>
    <div class="oh-composer-controls">
      <button
        class="oh-chip oh-chip-button"
        classList={{ "oh-chip-active": props.auto }}
        type="button"
        onClick={props.onToggleAuto}
      >
        Auto
      </button>
      <select
        class="oh-model-select"
        value={props.auto ? "" : (props.modelKey ?? "")}
        disabled={props.auto}
        aria-label="Modelo"
        onChange={(event) => props.onModelChange(event.currentTarget.value)}
      >
        <option value="" disabled>
          Modelo por defecto
        </option>
        <For each={props.models}>
          {(model) => <option value={`${model.providerID}/${model.modelID}`}>{model.name}</option>}
        </For>
      </select>
    </div>
  </footer>
)
