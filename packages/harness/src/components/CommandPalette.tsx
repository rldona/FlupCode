import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import type { FileSystemEntry, SessionInfo } from "../engine-types"
import type { Artifact, CommandOption, ProjectItem, Routine, Run, Workflow } from "../types"
import { t } from "../i18n"
import { sessionTitle } from "../session-title"
import { isCoworkSession } from "../chat"

/** What can be found. The order is the order of the tabs. */
export const KINDS = ["session", "project", "artifact", "routine", "run", "workflow", "command", "file"] as const
export type Kind = (typeof KINDS)[number]

export type PaletteItem = {
  kind: Kind
  id: string
  label: string
  detail?: string
  disabled?: boolean
  /** A Cowork conversation, marked so a project-backed chat is not read as a plain one. */
  cowork?: boolean
  /** What the handler for this kind is given: a name, an id or a path. */
  value: string
}

const LABELS: Record<Kind, string> = {
  session: "Sessions",
  project: "Projects",
  artifact: "Artifacts",
  routine: "Routines",
  run: "Runs",
  workflow: "Workflows",
  command: "Commands",
  file: "Files",
}

const BADGES: Record<Kind, string> = {
  session: "S",
  project: "P",
  artifact: "A",
  routine: "R",
  run: "▸",
  workflow: "W",
  command: "/",
  file: "@",
}

/** How many of each kind are worth showing at once when everything is on screen together. */
const LIMIT = 6

const contains = (haystack: string, query: string) => haystack.toLowerCase().includes(query)

/**
 * Everything the query matches, grouped by kind.
 *
 * Exported for its own test: this is the part that decides what a search finds, and it is the part
 * that can be wrong without anything looking broken.
 */
export function search(
  query: string,
  sources: {
    commands: CommandOption[]
    sessions: SessionInfo[]
    projects: ProjectItem[]
    artifacts: Artifact[]
    routines: Routine[]
    runs: Run[]
    workflows: Workflow[]
    files: FileSystemEntry[]
  },
): PaletteItem[] {
  const value = query.trim().toLowerCase()
  const items: PaletteItem[] = []
  for (const session of sources.sessions) {
    const title = sessionTitle(session) || t("Session without title")
    const directory = session.location?.directory ?? ""
    if (value && !contains(`${title} ${directory}`, value)) continue
    items.push({
      kind: "session",
      id: `session:${session.id}`,
      label: title,
      detail: directory.split("/").filter(Boolean).at(-1),
      cowork: isCoworkSession(session),
      value: session.id,
    })
  }
  for (const project of sources.projects) {
    if (value && !contains(`${project.name} ${project.directory}`, value)) continue
    items.push({ kind: "project", id: `project:${project.directory}`, label: project.name, detail: project.directory, value: project.directory })
  }
  for (const artifact of sources.artifacts) {
    if (value && !contains(`${artifact.title} ${artifact.kind}`, value)) continue
    items.push({ kind: "artifact", id: `artifact:${artifact.id}`, label: artifact.title, detail: artifact.kind, value: artifact.id })
  }
  for (const routine of sources.routines) {
    if (value && !contains(`${routine.name} ${routine.description ?? ""}`, value)) continue
    items.push({
      kind: "routine",
      id: `routine:${routine.id}`,
      label: routine.name,
      detail: routine.enabled ? undefined : t("Paused"),
      value: routine.id,
    })
  }
  for (const run of sources.runs) {
    const label = run.source.type === "routine" ? t("Routine") : t("Manual run")
    if (value && !contains(`${label} ${run.status}`, value)) continue
    items.push({ kind: "run", id: `run:${run.id}`, label, detail: run.status, value: run.id })
  }
  for (const workflow of sources.workflows) {
    if (value && !contains(`${workflow.name} ${workflow.description ?? ""}`, value)) continue
    items.push({
      kind: "workflow",
      id: `workflow:${workflow.name}`,
      label: workflow.name,
      detail: workflow.description,
      value: workflow.name,
    })
  }
  for (const command of sources.commands) {
    if (value && !contains(command.name, value)) continue
    items.push({
      kind: "command",
      id: `command:${command.name}`,
      label: command.name,
      detail: command.description,
      disabled: command.disabled,
      value: command.name,
    })
  }
  for (const file of sources.files) {
    items.push({ kind: "file", id: `file:${file.path}`, label: file.path, value: file.path })
  }
  return items
}

/** The kinds that actually matched, so a tab is never offered for an empty list. */
export const kindsIn = (items: PaletteItem[]) => KINDS.filter((kind) => items.some((item) => item.kind === kind))

/** What "All" shows: a few of each kind rather than a hundred sessions and nothing else. */
export const capped = (items: PaletteItem[], limit = LIMIT) =>
  KINDS.flatMap((kind) => items.filter((item) => item.kind === kind).slice(0, limit))

type CommandPaletteProps = {
  open: boolean
  commands: CommandOption[]
  sessions: SessionInfo[]
  projects: ProjectItem[]
  artifacts: Artifact[]
  routines: Routine[]
  runs: Run[]
  workflows: Workflow[]
  onClose: () => void
  onCommand: (name: string) => void
  onSession: (id: string) => void
  onProject: (directory: string) => void
  onArtifact: (id: string) => void
  onRoutine: (id: string) => void
  onRun: (id: string) => void
  onWorkflow: (name: string) => void
  onFile: (path: string) => void
  searchFiles: (query: string) => Promise<FileSystemEntry[]>
  /** Sessions matching the query that the loaded page does not hold (H-18). */
  searchSessions: (query: string) => Promise<SessionInfo[]>
}

/**
 * The search (⌘K, or the magnifier in the sidebar).
 *
 * It replaces the box that used to sit over the project list. That box could only ever narrow what
 * was already on screen; this reaches sessions, projects, artifacts, routines, runs, commands and
 * files. The tabs are only the kinds the query actually matched — a tab that always finds nothing
 * is furniture.
 */
export const CommandPalette: Component<CommandPaletteProps> = (props) => {
  let input: HTMLInputElement | undefined
  const [query, setQuery] = createSignal("")
  const [files, setFiles] = createSignal<FileSystemEntry[]>([])
  const [remoteSessions, setRemoteSessions] = createSignal<SessionInfo[]>([])
  const [active, setActive] = createSignal(0)
  const [tab, setTab] = createSignal<Kind>()

  createEffect(() => {
    if (!props.open) return
    setQuery("")
    setFiles([])
    setRemoteSessions([])
    setActive(0)
    setTab(undefined)
    queueMicrotask(() => input?.focus())
  })

  createEffect(() => {
    const value = query().trim()
    if (!props.open || value.length < 2) {
      setFiles([])
      setRemoteSessions([])
      return
    }
    const handle = setTimeout(async () => {
      // Files and sessions are asked for together: both reach past what is already on screen.
      const [found, sessions] = await Promise.all([
        props.searchFiles(value).catch(() => [] as FileSystemEntry[]),
        props.searchSessions(value).catch(() => [] as SessionInfo[]),
      ])
      setFiles(found)
      setRemoteSessions(sessions)
    }, 150)
    onCleanup(() => clearTimeout(handle))
  })

  // The loaded sessions plus whatever the server found beyond them, without a session twice.
  const sessions = createMemo(() => {
    const known = new Set(props.sessions.map((session) => session.id))
    return [...props.sessions, ...remoteSessions().filter((session) => !known.has(session.id))]
  })

  const all = createMemo(() =>
    search(query(), {
      commands: props.commands,
      sessions: sessions(),
      projects: props.projects,
      artifacts: props.artifacts,
      routines: props.routines,
      runs: props.runs,
      workflows: props.workflows,
      files: files(),
    }),
  )
  const tabs = createMemo(() => kindsIn(all()))
  const items = createMemo(() => {
    const only = tab()
    return only ? all().filter((item) => item.kind === only) : capped(all())
  })
  // A tab that stops matching stops existing, and the list must not be left pointing at it.
  createEffect(() => {
    const only = tab()
    if (only && !tabs().includes(only)) setTab(undefined)
  })

  const groups = createMemo(() => {
    const seen: Array<{ kind: Kind; items: PaletteItem[] }> = []
    for (const item of items()) {
      const last = seen.at(-1)
      if (last?.kind === item.kind) last.items.push(item)
      else seen.push({ kind: item.kind, items: [item] })
    }
    return seen
  })

  const select = (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return
    if (item.kind === "command") props.onCommand(item.value)
    else if (item.kind === "session") props.onSession(item.value)
    else if (item.kind === "project") props.onProject(item.value)
    else if (item.kind === "artifact") props.onArtifact(item.value)
    else if (item.kind === "routine") props.onRoutine(item.value)
    else if (item.kind === "run") props.onRun(item.value)
    else if (item.kind === "workflow") props.onWorkflow(item.value)
    else props.onFile(item.value)
    props.onClose()
  }

  /** Left and right walk the tabs, with "All" as the first of them. */
  const moveTab = (step: number) => {
    const available: Array<Kind | undefined> = [undefined, ...tabs()]
    const index = available.indexOf(tab())
    const next = available[Math.min(Math.max(index + step, 0), available.length - 1)]
    setTab(next)
    setActive(0)
  }

  /** The next enabled row in a direction, so the arrows never land on something that cannot open. */
  const moveItem = (step: number) => {
    const available = items()
    for (let index = active() + step; index >= 0 && index < available.length; index += step) {
      if (!available[index]?.disabled) {
        setActive(index)
        return
      }
    }
  }

  // The list is taller than the dialog in a long search: walking it with the arrows has to bring the
  // active row into view, or the reader scrolls by hand to see where they are.
  let list: HTMLDivElement | undefined
  createEffect(() => {
    active()
    tab()
    list?.querySelector<HTMLElement>(".fc-palette-item-active")?.scrollIntoView({ block: "nearest" })
  })

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-palette"
          role="dialog"
          aria-modal="true"
          aria-label={t("Search")}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-palette-head">
            <input
              ref={input}
              class="fc-palette-input"
              value={query()}
              placeholder={t("Search")}
              aria-label={t("Search")}
              onInput={(event) => {
                setQuery(event.currentTarget.value)
                setActive(0)
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  props.onClose()
                  return
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  moveItem(1)
                  return
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault()
                  moveItem(-1)
                  return
                }
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  // Only when the caret has nowhere to go, or typing a query becomes impossible.
                  const caret = event.currentTarget.selectionStart ?? 0
                  const atEdge = event.key === "ArrowLeft" ? caret === 0 : caret === event.currentTarget.value.length
                  if (!atEdge) return
                  event.preventDefault()
                  moveTab(event.key === "ArrowLeft" ? -1 : 1)
                  return
                }
                if (event.key === "Enter") {
                  event.preventDefault()
                  select(items()[active()])
                }
              }}
            />
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>

          <Show when={tabs().length > 1}>
            <div class="fc-palette-tabs">
              <button
                class="fc-palette-tab"
                classList={{ "fc-palette-tab-active": !tab() }}
                type="button"
                onClick={() => {
                  setTab(undefined)
                  setActive(0)
                  input?.focus()
                }}
              >
                {t("All")}
              </button>
              <For each={tabs()}>
                {(kind) => (
                  <button
                    class="fc-palette-tab"
                    classList={{ "fc-palette-tab-active": tab() === kind }}
                    type="button"
                    onClick={() => {
                      setTab(kind)
                      setActive(0)
                      input?.focus()
                    }}
                  >
                    {t(LABELS[kind])}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={items().length > 0} fallback={<div class="fc-palette-empty">{t("No results")}</div>}>
            <div class="fc-palette-list" ref={list}>
              <For each={groups()}>
                {(group) => (
                  <>
                    <Show when={!tab()}>
                      <div class="fc-palette-group">{t(LABELS[group.kind])}</div>
                    </Show>
                    <For each={group.items}>
                      {(item) => {
                        const index = () => items().indexOf(item)
                        return (
                          <button
                            class="fc-palette-item"
                            classList={{ "fc-palette-item-active": active() === index() && !item.disabled }}
                            type="button"
                            disabled={item.disabled}
                            onMouseEnter={() => setActive(index())}
                            onClick={() => select(item)}
                          >
                            <span class="fc-palette-badge">{BADGES[item.kind]}</span>
                            <span class="fc-palette-label">{item.label}</span>
                            <Show when={item.cowork}>
                              <span class="fc-cowork-badge">{t("Cowork")}</span>
                            </Show>
                            <Show when={item.detail}>
                              <span class="fc-palette-desc">{item.detail}</span>
                            </Show>
                          </button>
                        )
                      }}
                    </For>
                  </>
                )}
              </For>
            </div>
          </Show>

          <div class="fc-palette-foot">
            <span>
              {t("Select")} <kbd>↑</kbd>
              <kbd>↓</kbd>
            </span>
            <Show when={tabs().length > 1}>
              <span>
                {t("Change type")} <kbd>←</kbd>
                <kbd>→</kbd>
              </span>
            </Show>
            <span>
              {t("Open")} <kbd>↵</kbd>
            </span>
          </div>
        </div>
      </div>
    </Show>
  )
}
