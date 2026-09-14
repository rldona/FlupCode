import { Show, createEffect, createSignal, on, type Component } from "solid-js"
import { t } from "../i18n"

type RenameDialogProps = {
  open: boolean
  /** Heading shown in the modal, e.g. "Rename". */
  title: string
  initial: string
  onSave: (value: string) => void
  onClose: () => void
}

/**
 * Asks for a new name. The desktop renderer runs sandboxed, so `window.prompt` is unavailable
 * there; this keeps renaming working on web and desktop alike.
 */
export const RenameDialog: Component<RenameDialogProps> = (props) => {
  const [value, setValue] = createSignal("")
  let input: HTMLInputElement | undefined

  createEffect(
    on(
      () => [props.open, props.initial] as const,
      ([open, initial]) => {
        if (!open) return
        setValue(initial)
        queueMicrotask(() => {
          input?.focus()
          input?.select()
        })
      },
    ),
  )

  const save = () => {
    const next = value().trim()
    if (!next) return
    props.onSave(next)
  }

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-modal"
          role="dialog"
          aria-modal="true"
          aria-label={props.title}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-modal-header">
            <span>{props.title}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>
          <input
            ref={input}
            class="fc-question-custom fc-rename-input"
            value={value()}
            placeholder={t("New title")}
            aria-label={t("New title")}
            spellcheck={false}
            onInput={(event) => setValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                save()
                return
              }
              if (event.key === "Escape") {
                event.preventDefault()
                props.onClose()
              }
            }}
          />
          <div class="fc-dialog-actions">
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Cancel")}
            </button>
            <button
              class="fc-button fc-button-primary"
              type="button"
              disabled={value().trim().length === 0}
              onClick={save}
            >
              {t("Save")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
