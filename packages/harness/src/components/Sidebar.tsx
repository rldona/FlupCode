import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import type { SessionInfo } from "../engine-types"
import { t } from "../i18n"
import { ContextMenu, type MenuItem } from "./ContextMenu"
import { Loader } from "./Loader"
import logo from "../assets/flupcode-logo.png"

type ProjectGroup = {
  id: string
  name: string
  directory?: string
  sessions: SessionInfo[]
}

type SidebarProps = {
  collapsed: boolean
  width: number
  displayName: string
  sessions: SessionInfo[] | undefined
  sessionsLoading: boolean
  selectedSession?: string
  pinnedSessions: string[]
  expandedProjects: Record<string, boolean>
  noFolderSessions: string[]
  onDisplayName: (value: string) => void
  onToggleSessionPin: (id: string) => void
  onToggleProject: (id: string) => void
  onNewSession: (directory?: string) => void
  onSelectSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onRenameSession: (id: string) => void
  onDeleteProject: (directory: string) => void
  onResize: (width: number) => void
  onCollapse: () => void
  onCopyPath: (path: string) => void
  onRefresh: () => void
  onAbout: () => void
  onSettings: () => void
  onRoutines: () => void
  onArtifacts: () => void
  onProviders: () => void
  onConfig: () => void
  onRemote: () => void
  onMcp: () => void
}

export const Sidebar: Component<SidebarProps> = (props) => {
  const [filter, setFilter] = createSignal("")
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] }>()

  const sortedSessions = createMemo(() => {
    const query = filter().trim().toLowerCase()
    const list = (props.sessions ?? []).filter((session) => {
      if (!query) return true
      const directory = session.location?.directory ?? ""
      return `${session.title} ${directory}`.toLowerCase().includes(query)
    })
    return [...list].sort((a, b) => b.time.updated - a.time.updated)
  })

  const groups = createMemo(() => {
    const map = new Map<string, ProjectGroup>()
    for (const session of sortedSessions()) {
      const directory = props.noFolderSessions.includes(session.id) ? undefined : session.location?.directory
      const key = directory ?? "__none__"
      let group = map.get(key)
      if (!group) {
        group = {
          id: key,
          name: directory ? (directory.split("/").filter(Boolean).at(-1) ?? directory) : t("No folder"),
          directory,
          sessions: [],
        }
        map.set(key, group)
      }
      group.sessions.push(session)
    }
    return [...map.values()].sort((a, b) => {
      if (a.directory === undefined) return 1
      if (b.directory === undefined) return -1
      return a.name.localeCompare(b.name)
    })
  })

  const pinned = createMemo(() => sortedSessions().filter((session) => props.pinnedSessions.includes(session.id)))

  const isExpanded = (group: ProjectGroup) => {
    const state = props.expandedProjects[group.id]
    if (state !== undefined) return state
    const selected = props.sessions?.find((session) => session.id === props.selectedSession)
    if (!selected) return false
    const key = props.noFolderSessions.includes(selected.id) ? "__none__" : (selected.location?.directory ?? "__none__")
    return key === group.id
  }

  const openSessionMenu = (event: MouseEvent, session: SessionInfo) => {
    event.preventDefault()
    event.stopPropagation()
    const pinned = props.pinnedSessions.includes(session.id)
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: t("Open"), icon: "↗", onSelect: () => props.onSelectSession(session.id) },
        {
          label: pinned ? t("Unpin") : t("Pin"),
          icon: pinned ? "★" : "☆",
          onSelect: () => props.onToggleSessionPin(session.id),
        },
        { label: t("Rename"), icon: "✎", onSelect: () => props.onRenameSession(session.id) },
        {
          label: t("Copy path"),
          icon: "⧉",
          onSelect: () => props.onCopyPath(session.location?.directory ?? ""),
        },
        { label: t("Delete"), icon: "×", danger: true, onSelect: () => props.onDeleteSession(session.id) },
      ],
    })
  }

  const openProjectMenu = (event: MouseEvent, group: ProjectGroup) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: t("New session"), icon: "＋", onSelect: () => props.onNewSession(group.directory) },
        { label: t("Copy path"), icon: "⧉", onSelect: () => props.onCopyPath(group.directory ?? "") },
        {
          label: t("Delete"),
          icon: "×",
          danger: true,
          onSelect: () => props.onDeleteProject(group.directory ?? ""),
        },
      ],
    })
  }

  const SessionRow: Component<{ session: SessionInfo }> = (row) => (
    <div
      class="fc-session-row"
      classList={{ "fc-session-row-active": props.selectedSession === row.session.id }}
      onContextMenu={(event) => openSessionMenu(event, row.session)}
    >
      <button class="fc-session-main" type="button" onClick={() => props.onSelectSession(row.session.id)}>
        <span class="fc-session-title">{row.session.title || row.session.id.slice(0, 8)}</span>
      </button>
      <button
        class="fc-session-action"
        classList={{ "fc-session-action-on": props.pinnedSessions.includes(row.session.id) }}
        type="button"
        title={t("Pin")}
        aria-label={t("Pin")}
        onClick={() => props.onToggleSessionPin(row.session.id)}
      >
        {props.pinnedSessions.includes(row.session.id) ? "★" : "☆"}
      </button>
      <button
        class="fc-session-action"
        type="button"
        title={t("Delete")}
        aria-label={t("Delete")}
        onClick={() => props.onDeleteSession(row.session.id)}
      >
        ×
      </button>
    </div>
  )

  return (
    <Show when={!props.collapsed}>
      <aside class="fc-sidebar" style={{ width: `${props.width}px` }}>
        <div
          class="fc-sidebar-resizer"
          onPointerDown={(event) => {
            const target = event.currentTarget
            target.setPointerCapture(event.pointerId)
            const move = (moveEvent: PointerEvent) => {
              if (moveEvent.clientX < 160) {
                props.onCollapse()
                target.releasePointerCapture(event.pointerId)
                target.removeEventListener("pointermove", move)
                return
              }
              props.onResize(moveEvent.clientX)
            }
            const up = () => {
              target.removeEventListener("pointermove", move)
              target.removeEventListener("pointerup", up)
            }
            target.addEventListener("pointermove", move)
            target.addEventListener("pointerup", up)
          }}
        />

        <div class="fc-sidebar-top">
          <button class="fc-new" type="button" onClick={() => props.onNewSession()}>
            <span class="fc-new-icon">+</span>
            <span>{t("New")}</span>
          </button>
          <nav class="fc-nav">
            <button class="fc-nav-item" type="button" onClick={props.onArtifacts}>
              <span class="fc-nav-icon">▤</span>
              {t("Artifacts")}
            </button>
            <button class="fc-nav-item" type="button" onClick={props.onRoutines}>
              <span class="fc-nav-icon">↻</span>
              {t("Routines")}
            </button>
            <button class="fc-nav-item" type="button" onClick={props.onSettings}>
              <span class="fc-nav-icon">⚙</span>
              {t("Customize")}
            </button>
          </nav>
        </div>

        <input
          class="fc-filter-input"
          value={filter()}
          placeholder={t("Filter projects")}
          aria-label={t("Filter projects")}
          onInput={(event) => setFilter(event.currentTarget.value)}
        />

        <div class="fc-scroll fc-grow">
          <Show when={pinned().length > 0}>
            <div class="fc-section-label">{t("Pinned")}</div>
            <For each={pinned()}>{(session) => <SessionRow session={session} />}</For>
          </Show>

          <div class="fc-section-header">
            <span class="fc-section-label">{t("Projects")}</span>
            <button class="fc-icon-button" type="button" title={t("Refresh")} onClick={() => props.onRefresh()}>
              ↻
            </button>
          </div>

          <Show
            when={!props.sessionsLoading || groups().length > 0}
            fallback={<Loader class="fc-loader-inline" label={t("Loading sessions")} />}
          >
            <Show
              when={groups().length > 0}
              fallback={
                <div class="fc-empty-state">
                  <span class="fc-empty-title">{t("No sessions")}</span>
                  <span class="fc-empty-hint">{t("Create one with New")}</span>
                </div>
              }
            >
              <For each={groups()}>
                {(group) => (
                  <div class="fc-project-group">
                    <div class="fc-project-row" onContextMenu={(event) => openProjectMenu(event, group)}>
                      <button class="fc-project-toggle" type="button" onClick={() => props.onToggleProject(group.id)}>
                        <span class="fc-chevron">{isExpanded(group) ? "⌄" : "›"}</span>
                        <span class="fc-project-name">{group.name}</span>
                        <span class="fc-project-count">{group.sessions.length}</span>
                      </button>
                      <button
                        class="fc-icon-button"
                        type="button"
                        title={t("New session")}
                        aria-label={t("New session")}
                        onClick={() => props.onNewSession(group.directory)}
                      >
                        +
                      </button>
                    </div>
                    <Show when={isExpanded(group)}>
                      <For each={group.sessions}>{(session) => <SessionRow session={session} />}</For>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>

        <div class="fc-sidebar-footer">
          <button
            class="fc-profile-button"
            type="button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setMenu({
                x: rect.left,
                y: Math.max(8, rect.top - 360),
                items: [
                  { label: t("Settings"), icon: "⚙", shortcut: "⌘,", onSelect: props.onSettings },
                  { label: t("Providers & API keys"), icon: "⚿", onSelect: props.onProviders },
                  { label: t("Language"), icon: "文", onSelect: props.onSettings },
                  { label: t("Artifacts"), icon: "▤", onSelect: props.onArtifacts },
                  { label: t("Routines"), icon: "↻", onSelect: props.onRoutines },
                  { label: t("MCP servers"), icon: "◫", onSelect: props.onMcp },
                  { label: t("Config (advanced)"), icon: "{}", onSelect: props.onConfig },
                  { label: t("Remote access (QR)"), icon: "◉", onSelect: props.onRemote },
                  { label: t("About"), icon: "i", onSelect: props.onAbout },
                ],
              })
            }}
          >
            <span class="fc-avatar">
              <img src={logo} alt="" />
            </span>
            <span class="fc-profile-name">{props.displayName.trim() || t("Local")}</span>
            <span class="fc-chevron">⌄</span>
          </button>
        </div>

        <Show when={menu()}>
          {(m) => <ContextMenu x={m().x} y={m().y} items={m().items} onClose={() => setMenu(undefined)} />}
        </Show>
      </aside>
    </Show>
  )
}
