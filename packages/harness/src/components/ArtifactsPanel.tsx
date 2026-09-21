import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import type { Artifact, ArtifactKind } from "../types"
import { viewerFor, viewerNeedsRaw } from "../artifact-view"
import { openImagePreview } from "../image-preview"
import { isAbsolutePath, joinPath } from "../folder"
import { Markdown } from "./Markdown"

type ArtifactsPanelProps = {
  open: boolean
  artifacts: Artifact[]
  /** Files this session wrote. Not artifacts, but the one useful thing the old panel showed. */
  sessionFiles: string[]
  serverAvailable: boolean
  /** Whether the app can open a local path (the desktop bridge). Web only has Copy. */
  canOpenFiles: boolean
  /** Where an artifact's bytes are served, for a viewer that draws rather than reads. */
  rawUrl: (id: string) => string
  onCopy: (path: string) => void
  onRemove: (id: string) => void
  /** Keep one in front, or say when it may be forgotten (H-14). */
  onUpdate: (id: string, input: { pinned?: boolean; expiresAt?: number | null }) => void
  onOpenRun: (runID: string) => void
  /** Open a path in the system's default app. */
  onOpenPath: (path: string) => void
  /** Open a path in the code editor (VS Code): the default for a generated file. */
  onOpenInEditor: (path: string) => void
}

/** What each kind is called. Only the ones the harness writes today are offered as filters. */
const KINDS: ArtifactKind[] = [
  "document",
  "plan",
  "report",
  "verdict",
  "diff",
  "log",
  "file",
  "handoff",
  "screenshot",
]

const when = (at: number) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })

/** The one retention a reader can ask for in a click. Never is the default, and is a clear. */
const FORGET_DAYS = 30
const DAY_MS = 86_400_000

const size = (artifact: Artifact) => {
  const length = artifact.bytes ?? artifact.content?.length
  if (length === undefined) return undefined
  return length > 1000 ? `${Math.round(length / 100) / 10}k` : String(length)
}

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/** An artifact's path is relative to its directory; the desktop bridge wants the absolute one. */
const resolvedPath = (artifact: Artifact) => {
  if (!artifact.path) return undefined
  if (!artifact.directory || isAbsolutePath(artifact.path)) return artifact.path
  return joinPath(artifact.directory, artifact.path)
}

/**
 * Artifacts (H-14): what the runs left behind, and what the agent kept.
 *
 * Two lists, one screen: the artifacts the harness indexed — a report, a verdict, a document the
 * agent generated — and the files this session wrote, which is the old panel's list under its own
 * heading. Each has its own search; the artifacts come first because they are the point.
 *
 * An artifact is read in place and fills the panel: a page is drawn in a sandbox, an image and a PDF
 * by the browser, markdown rendered, and everything else as its text. A left arrow comes back to the
 * list.
 */
export const ArtifactsPanel: Component<ArtifactsPanelProps> = (props) => {
  const [tab, setTab] = createSignal<"artifacts" | "files">("artifacts")
  const [kind, setKind] = createSignal<ArtifactKind>()
  const [query, setQuery] = createSignal("")
  const [selectedID, setSelectedID] = createSignal<string>()

  const selected = createMemo(() => props.artifacts.find((artifact) => artifact.id === selectedID()))

  const shown = createMemo(() => {
    const only = kind()
    const needle = query().trim().toLowerCase()
    return props.artifacts.filter(
      (artifact) =>
        (!only || artifact.kind === only) &&
        (!needle ||
          artifact.title.toLowerCase().includes(needle) ||
          (artifact.content ?? "").toLowerCase().includes(needle)),
    )
  })
  // Only the kinds that are actually there: a filter that always finds nothing is furniture.
  const kinds = createMemo(() => KINDS.filter((name) => props.artifacts.some((artifact) => artifact.kind === name)))

  const files = createMemo(() => {
    const needle = query().trim().toLowerCase()
    return props.sessionFiles.filter((path) => !needle || path.toLowerCase().includes(needle))
  })

  const open = (artifact: Artifact) => setSelectedID(artifact.id)
  // Leaving the viewer keeps the list where it was: the tab and the search are still set.
  const back = () => setSelectedID(undefined)

  const FileActions: Component<{ path: string }> = (row) => (
    <span class="fc-artifact-file-actions">
      <Show when={props.canOpenFiles}>
        <button class="fc-button fc-button-primary" type="button" onClick={() => props.onOpenInEditor(row.path)}>
          {t("VS Code")}
        </button>
        <button class="fc-button" type="button" onClick={() => props.onOpenPath(row.path)}>
          {t("Open")}
        </button>
      </Show>
      <button class="fc-button" type="button" onClick={() => props.onCopy(row.path)}>
        {t("Copy")}
      </button>
    </span>
  )

  const ArtifactBody: Component<{ artifact: Artifact }> = (body) => {
    const viewer = () => viewerFor(body.artifact)
    return (
      <Show
        when={!viewerNeedsRaw(viewer()) || body.artifact.path || body.artifact.content}
        fallback={<p class="fc-artifact-note">{t("This artifact has nothing to show.")}</p>}
      >
        <Show when={viewer() === "markdown"}>
          <div class="fc-artifact-markdown">
            <Markdown text={body.artifact.content ?? ""} />
          </div>
        </Show>
        <Show when={viewer() === "html"}>
          <iframe
            class="fc-artifact-frame"
            title={body.artifact.title}
            // Scripts run (a navigable index needs them) but the page keeps an opaque origin: it can
            // not reach the app's storage or this window.
            sandbox="allow-scripts allow-popups allow-forms"
            referrerpolicy="no-referrer"
            srcdoc={body.artifact.content ?? ""}
          />
        </Show>
        <Show when={viewer() === "image"}>
          <button
            class="fc-artifact-image"
            type="button"
            onClick={() =>
              openImagePreview({ uri: body.artifact.content ?? props.rawUrl(body.artifact.id), name: body.artifact.title })
            }
          >
            <img alt={body.artifact.title} src={body.artifact.content ?? props.rawUrl(body.artifact.id)} />
          </button>
        </Show>
        <Show when={viewer() === "pdf"}>
          <iframe class="fc-artifact-frame" title={body.artifact.title} src={props.rawUrl(body.artifact.id)} />
        </Show>
        <Show when={viewer() === "text"}>
          <pre class="fc-artifact-body">{body.artifact.content ?? ""}</pre>
        </Show>
      </Show>
    )
  }

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Artifacts")}>
        <Show
          when={selected()}
          fallback={
            <>
              <div class="fc-routines-header">
                <div>
                  <div class="fc-routines-kicker">{t("Automation")}</div>
                  <h1>{t("Artifacts")}</h1>
                  <p>{t("What the runs left behind: reports, verdicts, plans, and the documents the agent kept.")}</p>
                </div>
              </div>

              <Show when={!props.serverAvailable}>
                <div class="fc-routines-notice">
                  <span class="fc-routines-notice-icon">⚠</span>
                  <span>{t("The harness server is not reachable, so this is the last it said.")}</span>
                </div>
              </Show>

              {/* Two kinds of thing, two lists: the artifacts, then the files this session wrote. */}
              <div class="fc-routines-toolbar">
                <div class="fc-routines-tabs">
                  <button
                    class="fc-routines-tab"
                    classList={{ "fc-routines-tab-active": tab() === "artifacts" }}
                    type="button"
                    onClick={() => setTab("artifacts")}
                  >
                    {t("Artifacts")}
                    <span class="fc-workflow-count">{props.artifacts.length}</span>
                  </button>
                  <button
                    class="fc-routines-tab"
                    classList={{ "fc-routines-tab-active": tab() === "files" }}
                    type="button"
                    onClick={() => setTab("files")}
                  >
                    {t("Files this session wrote")}
                    <span class="fc-workflow-count">{props.sessionFiles.length}</span>
                  </button>
                </div>
                <input
                  class="fc-question-custom fc-routines-search"
                  value={query()}
                  placeholder={tab() === "artifacts" ? t("Search artifacts") : t("Search files")}
                  aria-label={tab() === "artifacts" ? t("Search artifacts") : t("Search files")}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </div>

              <Show when={tab() === "artifacts"}>
                <Show when={kinds().length > 1}>
                  <div class="fc-artifact-kinds">
                    <button
                      class="fc-session-tag"
                      classList={{ "fc-session-tag-active": !kind() }}
                      type="button"
                      onClick={() => setKind(undefined)}
                    >
                      {t("All")}
                    </button>
                    <For each={kinds()}>
                      {(name) => (
                        <button
                          class="fc-session-tag"
                          classList={{ "fc-session-tag-active": kind() === name }}
                          type="button"
                          onClick={() => setKind(name)}
                        >
                          {t(name)}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>

                <Show
                  when={shown().length > 0}
                  fallback={<div class="fc-runs-empty">{t("Nothing has been kept yet.")}</div>}
                >
                  <div class="fc-routine-cards">
                    <For each={shown()}>
                      {(artifact) => (
                        <article class="fc-routine-card fc-artifact-card">
                          <button class="fc-artifact-card-main" type="button" onClick={() => open(artifact)}>
                            <span class="fc-routine-card-content">
                              <span class="fc-artifact-card-title">
                                <span class="fc-artifact-kind">{t(artifact.kind)}</span>
                                <strong>{artifact.title}</strong>
                              </span>
                              <small>
                                {[
                                  when(artifact.createdAt),
                                  size(artifact),
                                  artifact.truncated ? t("cut") : undefined,
                                  artifact.expiresAt
                                    ? t("forgets {when}", { when: when(artifact.expiresAt) })
                                    : undefined,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </small>
                            </span>
                          </button>
                          <span class="fc-artifact-card-actions">
                            <button
                              class="fc-icon-button fc-artifact-pin"
                              classList={{ "fc-artifact-pinned": artifact.pinned }}
                              type="button"
                              aria-pressed={!!artifact.pinned}
                              title={artifact.pinned ? t("Remove from pinned") : t("Keep in front")}
                              aria-label={artifact.pinned ? t("Remove from pinned") : t("Keep in front")}
                              disabled={!props.serverAvailable}
                              onClick={() => props.onUpdate(artifact.id, { pinned: !artifact.pinned })}
                            >
                              {artifact.pinned ? "★" : "☆"}
                            </button>
                            <Show when={artifact.runID}>
                              {(runID) => (
                                <button class="fc-button" type="button" onClick={() => props.onOpenRun(runID())}>
                                  {t("Run")}
                                </button>
                              )}
                            </Show>
                            <button
                              class="fc-button fc-button-danger"
                              type="button"
                              disabled={!props.serverAvailable}
                              onClick={() => props.onRemove(artifact.id)}
                            >
                              {t("Delete")}
                            </button>
                          </span>
                        </article>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>

              <Show when={tab() === "files"}>
                <Show
                  when={files().length > 0}
                  fallback={<div class="fc-runs-empty">{t("This session has not written anything yet.")}</div>}
                >
                  <div class="fc-artifact-files">
                    <For each={files()}>
                      {(path) => (
                        <div class="fc-artifact-file">
                          <span class="fc-artifact-file-name" title={path}>
                            {fileName(path)}
                          </span>
                          <span class="fc-artifact-file-path" title={path}>
                            {path}
                          </span>
                          <FileActions path={path} />
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </>
          }
        >
          {(artifact) => (
            <div class="fc-artifact-viewer">
              <div class="fc-artifact-viewer-bar">
                <button class="fc-icon-button" type="button" aria-label={t("Back")} title={t("Back")} onClick={back}>
                  ←
                </button>
                <span class="fc-artifact-kind">{t(artifact().kind)}</span>
                <span class="fc-artifact-viewer-title" dir="auto">
                  {artifact().title}
                </span>
                <span class="fc-artifact-viewer-actions">
                  <Show when={artifact().path && props.canOpenFiles}>
                    <button
                      class="fc-button fc-button-primary"
                      type="button"
                      onClick={() => props.onOpenInEditor(resolvedPath(artifact())!)}
                    >
                      {t("VS Code")}
                    </button>
                    <button class="fc-button" type="button" onClick={() => props.onOpenPath(resolvedPath(artifact())!)}>
                      {t("Open")}
                    </button>
                  </Show>
                  <Show when={artifact().path}>
                    <button class="fc-button" type="button" onClick={() => props.onCopy(resolvedPath(artifact())!)}>
                      {t("Copy path")}
                    </button>
                  </Show>
                </span>
              </div>
              <div class="fc-artifact-viewer-body">
                <ArtifactBody artifact={artifact()} />
              </div>
              {/* Retention (H-14): nothing expires by default, and a pinned one is never swept. */}
              <div class="fc-artifact-retention">
                <Show
                  when={artifact().expiresAt}
                  fallback={
                    <button
                      class="fc-button"
                      type="button"
                      disabled={!props.serverAvailable}
                      onClick={() => props.onUpdate(artifact().id, { expiresAt: Date.now() + FORGET_DAYS * DAY_MS })}
                    >
                      {t("Forget in {n} days", { n: FORGET_DAYS })}
                    </button>
                  }
                >
                  {(at) => (
                    <>
                      <span class="fc-routine-muted">{t("Forgotten on {when}", { when: when(at()) })}</span>
                      <button
                        class="fc-button"
                        type="button"
                        disabled={!props.serverAvailable}
                        onClick={() => props.onUpdate(artifact().id, { expiresAt: null })}
                      >
                        {t("Keep indefinitely")}
                      </button>
                    </>
                  )}
                </Show>
              </div>
              <Show when={artifact().truncated}>
                <p class="fc-artifact-note">{t("Only the first part was kept.")}</p>
              </Show>
            </div>
          )}
        </Show>
      </section>
    </Show>
  )
}
