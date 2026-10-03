import { Show, type JSX, type Component } from "solid-js"
import { t } from "../i18n"
import type { AppView } from "../chat"
import { Icon } from "./Icon"

type TopbarProps = {
  healthLoading: boolean
  healthHealthy: boolean | undefined
  healthError: boolean
  /** The engine's event stream, which is what decides whether the app is following a live run. */
  streamState: "connecting" | "live" | "reconnecting"
  /** Sessions other than the open one that are waiting on a permission; clicking opens the first. */
  blockedElsewhere: string[]
  onOpenBlocked: (sessionID: string) => void
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onToggleSidebar: () => void
  view: AppView
  onViewChange: (view: AppView) => void
  /** Which tabs have sessions working right now, for the dot on their icons. */
  viewActivity: { chat: boolean; code: boolean }
  /** True where the Code chrome applies: the Code tab, or a Cowork conversation in the Chat tab. */
  codeChrome: boolean
  /** The Chat / Code tabs live at the top of the sidebar; while it is hidden they show here. */
  sidebarCollapsed: boolean
  /** The tabs live here when the sidebar has no room for them, and always in the desktop strip. */
  showTabs: boolean
  /**
   * The engine status pill. Only the desktop app shows it: in the browser it was a label the reader
   * could do nothing with, and the engine it names is the one serving this page either way.
   */
  showEngineStatus: boolean
  /** The session's right-hand details panel, when a session is open. */
  contextPanel?: { open: boolean; onToggle: () => void }
  /**
   * The agent-browser panel toggle. Only the desktop app shows it: the live browser view it opens
   * is not operative in the browser build.
   */
  showAgentBrowser: boolean
  /** The preview toggle (BU-06): only where the desktop app hosts one. */
  showPreview?: boolean
  onTogglePanel: (kind: string) => void
  /** The workspace panels open right now, so their buttons can show it. */
  openPanels: string[]
  sessionTitle?: JSX.Element
  sessionActions?: JSX.Element
  /** Set when this device is controlling a remote computer. */
  remote?: { name: string; connected: boolean; onOpen: () => void }
  /** Set when this app is the computer hosting remote control. */
  hostRemote?: { name: string; connected: boolean; onOpen: () => void }
}

/** Chat / Code switch, like Claude's: two icon tabs in one pill. */
export const ViewTabs: Component<{
  view: AppView
  onChange: (view: AppView) => void
  /** A tab whose own sessions are working shows a dot; a quiet one shows nothing. */
  activity?: { chat: boolean; code: boolean }
}> = (props) => (
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
      <Icon name="chat" size={16} />
      <Show when={props.activity?.chat}>
        <span class="fc-view-tab-dot" aria-hidden="true" />
      </Show>
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
      <Icon name="code" size={16} />
      <Show when={props.activity?.code}>
        <span class="fc-view-tab-dot" aria-hidden="true" />
      </Show>
    </button>
  </div>
)

export const Topbar: Component<TopbarProps> = (props) => {
  // A healthy engine the app has lost the stream to is not "Connected": nothing it does reaches
  // this window until the stream is back, so the pill says so instead of looking fine.
  const status = () => {
    if (props.healthLoading) return t("Connecting")
    if (props.healthHealthy) return props.streamState === "reconnecting" ? t("Reconnecting") : t("Connected")
    if (props.healthError) return t("Offline")
    return t("Offline")
  }

  return (
    <header class="fc-topbar">
      <div class="fc-topbar-left">
        <button class="fc-nav-arrow" type="button" title={t("Toggle sidebar")} onClick={props.onToggleSidebar}>
          <Icon name="sidebar" size={16} />
        </button>
        <button class="fc-nav-arrow" type="button" title={t("Back")} disabled={!props.canGoBack} onClick={props.onBack}>
          <Icon name="arrow-left" size={16} />
        </button>
        <button
          class="fc-nav-arrow"
          type="button"
          title={t("Forward")}
          disabled={!props.canGoForward}
          onClick={props.onForward}
        >
          <Icon name="arrow-right" size={16} />
        </button>
        <Show when={props.showTabs}>
          <ViewTabs view={props.view} onChange={props.onViewChange} activity={props.viewActivity} />
        </Show>
        {props.sessionTitle}
      </div>
      <div class="fc-topbar-right">
        {props.sessionActions}
        <Show when={props.codeChrome}>
          <button
            class="fc-nav-arrow"
            classList={{ "fc-nav-arrow-active": props.openPanels.includes("diff") }}
            type="button"
            title={t("Files changed")}
            aria-label={t("Files changed")}
            aria-pressed={props.openPanels.includes("diff")}
            onClick={() => props.onTogglePanel("diff")}
          >
            <Icon name="file" size={16} />
          </button>
          <Show when={props.showAgentBrowser}>
            <button
              class="fc-nav-arrow"
              classList={{ "fc-nav-arrow-active": props.openPanels.includes("agent-browser") }}
              type="button"
              title={t("Agent browser")}
              aria-label={t("Agent browser")}
              aria-pressed={props.openPanels.includes("agent-browser")}
              onClick={() => props.onTogglePanel("agent-browser")}
            >
              <Icon name="eye" size={16} />
            </button>
          </Show>
          <Show when={props.showPreview}>
            <button
              class="fc-nav-arrow"
              classList={{ "fc-nav-arrow-active": props.openPanels.includes("preview") }}
              type="button"
              title={t("Preview")}
              aria-label={t("Preview")}
              aria-pressed={props.openPanels.includes("preview")}
              onClick={() => props.onTogglePanel("preview")}
            >
              <TopIcon d="M3 5h18v14H3zM3 9h18M6 7h.01M9 7h.01" />
            </button>
          </Show>
          <button
            class="fc-nav-arrow"
            classList={{ "fc-nav-arrow-active": props.openPanels.includes("terminal") }}
            type="button"
            title={t("Terminal")}
            aria-label={t("Terminal")}
            aria-pressed={props.openPanels.includes("terminal")}
            onClick={() => props.onTogglePanel("terminal")}
          >
            <Icon name="terminal" size={16} />
          </button>
        </Show>
        <Show when={props.remote ?? props.hostRemote}>
          {(pill) => (
            <button
              class="fc-status fc-status-remote"
              classList={{ "fc-status-on": pill().connected, "fc-status-off": !pill().connected }}
              type="button"
              title={t("Remote: {name}", { name: pill().name })}
              onClick={pill().onOpen}
            >
              {t(pill().connected ? "Connected" : "Disconnected")}
            </button>
          )}
        </Show>
        {/* The remote pill replaces the engine pill: "Connected" there is the local engine, not the
            remote control connection the reader is watching. Without one, the engine status stays a
            flat label: it never opens remote control, which lives in Settings. */}
        {/* An agent waiting on a permission in another session makes no noise; this is the only
            place the reader can notice it without opening every session. */}
        <Show when={props.blockedElsewhere.length > 0}>
          <button
            class="fc-status fc-status-waiting fc-status-blocked"
            type="button"
            title={t("Another session is waiting for permission")}
            onClick={() => props.onOpenBlocked(props.blockedElsewhere[0]!)}
          >
            {t("{count} waiting", { count: props.blockedElsewhere.length })}
          </button>
        </Show>
        <Show when={!props.remote && !props.hostRemote && props.showEngineStatus}>
          <span
            class="fc-status"
            classList={{
              "fc-status-on": props.healthHealthy === true && props.streamState !== "reconnecting",
              "fc-status-waiting": props.healthHealthy === true && props.streamState === "reconnecting",
              "fc-status-off": props.healthError,
            }}
          >
            {status()}
          </span>
        </Show>
        <Show when={props.contextPanel}>
          {(panel) => (
            <button
              class="fc-nav-arrow"
              type="button"
              title={t("Toggle details panel")}
              aria-label={t("Toggle details panel")}
              aria-pressed={panel().open}
              onClick={panel().onToggle}
            >
              <Icon name="context-panel" size={16} />
            </button>
          )}
        </Show>
      </div>
    </header>
  )
}
