import { For, Show, type Component } from "solid-js"
import type { StashedPrompt } from "../types"
import { t } from "../i18n"

type StashDialogProps = {
  open: boolean
  items: StashedPrompt[]
  onRestore: (id: string) => void
  onRemove: (id: string) => void
  onClose: () => void
}

export const StashDialog: Component<StashDialogProps> = (props) => (
  <Show when={props.open}>
    <div class="fc-modal-backdrop" onClick={props.onClose}>
      <div class="fc-modal fc-modal-wide" role="dialog" aria-modal="true" aria-label={t("Saved prompts")} onClick={(event) => event.stopPropagation()}>
        <div class="fc-modal-header">
          <span>{t("Saved prompts")}</span>
          <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
            ×
          </button>
        </div>
        <Show
          when={props.items.length > 0}
          fallback={
            <div class="fc-empty-state">
              <span class="fc-empty-title">{t("No saved prompts")}</span>
              <span class="fc-empty-hint">{t("Use /stash to save the current prompt")}</span>
            </div>
          }
        >
          <ul class="fc-stash-list">
            <For each={props.items}>
              {(item) => (
                <li class="fc-stash-row">
                  <span class="fc-stash-text">{item.text}</span>
                  <button class="fc-button" type="button" onClick={() => props.onRestore(item.id)}>
                    {t("Restore")}
                  </button>
                  <button class="fc-button fc-button-danger" type="button" onClick={() => props.onRemove(item.id)}>
                    {t("Remove")}
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
