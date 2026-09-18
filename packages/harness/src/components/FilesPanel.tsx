import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import type { FileSystemEntry } from "../engine-types"
import type { FileText } from "../types"
import { t } from "../i18n"
import { highlight, languageFor } from "../highlight"

type FilesPanelProps = {
  open: boolean
  directory?: string
  /** The children of one directory, or of the folder root when no path is given. */
  list: (path?: string) => Promise<FileSystemEntry[]>
  /** Ranked paths matching a query anywhere in the folder. */
  search: (query: string) => Promise<FileSystemEntry[]>
  /** One file's text, read by the harness server. */
  read: (path: string) => Promise<FileText>
  onClose: () => void
}

const basename = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path

/**
 * The file tree, one file's text, and a search that reaches anywhere in the folder (H-19).
 *
 * The diff viewer answers "what changed"; this answers "what is here". Both read the same working
 * tree, and searching is the same ranked `find` the composer's `@` menu already used.
 */
export const FilesPanel: Component<FilesPanelProps> = (props) => {
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string>()
  const [children, setChildren] = createSignal<Record<string, FileSystemEntry[]>>({})
  const [openDirs, setOpenDirs] = createSignal<Set<string>>(new Set())

  const rootKey = createMemo(() => (props.open && props.directory ? props.directory : undefined))
  const [root] = createResource(rootKey, () => props.list())

  const childrenOf = (path: string) => (path === "" ? (root() ?? []) : (children()[path] ?? []))
  const isOpenDirectory = (path: string) => openDirs().has(path)

  const [file, setFile] = createSignal<FileText>()
  const [fileError, setFileError] = createSignal<string>()
  const [fileLoading, setFileLoading] = createSignal(false)

  const open = async (path: string) => {
    setSelected(path)
    setFileError(undefined)
    setFile(undefined)
    setFileLoading(true)
    try {
      setFile(await props.read(path))
    } catch (cause) {
      setFileError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setFileLoading(false)
    }
  }

  const toggle = async (entry: FileSystemEntry) => {
    if (entry.type !== "directory") {
      void open(entry.path)
      return
    }
    const next = new Set(openDirs())
    if (next.has(entry.path)) {
      next.delete(entry.path)
      setOpenDirs(next)
      return
    }
    // Loaded once: a folder that is closed and opened again keeps its children.
    if (!children()[entry.path]) {
      try {
        setChildren({ ...children(), [entry.path]: await props.list(entry.path) })
      } catch {
        setChildren({ ...children(), [entry.path]: [] })
      }
    }
    next.add(entry.path)
    setOpenDirs(next)
  }

  const [searchResults] = createResource(
    () => (query().trim() ? query().trim() : undefined),
    (value) => props.search(value),
  )

  const lines = () => (file()?.binary ? [] : (file()?.content ?? "").split("\n"))

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Files")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{props.directory ? basename(props.directory) : t("Files")}</div>
            <h1>{t("Files")}</h1>
            <p>{t("Look at what is in the folder, and search it.")}</p>
          </div>
          <div class="fc-routines-header-actions">
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Back to sessions")}
            </button>
          </div>
        </div>

        <div class="fc-files-layout">
          <div class="fc-files-tree">
            <input
              class="fc-input fc-files-search"
              placeholder={t("Search files")}
              value={query()}
              aria-label={t("Search files")}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <Show
              when={!query().trim()}
              fallback={
                <Show
                  when={(searchResults() ?? []).length > 0}
                  fallback={
                    <p class="fc-settings-hint">
                      {searchResults.loading ? t("Searching…") : t("Nothing matched.")}
                    </p>
                  }
                >
                  <ul class="fc-files-list">
                    <For each={searchResults()}>
                      {(entry) => (
                        <li>
                          <button
                            class="fc-files-entry"
                            classList={{ "fc-files-entry-active": selected() === entry.path }}
                            type="button"
                            onClick={() => void open(entry.path)}
                          >
                            <span class="fc-files-name">{entry.path}</span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              }
            >
              <ul class="fc-files-list">
                <For each={childrenOf("")}>
                  {(entry) => (
                    <TreeEntry
                      entry={entry}
                      depth={0}
                      selected={selected()}
                      childrenOf={childrenOf}
                      isOpen={isOpenDirectory}
                      onToggle={toggle}
                    />
                  )}
                </For>
              </ul>
            </Show>
          </div>

          <div class="fc-files-viewer">
            <Show when={selected()} fallback={<div class="fc-runs-empty">{t("Pick a file to read it.")}</div>}>
              <div class="fc-files-viewer-head">
                <span class="fc-files-viewer-path" title={selected()}>
                  {selected()}
                </span>
                <Show when={file()}>
                  {(text) => (
                    <span class="fc-files-viewer-meta">
                      {text().bytes.toLocaleString()} {t("bytes")}
                      <Show when={text().truncated}> · {t("showing the beginning")}</Show>
                    </span>
                  )}
                </Show>
              </div>
              <Show when={fileLoading()}>
                <div class="fc-runs-empty">{t("Reading…")}</div>
              </Show>
              <Show when={fileError()}>{(message) => <div class="fc-routines-notice">{message()}</div>}</Show>
              <Show when={file()?.binary}>
                <div class="fc-runs-empty">{t("That file is not text.")}</div>
              </Show>
              <Show when={file() && !file()!.binary}>
                <div class="fc-files-code">
                  <For each={lines()}>
                    {(line, index) => (
                      <div class="fc-files-code-line">
                        <span class="fc-files-code-no">{index() + 1}</span>
                        <span class="fc-files-code-text" innerHTML={highlight(line, languageFor(selected() ?? ""))} />
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      </section>
    </Show>
  )
}

const TreeEntry: Component<{
  entry: FileSystemEntry
  depth: number
  selected: string | undefined
  childrenOf: (path: string) => FileSystemEntry[]
  isOpen: (path: string) => boolean
  onToggle: (entry: FileSystemEntry) => void
}> = (props) => (
  <li>
    <button
      class="fc-files-entry"
      classList={{ "fc-files-entry-active": props.selected === props.entry.path }}
      style={{ "padding-inline-start": `${8 + props.depth * 14}px` }}
      type="button"
      onClick={() => props.onToggle(props.entry)}
    >
      <span class="fc-files-caret" aria-hidden="true">
        {props.entry.type === "directory" ? (props.isOpen(props.entry.path) ? "▾" : "▸") : ""}
      </span>
      <span class="fc-files-name">{basename(props.entry.path) || props.entry.path}</span>
    </button>
    <Show when={props.entry.type === "directory" && props.isOpen(props.entry.path)}>
      <ul class="fc-files-list">
        <For each={props.childrenOf(props.entry.path)}>
          {(child) => (
            <TreeEntry
              entry={child}
              depth={props.depth + 1}
              selected={props.selected}
              childrenOf={props.childrenOf}
              isOpen={props.isOpen}
              onToggle={props.onToggle}
            />
          )}
        </For>
      </ul>
    </Show>
  </li>
)
