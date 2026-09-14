import { Show, type JSX, type Component } from "solid-js"
import { t } from "../i18n"
import type { AppView } from "../chat"

type TopbarProps = {
  healthLoading: boolean
  healthHealthy: boolean | undefined
  healthError: boolean
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onToggleSidebar: () => void
  view: AppView
  onViewChange: (view: AppView) => void
  /** The Chat / Code tabs live at the top of the sidebar; while it is hidden they show here. */
  sidebarCollapsed: boolean
  /** The session's right-hand context panel, when a session is open. */
  contextPanel?: { open: boolean; onToggle: () => void }
  onOpenPalette: () => void
  onTogglePanel: (kind: string) => void
  sessionTitle?: JSX.Element
  sessionActions?: JSX.Element
  /** Set when this device is controlling a remote computer. */
  remote?: { name: string; connected: boolean; onOpen: () => void }
  /** Set when this app is the computer hosting remote control. */
  hostRemote?: { name: string; connected: boolean; onOpen: () => void }
  /** Makes the engine status pill open the Remote control panel. */
  onConnection?: () => void
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
  // The left sidebar's icon, mirrored.
  contextPanel: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM15 4v16",
  back: "M19 12H5M11 6l-6 6 6 6",
  forward: "M5 12h14M13 6l6 6-6 6",
  files: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM14 3v5h5M9 13h6M9 17h4",
  browser: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM3 9h18",
  menu: "M5 12h.01M12 12h.01M19 12h.01",
  chat: "M7 17.5 3.5 20V6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2Z",
  code: "m9 8-4 4 4 4M15 8l4 4-4 4",
}

/** Chat / Code switch, like Claude's: two icon tabs in one pill. */
export const ViewTabs: Component<{ view: AppView; onChange: (view: AppView) => void }> = (props) => (
  <div class="fc-view-tabs" role="tablist" aria-label={t("View")}>
    <button
      class="fc-view-tab"
      classList={{ "fc-view-tab-active": props.view === "chat" }}
      type="button"
      role="tab"
      aria-selected={props.view === "chat"}
      title={t("Chat")}
      aria-label={t("Chat")}
      onClick={() => props.onChange("chat")}
    >
      <TopIcon d={TopbarIcons.chat} />
    </button>
    <button
      class="fc-view-tab"
      classList={{ "fc-view-tab-active": props.view === "code" }}
      type="button"
      role="tab"
      aria-selected={props.view === "code"}
      title={t("Code")}
      aria-label={t("Code")}
      onClick={() => props.onChange("code")}
    >
      <TopIcon d={TopbarIcons.code} />
    </button>
  </div>
)

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
        <Show when={props.sidebarCollapsed}>
          <ViewTabs view={props.view} onChange={props.onViewChange} />
        </Show>
        {props.sessionTitle}
      </div>
      <div class="fc-topbar-right">
        {props.sessionActions}
        <Show when={props.view === "code"}>
          <button
            class="fc-nav-arrow"
            type="button"
            title={t("Files changed")}
            aria-label={t("Files changed")}
            onClick={() => props.onTogglePanel("diff")}
          >
            <TopIcon d={TopbarIcons.files} />
          </button>
          <button
            class="fc-nav-arrow"
            type="button"
            title={t("Browser")}
            aria-label={t("Browser")}
            onClick={() => props.onTogglePanel("browser")}
          >
            <TopIcon d={TopbarIcons.browser} />
          </button>
          <button
            class="fc-nav-arrow"
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
        </Show>
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
        <Show when={props.remote ?? props.hostRemote}>
          {(pill) => (
            <button
              class="fc-status fc-status-remote"
              classList={{ "fc-status-on": pill().connected, "fc-status-off": !pill().connected }}
              type="button"
              title={t("Remote control")}
              onClick={pill().onOpen}
            >
              {t("Remote: {name}", { name: pill().name })}
            </button>
          )}
        </Show>
        {/* The host's remote pill replaces the engine pill: "Connected" there is the local engine,
            not the remote control connection the reader is watching. */}
        <Show when={!props.hostRemote}>
          <Show
            when={props.onConnection}
            fallback={
              <span
                class="fc-status"
                classList={{
                  "fc-status-on": props.healthHealthy === true,
                  "fc-status-off": props.healthError,
                }}
              >
                {status()}
              </span>
            }
          >
            {(open) => (
              <button
                class="fc-status"
                classList={{
                  "fc-status-on": props.healthHealthy === true,
                  "fc-status-off": props.healthError,
                }}
                type="button"
                title={t("Remote control")}
                onClick={open()}
              >
                {status()}
              </button>
            )}
          </Show>
        </Show>
        <Show when={props.contextPanel}>
          {(panel) => (
            <button
              class="fc-nav-arrow"
              type="button"
              title={t("Toggle context panel")}
              aria-label={t("Toggle context panel")}
              aria-pressed={panel().open}
              onClick={panel().onToggle}
            >
              <TopIcon d={TopbarIcons.contextPanel} />
            </button>
          )}
        </Show>
      </div>
    </header>
  )
}
