import { For, Show, createEffect, createMemo, createSignal, on, type Component } from "solid-js"
import { sessionTitle } from "../session-title"
import type { SessionInfo } from "../engine-types"
import { ViewTabs } from "./Topbar"
import { t } from "../i18n"
import { isCoworkSession, type AppView } from "../chat"
import { cssPx } from "../text-size"
import { UNAVAILABLE_FEATURES } from "../features"
import type { Routine } from "../types"
import type { Screen } from "../screen"
import { ContextMenu, type MenuItem } from "./ContextMenu"
import { Loader } from "./Loader"
import logo from "../assets/flupcode-logo.png"

/** The sidebar's width until the reader drags it; double-clicking its edge goes back to it. */
export const SIDEBAR_WIDTH_DEFAULT = 280

/** Sessions with no folder of their own are listed under this bucket, last. */
const NO_FOLDER_GROUP = "__none__"

/**
 * The group a session is listed under: its project folder, or the no-folder bucket. The app keeps a
 * session's group open across selection so opening a row lower down cannot remove the rows above it
 * and jump the list; that effect has to name the same group this file does, or the no-folder group
 * still collapses.
 */
export function sessionGroupKey(session: SessionInfo, noFolderSessions: string[]) {
  if (noFolderSessions.includes(session.id)) return NO_FOLDER_GROUP
  return session.location?.directory ?? NO_FOLDER_GROUP
}

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
  /** Which tabs have sessions working right now, for the dot on their icons. */
  viewActivity: { chat: boolean; code: boolean }
  /**
   * The view tabs, next to the app's name. The desktop app's own window strip already carries them,
   * so showing them here too would put Chat / Code in two places at once; the name still belongs
   * here in every case, same as in the browser.
   */
  showBrand: boolean
  sessions: SessionInfo[] | undefined
  sessionsLoading: boolean
  selectedSession?: string
  /** Sessions the engine is working on right now. */
  runningSessions: string[]
  /** Sessions waiting on a permission nobody has answered; they look idle without this. */
  blockedSessions: string[]
  /** Sessions with a question to answer: a yellow hand instead of the dot (QH-1). */
  questionSessions: string[]
  pinnedSessions: string[]
  /** The tags a reader put on each session, by session id (H-18). */
  sessionTags: Record<string, string[]>
  expandedProjects: Record<string, boolean>
  noFolderSessions: string[]
  /** Whether the server has another page of sessions to load (H-18). */
  hasMoreSessions: boolean
  onDisplayName: (value: string) => void
  onToggleSessionPin: (id: string) => void
  /** Opens the dialog that edits a session's tags, so this only asks for it (H-18). */
  onEditTags: (id: string) => void
  /** Archives a session, or brings it back (H-18). */
  onArchiveSession: (id: string, archived: boolean) => void
  onLoadMoreSessions: () => void
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
  /** The tool screen open in the main column, if any, so the nav marks it (HF-9). */
  activeScreen?: Screen
  onRuns: () => void
  onUsage: () => void
  onContext: () => void
  onAgents: () => void
  onSkills: () => void
  onWorkflows: () => void
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

  // Narrowing the list by tag is the one filter a reader can do here that the palette cannot (H-18).
  const [tagFilter, setTagFilter] = createSignal<string>()
  // Archived sessions are out of the way by default and brought back on request (H-18).
  const [showArchived, setShowArchived] = createSignal(false)
  const tagOf = (id: string) => props.sessionTags[id] ?? []
  const allTags = createMemo(() => [...new Set(Object.values(props.sessionTags).flat())].sort((a, b) => a.localeCompare(b)))
  const archived = (session: SessionInfo) => !!session.time?.archived
  const hasArchived = createMemo(() => sortedSessions().some(archived))
  const visibleSessions = createMemo(() => {
    const only = tagFilter()
    return sortedSessions().filter((session) => {
      if (!showArchived() && archived(session)) return false
      return !only || tagOf(session.id).includes(only)
    })
  })

  /**
   * Keep the reader where they scrolled when the list is rebuilt.
   *
   * The groups are a `<For>` over objects the memo recreates, so a sessions refetch replaces every
   * row. Chromium's default here (scroll anchoring) sometimes clamps the container back to the top
   * when that happens — seen in the desktop app's Chromium, not in the one the tests run on, which is
   * why no `e2e` guards it. Only the reader's own scroll (`isTrusted`) is remembered, so the reset's
   * own scroll event cannot overwrite it, and the position is put back once the new rows are in.
   */
  let scrollEl: HTMLDivElement | undefined
  let readerScrollTop = 0
  createEffect(
    on(
      () => props.sessions,
      () => {
        const top = readerScrollTop
        if (!scrollEl || top === 0) return
        requestAnimationFrame(() => {
          if (scrollEl && scrollEl.scrollTop !== top) scrollEl.scrollTop = top
        })
      },
      { defer: true },
    ),
  )

  const isPinned = (session: SessionInfo) => props.pinnedSessions.includes(session.id)
  // A pinned session is listed under Pinned and nowhere else; leaving it in the chats list and the
  // project groups would render the same row twice.
  const pinned = createMemo(() => visibleSessions().filter(isPinned))
  const unpinned = createMemo(() => visibleSessions().filter((session) => !isPinned(session)))

  const groups = createMemo(() => {
    const map = new Map<string, ProjectGroup>()
    for (const session of unpinned()) {
      const key = sessionGroupKey(session, props.noFolderSessions)
      const directory = key === NO_FOLDER_GROUP ? undefined : key
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

  const isExpanded = (group: ProjectGroup) => {
    const state = props.expandedProjects[group.id]
    if (state !== undefined) return state
    const selected = props.sessions?.find((session) => session.id === props.selectedSession)
    if (!selected) return false
    return sessionGroupKey(selected, props.noFolderSessions) === group.id
  }

  /** Just the point a menu is opened at, so a long press can open one without a MouseEvent. */
  type MenuPoint = { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }

  /**
   * Opens a menu on a long press (H-24). Touch screens have no right-click, and without this the
   * session and project menus were unreachable on a phone.
   */
  const longPress = (open: (point: MenuPoint) => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let fired = false
    const clear = () => {
      clearTimeout(timer)
      timer = undefined
    }
    return {
      onPointerDown: (event: PointerEvent) => {
        if (event.pointerType !== "touch") return
        fired = false
        const { clientX, clientY } = event
        timer = setTimeout(() => {
          fired = true
          open({ clientX, clientY, preventDefault: () => {}, stopPropagation: () => {} })
        }, 500)
      },
      onPointerUp: clear,
      onPointerMove: clear,
      onPointerCancel: clear,
      // The press already opened the menu; the click it ends with must not also select the row.
      onClickCapture: (event: MouseEvent) => {
        if (!fired) return
        fired = false
        event.preventDefault()
        event.stopPropagation()
      },
    }
  }

  const openSessionMenu = (event: MenuPoint, session: SessionInfo) => {
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
        { label: t("Edit tags…"), icon: "🏷", onSelect: () => props.onEditTags(session.id) },
        {
          label: archived(session) ? t("Unarchive") : t("Archive"),
          icon: "▣",
          onSelect: () => props.onArchiveSession(session.id, !archived(session)),
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

  const openProjectMenu = (event: MenuPoint, group: ProjectGroup) => {
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
      {...longPress((point) => openSessionMenu(point, row.session))}
    >
      <button class="fc-session-main" type="button" onClick={() => props.onSelectSession(row.session.id)}>
        {/* A question beats every dot: it is the one stuck state the reader can clear (QH-1). */}
        <Show
          when={props.questionSessions.includes(row.session.id)}
          fallback={
            <span
              class="fc-session-dot"
              classList={{
                "fc-session-dot-running": props.runningSessions.includes(row.session.id),
                "fc-session-dot-blocked": props.blockedSessions.includes(row.session.id),
              }}
              title={props.blockedSessions.includes(row.session.id) ? t("Waiting for permission") : undefined}
              aria-hidden="true"
            />
          }
        >
          <span class="fc-session-hand" role="img" aria-label={t("Waiting for answer")} title={t("Waiting for answer")}>
            ✋
          </span>
        </Show>
        <span class="fc-session-title">{sessionTitle(row.session) || t("New session")}</span>
        <Show when={isCoworkSession(row.session)}>
          <span class="fc-cowork-badge">{t("Cowork")}</span>
        </Show>
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
      <Show when={tagOf(row.session.id).length > 0}>
        <span class="fc-session-tags">
          <For each={tagOf(row.session.id)}>
            {(tag) => (
              <button
                class="fc-session-tag"
                classList={{ "fc-session-tag-active": tagFilter() === tag }}
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setTagFilter(tagFilter() === tag ? undefined : tag)
                }}
              >
                {tag}
              </button>
            )}
          </For>
        </span>
      </Show>
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
          <div class="fc-sidebar-brand">
            <span class="fc-sidebar-brand-name">FlupCode</span>
            <Show when={props.showBrand}>
              <ViewTabs view={props.view} onChange={props.onViewChange} activity={props.viewActivity} />
            </Show>
          </div>
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

        <div
          class="fc-scroll fc-grow"
          ref={scrollEl}
          onScroll={(event) => {
            if (event.isTrusted) readerScrollTop = event.currentTarget.scrollTop
          }}
        >
          {/* The nav scrolls with the lists under it; "+ New" is the one thing that stays put. */}
          <nav class="fc-nav">
            <Show when={props.view === "code"}>
              {/* Live first: runs are what the harness is doing now, workflows launch them,
                  artifacts are what they leave, routines run on their own. */}
              <button
                class="fc-nav-item"
                classList={{ "fc-nav-item-active": props.activeScreen === "runs" }}
                type="button"
                onClick={props.onRuns}
              >
                <span class="fc-nav-icon">⛭</span>
                {t("Runs")}
              </button>
              <button
                class="fc-nav-item"
                classList={{ "fc-nav-item-active": props.activeScreen === "workflows" }}
                type="button"
                onClick={props.onWorkflows}
              >
                <span class="fc-nav-icon">⛓</span>
                {t("Workflows")}
              </button>
              <button
                class="fc-nav-item"
                classList={{ "fc-nav-item-active": props.activeScreen === "artifacts" }}
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
              <button
                class="fc-nav-item"
                classList={{ "fc-nav-item-active": props.activeScreen === "routines" }}
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

          {/* Tags a reader has used, as a filter (H-18). Only shown once there are any. */}
          <Show when={allTags().length > 0}>
            <div class="fc-tag-filter">
              <button
                class="fc-session-tag"
                classList={{ "fc-session-tag-active": !tagFilter() }}
                type="button"
                onClick={() => setTagFilter(undefined)}
              >
                {t("All")}
              </button>
              <For each={allTags()}>
                {(tag) => (
                  <button
                    class="fc-session-tag"
                    classList={{ "fc-session-tag-active": tagFilter() === tag }}
                    type="button"
                    onClick={() => setTagFilter(tagFilter() === tag ? undefined : tag)}
                  >
                    {tag}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={pinned().length > 0}>
            <section class="fc-sidebar-section">
              <div class="fc-section-header">
                <span class="fc-section-label">{t("Pinned")}</span>
              </div>
              <For each={pinned()}>{(session) => <SessionRow session={session} />}</For>
            </section>
          </Show>

          <Show when={props.view === "chat" && (unpinned().length > 0 || pinned().length === 0)}>
            <section class="fc-sidebar-section">
            <div class="fc-section-header">
              <span class="fc-section-label">{t("Chats")}</span>
            </div>
            <Show
              when={!props.sessionsLoading || unpinned().length > 0}
              fallback={<Loader class="fc-loader-inline" label={t("Loading chats")} />}
            >
              <Show
                when={unpinned().length > 0}
                fallback={
                  <div class="fc-empty-state">
                    <span class="fc-empty-title">{t("No chats yet")}</span>
                    <span class="fc-empty-hint">{t("Start one with New")}</span>
                  </div>
                }
              >
                <For each={unpinned()}>{(session) => <SessionRow session={session} />}</For>
              </Show>
            </Show>
            </section>
          </Show>

          <Show when={props.view === "code"}>
            <section class="fc-sidebar-section">
            <div class="fc-section-header">
              <span class="fc-section-label">{t("Projects")}</span>
              {/* Only offered once something is archived: a toggle that always finds nothing is furniture. */}
              <Show when={hasArchived()}>
                <button
                  class="fc-icon-button"
                  classList={{ "fc-icon-button-active": showArchived() }}
                  type="button"
                  title={showArchived() ? t("Hide archived") : t("Show archived")}
                  aria-label={showArchived() ? t("Hide archived") : t("Show archived")}
                  aria-pressed={showArchived()}
                  onClick={() => setShowArchived((value) => !value)}
                >
                  ▣
                </button>
              </Show>
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
                  <Show when={pinned().length === 0}>
                    <div class="fc-empty-state">
                      <span class="fc-empty-title">{t("No sessions")}</span>
                      <span class="fc-empty-hint">{t("Create one with New")}</span>
                    </div>
                  </Show>
                }
              >
                <For each={groups()}>
                  {(group) => (
                    <div class="fc-project-group">
                      <div
                        class="fc-project-row"
                        onContextMenu={(event) => openProjectMenu(event, group)}
                        {...longPress((point) => openProjectMenu(point, group))}
                      >
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

          {/* The engine has more sessions than the page asked for (H-18). */}
          <Show when={props.hasMoreSessions}>
            <button class="fc-load-more" type="button" onClick={props.onLoadMoreSessions}>
              {t("Load more")}
            </button>
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
                  { label: t("Context"), icon: "◫", onSelect: props.onContext },
                  { label: t("Agents"), icon: "◍", onSelect: props.onAgents },
                  { label: t("Skills"), icon: "✦", onSelect: props.onSkills },
                  { label: t("Cost"), icon: "▦", onSelect: props.onUsage },
                  { label: t("Remote control"), icon: "◉", onSelect: props.onRemote },
                  { label: t("About FlupCode"), icon: "i", onSelect: props.onAbout },
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
