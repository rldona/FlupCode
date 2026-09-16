import { For, Show, createMemo, type Component } from "solid-js"
import { t } from "../i18n"
import { FileDiff, type FileChange } from "./FileDiff"

export type DiffMode = "git" | "branch"

type ChangesPanelProps = {
  open: boolean
  /** The folder being read. Absent when no session and no folder is picked. */
  directory?: string
  branch?: string
  defaultBranch?: string
  changes: FileChange[]
  loading: boolean
  error?: string
  mode: DiffMode
  onMode: (mode: DiffMode) => void
  onRefresh: () => void
  onClose: () => void
}

const name = (directory: string) => directory.split("/").filter(Boolean).at(-1) ?? directory

/**
 * The diff viewer (H-06): what the working tree says has changed, at a width you can read it at.
 *
 * The files panel beside a session already drew a patch, but at 420 pixels and with git's own file
 * header rendered as code — and it asked the engine for a diff with no `context`, which for one
 * changed line in a 250-line file sends all 250. Measured on a real repo: 254 rows for an eight-row
 * change, against 35 once the request says `context=3`. That is why this exists.
 *
 * Two modes, because they answer different questions. **Working tree** is what is not committed
 * yet — what a run just did to the folder. **Branch** is everything this branch has that the
 * default branch does not, which is what survives once a run commits and the working tree is clean
 * again. Nothing here guesses which one the reader wants; the toggle says which one is showing.
 */
export const ChangesPanel: Component<ChangesPanelProps> = (props) => {
  const totals = createMemo(() =>
    props.changes.reduce(
      (sum, change) => ({ additions: sum.additions + change.additions, deletions: sum.deletions + change.deletions }),
      { additions: 0, deletions: 0 },
    ),
  )
  const subtitle = () =>
    props.mode === "git"
      ? t("Everything in the folder that is not committed yet.")
      : props.defaultBranch
        ? t("Everything this branch has that {branch} does not.", { branch: props.defaultBranch })
        : t("Everything this branch has that the default branch does not.")

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Changes")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{props.directory ? name(props.directory) : t("Changes")}</div>
            <h1>
              {t("Changes")}
              <Show when={props.branch}>
                <span class="fc-changes-branch">{props.branch}</span>
              </Show>
            </h1>
            <p>{subtitle()}</p>
          </div>
          <div class="fc-routines-header-actions">
            <button class="fc-button" type="button" disabled={props.loading} onClick={props.onRefresh}>
              {props.loading ? t("Reading…") : t("Refresh")}
            </button>
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Back to sessions")}
            </button>
          </div>
        </div>

        <div class="fc-routines-toolbar">
          <div class="fc-routines-tabs">
            <button
              class="fc-routines-tab"
              classList={{ "fc-routines-tab-active": props.mode === "git" }}
              type="button"
              onClick={() => props.onMode("git")}
            >
              {t("Working tree")}
            </button>
            <button
              class="fc-routines-tab"
              classList={{ "fc-routines-tab-active": props.mode === "branch" }}
              type="button"
              onClick={() => props.onMode("branch")}
            >
              {t("Branch")}
            </button>
          </div>
          <Show when={props.changes.length > 0}>
            <span class="fc-changes-totals">
              {props.changes.length === 1 ? t("1 file") : t("{files} files", { files: props.changes.length })}
              <span class="fc-diff-plus">+{totals().additions}</span>
              <span class="fc-diff-minus">−{totals().deletions}</span>
            </span>
          </Show>
        </div>

        <Show when={props.error}>{(error) => <div class="fc-routines-notice">{error()}</div>}</Show>

        <Show
          when={props.directory}
          fallback={<div class="fc-runs-empty">{t("Pick a folder to see what has changed in it.")}</div>}
        >
          <Show
            when={props.changes.length > 0}
            fallback={
              <div class="fc-runs-empty">{props.loading ? t("Reading…") : t("Nothing has changed here.")}</div>
            }
          >
            <div class="fc-changes-list">
              <For each={props.changes}>
                {(change) => <FileDiff change={change} open={props.changes.length === 1} />}
              </For>
            </div>
          </Show>
        </Show>
      </section>
    </Show>
  )
}
