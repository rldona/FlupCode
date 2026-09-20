import type { Component } from "solid-js"
import { t } from "../i18n"

type TopbarProps = {
  serverInput: string
  healthLoading: boolean
  healthHealthy: boolean | undefined
  healthError: boolean
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onToggleSidebar: () => void
  onRefreshServer: () => void
  onServerInput: (value: string) => void
}

export const Topbar: Component<TopbarProps> = (props) => {
  const status = () => {
    if (props.healthLoading) return t("Connecting")
    if (props.healthHealthy) return t("Connected")
    if (props.healthError) return t("Offline")
    return t("Offline")
  }

  return (
    <header class="fc-topbar">
      <div class="fc-topbar-left">
        <button class="fc-nav-arrow" type="button" title={t("Toggle sidebar")} onClick={props.onToggleSidebar}>
          ▤
        </button>
        <button class="fc-nav-arrow" type="button" title={t("Back")} disabled={!props.canGoBack} onClick={props.onBack}>
          ←
        </button>
        <button
          class="fc-nav-arrow"
          type="button"
          title={t("Forward")}
          disabled={!props.canGoForward}
          onClick={props.onForward}
        >
          →
        </button>
        <span class="fc-logo">FlupCode</span>
      </div>
      <div class="fc-topbar-right">
        <input
          class="fc-server-input"
          value={props.serverInput}
          spellcheck={false}
          aria-label="Server URL"
          onInput={(event) => props.onServerInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") props.onRefreshServer()
          }}
        />
        <span
          class="fc-status"
          classList={{
            "fc-status-on": props.healthHealthy === true,
            "fc-status-off": props.healthError,
          }}
        >
          {status()}
        </span>
      </div>
    </header>
  )
}
