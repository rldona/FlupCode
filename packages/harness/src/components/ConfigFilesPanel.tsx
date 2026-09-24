import { For, Show, createEffect, createSignal, onCleanup, type Component } from "solid-js"
import { t } from "../i18n"
import { createHarnessClient } from "../client"
import type {
  ConfigFileEntry,
  ConfigFileExport,
  ConfigFileExportClassification,
  ConfigFileKind,
} from "../types"

type ConfigFilesPanelProps = {
  open: boolean
  /** The harness server: this listing is its own, not the engine's. */
  harnessServerUrl: string
  /** The folder whose config files this lists; absent means the global layers only. */
  directory?: string
  /** The harness server advertises the `config-files` capability. */
  serverAvailable: boolean
  /** Whether this window can hand a path to the OS (the desktop bridge). */
  canOpenFiles: boolean
  /** The repository the global config names, when one is set. */
  configRepo?: string
  /** Writes `flupcode.configRepo` into the global config. */
  onSetConfigRepo: (repo: string) => void
  /** Open a path in the code editor. */
  onOpenInEditor: (path: string) => void
  /** Re-reads the engine's definitions after a file changed on disk. */
  onReload: () => Promise<unknown> | void
  onClose: () => void
  onBack?: () => void
}

/** The order the groups are shown: what the engine scans, then what it would refuse, then its own files. */
export const CONFIG_KINDS = ["tool", "guard", "config"] as const

export const KIND_LABELS: Record<ConfigFileKind, string> = {
  tool: "Tools",
  guard: "Guards",
  config: "Config files",
}

/** How an export ended, in the order the plan reads. */
export const CLASSIFICATIONS = ["written", "unchanged", "conflicts", "skipped", "outside"] as const

export const CLASSIFICATION_LABELS: Record<ConfigFileExportClassification, string> = {
  written: "written",
  unchanged: "unchanged",
  conflicts: "conflicts",
  skipped: "skipped",
  outside: "outside",
}

/** The entries that have one, by kind, so an empty group is not drawn. */
export function groupByKind(entries: ConfigFileEntry[]): Array<{ kind: ConfigFileKind; entries: ConfigFileEntry[] }> {
  return CONFIG_KINDS.map((kind) => ({ kind, entries: entries.filter((entry) => entry.kind === kind) })).filter(
    (group) => group.entries.length > 0,
  )
}

/** How big a file is, in the unit a reader scans rather than counts. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} kB`
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

/**
 * The paths whose mtime moved between two readings.
 *
 * A file that appeared between them counts as changed even though it has no previous mtime, because
 * a new tool module is exactly the case the reload is for. A missing guard has an mtime of zero at
 * both readings and only counts once it actually lands.
 */
export function changedPaths(previous: ConfigFileEntry[], next: ConfigFileEntry[]): string[] {
  const before = new Map(previous.map((entry) => [entry.path, entry.mtimeMs]))
  return next.filter((entry) => before.get(entry.path) !== entry.mtimeMs).map((entry) => entry.path)
}

/**
 * Which changed kinds need an engine restart rather than a reload.
 *
 * A guard edited under a running engine keeps its old ESM copy, and so does an edited tool module:
 * only a new process picks either up. A tool file that is simply new is read fresh on the reload, so
 * it only counts as a restart when it was already there in `before`.
 */
export function restartKinds(
  changed: string[],
  next: ConfigFileEntry[],
  before: ConfigFileEntry[],
): { guard: boolean; tool: boolean } {
  const known = new Set(before.map((entry) => entry.path))
  const kindOf = (path: string) => next.find((entry) => entry.path === path)?.kind
  return {
    guard: changed.some((path) => kindOf(path) === "guard"),
    tool: changed.some((path) => known.has(path) && kindOf(path) === "tool"),
  }
}

/** The five classifications with their counts, so the plan and the result are read the same way. */
export function exportCounts(
  result: ConfigFileExport,
): Array<{ classification: ConfigFileExportClassification; count: number }> {
  return CLASSIFICATIONS.map((classification) => ({ classification, count: result[classification].length }))
}

const POLL_MS = 2000
const DEBOUNCE_MS = 500

/**
 * The rest of the engine's configuration, on disk.
 *
 * The harness could show the agents, commands and skills a folder loads, but not the tool modules
 * the engine scans, the guards a delivery profile names, or the global config files. This lists
 * them, opens them in the OS editor (no in-app editing), watches their mtimes so a change made
 * elsewhere reloads the engine's definitions, and copies the chosen global ones into the user's own
 * config repository — previewed first, and never by running a script.
 */
export const ConfigFilesPanel: Component<ConfigFilesPanelProps> = (props) => {
  const [entries, setEntries] = createSignal<ConfigFileEntry[]>([])
  const [loading, setLoading] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [plan, setPlan] = createSignal<ConfigFileExport>()
  const [result, setResult] = createSignal<ConfigFileExport>()
  const [exporting, setExporting] = createSignal(false)
  const [reloading, setReloading] = createSignal(false)
  const [repoInput, setRepoInput] = createSignal("")
  // A guard edited under a running engine keeps its old ESM copy, and so does an edited tool module:
  // only a new process picks either up. New tool files are the exception and follow the reload.
  const [guardRestart, setGuardRestart] = createSignal(false)
  const [toolRestart, setToolRestart] = createSignal(false)

  // The last reading the poll compares against. Not reactive: only the changed paths matter.
  let previous: ConfigFileEntry[] = []
  let reloadTimer: ReturnType<typeof setTimeout> | undefined

  const client = () => createHarnessClient(props.harnessServerUrl)
  const read = () =>
    client().configFiles.list(props.directory ? { directory: props.directory } : {})

  const refresh = async () => {
    setLoading(true)
    try {
      const next = await read()
      setEntries(next)
      setProblem(undefined)
      return next
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
      return undefined
    } finally {
      setLoading(false)
    }
  }

  const applyReload = async () => {
    setReloading(true)
    try {
      await props.onReload()
    } finally {
      setReloading(false)
    }
  }

  /** The reload a detected change asks for, once the writes have stopped landing. */
  const scheduleReload = (changed: string[], next: ConfigFileEntry[], before: ConfigFileEntry[]) => {
    clearTimeout(reloadTimer)
    const restarts = restartKinds(changed, next, before)
    reloadTimer = setTimeout(() => {
      if (restarts.guard) setGuardRestart(true)
      if (restarts.tool) setToolRestart(true)
      void applyReload().then(() => refresh())
    }, DEBOUNCE_MS)
  }

  const manualReload = () => void applyReload().then(() => refresh())

  createEffect(() => {
    if (!props.open || !props.serverAvailable || !props.harnessServerUrl) return
    void refresh().then((next) => {
      if (next) previous = next
    })
    // A file written while this is open — by an editor, an install script — is what the reload is
    // for, so the list is watched while it is on screen and on every focus, never in the background.
    const check = async () => {
      try {
        const next = await read()
        const before = previous
        const changed = changedPaths(before, next)
        previous = next
        setEntries(next)
        setProblem(undefined)
        if (changed.length > 0) scheduleReload(changed, next, before)
      } catch (cause) {
        setProblem(cause instanceof Error ? cause.message : String(cause))
      }
    }
    const interval = setInterval(() => void check(), POLL_MS)
    const onFocus = () => void check()
    window.addEventListener("focus", onFocus)
    onCleanup(() => {
      clearInterval(interval)
      window.removeEventListener("focus", onFocus)
      clearTimeout(reloadTimer)
    })
  })

  // The repository is configuration, so the field follows it: a save re-reads the global config and
  // the answer lands here instead of being typed twice.
  createEffect(() => {
    const repo = props.configRepo
    if (repo) setRepoInput(repo)
  })

  const toggle = (path: string) => {
    const next = new Set(selected())
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setSelected(next)
    // The plan names the selection it was built from, so any change to the selection retires it.
    setPlan(undefined)
  }

  const allSelected = () => entries().length > 0 && entries().every((entry) => selected().has(entry.path))
  const toggleAll = () => {
    setSelected(allSelected() ? new Set<string>() : new Set(entries().map((entry) => entry.path)))
    setPlan(undefined)
  }
  const selectedPaths = () => entries().filter((entry) => selected().has(entry.path)).map((entry) => entry.path)

  const runExport = async (confirm: boolean) => {
    const paths = selectedPaths()
    if (paths.length === 0) return
    setExporting(true)
    setProblem(undefined)
    try {
      const answer = await client().configFiles.export({
        ...(props.directory ? { directory: props.directory } : {}),
        paths,
        ...(confirm ? { confirm: true } : {}),
      })
      if (confirm) {
        setResult(answer)
        setPlan(undefined)
      } else {
        setPlan(answer)
        setResult(undefined)
      }
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setExporting(false)
    }
  }

  const saveRepo = () => {
    const repo = repoInput().trim()
    if (repo) props.onSetConfigRepo(repo)
  }

  const ExportReport: Component<{ value: ConfigFileExport; title: string; onConfirm?: () => void }> = (report) => (
    <div class="fc-routine-cards">
      <p class="fc-usage-note">{report.title}</p>
      <For each={exportCounts(report.value)}>
        {(count) => (
          <div class="fc-usage-row">
            <span class="fc-usage-key">{t(CLASSIFICATION_LABELS[count.classification])}</span>
            <span>{count.count}</span>
          </div>
        )}
      </For>
      <div class="fc-artifact-files">
        <For each={report.value.entries}>
          {(entry) => (
            <div class="fc-artifact-file">
              <span class="fc-artifact-file-name">{t(CLASSIFICATION_LABELS[entry.classification])}</span>
              <span class="fc-artifact-file-path" title={entry.path}>
                {entry.path}
              </span>
              <Show when={entry.reason}>{(why) => <span class="fc-usage-note">{why()}</span>}</Show>
            </div>
          )}
        </For>
      </div>
      <Show when={report.onConfirm}>
        {(confirm) => (
          <div class="fc-modal-links">
            <button class="fc-button fc-button-primary" type="button" disabled={exporting()} onClick={confirm()}>
              {t("Confirm export")}
            </button>
            <button class="fc-button" type="button" onClick={() => setPlan(undefined)}>
              {t("Cancel")}
            </button>
          </div>
        )}
      </Show>
    </div>
  )

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-modal fc-form-modal"
          role="dialog"
          aria-modal="true"
          aria-label={t("Config files")}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-modal-header">
            <span class="fc-modal-heading">
              <Show when={props.onBack}>
                <button class="fc-icon-button fc-back" type="button" aria-label={t("Back")} onClick={props.onBack}>
                  ←
                </button>
              </Show>
              <span>{t("Config files")}</span>
            </span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>

          <div class="fc-modal-body">
            <Show when={!props.serverAvailable}>
              <div class="fc-routines-notice">{t("The harness server is not reachable, so this is the last it said.")}</div>
            </Show>

            <Show when={guardRestart()}>
              <p class="fc-usage-note">{t("Guards are cached as ESM: a change needs an engine restart.")}</p>
            </Show>
            <Show when={toolRestart()}>
              <p class="fc-usage-note">
                {t("An edited tool file needs an engine restart; a new one takes effect after a reload.")}
              </p>
            </Show>
            <Show when={!props.canOpenFiles}>
              <p class="fc-usage-note">{t("The desktop app is required to open files in an editor.")}</p>
            </Show>

            <Show when={problem()}>{(why) => <p class="fc-run-error">{why()}</p>}</Show>

            <Show
              when={groupByKind(entries()).length > 0}
              fallback={
                <p class="fc-usage-note">
                  {loading() ? t("Reading…") : t("No config files are loaded for this folder.")}
                </p>
              }
            >
              <For each={groupByKind(entries())}>
                {(group) => (
                  <section class="fc-usage-block">
                    <h2>
                      {t(KIND_LABELS[group.kind])}
                      <span class="fc-context-aside">{group.entries.length}</span>
                    </h2>
                    <div class="fc-artifact-files">
                      <For each={group.entries}>
                        {(entry) => (
                          <div class="fc-artifact-file">
                            <label class="fc-check">
                              <input
                                type="checkbox"
                                checked={selected().has(entry.path)}
                                aria-label={t("Select {name}", { name: entry.name })}
                                onChange={() => toggle(entry.path)}
                              />
                              <span class="fc-artifact-file-name" title={entry.path}>
                                {entry.name}
                              </span>
                            </label>
                            <span class="fc-artifact-file-path" title={entry.path}>
                              {entry.path}
                            </span>
                            <span class="fc-artifact-kind">{t(entry.scope)}</span>
                            <span class="fc-artifact-kind">{sizeLabel(entry.bytes)}</span>
                            <Show when={entry.missing}>
                              <span class="fc-run-error">{t("Missing")}</span>
                            </Show>
                            <Show when={entry.symlink}>
                              {(link) => (
                                <span class="fc-artifact-file-path" title={link().target}>
                                  {t("link to {target}", { target: link().target })}
                                </span>
                              )}
                            </Show>
                            <Show when={props.canOpenFiles && !entry.missing}>
                              <button class="fc-button" type="button" onClick={() => props.onOpenInEditor(entry.path)}>
                                {t("Open in editor")}
                              </button>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </Show>

            <section class="fc-usage-block">
              <h2>{t("Export to config repo")}</h2>
              <p class="fc-usage-note">
                {t(
                  "Copies the chosen global config files into the repository the global config names. Project files, and links that leave the repository, are left alone.",
                )}
              </p>
              <Show
                when={props.configRepo}
                fallback={
                  <p class="fc-run-error">{t("No config repository is set in the global config (flupcode.configRepo).")}</p>
                }
              >
                {(repo) => <p class="fc-usage-note">{t("Repository: {repo}", { repo: repo() })}</p>}
              </Show>
              <div class="fc-field-row">
                <label class="fc-field">
                  <span>{t("Config repository")}</span>
                  <input
                    class="fc-question-custom"
                    spellcheck={false}
                    value={repoInput()}
                    placeholder="/path/to/config"
                    onInput={(event) => setRepoInput(event.currentTarget.value)}
                  />
                </label>
                <button class="fc-button" type="button" onClick={saveRepo}>
                  {t("Save")}
                </button>
              </div>

              <div class="fc-modal-links">
                <button class="fc-button" type="button" onClick={toggleAll}>
                  {allSelected() ? t("Clear selection") : t("Select all")}
                </button>
                <button
                  class="fc-button fc-button-primary"
                  type="button"
                  disabled={exporting() || selectedPaths().length === 0 || !props.configRepo}
                  onClick={() => void runExport(false)}
                >
                  {t("Plan export")}
                </button>
              </div>

              <Show when={plan()}>
                {(value) => (
                  <ExportReport
                    value={value()}
                    title={t("This is a plan; nothing has been written yet.")}
                    onConfirm={() => void runExport(true)}
                  />
                )}
              </Show>

              <Show when={result()}>
                {(value) => (
                  <ExportReport value={value()} title={t("Exported {n} files.", { n: value().written.length })} />
                )}
              </Show>
            </section>
          </div>

          <div class="fc-dialog-actions">
            <button
              class="fc-button"
              type="button"
              disabled={reloading() || !props.serverAvailable}
              onClick={manualReload}
            >
              {reloading() ? t("Reloading…") : t("Reload")}
            </button>
            <button class="fc-button fc-button-primary" type="button" onClick={props.onClose}>
              {t("Close")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
