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
  /** The session's right-hand context panel, when a session is open. */
  contextPanel?: { open: boolean; onToggle: () => void }
  onOpenPalette: () => void
  workspace: string[]
  onTogglePanel: (kind: string) => void
  sessionTitle?: JSX.Element
  sessionActions?: JSX.Element
  /** Set when this device is controlling a remote computer. */
  remote?: { name: string; connected: boolean; onOpen: () => void }
}

/** Top bar icons share one size and stroke so every button reads the same. */
export const TopIcon: Component<{ d: string }> = (props) => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path
      d={props.d}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)

export const TopbarIcons = {
  sidebar: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM9 4v16",
  back: "M19 12H5M11 6l-6 6 6 6",
  forward: "M5 12h14M13 6l6 6-6 6",
  files: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM14 3v5h5M9 13h6M9 17h4",
  browser: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM3 9h18",
  menu: "M5 12h.01M12 12h.01M19 12h.01",
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
          <TopIcon d={TopbarIcons.sidebar} />
        </button>
        <button class="fc-nav-arrow" type="button" title={t("Back")} disabled={!props.canGoBack} onClick={props.onBack}>
          <TopIcon d={TopbarIcons.back} />
        </button>
        <button
          class="fc-nav-arrow"
          type="button"
          title={t("Forward")}
          disabled={!props.canGoForward}
          onClick={props.onForward}
        >
          <TopIcon d={TopbarIcons.forward} />
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
          <TopIcon d={TopbarIcons.files} />
        </button>
        <button
          class="fc-nav-arrow"
          classList={{ "fc-icon-button-active": props.workspace.includes("browser") }}
          type="button"
          title={t("Browser")}
          aria-label={t("Browser")}
          onClick={() => props.onTogglePanel("browser")}
        >
          <TopIcon d={TopbarIcons.browser} />
        </button>
        <button
          class="fc-nav-arrow"
          classList={{ "fc-icon-button-active": props.workspace.includes("terminal") }}
          type="button"
          title={t("Terminal")}
          aria-label={t("Terminal")}
          onClick={() => props.onTogglePanel("terminal")}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="m5 7 5 5-5 5M12 18h7"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          class="fc-nav-arrow"
          type="button"
          title={t("Command palette")}
          aria-label={t("Command palette")}
          onClick={props.onOpenPalette}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="m20 20-4.5-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
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
        <Show when={props.contextPanel}>
          {(panel) => (
            <button
              class="fc-nav-arrow"
              classList={{ "fc-icon-button-active": panel().open }}
              type="button"
              title={t("Toggle context panel")}
              aria-label={t("Toggle context panel")}
              aria-pressed={panel().open}
              onClick={panel().onToggle}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <rect
                  x="3.5"
                  y="4.5"
                  width="17"
                  height="15"
                  rx="2.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                />
                <path d="M15 4.5v15" fill="none" stroke="currentColor" stroke-width="1.8" />
              </svg>
            </button>
          )}
        </Show>
      </div>
    </header>
  )
}
