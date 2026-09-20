import { Show, createEffect, onCleanup, type Component } from "solid-js"
import pkg from "../../package.json"
import { t } from "../i18n"

type AboutProps = {
  open: boolean
  onClose: () => void
}

export const About: Component<AboutProps> = (props) => {
  createEffect(() => {
    if (!props.open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose()
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div class="fc-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
          <div class="fc-modal-header">
            <span>{t("About FlupCode")}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>
          <p class="fc-modal-line">{t("Version {version}", { version: pkg.version })}</p>
          <p class="fc-modal-note">
            {t(
              "FlupCode is an independent fork of OpenCode. It is not affiliated with or endorsed by Anomaly (OpenCode) or Anthropic (Claude Code).",
            )}
          </p>
          <div class="fc-modal-links">
            <a href="https://github.com/rldona/FlupCode" target="_blank" rel="noreferrer">
              {t("Repository")}
            </a>
            <a href="https://github.com/anomalyco/opencode" target="_blank" rel="noreferrer">
              {t("Upstream OpenCode")}
            </a>
          </div>
          <p class="fc-modal-license">{t("MIT license. OpenCode copyright preserved.")}</p>
        </div>
      </div>
    </Show>
  )
}
