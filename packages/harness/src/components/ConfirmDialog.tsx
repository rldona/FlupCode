import { Show, createUniqueId, onCleanup, type Component, type JSX } from "solid-js"
import { t } from "../i18n"
import { holdModalFocus } from "../modal-focus"

type ConfirmDialogProps = {
  open: boolean
  title: string
  message: string
  /** What the confirming button says; defaults to "Delete" because that is what asks for one. */
  confirmLabel?: string
  /** What the person is asked to review before confirming, below the message (AH-A04). */
  children?: JSX.Element
  onConfirm: () => void
  onClose: () => void
}

/**
 * Asks before something that cannot be undone (H-24).
 *
 * `window.confirm` is unavailable in the sandboxed desktop renderer, and it looks like the browser
 * rather than the app; this is the app's own. Escape and a backdrop click cancel, Enter confirms. The
 * focus moves in on open and back to the control that opened it on close (AH-E06).
 */
export const ConfirmDialog: Component<ConfirmDialogProps> = (props) => {
  const messageID = createUniqueId()
  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          ref={(node) => onCleanup(holdModalFocus(node))}
          class="fc-modal"
          role="dialog"
          aria-modal="true"
          aria-label={props.title}
          aria-describedby={messageID}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              props.onClose()
            }
            // Enter on the dialog itself confirms; on a button it presses that button, so Enter on
            // Cancel cancels instead of confirming.
            if (event.key === "Enter" && event.target === event.currentTarget) {
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
          <p id={messageID} class="fc-confirm-message">
            {props.message}
          </p>
          {props.children}
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
