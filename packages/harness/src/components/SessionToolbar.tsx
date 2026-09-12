import { For, Show, createSignal, type Component } from "solid-js"
import type { SessionInfo } from "../engine-types"
import type { ProjectItem } from "../types"
import { t } from "../i18n"
import { ContextMenu, type MenuItem } from "./ContextMenu"

type SessionToolbarProps = {
  session: SessionInfo
  projects: ProjectItem[]
  busy: boolean
  reverting: boolean
  tags: string[]
  onFork: () => void
  onCompact: () => void
  onRename: () => void
  onExport: () => void
  onMove: (directory: string) => void
  onDelete: () => void
  onUndo: () => void
  onRedo: () => void
  onCommitRevert: () => void
  onAddTag: (tag: string) => void
  onRemoveTag: (tag: string) => void
}

export const SessionToolbar: Component<SessionToolbarProps> = (props) => {
  const [tag, setTag] = createSignal("")
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] }>()

  const addTag = () => {
    const value = tag().trim()
    if (!value) return
    props.onAddTag(value)
    setTag("")
  }

  const items = (): MenuItem[] => [
    { label: t("Fork"), icon: "⑂", onSelect: props.onFork },
    { label: t("Compact"), icon: "⇲", onSelect: props.onCompact },
    { label: t("Undo"), icon: "↶", onSelect: props.onUndo },
    { label: t("Redo"), icon: "↷", onSelect: props.onRedo },
    ...(props.reverting
      ? [{ label: t("Confirm revert"), icon: "✓", onSelect: props.onCommitRevert }]
      : []),
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
    <div class="fc-session-toolbar">
      <div class="fc-session-toolbar-title">{props.session.title || t("Session without title")}</div>
      <button
        class="fc-icon-button"
        type="button"
        title={t("Menu")}
        aria-label={t("Menu")}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMenu({ x: Math.max(8, rect.right - 220), y: rect.bottom + 4, items: items() })
        }}
      >
        ⋯
      </button>
      <div class="fc-session-tags">
        <For each={props.tags}>
          {(value) => (
            <span class="fc-tag">
              {value}
              <button
                class="fc-tag-remove"
                type="button"
                aria-label={`${t("Remove")} ${value}`}
                onClick={() => props.onRemoveTag(value)}
              >
                ×
              </button>
            </span>
          )}
        </For>
        <input
          class="fc-tag-input"
          placeholder={t("Add tag")}
          value={tag()}
          onInput={(event) => setTag(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              addTag()
            }
          }}
        />
      </div>
      <Show when={menu()}>
        {(m) => <ContextMenu x={m().x} y={m().y} items={m().items} onClose={() => setMenu(undefined)} />}
      </Show>
    </div>
  )
}
