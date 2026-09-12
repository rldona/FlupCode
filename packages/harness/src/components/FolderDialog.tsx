import { Show, createSignal, type Component } from "solid-js"
import { t } from "../i18n"

type FolderDialogProps = {
  open: boolean
  initial?: string
  onOpen: (path: string) => void
  onClose: () => void
}

export const FolderDialog: Component<FolderDialogProps> = (props) => {
  const [value, setValue] = createSignal("")
  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-modal"
          role="dialog"
          aria-modal="true"
          aria-label={t("Open folder")}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-modal-header">
            <span>{t("Open folder")}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>
          <p class="fc-modal-note">{t("Type the absolute path of a project folder to start a new project.")}</p>
          <input
            class="fc-question-custom"
            value={value() || props.initial || ""}
            placeholder="/Users/you/project"
            spellcheck={false}
            onInput={(event) => setValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && value().trim()) props.onOpen(value().trim())
            }}
          />
          <div class="fc-settings-row">
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Cancel")}
            </button>
            <button
              class="fc-button fc-button-primary"
              type="button"
              disabled={value().trim().length === 0}
              onClick={() => props.onOpen(value().trim())}
            >
              {t("Open")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
