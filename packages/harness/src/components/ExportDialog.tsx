import { Show, createSignal, type Component } from "solid-js"
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from "../export"
import { t } from "../i18n"

type ExportDialogProps = {
  open: boolean
  title: string
  /** The harness server can keep a copy and hand back a link (H-35). */
  canShare: boolean
  onExport: (format: "markdown" | "json", options: ExportOptions) => void
  onShare: (options: ExportOptions) => void
  onClose: () => void
}

/**
 * What to leave in when a conversation becomes a file (H-35).
 *
 * The old export was one menu item and a fixed shape. These are the three choices a reader actually
 * makes — the thinking, the tool calls, and what the tools printed — and the format, because "give
 * me the data" is a different request from "give me something to read".
 */
export const ExportDialog: Component<ExportDialogProps> = (props) => {
  const [options, setOptions] = createSignal<ExportOptions>({ ...DEFAULT_EXPORT_OPTIONS })
  const toggle = (key: keyof ExportOptions) => setOptions({ ...options(), [key]: !options()[key] })

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-modal"
          role="dialog"
          aria-modal="true"
          aria-label={t("Export conversation")}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-modal-header">
            <span>{t("Export conversation")}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>
          <p class="fc-settings-hint">{props.title}</p>
          <div class="fc-settings-section">
            <label class="fc-settings-row">
              <span class="fc-settings-usage">
                <span>{t("Include the thinking")}</span>
                <span class="fc-settings-hint">{t("What the model thought, as a collapsed block.")}</span>
              </span>
              <input
                type="checkbox"
                checked={!!options().reasoning}
                aria-label={t("Include the thinking")}
                onChange={() => toggle("reasoning")}
              />
            </label>
            <label class="fc-settings-row">
              <span class="fc-settings-usage">
                <span>{t("Include tool calls")}</span>
                <span class="fc-settings-hint">{t("Each call by name. Off leaves only the conversation.")}</span>
              </span>
              <input
                type="checkbox"
                checked={!!options().tools}
                aria-label={t("Include tool calls")}
                onChange={() => toggle("tools")}
              />
            </label>
            <label class="fc-settings-row">
              <span class="fc-settings-usage">
                <span>{t("Include tool output")}</span>
                <span class="fc-settings-hint">{t("What the tools printed. The noisy half.")}</span>
              </span>
              <input
                type="checkbox"
                checked={!!options().toolOutput}
                aria-label={t("Include tool output")}
                onChange={() => toggle("toolOutput")}
              />
            </label>
          </div>
          <div class="fc-dialog-actions">
            <Show when={props.canShare}>
              <button class="fc-button" type="button" onClick={() => props.onShare(options())}>
                {t("Copy link")}
              </button>
            </Show>
            <button class="fc-button" type="button" onClick={() => props.onExport("json", options())}>
              {t("Download JSON")}
            </button>
            <button class="fc-button fc-button-primary" type="button" onClick={() => props.onExport("markdown", options())}>
              {t("Download Markdown")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
