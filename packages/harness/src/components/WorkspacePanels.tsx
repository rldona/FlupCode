import {
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  on,
  onCleanup,
  type Component,
} from "solid-js"
import { createResource } from "../resource"
import type { SessionInfo } from "../engine-types"
import { createClient, createHarnessClient, type AgentBrowserSession } from "../client"
import { browser } from "../browser"
import { t } from "../i18n"
import { cssPx } from "../text-size"
import { FileDiff } from "./FileDiff"
import { Loader } from "./Loader"
import { TopIcon, TopbarIcons } from "./Topbar"

const TerminalPanel = lazy(() => import("./Terminal").then((module) => ({ default: module.TerminalPanel })))

type WorkspacePanelsProps = {
  panels: string[]
  serverUrl: string
  harnessServerUrl: string
  session: SessionInfo | undefined
  width: number
  /** Changes whenever messages or VCS status refresh, so the diff panel stays in sync. */
  revision?: unknown
  /** Project-relative paths in session order, most recently changed last. */
  changedFiles?: string[]
  /** Opens the full-width diff viewer on the session's folder. */
  onOpenChanges?: () => void
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

/** How often the live view polls the latest frame while a browser session is open. */
const AGENT_FRAME_POLL_MS = 2000

/**
 * The live view and its takeover (WA-6): the latest frame of the session's browser run, what it
 * shows, and Take over / Release / Stop. Take over reveals the headed window and holds the agent;
 * Release lets it carry on; Stop ends the run. Without the desktop's token the controls are refused
 * and the panel only watches.
 */
const AgentBrowserPanel: Component<{ harnessServerUrl: string; sessionID: string | undefined }> = (props) => {
  // The run's status: `undefined` while it loads, `null` when no browser session is open.
  const [status, setStatus] = createSignal<AgentBrowserSession | null | undefined>(undefined)
  const [frame, setFrame] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal<string | undefined>()
  const [notice, setNotice] = createSignal("")

  const client = () => createHarnessClient(props.harnessServerUrl)

  const refreshStatus = async () => {
    const sessionID = props.sessionID
    if (!sessionID) {
      setStatus(null)
      return
    }
    try {
      setStatus(await client().agentBrowser.session(sessionID))
    } catch {
      // No session on the runtime, or it went away: the empty state covers it and the next poll
      // or event tries again.
      setStatus(null)
    }
  }

  // A poll, an event and a button can all ask for a frame at once; only one fetch runs and the
  // picture swaps only after the new PNG decoded, so the old frame stays painted instead of flashing.
  let inflight: Promise<void> | undefined
  let alive = true

  const refreshFrame = () => {
    const sessionID = props.sessionID
    if (!sessionID || inflight) return Promise.resolve()
    inflight = (async () => {
      try {
        const next = await client().agentBrowser.frame(sessionID, { store: false })
        const url = URL.createObjectURL(next.blob)
        try {
          await new Promise<void>((resolve, reject) => {
            const pending = new Image()
            pending.onload = () => resolve()
            pending.onerror = () => reject(new Error("frame"))
            pending.src = url
          })
        } catch {
          URL.revokeObjectURL(url)
          return
        }
        if (!alive) {
          URL.revokeObjectURL(url)
          return
        }
        const previous = frame()
        if (previous) URL.revokeObjectURL(previous)
        setFrame(url)
      } catch {
        // A frame that is not there yet is not an error: the next poll tries again.
      } finally {
        inflight = undefined
      }
    })()
    return inflight
  }

  const act = (name: string, call: (sessionID: string) => Promise<unknown>) => {
    const sessionID = props.sessionID
    if (!sessionID || busy()) return
    setBusy(name)
    setNotice("")
    void call(sessionID)
      .then(() => refreshStatus())
      .then(() => refreshFrame())
      .catch((cause) => setNotice(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(undefined))
  }

  // A new session starts blank: its frames and its status belong to whoever ran before.
  createEffect(
    on(
      () => props.sessionID,
      () => {
        const previous = frame()
        if (previous) URL.revokeObjectURL(previous)
        setFrame(undefined)
        setNotice("")
        setStatus(undefined)
        void refreshStatus().then(() => void refreshFrame())
      },
    ),
  )

  onCleanup(() => {
    alive = false
    const previous = frame()
    if (previous) URL.revokeObjectURL(previous)
  })

  // Frames arrive as stored artifacts and statuses as lifecycle changes; the poll below is what
  // moves the picture when the stream is away.
  createEffect(() => {
    const sessionID = props.sessionID
    const url = props.harnessServerUrl
    if (!sessionID) return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    void (async () => {
      for (let attempt = 0; !controller.signal.aborted; attempt++) {
        try {
          for await (const event of createHarnessClient(url).events({ signal: controller.signal })) {
            attempt = 0
            const type = (event as { type?: string }).type
            if (type !== "browser.frame" && type !== "browser.status") continue
            if ((event as { sessionID?: string }).sessionID !== sessionID) continue
            if (type === "browser.status") void refreshStatus()
            else void refreshFrame()
          }
        } catch {
          if (controller.signal.aborted) return
        }
        if (controller.signal.aborted) return
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)))
      }
    })()
  })

  createEffect(() => {
    if (!props.sessionID) return
    const timer = setInterval(() => {
      void refreshFrame()
    }, AGENT_FRAME_POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <div class="fc-panel-body fc-agent-browser">
      <Show
        when={props.sessionID}
        fallback={
          <div class="fc-empty-state">
            <span class="fc-empty-title">{t("No session")}</span>
          </div>
        }
      >
        <Show
          when={status()}
          fallback={
            <div class="fc-empty-state fc-browser-empty">
              <span class="fc-empty-title">{t("No browser session")}</span>
              <span class="fc-empty-hint">{t("The agent's browser appears here while it acts on a site.")}</span>
            </div>
          }
        >
            {(live) => (
            <>
              <Show when={frame()} fallback={<div class="fc-agent-browser-frame fc-agent-browser-waiting" />}>
                {(src) => <img class="fc-agent-browser-frame" src={src()} alt={live().title || live().url} />}
              </Show>
              <div class="fc-agent-browser-meta">
                <span class="fc-agent-browser-url" title={live().url}>
                  {live().title || live().url}
                </span>
                <span class="fc-agent-browser-state">{live().paused ? t("Paused") : t("Running")}</span>
              </div>
              <div class="fc-agent-browser-actions">
                <button
                  class="fc-button"
                  type="button"
                  disabled={busy() !== undefined || live().paused}
                  onClick={() => act("takeover", (id) => client().agentBrowser.takeOver(id))}
                >
                  {busy() === "takeover" ? t("Loading…") : t("Take over")}
                </button>
                <button
                  class="fc-button"
                  type="button"
                  disabled={busy() !== undefined || !live().paused}
                  onClick={() => act("resume", (id) => client().agentBrowser.resume(id))}
                >
                  {busy() === "resume" ? t("Loading…") : t("Release")}
                </button>
                <button
                  class="fc-button"
                  type="button"
                  disabled={busy() !== undefined}
                  onClick={() => act("stop", (id) => client().agentBrowser.stop(id))}
                >
                  {busy() === "stop" ? t("Loading…") : t("Stop")}
                </button>
              </div>
              <Show when={notice()}>
                <span class="fc-agent-browser-notice">{notice()}</span>
              </Show>
            </>
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
  onOpenChanges?: () => void
}> = (props) => {
  const [diff] = createResource(
    () => {
      const directory = props.session?.location?.directory
      return directory ? { url: props.serverUrl, directory, revision: props.revision } : undefined
    },
    (source) => createClient(source.url).vcs.diff(source.directory),
  )
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

  // Reveal the file the session changed most recently; which one opens is `FileDiff`'s own business.
  createEffect(
    on(signature, () => {
      if (typeof requestAnimationFrame !== "function") return
      requestAnimationFrame(() => list?.lastElementChild?.scrollIntoView({ block: "nearest" }))
    }),
  )

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
          {/* This panel is 420 pixels wide and a patch is not. The way out is one click away. */}
          <Show when={props.onOpenChanges}>
            <button class="fc-files-wide" type="button" onClick={() => props.onOpenChanges?.()}>
              {t("Open the diff viewer")}
            </button>
          </Show>
          <div class="fc-changes-list fc-changes-list-panel" ref={list}>
            <For each={ordered()}>
              {(entry, index) => (
                <FileDiff
                  change={{
                    file: entry.file ?? "",
                    patch: entry.patch,
                    additions: entry.additions,
                    deletions: entry.deletions,
                    status: entry.status,
                  }}
                  open={index() === ordered().length - 1}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}

const TITLES: Record<string, string> = {
  browser: "Browser",
  "agent-browser": "Agent browser",
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
              <Show when={kind === "agent-browser"}>
                <AgentBrowserPanel harnessServerUrl={props.harnessServerUrl} sessionID={props.session?.id} />
              </Show>
              <Show when={kind === "diff"}>
                <DiffPanel
                  serverUrl={props.serverUrl}
                  session={props.session}
                  revision={props.revision}
                  changedFiles={props.changedFiles}
                  onOpenChanges={props.onOpenChanges}
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
