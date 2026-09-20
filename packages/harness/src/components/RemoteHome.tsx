import { For, Index, Show, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import { t } from "../i18n"
import { remote } from "../remote"
import { RemoteNotifications } from "./RemoteNotifications"
import type { ProjectItem } from "../types"

/** Phone home screen while controlling a computer: devices, sessions and a new-session action. */

export type RemoteSessionState = "busy" | "waiting" | "idle"

export type RemoteSessionItem = {
  id: string
  title: string
  project?: string
  branch?: string
  updated: number
  state: RemoteSessionState
}

type RemoteHomeProps = {
  sessions: RemoteSessionItem[]
  loading: boolean
  projects: ProjectItem[]
  onOpen: (sessionID: string) => void
  onNew: (directory: string | undefined) => void
  onAddDevice: () => void
}

function ago(timestamp: number, now: number) {
  const minutes = Math.floor((now - timestamp) / 60_000)
  if (minutes < 1) return t("now")
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

const STATE_LABEL: Record<RemoteSessionState, string> = {
  busy: "Working",
  waiting: "Needs your input",
  idle: "Idle",
}

export const RemoteHome: Component<RemoteHomeProps> = (props) => {
  const [filter, setFilter] = createSignal<"all" | "active">("all")
  const [picking, setPicking] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(timer))

  // Index keeps each card's element while its data refreshes, so taps are not lost to re-renders.
  const visible = createMemo(() => props.sessions.filter((session) => filter() === "all" || session.state !== "idle"))

  const hostState = (hostId: string) => {
    if (remote.activeHost()?.hostId !== hostId) return "idle"
    if (remote.status() === "connected") return "online"
    if (remote.status() === "error") return "error"
    return "connecting"
  }

  const newSession = (directory: string | undefined) => {
    setPicking(false)
    props.onNew(directory)
  }

  return (
    <div class="fc-remote-home">
      <h1 class="fc-remote-home-title">{t("Code")}</h1>

      <section class="fc-remote-home-section">
        <h2 class="fc-remote-home-heading">{t("Devices")}</h2>
        <For each={remote.hosts()}>
          {(host) => (
            <button
              class="fc-remote-card fc-remote-device"
              classList={{ "fc-remote-card-active": remote.activeHost()?.hostId === host.hostId }}
              type="button"
              onClick={() => {
                if (remote.activeHost()?.hostId !== host.hostId) remote.connect(host.hostId)
              }}
            >
              <span class={`fc-remote-dot fc-remote-dot-${hostState(host.hostId)}`} aria-hidden="true" />
              <span class="fc-remote-card-main">
                <span class="fc-remote-card-title">{host.name}</span>
                <span class="fc-remote-card-meta">
                  {hostState(host.hostId) === "online"
                    ? t("Connected")
                    : hostState(host.hostId) === "idle"
                      ? t("Tap to connect")
                      : hostState(host.hostId) === "error"
                        ? t("Error")
                        : t("Connecting")}
                </span>
              </span>
            </button>
          )}
        </For>
        <button class="fc-remote-pill" type="button" onClick={props.onAddDevice}>
          <span aria-hidden="true">+</span> {t("Add device")}
        </button>
        <RemoteNotifications />
      </section>

      <section class="fc-remote-home-section">
        <div class="fc-remote-home-row">
          <h2 class="fc-remote-home-heading">{t("Sessions")}</h2>
          <select
            class="fc-remote-filter"
            aria-label={t("Filter sessions")}
            value={filter()}
            onChange={(event) => setFilter(event.currentTarget.value === "active" ? "active" : "all")}
          >
            <option value="all">{t("All")}</option>
            <option value="active">{t("Active sessions")}</option>
          </select>
        </div>

        <Show when={!props.loading || props.sessions.length > 0} fallback={<div class="fc-remote-card fc-skeleton" />}>
          <Show
            when={visible().length > 0}
            fallback={
              <p class="fc-remote-empty">{filter() === "active" ? t("No active sessions") : t("No sessions")}</p>
            }
          >
            <Index each={visible()}>
              {(session) => (
                <button class="fc-remote-card" type="button" onClick={() => props.onOpen(session().id)}>
                  <span
                    class={`fc-remote-dot fc-remote-dot-${session().state}`}
                    role="img"
                    aria-label={t(STATE_LABEL[session().state])}
                  />
                  <span class="fc-remote-card-main">
                    <span class="fc-remote-card-title">{session().title || t("New session")}</span>
                    <Show when={session().project}>
                      <span class="fc-remote-card-meta">
                        {session().project}
                        <Show when={session().branch}>{(branch) => <> · {branch()}</>}</Show>
                      </span>
                    </Show>
                  </span>
                  <span class="fc-remote-card-time">{ago(session().updated, now())}</span>
                </button>
              )}
            </Index>
          </Show>
        </Show>
      </section>

      <button class="fc-remote-fab" type="button" onClick={() => setPicking(true)}>
        <span aria-hidden="true">+</span> {t("New session")}
      </button>

      <Show when={picking()}>
        <div class="fc-remote-sheet-backdrop" onClick={() => setPicking(false)}>
          <div
            class="fc-remote-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={t("New session")}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 class="fc-remote-home-heading">{t("Choose a project")}</h2>
            <For each={props.projects}>
              {(project) => (
                <button class="fc-remote-card" type="button" onClick={() => newSession(project.directory)}>
                  <span class="fc-remote-card-main">
                    <span class="fc-remote-card-title">{project.name}</span>
                    <span class="fc-remote-card-meta">{project.directory}</span>
                  </span>
                </button>
              )}
            </For>
            <button class="fc-remote-card" type="button" onClick={() => newSession(undefined)}>
              <span class="fc-remote-card-main">
                <span class="fc-remote-card-title">{t("No folder")}</span>
              </span>
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}
