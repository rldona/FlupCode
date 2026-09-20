import { Show, type Component } from "solid-js"
import { t } from "../i18n"

type ConfirmDialogProps = {
  open: boolean
  title: string
  message: string
  /** What the confirming button says; defaults to "Delete" because that is what asks for one. */
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
}

/**
 * Asks before something that cannot be undone (H-24).
 *
 * `window.confirm` is unavailable in the sandboxed desktop renderer, and it looks like the browser
 * rather than the app; this is the app's own. Escape and a backdrop click cancel, Enter confirms.
 */
export const ConfirmDialog: Component<ConfirmDialogProps> = (props) => {
  let dialog: HTMLDivElement | undefined
  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          ref={(node) => {
            dialog = node
            queueMicrotask(() => dialog?.focus())
          }}
          class="fc-modal"
          role="dialog"
          aria-modal="true"
          aria-label={props.title}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              props.onClose()
            }
            if (event.key === "Enter") {
              event.preventDefault()
              props.onConfirm()
            }
          }}
        >
          <div class="fc-modal-header">
            <span>{props.title}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>
          <p class="fc-confirm-message">{props.message}</p>
          <div class="fc-dialog-actions">
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Cancel")}
            </button>
            <button class="fc-button fc-button-danger" type="button" onClick={props.onConfirm}>
              {props.confirmLabel ?? t("Delete")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
