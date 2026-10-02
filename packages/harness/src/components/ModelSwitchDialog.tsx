import { createEffect, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { Modal, ModalClose } from "./Modal"

type ModelSwitchDialogProps = {
  open: boolean
  /** Names of the model the session holds and of the one the reader picked. */
  from: string
  to: string
  onCancel: () => void
  onConfirm: (skipNextTime: boolean) => void
}

/**
 * Warns before a session that already holds context moves to another model, because the new model
 * re-reads the whole transcript on the next message and spends more of the reader's limit.
 */
export const ModelSwitchDialog: Component<ModelSwitchDialogProps> = (props) => {
  const [skip, setSkip] = createSignal(false)
  let cancel: HTMLButtonElement | undefined

  createEffect(() => {
    if (!props.open) return
    setSkip(false)
    // Cancel takes the focus so a stray Enter or Escape backs out instead of switching.
    queueMicrotask(() => cancel?.focus())
  })

  return (
    <Modal open={props.open} onClose={props.onCancel} label={t("Switch model?")}>
      <div class="fc-modal-header">
        <span>{t("Switch model?")}</span>
        <ModalClose />
      </div>
      <p class="fc-modal-note">
        {t(
          "This session is cached for {from}. Switching to {to} means the whole session is re-read on your next message, which uses more of your limit.",
          { from: props.from, to: props.to },
        )}
      </p>
      <label class="fc-dialog-check">
        <input type="checkbox" checked={skip()} onChange={(event) => setSkip(event.currentTarget.checked)} />
        {t("Don't ask again")}
      </label>
      <div class="fc-dialog-actions">
        <button ref={cancel} class="fc-button" type="button" onClick={props.onCancel}>
          {t("Cancel")}
        </button>
        <button class="fc-button fc-button-primary" type="button" onClick={() => props.onConfirm(skip())}>
          {t("Switch model")}
        </button>
      </div>
    </Modal>
  )
}
