import { Show, type JSX, type Component } from "solid-js"
import { t } from "../i18n"

type TopbarProps = {
  healthLoading: boolean
  healthHealthy: boolean | undefined
  healthError: boolean
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onToggleSidebar: () => void
  onOpenPalette: () => void
  workspace: string[]
  onTogglePanel: (kind: string) => void
  sessionTitle?: JSX.Element
  sessionActions?: JSX.Element
  /** Set when this device is controlling a remote computer. */
  remote?: { name: string; connected: boolean; onOpen: () => void }
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
        {props.sessionTitle}
      </div>
      <div class="fc-topbar-right">
        {props.sessionActions}
        <button
          class="fc-nav-arrow"
          classList={{ "fc-icon-button-active": props.workspace.includes("diff") }}
          type="button"
          title={t("Files changed")}
          aria-label={t("Files changed")}
          onClick={() => props.onTogglePanel("diff")}
        >
          ▤
        </button>
        <button
          class="fc-nav-arrow"
          classList={{ "fc-icon-button-active": props.workspace.includes("browser") }}
          type="button"
          title={t("Browser")}
          aria-label={t("Browser")}
          onClick={() => props.onTogglePanel("browser")}
        >
          ◱
        </button>
        <button
          class="fc-nav-arrow"
          classList={{ "fc-icon-button-active": props.workspace.includes("terminal") }}
          type="button"
          title={t("Terminal")}
          aria-label={t("Terminal")}
          onClick={() => props.onTogglePanel("terminal")}
        >
          ⌨
        </button>
        <button
          class="fc-nav-arrow"
          type="button"
          title={t("Command palette")}
          aria-label={t("Command palette")}
          onClick={props.onOpenPalette}
        >
          ⌕
        </button>
        <Show when={props.remote}>
          {(remote) => (
            <button
              class="fc-status fc-status-remote"
              classList={{ "fc-status-on": remote().connected, "fc-status-off": !remote().connected }}
              type="button"
              title={t("Remote control")}
              onClick={remote().onOpen}
            >
              {t("Remote: {name}", { name: remote().name })}
            </button>
          )}
        </Show>
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
