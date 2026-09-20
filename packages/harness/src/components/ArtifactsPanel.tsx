import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import type { Artifact, ArtifactKind } from "../types"

type ArtifactsPanelProps = {
  open: boolean
  artifacts: Artifact[]
  /** Files this session wrote. Not artifacts, but the one useful thing the old panel showed. */
  sessionFiles: string[]
  serverAvailable: boolean
  onCopy: (path: string) => void
  onRemove: (id: string) => void
  /** Keep one in front, or say when it may be forgotten (H-14). */
  onUpdate: (id: string, input: { pinned?: boolean; expiresAt?: number | null }) => void
  onOpenRun: (runID: string) => void
  onClose: () => void
}

/** What each kind is called. Only the ones the harness writes today are offered as filters. */
const KINDS: ArtifactKind[] = ["report", "verdict", "plan", "handoff", "diff", "log", "file"]

const when = (at: number) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })

/** The one retention a reader can ask for in a click. Never is the default, and is a clear. */
const FORGET_DAYS = 30
const DAY_MS = 86_400_000

const size = (artifact: Artifact) => {
  const length = artifact.bytes ?? artifact.content?.length
  if (length === undefined) return undefined
  return length > 1000 ? `${Math.round(length / 100) / 10}k` : String(length)
}

/**
 * Artifacts (H-14): what the runs left behind.
 *
 * An index with a reader, not a CMS (§12.1). The panel this replaces listed the files the current
 * session had touched and called them artifacts; that list is still here, under its own heading and
 * its own name, because it was useful and it was not that.
 */
export const ArtifactsPanel: Component<ArtifactsPanelProps> = (props) => {
  const [kind, setKind] = createSignal<ArtifactKind>()
  const [openID, setOpenID] = createSignal<string>()

  const shown = createMemo(() => {
    const only = kind()
    return only ? props.artifacts.filter((artifact) => artifact.kind === only) : props.artifacts
  })
  const opened = createMemo(() => props.artifacts.find((artifact) => artifact.id === openID()))
  // Only the kinds that are actually there: a filter that always finds nothing is furniture.
  const kinds = createMemo(() => KINDS.filter((name) => props.artifacts.some((artifact) => artifact.kind === name)))

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Artifacts")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{t("Automation")}</div>
            <h1>{t("Artifacts")}</h1>
            <p>{t("What the runs left behind: reports, verdicts and plans.")}</p>
          </div>
          <div class="fc-routines-header-actions">
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Back to sessions")}
            </button>
          </div>
        </div>

        <Show when={!props.serverAvailable}>
          <div class="fc-routines-notice">{t("The harness server is not reachable, so this is the last it said.")}</div>
        </Show>

        <Show when={kinds().length > 1}>
          <div class="fc-routines-toolbar">
            <div class="fc-routines-tabs">
              <button
                class="fc-routines-tab"
                classList={{ "fc-routines-tab-active": !kind() }}
                type="button"
                onClick={() => setKind(undefined)}
              >
                {t("All")}
              </button>
              <For each={kinds()}>
                {(name) => (
                  <button
                    class="fc-routines-tab"
                    classList={{ "fc-routines-tab-active": kind() === name }}
                    type="button"
                    onClick={() => setKind(name)}
                  >
                    {t(name)}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show
          when={shown().length > 0}
          fallback={<div class="fc-runs-empty">{t("Nothing has been kept yet.")}</div>}
        >
          <div class="fc-runs-list">
            <For each={shown()}>
              {(artifact) => (
                <article class="fc-run-card">
                  <header class="fc-run-head">
                    <span class="fc-artifact-kind">{t(artifact.kind)}</span>
                    <span class="fc-run-title">{artifact.title}</span>
                    <span class="fc-run-meta">
                      {[
                        when(artifact.createdAt),
                        size(artifact),
                        artifact.truncated ? t("cut") : undefined,
                        artifact.expiresAt ? t("forgets {when}", { when: when(artifact.expiresAt) }) : undefined,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <button
                      class="fc-run-open fc-artifact-pin"
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
                        <button class="fc-run-open" type="button" onClick={() => props.onOpenRun(runID())}>
                          {t("Run")}
                        </button>
                      )}
                    </Show>
                    <Show when={artifact.content}>
                      <button
                        class="fc-run-open"
                        type="button"
                        onClick={() => setOpenID(openID() === artifact.id ? undefined : artifact.id)}
                      >
                        {openID() === artifact.id ? t("Hide") : t("Read")}
                      </button>
                    </Show>
                    <button
                      class="fc-run-open fc-run-danger"
                      type="button"
                      disabled={!props.serverAvailable}
                      onClick={() => props.onRemove(artifact.id)}
                    >
                      {t("Delete")}
                    </button>
                  </header>
                  <Show when={artifact.path}>{(path) => <p class="fc-artifact-path">{path()}</p>}</Show>
                  <Show when={opened()?.id === artifact.id}>
                    <pre class="fc-artifact-body">{artifact.content}</pre>
                    <Show when={artifact.truncated}>
                      <p class="fc-routine-muted">{t("Only the first part was kept.")}</p>
                    </Show>
                    {/*
                      Retention (H-14). Nothing expires by default: a date is stated by a reader, and
                      the server only acts on one that was. Pinned is separate — pinned is never swept.
                    */}
                    <div class="fc-artifact-retention">
                      <Show
                        when={artifact.expiresAt}
                        fallback={
                          <button
                            class="fc-button"
                            type="button"
                            disabled={!props.serverAvailable}
                            onClick={() => props.onUpdate(artifact.id, { expiresAt: Date.now() + FORGET_DAYS * DAY_MS })}
                          >
                            {t("Forget in {n} days", { n: FORGET_DAYS })}
                          </button>
                        }
                      >
                        {(at) => (
                          <>
                            <span class="fc-routine-muted">
                              {t("Forgotten on {when}", { when: when(at()) })}
                            </span>
                            <button
                              class="fc-button"
                              type="button"
                              disabled={!props.serverAvailable}
                              onClick={() => props.onUpdate(artifact.id, { expiresAt: null })}
                            >
                              {t("Keep indefinitely")}
                            </button>
                          </>
                        )}
                      </Show>
                    </div>
                  </Show>
                </article>
              )}
            </For>
          </div>
        </Show>

        <Show when={props.sessionFiles.length > 0}>
          <section class="fc-routine-detail-section">
            <h3>{t("Files this session wrote")}</h3>
            <ul class="fc-artifact-list">
              <For each={props.sessionFiles}>
                {(path) => (
                  <li class="fc-artifact-row">
                    <span class="fc-artifact-path">{path}</span>
                    <button class="fc-button" type="button" onClick={() => props.onCopy(path)}>
                      {t("Copy")}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </section>
    </Show>
  )
}
