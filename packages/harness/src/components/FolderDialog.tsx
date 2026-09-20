import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, type Component } from "solid-js"
import { t } from "../i18n"
import {
  isAbsolutePath,
  joinPath,
  parentPath,
  pathOfSegments,
  segmentsOf,
  trimTrailing,
  visibleFolders,
  type FolderEntry,
} from "../folder"

type FolderDialogProps = {
  open: boolean
  initial?: string
  /** Project folders already known to this harness, offered as shortcuts. */
  recents?: string[]
  /** The engine machine's home folder: where browsing starts. */
  home: () => Promise<string>
  /** One directory level of `directory`, at the relative `path` inside it. */
  list: (directory: string, path: string) => Promise<FolderEntry[]>
  onOpen: (path: string) => void
  onClose: () => void
}

const RECENTS_LIMIT = 6

/**
 * Picks a project folder. On the desktop the native chooser is the primary action; everywhere
 * else (web, phone through the tunnel) it browses the engine machine from the home folder with
 * `fs.list`, and the address bar still accepts a typed absolute path.
 */
export const FolderDialog: Component<FolderDialogProps> = (props) => {
  const [root, setRoot] = createSignal<string>()
  const [relative, setRelative] = createSignal("")
  const [address, setAddress] = createSignal("")
  const [filter, setFilter] = createSignal("")
  const [hidden, setHidden] = createSignal(false)
  const [homeError, setHomeError] = createSignal(false)
  let addressInput: HTMLInputElement | undefined

  const native = () => typeof window !== "undefined" && typeof window.flupcode?.chooseFolder === "function"
  const current = createMemo(() => (root() ? joinPath(root()!, relative()) : ""))
  const segments = createMemo(() => (current() ? segmentsOf(current()) : []))
  const recents = createMemo(() =>
    (props.recents ?? []).filter((path, index, all) => path && all.indexOf(path) === index).slice(0, RECENTS_LIMIT),
  )

  const [entries] = createResource(
    () => (props.open && root() ? { directory: root()!, path: relative() } : undefined),
    async (source) => {
      try {
        return { entries: await props.list(source.directory, source.path), error: false }
      } catch {
        return { entries: [] as FolderEntry[], error: true }
      }
    },
  )
  const folders = createMemo(() => visibleFolders(entries()?.entries ?? [], { hidden: hidden(), filter: filter() }))

  // Start at the last chosen folder if there is one, otherwise at the engine's home.
  createEffect(
    on(
      () => props.open,
      async (open) => {
        if (!open) return
        setFilter("")
        setHomeError(false)
        if (props.initial && isAbsolutePath(props.initial)) browseTo(props.initial)
        else if (!root()) {
          try {
            browseTo(await props.home())
          } catch {
            setHomeError(true)
          }
        }
        queueMicrotask(() => addressInput?.focus())
      },
    ),
  )

  createEffect(() => setAddress(current()))

  const browseTo = (directory: string, path = "") => {
    setRoot(trimTrailing(directory))
    setRelative(path)
    setFilter("")
  }

  const enter = (name: string) => {
    setRelative(relative() ? `${relative()}/${name}` : name)
    setFilter("")
  }

  const up = () => {
    const rel = relative()
    if (rel) {
      const index = Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\"))
      setRelative(index > 0 ? rel.slice(0, index) : "")
      setFilter("")
      return
    }
    const parent = root() ? parentPath(root()!) : undefined
    if (parent) browseTo(parent)
  }

  const crumb = (count: number) => {
    const target = pathOfSegments(segments(), count)
    const base = root() ?? ""
    // Inside the browsed location keep it as the location; above it the parent becomes the location.
    if (target.length >= base.length && target.startsWith(base)) {
      const rest = target.slice(base.length).replace(/^[\\/]+/, "")
      setRelative(rest)
      setFilter("")
    } else browseTo(target)
  }

  const open = (path?: string) => {
    const typed = address().trim()
    const target = path ?? (isAbsolutePath(typed) ? typed : current())
    if (target) props.onOpen(trimTrailing(target))
  }

  const go = () => {
    const typed = address().trim()
    if (!typed) return
    if (isAbsolutePath(typed)) browseTo(typed)
    else open(typed)
  }

  const choose = async () => {
    const path = await window.flupcode?.chooseFolder?.()
    if (path) props.onOpen(path)
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && props.open) {
      event.preventDefault()
      props.onClose()
    }
  }
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  }

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-modal fc-modal-wide fc-folder"
          role="dialog"
          aria-modal="true"
          aria-label={t("Open folder")}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-modal-header">
            <span>{t("Open folder")}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>

          <Show when={native()}>
            <button class="fc-button fc-button-primary fc-folder-native" type="button" onClick={() => void choose()}>
              {t("Choose folder…")}
            </button>
          </Show>

          <Show when={recents().length > 0}>
            <div class="fc-folder-section">
              <span class="fc-folder-section-title">{t("Recent projects")}</span>
              <div class="fc-folder-recents">
                <For each={recents()}>
                  {(path) => (
                    <button class="fc-folder-recent" type="button" title={path} onClick={() => props.onOpen(path)}>
                      <span class="fc-folder-recent-name">{segmentsOf(path).pop()}</span>
                      <span class="fc-folder-recent-path">{path}</span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <div class="fc-folder-address">
            <button class="fc-icon-button" type="button" aria-label={t("Up")} title={t("Up")} onClick={up}>
              ↑
            </button>
            <input
              ref={addressInput}
              class="fc-question-custom fc-folder-input"
              value={address()}
              placeholder="/Users/you/project"
              spellcheck={false}
              aria-label={t("Folder path")}
              onInput={(event) => setAddress(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  if (event.metaKey || event.ctrlKey) open()
                  else go()
                }
              }}
            />
            <button class="fc-button" type="button" onClick={go} disabled={address().trim().length === 0}>
              {t("Go")}
            </button>
          </div>

          <Show when={segments().length > 0}>
            <nav class="fc-folder-crumbs" aria-label={t("Folder path")}>
              <For each={segments()}>
                {(segment, index) => (
                  <>
                    <Show when={index() > 0}>
                      <span class="fc-folder-crumb-sep">›</span>
                    </Show>
                    <button
                      class="fc-folder-crumb"
                      classList={{ "fc-folder-crumb-current": index() === segments().length - 1 }}
                      type="button"
                      onClick={() => crumb(index() + 1)}
                    >
                      {segment}
                    </button>
                  </>
                )}
              </For>
            </nav>
          </Show>

          <div class="fc-folder-tools">
            <input
              class="fc-question-custom fc-folder-filter"
              value={filter()}
              placeholder={t("Filter folders")}
              aria-label={t("Filter folders")}
              onInput={(event) => setFilter(event.currentTarget.value)}
            />
            <label class="fc-folder-hidden">
              <input type="checkbox" checked={hidden()} onChange={(event) => setHidden(event.currentTarget.checked)} />
              {t("Show hidden folders")}
            </label>
          </div>

          <ul class="fc-folder-list" role="listbox" aria-label={t("Subfolders")}>
            <Show when={homeError()}>
              <li class="fc-palette-empty">{t("Could not read the home folder; type a path instead.")}</li>
            </Show>
            <Show when={entries.loading}>
              <li class="fc-palette-empty">{t("Loading…")}</li>
            </Show>
            <Show when={!entries.loading && entries()?.error}>
              <li class="fc-palette-empty">{t("Could not read this folder.")}</li>
            </Show>
            <Show when={!entries.loading && entries() && !entries()?.error && folders().length === 0}>
              <li class="fc-palette-empty">{t("No subfolders")}</li>
            </Show>
            <For each={folders()}>
              {(folder) => (
                <li class="fc-folder-row">
                  <button
                    class="fc-palette-item fc-folder-item"
                    type="button"
                    title={t("Enter")}
                    onClick={() => enter(folder.name)}
                    onDblClick={() => open(joinPath(current(), folder.name))}
                  >
                    <span class="fc-palette-badge" aria-hidden="true">
                      ▸
                    </span>
                    <span class="fc-palette-label">{folder.name}</span>
                  </button>
                  <button
                    class="fc-button fc-folder-item-open"
                    type="button"
                    aria-label={`${t("Open")} ${folder.name}`}
                    onClick={() => open(joinPath(current(), folder.name))}
                  >
                    {t("Open")}
                  </button>
                </li>
              )}
            </For>
          </ul>

          <div class="fc-dialog-actions">
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Cancel")}
            </button>
            <button
              class="fc-button fc-button-primary"
              type="button"
              disabled={!current() && address().trim().length === 0}
              title={current()}
              onClick={() => open()}
            >
              {t("Open this folder")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
