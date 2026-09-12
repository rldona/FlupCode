import { For, Show, createEffect, createSignal, onCleanup, type Component } from "solid-js"
import type { FileSystemEntry, SessionInfo } from "../engine-types"
import type { CommandOption } from "../types"
import { t } from "../i18n"

type PaletteItem =
  | { kind: "command"; id: string; name: string; description?: string }
  | { kind: "session"; id: string; title: string; subtitle: string }
  | { kind: "file"; id: string; path: string }

type CommandPaletteProps = {
  open: boolean
  commands: CommandOption[]
  sessions: SessionInfo[]
  onClose: () => void
  onCommand: (name: string) => void
  onSession: (id: string) => void
  onFile: (path: string) => void
  searchFiles: (query: string) => Promise<FileSystemEntry[]>
}

export const CommandPalette: Component<CommandPaletteProps> = (props) => {
  let input: HTMLInputElement | undefined
  const [query, setQuery] = createSignal("")
  const [files, setFiles] = createSignal<FileSystemEntry[]>([])
  const [active, setActive] = createSignal(0)

  createEffect(() => {
    if (!props.open) return
    setQuery("")
    setFiles([])
    setActive(0)
    queueMicrotask(() => input?.focus())
  })

  createEffect(() => {
    const value = query().trim()
    if (!props.open || value.length < 2) {
      setFiles([])
      return
    }
    const handle = setTimeout(async () => {
      try {
        setFiles(await props.searchFiles(value))
      } catch {
        setFiles([])
      }
    }, 150)
    onCleanup(() => clearTimeout(handle))
  })

  const items = (): PaletteItem[] => {
    const value = query().trim().toLowerCase()
    const commands = props.commands
      .filter((command) => command.name.toLowerCase().includes(value))
      .slice(0, 6)
      .map<PaletteItem>((command) => ({
        kind: "command",
        id: `command:${command.name}`,
        name: command.name,
        description: command.description,
      }))
    const sessions = props.sessions
      .filter((session) => (session.title || session.id).toLowerCase().includes(value))
      .slice(0, 5)
      .map<PaletteItem>((session) => ({
        kind: "session",
        id: `session:${session.id}`,
        title: session.title || t("Session without title"),
        subtitle: session.id.slice(0, 8),
      }))
    const fileItems = files()
      .slice(0, 8)
      .map<PaletteItem>((file) => ({ kind: "file", id: `file:${file.path}`, path: file.path }))
    return [...commands, ...sessions, ...fileItems]
  }

  const select = (item: PaletteItem | undefined) => {
    if (!item) return
    if (item.kind === "command") props.onCommand(item.name)
    else if (item.kind === "session") props.onSession(item.id)
    else props.onFile(item.path)
    props.onClose()
  }

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div class="fc-palette" role="dialog" aria-modal="true" aria-label={t("Command palette")} onClick={(event) => event.stopPropagation()}>
          <input
            ref={input}
            class="fc-palette-input"
            value={query()}
            placeholder={t("Search commands, sessions and files")}
            aria-label="Command palette"
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
                setActive((index) => Math.min(index + 1, items().length - 1))
                return
              }
              if (event.key === "ArrowUp") {
                event.preventDefault()
                setActive((index) => Math.max(index - 1, 0))
                return
              }
              if (event.key === "Enter") {
                event.preventDefault()
                select(items()[active()])
              }
            }}
          />
          <Show
            when={items().length > 0}
            fallback={<div class="fc-palette-empty">{t("No results")}</div>}
          >
            <ul class="fc-palette-list">
              <For each={items()}>
                {(item, index) => (
                  <li>
                    <button
                      class="fc-palette-item"
                      classList={{ "fc-palette-item-active": active() === index() }}
                      type="button"
                      onMouseEnter={() => setActive(index())}
                      onClick={() => select(item)}
                    >
                      <span class="fc-palette-badge">
                        {item.kind === "command" ? "/" : item.kind === "session" ? "S" : "@"}
                      </span>
                      <span class="fc-palette-label">
                        {item.kind === "command" ? item.name : item.kind === "session" ? item.title : item.path}
                      </span>
                      <Show when={item.kind === "command" && item.description}>
                        <span class="fc-palette-desc">{item.kind === "command" ? item.description : ""}</span>
                      </Show>
                      <Show when={item.kind === "session"}>
                        <span class="fc-palette-desc">{item.kind === "session" ? item.subtitle : ""}</span>
                      </Show>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </Show>
  )
}
