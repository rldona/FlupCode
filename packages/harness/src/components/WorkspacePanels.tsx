import {
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  on,
  untrack,
  type Component,
} from "solid-js"
import { createResource } from "../resource"
import type { FileDiffInfo, SessionInfo } from "../engine-types"
import { createClient } from "../client"
import { browser } from "../browser"
import { t } from "../i18n"
import { parsePatch } from "../highlight"
import { cssPx } from "../text-size"
import { Loader } from "./Loader"
import { TopIcon, TopbarIcons } from "./Topbar"

const TerminalPanel = lazy(() => import("./Terminal").then((module) => ({ default: module.TerminalPanel })))

type WorkspacePanelsProps = {
  panels: string[]
  serverUrl: string
  session: SessionInfo | undefined
  width: number
  /** Changes whenever messages or VCS status refresh, so the diff panel stays in sync. */
  revision?: unknown
  /** Project-relative paths in session order, most recently changed last. */
  changedFiles?: string[]
  onResize: (width: number) => void
  onClose: (kind: string) => void
}

/** Local dev servers people actually run, tried in order when detecting a preview. */
const DEV_SERVER_PORTS = [3000, 5173, 4200, 4321, 8000, 8080]

const BrowserIcons = {
  reload: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  external: "M14 5h5v5M19 5l-9 9M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
}

const BrowserPanel: Component = () => {
  const [history, setHistory] = createSignal<string[]>([])
  const [position, setPosition] = createSignal(-1)
  const [input, setInput] = createSignal("")
  const [reloadKey, setReloadKey] = createSignal(1)
  const [detecting, setDetecting] = createSignal(false)
  const [notice, setNotice] = createSignal("")

  const url = () => history()[position()] ?? ""
  const canBack = () => position() > 0
  const canForward = () => position() >= 0 && position() < history().length - 1

  const open = (target: string) => {
    const value = target.trim()
    if (!value) return
    const next = value.startsWith("http") ? value : `https://${value}`
    const list = history().slice(0, position() + 1)
    list.push(next)
    setHistory(list)
    setPosition(list.length - 1)
    setInput(next)
    setNotice("")
  }

  const jump = (offset: number) => {
    setPosition(position() + offset)
    setInput(url())
  }

  // A local preview linked from the transcript navigates this panel (see browser.ts).
  createEffect(
    on(browser.request, (pending) => {
      if (pending) open(pending.url)
    }),
  )

  // A no-cors request resolves once the server answers and rejects on connection refused, which is
  // enough to tell a running dev server apart from a closed port.
  const reachable = async (target: string) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 900)
    try {
      await fetch(target, { mode: "no-cors", signal: controller.signal })
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  const detect = async () => {
    setDetecting(true)
    setNotice("")
    for (const port of DEV_SERVER_PORTS) {
      const candidate = `http://localhost:${port}`
      if (!(await reachable(candidate))) continue
      open(candidate)
      setDetecting(false)
      return
    }
    setDetecting(false)
    setNotice(t("No dev server found"))
  }

  return (
    <div class="fc-panel-body fc-browser">
      <div class="fc-browser-bar">
        <button
          class="fc-browser-nav"
          type="button"
          title={t("Back")}
          aria-label={t("Back")}
          disabled={!canBack()}
          onClick={() => jump(-1)}
        >
          <TopIcon d={TopbarIcons.back} />
        </button>
        <button
          class="fc-browser-nav"
          type="button"
          title={t("Forward")}
          aria-label={t("Forward")}
          disabled={!canForward()}
          onClick={() => jump(1)}
        >
          <TopIcon d={TopbarIcons.forward} />
        </button>
        <button
          class="fc-browser-nav"
          type="button"
          title={t("Reload")}
          aria-label={t("Reload")}
          disabled={!url()}
          onClick={() => setReloadKey((key) => key + 1)}
        >
          <TopIcon d={BrowserIcons.reload} />
        </button>
        <input
          class="fc-browser-url"
          placeholder={t("Type a URL")}
          value={input()}
          spellcheck={false}
          onInput={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") open(input())
          }}
        />
        <button
          class="fc-browser-nav"
          type="button"
          title={t("Open in new tab")}
          aria-label={t("Open in new tab")}
          disabled={!url()}
          onClick={() => window.open(url(), "_blank", "noopener,noreferrer")}
        >
          <TopIcon d={BrowserIcons.external} />
        </button>
      </div>
      <Show
        when={url()}
        fallback={
          <div class="fc-empty-state fc-browser-empty">
            <svg class="fc-browser-globe" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5" />
              <path
                d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              />
            </svg>
            <span class="fc-empty-title">{t("Browse with FlupCode")}</span>
            <span class="fc-empty-hint">
              {t("Type a URL or ask FlupCode to open a site. Some sites don't allow embedding.")}
            </span>
            <button class="fc-button" type="button" disabled={detecting()} onClick={() => void detect()}>
              {detecting() ? t("Detecting…") : t("Detect dev server")}
            </button>
            <Show when={notice()}>
              <span class="fc-empty-hint">{notice()}</span>
            </Show>
          </div>
        }
      >
        <Show when={reloadKey()} keyed>
          {(_key) => (
            // The panel shows whatever the agent or the reader typed, so the page is untrusted: the
            // sandbox keeps it from navigating this window, opening dialogs or reaching the top
            // frame. `allow-same-origin` only keeps the page in its own origin (which is never the
            // harness's), so it still cannot touch anything here.
            <iframe
              class="fc-browser-frame"
              src={url()}
              title={t("Browser")}
              sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin"
              referrerpolicy="no-referrer"
            />
          )}
        </Show>
      </Show>
    </div>
  )
}

const DiffPanel: Component<{
  serverUrl: string
  session: SessionInfo | undefined
  revision: unknown
  changedFiles?: string[]
}> = (props) => {
  const [diff] = createResource(
    () => {
      const directory = props.session?.location?.directory
      return directory ? { url: props.serverUrl, directory, revision: props.revision } : undefined
    },
    (source) => createClient(source.url).vcs.diff(source.directory),
  )
  const [open, setOpen] = createSignal<string[]>([])
  const files = () => diff() ?? []
  // Git lists files by path, so order them session-first to keep the agent's last edit at the end.
  const ordered = createMemo(() => {
    const rank = new Map((props.changedFiles ?? []).map((file, index) => [file, index]))
    if (rank.size === 0) return files()
    return [...files()].sort((left, right) => (rank.get(left.file ?? "") ?? -1) - (rank.get(right.file ?? "") ?? -1))
  })
  const signature = createMemo(() =>
    ordered()
      .map((entry) => entry.file ?? "")
      .join("\n"),
  )
  let list: HTMLDivElement | undefined

  // Expand the stack for the file the session changed most recently and reveal it.
  createEffect(
    on(signature, () => {
      const entries = untrack(ordered)
      const last = entries[entries.length - 1]?.file
      setOpen(last ? [last] : [])
      if (typeof requestAnimationFrame !== "function") return
      requestAnimationFrame(() => list?.lastElementChild?.scrollIntoView({ block: "nearest" }))
    }),
  )

  const toggle = (entry: FileDiffInfo) => {
    const file = entry.file ?? ""
    setOpen((current) => (current.includes(file) ? current.filter((value) => value !== file) : [...current, file]))
  }

  return (
    <Show
      when={props.session}
      fallback={
        <div class="fc-empty-state">
          <span class="fc-empty-title">{t("No session")}</span>
        </div>
      }
    >
      <div class="fc-panel-body fc-files">
        <Show
          when={ordered().length > 0}
          fallback={
            <div class="fc-empty-state">
              <span class="fc-empty-title">{t("No changes")}</span>
              <span class="fc-empty-hint">{t("Files changed by the session appear here")}</span>
            </div>
          }
        >
          <div class="fc-file-list" ref={list}>
            <For each={ordered()}>
              {(entry) => {
                const file = () => entry.file ?? ""
                const expanded = () => open().includes(file())
                return (
                  <div class="fc-file" classList={{ "fc-file-open": expanded() }}>
                    <button
                      class="fc-file-header"
                      type="button"
                      aria-expanded={expanded()}
                      onClick={() => toggle(entry)}
                    >
                      <svg class="fc-file-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                        <path
                          d="m9 6 6 6-6 6"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        />
                      </svg>
                      <span class="fc-file-name" title={file()}>
                        {file()}
                      </span>
                      <span class="fc-file-stats">
                        <span class="fc-file-add">+{entry.additions}</span>
                        <span class="fc-file-del">-{entry.deletions}</span>
                      </span>
                    </button>
                    <Show when={expanded()}>
                      <Show when={entry.patch} fallback={<div class="fc-file-missing">{t("No diff available")}</div>}>
                        {(patch) => (
                          <div class="fc-file-patch">
                            <For each={parsePatch(patch())}>
                              {(row) => (
                                <div class={`fc-file-row fc-file-row-${row.type}`}>
                                  <span class="fc-file-no">{row.no ?? ""}</span>
                                  <span class="fc-file-sign">
                                    {row.type === "add" ? "+" : row.type === "del" ? "-" : " "}
                                  </span>
                                  <span class="fc-file-code">{row.text}</span>
                                </div>
                              )}
                            </For>
                          </div>
                        )}
                      </Show>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}

const TITLES: Record<string, string> = {
  browser: "Browser",
  diff: "Files changed",
  terminal: "Terminal",
}

/** The panels' width until the reader drags it; double-clicking their edge goes back to it. */
export const WORKSPACE_WIDTH_DEFAULT = 420

export const WorkspacePanels: Component<WorkspacePanelsProps> = (props) => {
  const [container, setContainer] = createSignal<HTMLElement>()

  return (
    <Show when={props.panels.length > 0}>
      <section class="fc-workspace" style={{ width: `${props.width}px` }} ref={setContainer}>
        <div
          class="fc-workspace-resizer"
          title={t("Drag to resize, double-click to reset")}
          onDblClick={() => props.onResize(WORKSPACE_WIDTH_DEFAULT)}
          onPointerDown={(event) => {
            const target = event.currentTarget
            target.setPointerCapture(event.pointerId)
            const move = (moveEvent: PointerEvent) => {
              const rect = container()?.getBoundingClientRect()
              if (!rect) return
              props.onResize(cssPx(rect.right - moveEvent.clientX))
            }
            const up = () => {
              target.removeEventListener("pointermove", move)
              target.removeEventListener("pointerup", up)
            }
            target.addEventListener("pointermove", move)
            target.addEventListener("pointerup", up)
          }}
        />
        <For each={props.panels}>
          {(kind) => (
            <div class="fc-panel">
              <div class="fc-panel-header">
                <span class="fc-panel-title">{t(TITLES[kind] ?? kind)}</span>
                <button
                  class="fc-icon-button"
                  type="button"
                  aria-label={t("Close")}
                  onClick={() => props.onClose(kind)}
                >
                  ×
                </button>
              </div>
              <Show when={kind === "browser"}>
                <BrowserPanel />
              </Show>
              <Show when={kind === "diff"}>
                <DiffPanel
                  serverUrl={props.serverUrl}
                  session={props.session}
                  revision={props.revision}
                  changedFiles={props.changedFiles}
                />
              </Show>
              <Show when={kind === "terminal"}>
                <Suspense
                  fallback={
                    <div class="fc-loading-center">
                      <Loader label={t("Loading terminal…")} />
                    </div>
                  }
                >
                  <TerminalPanel serverUrl={props.serverUrl} directory={props.session?.location?.directory} />
                </Suspense>
              </Show>
            </div>
          )}
        </For>
      </section>
    </Show>
  )
}
