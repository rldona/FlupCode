import { Show, createSignal, type Component } from "solid-js"
import type { SessionInfo } from "../engine-types"
import type { ProjectItem } from "../types"
import { t } from "../i18n"
import { ContextMenu, type MenuItem } from "./ContextMenu"

type SessionTitleProps = {
  session: SessionInfo
}

export const SessionTitle: Component<SessionTitleProps> = (props) => (
  <div class="fc-session-heading">
    <span class="fc-session-heading-title" title={props.session.title}>
      {props.session.title || t("Session without title")}
    </span>
  </div>
)

type SessionActionsProps = {
  session: SessionInfo
  projects: ProjectItem[]
  reverting: boolean
  onFork: () => void
  onCompact: () => void
  onRename: () => void
  onExport: () => void
  onShare: () => void
  onUnshare: () => void
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
    { label: t("Share"), icon: "↗", onSelect: props.onShare },
    { label: t("Stop sharing"), icon: "⌀", onSelect: props.onUnshare },
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
