import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { sessionTitle } from "../session-title"
import type { SessionInfo } from "../engine-types"
import { ViewTabs } from "./Topbar"
import { t } from "../i18n"
import type { AppView } from "../chat"
import { cssPx } from "../text-size"
import { UNAVAILABLE_FEATURES } from "../features"
import type { Routine } from "../types"
import { ContextMenu, type MenuItem } from "./ContextMenu"
import { Loader } from "./Loader"
import logo from "../assets/flupcode-logo.png"

/** The sidebar's width until the reader drags it; double-clicking its edge goes back to it. */
export const SIDEBAR_WIDTH_DEFAULT = 280

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
  /** Chat lists conversations flat; Code groups sessions by project. */
  view: AppView
  onViewChange: (view: AppView) => void
  /**
   * The name and the view tabs. The desktop app has neither here: its window strip runs the width of
   * the window and carries the tabs, and the name is the window's own.
   */
  showBrand: boolean
  sessions: SessionInfo[] | undefined
  sessionsLoading: boolean
  selectedSession?: string
  /** Sessions the engine is working on right now. */
  runningSessions: string[]
  /** Sessions waiting on a permission nobody has answered; they look idle without this. */
  blockedSessions: string[]
  pinnedSessions: string[]
  expandedProjects: Record<string, boolean>
  noFolderSessions: string[]
  onDisplayName: (value: string) => void
  onToggleSessionPin: (id: string) => void
  onToggleProject: (id: string) => void
  onNewSession: (directory?: string) => void
  onSelectSession: (id: string) => void
  /** Opens the session next to the open one (split view). */
  onSplitSession: (id: string) => void
  /** Sessions shown side by side right now, empty when not split. */
  splitSessions: string[]
  onDeleteSession: (id: string) => void
  onRenameSession: (id: string) => void
  onDeleteProject: (directory: string) => void
  onResize: (width: number) => void
  onCollapse: () => void
  onCopyPath: (path: string) => void
  onRefresh: () => void
  onAbout: () => void
  onSettings: () => void
  onRoutines: (focus?: string) => void
  /** The routines there are, for the section at the top. Empty means no section at all. */
  routines: Routine[]
  onSearch: () => void
  onRuns: () => void
  onUsage: () => void
  onContext: () => void
  onAgents: () => void
  onSkills: () => void
  onArtifacts: () => void
  onProviders: () => void
  onConfig: () => void
  onRemote: () => void
  onMcp: () => void
}

export const Sidebar: Component<SidebarProps> = (props) => {
  const [menu, setMenu] = createSignal<{
    x: number
    y: number
    placement?: "below" | "above"
    width?: number
    items: MenuItem[]
  }>()

  // Everything, newest first. Narrowing the list from a box in the sidebar is gone: searching is a
  // modal now, and it reaches artifacts, routines and runs too, which a box over this list cannot.
  const sortedSessions = createMemo(() =>
    [...(props.sessions ?? [])].sort((a, b) => b.time.updated - a.time.updated),
  )

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
        ...(session.id === props.selectedSession || props.splitSessions.includes(session.id)
          ? []
          : [{ label: t("Split view"), icon: "◫", onSelect: () => props.onSplitSession(session.id) }]),
        {
          label: pinned ? t("Unpin") : t("Pin"),
          icon: pinned ? "★" : "☆",
          onSelect: () => props.onToggleSessionPin(session.id),
        },
        { label: t("Rename"), icon: "✎", onSelect: () => props.onRenameSession(session.id) },
        ...(props.view === "code"
          ? [
              {
                label: t("Copy path"),
                icon: "⧉",
                onSelect: () => props.onCopyPath(session.location?.directory ?? ""),
              },
            ]
          : []),
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
      classList={{
        "fc-session-row-active": props.selectedSession === row.session.id,
        "fc-session-row-split":
          props.selectedSession !== row.session.id && props.splitSessions.includes(row.session.id),
      }}
      onContextMenu={(event) => openSessionMenu(event, row.session)}
    >
      <button class="fc-session-main" type="button" onClick={() => props.onSelectSession(row.session.id)}>
        <span
          class="fc-session-dot"
          classList={{
            "fc-session-dot-running": props.runningSessions.includes(row.session.id),
            "fc-session-dot-blocked": props.blockedSessions.includes(row.session.id),
          }}
          title={props.blockedSessions.includes(row.session.id) ? t("Waiting for permission") : undefined}
          aria-hidden="true"
        />
        <span class="fc-session-title">{sessionTitle(row.session) || t("New session")}</span>
      </button>
      <button
        class="fc-session-action"
        type="button"
        title={t("Session options")}
        aria-label={t("Session options")}
        onClick={(event) => openSessionMenu(event, row.session)}
      >
        ⋮
      </button>
    </div>
  )

  return (
    <Show when={!props.collapsed}>
      <aside
        class="fc-sidebar"
        classList={{ "fc-sidebar-collapsed": props.collapsed }}
        style={{ "--fc-sidebar-width": `${props.width}px` }}
      >
        <div
          class="fc-sidebar-resizer"
          title={t("Drag to resize, double-click to reset")}
          onDblClick={() => props.onResize(SIDEBAR_WIDTH_DEFAULT)}
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
              props.onResize(cssPx(moveEvent.clientX))
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
          <Show when={props.showBrand}>
            <div class="fc-sidebar-brand">
              <span class="fc-sidebar-brand-name">FlupCode</span>
              <ViewTabs view={props.view} onChange={props.onViewChange} />
            </div>
          </Show>
          <div class="fc-sidebar-new">
            <button class="fc-new" type="button" onClick={() => props.onNewSession()}>
              <span class="fc-new-icon">+</span>
              <span>{t("New")}</span>
            </button>
            {/* The old box only narrowed this list. Search reaches what is not in it. */}
            <button
              class="fc-icon-button fc-sidebar-search"
              type="button"
              title={`${t("Search")} ⌘K`}
              aria-label={t("Search")}
              onClick={props.onSearch}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2" />
                <path d="m16 16 4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div class="fc-scroll fc-grow">
          {/* The nav scrolls with the lists under it; "+ New" is the one thing that stays put. */}
          <nav class="fc-nav">
            <Show when={props.view === "code"}>
              <button
                class="fc-nav-item"
                type="button"
                disabled={UNAVAILABLE_FEATURES.has("artifacts")}
                title={UNAVAILABLE_FEATURES.has("artifacts") ? t("Coming soon") : undefined}
                onClick={props.onArtifacts}
              >
                <span class="fc-nav-icon">▤</span>
                {t("Artifacts")}
                <Show when={UNAVAILABLE_FEATURES.has("artifacts")}>
                  <span class="fc-nav-soon">{t("Soon")}</span>
                </Show>
              </button>
              <button class="fc-nav-item" type="button" onClick={props.onRuns}>
                <span class="fc-nav-icon">⛭</span>
                {t("Runs")}
              </button>
              <button class="fc-nav-item" type="button" onClick={props.onUsage}>
                <span class="fc-nav-icon">▦</span>
                {t("Cost")}
              </button>
              <button class="fc-nav-item" type="button" onClick={props.onContext}>
                <span class="fc-nav-icon">◫</span>
                {t("Context")}
              </button>
              <button class="fc-nav-item" type="button" onClick={props.onAgents}>
                <span class="fc-nav-icon">◍</span>
                {t("Agents")}
              </button>
              <button class="fc-nav-item" type="button" onClick={props.onSkills}>
                <span class="fc-nav-icon">✦</span>
                {t("Skills")}
              </button>
              <button
                class="fc-nav-item"
                type="button"
                disabled={UNAVAILABLE_FEATURES.has("routines")}
                title={UNAVAILABLE_FEATURES.has("routines") ? t("Coming soon") : undefined}
                onClick={() => props.onRoutines()}
              >
                <span class="fc-nav-icon">↻</span>
                {t("Routines")}
                <Show when={UNAVAILABLE_FEATURES.has("routines")}>
                  <span class="fc-nav-soon">{t("Soon")}</span>
                </Show>
              </button>
            </Show>
            <button class="fc-nav-item" type="button" onClick={props.onSettings}>
              <span class="fc-nav-icon">⚙</span>
              {t("Customize")}
            </button>
          </nav>
          {/*
            Routines first, and only when there are any (§ the reader's own layout): they run
            whether or not this window is open, so what they are doing is the one thing on this list
            that is not waiting for you to click it.
          */}
          <Show when={props.view === "code" && props.routines.length > 0}>
            <section class="fc-sidebar-section">
              <div class="fc-section-header">
                <span class="fc-section-label">{t("Routines")}</span>
              </div>
              <For each={props.routines}>
                {(routine) => (
                  <button
                    class="fc-sidebar-routine"
                    type="button"
                    title={routine.description || routine.prompt}
                    onClick={() => props.onRoutines(routine.id)}
                  >
                    <span class="fc-sidebar-routine-dot" classList={{ "fc-sidebar-routine-off": !routine.enabled }} />
                    <span class="fc-sidebar-routine-name">{routine.name}</span>
                  </button>
                )}
              </For>
            </section>
          </Show>

          <Show when={pinned().length > 0}>
            <section class="fc-sidebar-section">
              <div class="fc-section-header">
                <span class="fc-section-label">{t("Pinned")}</span>
              </div>
              <For each={pinned()}>{(session) => <SessionRow session={session} />}</For>
            </section>
          </Show>

          <Show when={props.view === "chat"}>
            <section class="fc-sidebar-section">
            <div class="fc-section-header">
              <span class="fc-section-label">{t("Chats")}</span>
            </div>
            <Show
              when={!props.sessionsLoading || sortedSessions().length > 0}
              fallback={<Loader class="fc-loader-inline" label={t("Loading chats")} />}
            >
              <Show
                when={sortedSessions().length > 0}
                fallback={
                  <div class="fc-empty-state">
                    <span class="fc-empty-title">{t("No chats yet")}</span>
                    <span class="fc-empty-hint">{t("Start one with New")}</span>
                  </div>
                }
              >
                <For each={sortedSessions()}>{(session) => <SessionRow session={session} />}</For>
              </Show>
            </Show>
            </section>
          </Show>

          <Show when={props.view === "code"}>
            <section class="fc-sidebar-section">
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
                          <span class="fc-project-name">{group.name}</span>
                        </button>
                        <button
                          class="fc-icon-button fc-project-new"
                          type="button"
                          title={t("New session")}
                          aria-label={t("New session")}
                          onClick={() => props.onNewSession(group.directory)}
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                            <path
                              d="M12 5v14M5 12h14"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2.4"
                              stroke-linecap="round"
                            />
                          </svg>
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
            </section>
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
                y: rect.top - 6,
                placement: "above",
                width: rect.width,
                items: [
                  { label: t("Settings"), icon: "⚙", shortcut: "⌘,", onSelect: props.onSettings },
                  { label: t("Providers & API keys"), icon: "⚿", onSelect: props.onProviders },
                  { label: t("Language"), icon: "文", onSelect: props.onSettings },
                  {
                    label: t("Artifacts"),
                    icon: "▤",
                    disabled: UNAVAILABLE_FEATURES.has("artifacts"),
                    onSelect: props.onArtifacts,
                  },
                  {
                    label: t("Routines"),
                    icon: "↻",
                    disabled: UNAVAILABLE_FEATURES.has("routines"),
                    onSelect: () => props.onRoutines(),
                  },
                  { label: t("MCP servers"), icon: "◫", onSelect: props.onMcp },
                  { label: t("Config (advanced)"), icon: "{}", onSelect: props.onConfig },
                  { label: t("Remote control"), icon: "◉", onSelect: props.onRemote },
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
          {(m) => (
            <ContextMenu
              x={m().x}
              y={m().y}
              placement={m().placement}
              width={m().width}
              items={m().items}
              onClose={() => setMenu(undefined)}
            />
          )}
        </Show>
      </aside>
    </Show>
  )
}
