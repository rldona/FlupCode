import { Show, type Component } from "solid-js"
import pkg from "../../package.json"
import { t } from "../i18n"
import { Modal, ModalClose } from "./Modal"

type AboutProps = {
  open: boolean
  onClose: () => void
  onBack?: () => void
}

export const About: Component<AboutProps> = (props) => {
  return (
    <Modal open={props.open} onClose={props.onClose} label={t("About FlupCode")}>
      <div class="fc-modal-header">
        <span class="fc-modal-heading">
          <Show when={props.onBack}>
            <button class="fc-icon-button fc-back" type="button" aria-label={t("Back")} onClick={props.onBack}>
              ←
            </button>
          </Show>
          <span>{t("About FlupCode")}</span>
        </span>
        <ModalClose />
      </div>
      <p class="fc-modal-line">{t("Version {version}", { version: pkg.version })}</p>
      <p class="fc-modal-note">
        {t(
          "FlupCode is an independent project built on OpenCode. It is not affiliated with or endorsed by Anomaly (OpenCode) or Anthropic (Claude Code).",
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
    </Modal>
  )
}
