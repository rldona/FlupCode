import type { Component } from "solid-js"

type ComposerProps = {
  value: string
  sending: boolean
  onInput: (value: string) => void
  onSend: () => void
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
  </footer>
)
