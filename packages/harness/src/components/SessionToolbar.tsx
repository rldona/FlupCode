import { Show, createSignal, type Component } from "solid-js"
import type { SessionInfo } from "../engine-types"
import type { ProjectItem } from "../types"
import { t } from "../i18n"
import { isCoworkSession } from "../chat"
import { sessionTitle } from "../session-title"
import { ContextMenu, type MenuItem } from "./ContextMenu"

type SessionTitleProps = {
  session: SessionInfo
  /** Ancestors and this session, oldest first, so a child shows where it came from (H-18). */
  lineage?: SessionInfo[]
  onOpenLineage?: (id: string) => void
}

/**
 * The session's name in the top bar, or, for a child session, where it came from (H-18).
 *
 * A subagent session is a child of the one that spawned it (`parentID`), and once you are in it the
 * only way back used to be the sidebar. A child therefore draws a tab instead of a bare title: a
 * back arrow, then `project · parent session · agent`, so the reader can see which session and which
 * subagent they are in and step back to the parent with one click.
 */
export const SessionTitle: Component<SessionTitleProps> = (props) => {
  const parent = () => {
    const chain = props.lineage ?? []
    return chain.length > 1 ? chain[chain.length - 2] : undefined
  }
  const parentTitle = () => sessionTitle(parent()) || t("Session without title")
  const parentID = () => props.session.parentID
  const openParent = () => {
    const id = parentID()
    if (id) props.onOpenLineage?.(id)
  }
  return (
    <Show
      when={parentID()}
      fallback={
        <div class="fc-session-heading">
          <span class="fc-session-heading-title" title={sessionTitle(props.session)}>
            {sessionTitle(props.session) || t("Session without title")}
          </span>
          <Show when={isCoworkSession(props.session)}>
            <span class="fc-cowork-badge">{t("Cowork")}</span>
          </Show>
        </div>
      }
    >
      <div class="fc-session-heading fc-session-subagent">
        <nav class="fc-session-lineage" aria-label={t("Lineage")}>
          <button class="fc-session-lineage-link" type="button" onClick={openParent}>
            {parentTitle()}
          </button>
          <Show when={props.session.agent}>
            {(agent) => (
              <>
                <span class="fc-session-subagent-arrow" aria-hidden="true">
                  →
                </span>
                <span class="fc-session-subagent-part">{agent()}</span>
              </>
            )}
          </Show>
        </nav>
      </div>
    </Show>
  )
}

type SessionActionsProps = {
  session: SessionInfo
  projects: ProjectItem[]
  reverting: boolean
  onFork: () => void
  onCompact: () => void
  onRename: () => void
  onExport: () => void
  onMove: (directory: string) => void
  onDelete: () => void
  onUndo: () => void
  onRedo: () => void
  onCommitRevert: () => void
}

export const SessionActions: Component<SessionActionsProps> = (props) => {
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] }>()

  const items = (): MenuItem[] => [
    { label: t("Fork"), icon: "⑂", onSelect: props.onFork },
    { label: t("Compact"), icon: "⇲", onSelect: props.onCompact },
    { label: t("Undo"), icon: "↶", onSelect: props.onUndo },
    { label: t("Redo"), icon: "↷", onSelect: props.onRedo },
    ...(props.reverting ? [{ label: t("Confirm revert"), icon: "✓", onSelect: props.onCommitRevert }] : []),
    { label: t("Rename"), icon: "✎", onSelect: props.onRename },
    { label: t("Export MD"), icon: "↓", onSelect: props.onExport },
    ...props.projects.map((project) => ({
      label: `${t("Move to…")} ${project.name}`,
      icon: "→",
      onSelect: () => props.onMove(project.directory),
    })),
    { label: t("Delete"), icon: "×", danger: true, onSelect: props.onDelete },
  ]

  return (
    <>
      <button
        class="fc-nav-arrow"
        type="button"
        title={t("Menu")}
        aria-label={t("Menu")}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMenu({ x: Math.max(8, rect.right - 220), y: rect.bottom + 4, items: items() })
        }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            d="M5 12h.01M12 12h.01M19 12h.01"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <Show when={menu()}>
        {(m) => <ContextMenu x={m().x} y={m().y} items={m().items} onClose={() => setMenu(undefined)} />}
      </Show>
    </>
  )
}
