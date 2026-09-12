import { For, Show, Suspense, createResource, createSignal, lazy, type Component } from "solid-js"
import type { FileDiffInfo, SessionInfo } from "../engine-types"
import { createClient } from "../client"
import { t } from "../i18n"
import { Loader } from "./Loader"

const TerminalPanel = lazy(() => import("./Terminal").then((module) => ({ default: module.TerminalPanel })))

type WorkspacePanelsProps = {
  panels: string[]
  serverUrl: string
  session: SessionInfo | undefined
  width: number
  onResize: (width: number) => void
  onClose: (kind: string) => void
}

const BrowserPanel: Component = () => {
  const [url, setUrl] = createSignal("")
  const [input, setInput] = createSignal("")

  const go = () => {
    const value = input().trim()
    if (!value) return
    setUrl(value.startsWith("http") ? value : `https://${value}`)
  }

  return (
    <div class="fc-panel-body fc-browser">
      <div class="fc-browser-bar">
        <input
          class="fc-browser-url"
          placeholder={t("Type a URL")}
          value={input()}
          spellcheck={false}
          onInput={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") go()
          }}
        />
        <button class="fc-button" type="button" onClick={go}>
          {t("Go")}
        </button>
      </div>
      <Show
        when={url()}
        fallback={
          <div class="fc-empty-state">
            <span class="fc-empty-title">{t("No page")}</span>
            <span class="fc-empty-hint">{t("Type a URL to preview")}</span>
          </div>
        }
      >
        <iframe class="fc-browser-frame" src={url()} title="Browser" />
      </Show>
    </div>
  )
}

const DiffPanel: Component<{ serverUrl: string; session: SessionInfo | undefined }> = (props) => {
  const [diff] = createResource(
    () => {
      const sessionID = props.session?.id
      return sessionID ? { url: props.serverUrl, sessionID } : undefined
    },
    (source) => createClient(source.url).session.diff({ sessionID: source.sessionID }),
  )
  const [selected, setSelected] = createSignal<string>()

  const files = () => diff() ?? []
  const current = (): FileDiffInfo | undefined => {
    const list = files()
    return list.find((entry) => (entry.file ?? "") === selected()) ?? list[0]
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
      <div class="fc-panel-body fc-diff">
        <Show
          when={files().length > 0}
          fallback={
            <div class="fc-empty-state">
              <span class="fc-empty-title">{t("No changes")}</span>
            </div>
          }
        >
          <ul class="fc-diff-files">
            <For each={files()}>
              {(entry) => (
                <li>
                  <button
                    class="fc-diff-file"
                    classList={{ "fc-diff-file-active": (current()?.file ?? "") === (entry.file ?? "") }}
                    type="button"
                    onClick={() => setSelected(entry.file ?? "")}
                  >
                    <span class="fc-diff-name">{entry.file}</span>
                    <span class="fc-diff-stats">
                      <span class="fc-diff-add">+{entry.additions}</span>
                      <span class="fc-diff-del">-{entry.deletions}</span>
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
          <pre class="fc-diff-patch">{current()?.patch ?? ""}</pre>
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

export const WorkspacePanels: Component<WorkspacePanelsProps> = (props) => {
  const [container, setContainer] = createSignal<HTMLElement>()

  return (
    <Show when={props.panels.length > 0}>
      <section class="fc-workspace" style={{ width: `${props.width}px` }} ref={setContainer}>
        <div
          class="fc-workspace-resizer"
          onPointerDown={(event) => {
            const target = event.currentTarget
            target.setPointerCapture(event.pointerId)
            const move = (moveEvent: PointerEvent) => {
              const rect = container()?.getBoundingClientRect()
              if (!rect) return
              props.onResize(rect.right - moveEvent.clientX)
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
                <DiffPanel serverUrl={props.serverUrl} session={props.session} />
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
