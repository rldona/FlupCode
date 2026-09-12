import { For, Show, type Component } from "solid-js"
import type { StashedPrompt } from "../types"

type StashDialogProps = {
  open: boolean
  items: StashedPrompt[]
  onRestore: (id: string) => void
  onRemove: (id: string) => void
  onClose: () => void
}

export const StashDialog: Component<StashDialogProps> = (props) => (
  <Show when={props.open}>
    <div class="oh-modal-backdrop" onClick={props.onClose}>
      <div class="oh-modal oh-modal-wide" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div class="oh-modal-header">
          <span>Prompts guardados</span>
          <button class="oh-icon-button" type="button" aria-label="Cerrar" onClick={props.onClose}>
            ×
          </button>
        </div>
        <Show
          when={props.items.length > 0}
          fallback={
            <div class="oh-empty-state">
              <span class="oh-empty-title">Sin prompts guardados</span>
              <span class="oh-empty-hint">Usa /stash para guardar el prompt actual</span>
            </div>
          }
        >
          <ul class="oh-stash-list">
            <For each={props.items}>
              {(item) => (
                <li class="oh-stash-row">
                  <span class="oh-stash-text">{item.text}</span>
                  <button class="oh-button" type="button" onClick={() => props.onRestore(item.id)}>
                    Restaurar
                  </button>
                  <button class="oh-button oh-button-danger" type="button" onClick={() => props.onRemove(item.id)}>
                    Quitar
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  </Show>
)
