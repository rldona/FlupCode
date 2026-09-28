import { Show, createEffect, createSignal, type Component } from "solid-js"
import { externalLinkOrigin } from "../external-links"
import { t } from "../i18n"

type ExternalLinkDialogProps = {
  url: string | undefined
  onCancel: () => void
  /** `remember` is the state of the checkbox: the reader asked not to be prompted for this host again. */
  onOpen: (remember: boolean) => void
}

/**
 * Asks before leaving the app for a link in the transcript.
 *
 * The desktop renderer is sandboxed and the integrated browser cannot render another origin, so a
 * link belongs in the reader's own browser and not in a panel. This is the app's own prompt, never
 * `window.confirm`, which the sandbox does not have. Escape and a backdrop click cancel; Enter opens.
 */
export const ExternalLinkDialog: Component<ExternalLinkDialogProps> = (props) => {
  const [remember, setRemember] = createSignal(false)
  let dialog: HTMLDivElement | undefined
  // A fresh link is a fresh question: a box checked for one origin must not leave the next one
  // pre-checked, which would remember a host the reader never agreed to.
  createEffect(() => {
    props.url
    setRemember(false)
  })
  const origin = () => {
    const url = props.url
    if (!url) return ""
    return externalLinkOrigin(url) ?? url
  }

  return (
    <Show when={props.url}>
      <div class="fc-modal-backdrop" onClick={props.onCancel}>
        <div
          ref={(node) => {
            dialog = node
            queueMicrotask(() => dialog?.focus())
          }}
          class="fc-modal"
          role="dialog"
          aria-modal="true"
          aria-label={t("Open external link")}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              props.onCancel()
            }
            if (event.key === "Enter") {
              // Enter on a focused control does what that control says: only a bare Enter on the
              // dialog itself opens the link, so Tab-to-Cancel then Enter cancels.
              const target = event.target
              if (target instanceof Element && target.closest("button, a, input, textarea, select")) return
              event.preventDefault()
              props.onOpen(remember())
            }
          }}
        >
          <div class="fc-modal-header">
            <span>{t("Open external link")}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onCancel}>
              ×
            </button>
          </div>
          <p class="fc-confirm-message">{t("You're leaving FlupCode to visit an external link:")}</p>
          <code class="fc-external-link-url">{props.url}</code>
          <label class="fc-dialog-check">
            <input
              type="checkbox"
              checked={remember()}
              onChange={(event) => setRemember(event.currentTarget.checked)}
            />
            <span>{t("Don't ask again for links to {host}", { host: origin() })}</span>
          </label>
          <div class="fc-dialog-actions">
            <button class="fc-button" type="button" onClick={props.onCancel}>
              {t("Cancel")}
            </button>
            <button class="fc-button fc-button-primary" type="button" onClick={() => props.onOpen(remember())}>
              {t("Open link")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
