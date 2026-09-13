import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js"
import type { ProjectItem } from "../types"
import { t } from "../i18n"

type FolderMenuProps = {
  value: string | undefined
  projects: ProjectItem[]
  onSelect: (directory: string | undefined) => void
  onOpenFolder: () => void
}

const label = (project: ProjectItem) =>
  project.name || project.directory.split("/").filter(Boolean).at(-1) || project.directory

export const FolderMenu: Component<FolderMenuProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  let root: HTMLDivElement | undefined

  onMount(() => {
    const onDocClick = (event: MouseEvent) => {
      if (root && !root.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    onCleanup(() => document.removeEventListener("mousedown", onDocClick))
  })

  const current = () => (props.value ? (props.value.split("/").filter(Boolean).at(-1) ?? props.value) : t("No folder"))
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase()
    if (!needle) return props.projects
    return props.projects.filter((project) => `${label(project)} ${project.directory}`.toLowerCase().includes(needle))
  })

  const select = (directory: string | undefined) => {
    props.onSelect(directory)
    setOpen(false)
    setQuery("")
  }

  return (
    <div class="fc-folder" ref={root}>
      <button class="fc-folder-button" type="button" onClick={() => setOpen((value) => !value)} title={props.value}>
        <span class="fc-folder-button-label">{current()}</span>
        <span class="fc-mode-caret">▾</span>
      </button>
      <Show when={open()}>
        <div class="fc-folder-popover">
          <input
            class="fc-filter-input"
            value={query()}
            autofocus
            placeholder={t("Filter projects")}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <button class="fc-folder-item" type="button" onClick={() => select(undefined)}>
            <span>{t("No folder")}</span>
            <Show when={!props.value}>
              <span class="fc-mode-check">✓</span>
            </Show>
          </button>
          <For each={filtered()}>
            {(project) => (
              <button class="fc-folder-item" type="button" onClick={() => select(project.directory)}>
                <span class="fc-folder-item-label">{label(project)}</span>
                <Show when={props.value === project.directory}>
                  <span class="fc-mode-check">✓</span>
                </Show>
              </button>
            )}
          </For>
          <button class="fc-folder-item fc-folder-open" type="button" onClick={() => { setOpen(false); props.onOpenFolder() }}>
            {t("Open folder…")}
          </button>
        </div>
      </Show>
    </div>
  )
}
