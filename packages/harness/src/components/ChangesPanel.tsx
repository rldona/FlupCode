import { For, Show, createEffect, createMemo, createSignal, on, type Component } from "solid-js"
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
  /** Whether the harness server — the only part of FlupCode that can run git — is answering. */
  canCommit: boolean
  committing: boolean
  onMode: (mode: DiffMode) => void
  onRefresh: () => void
  onCommit: (input: { message: string; paths: string[] }) => void
  onBranch: (name: string) => void
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
  // Which files go into the next commit. Everything, until somebody says otherwise: a run usually
  // means one change, and making the reader tick four boxes to commit what they just read is work
  // for its own sake. Unticking is the deliberate act, and it is the one worth making explicit.
  const [picked, setPicked] = createSignal<string[]>([])
  const [message, setMessage] = createSignal("")
  const [naming, setNaming] = createSignal(false)
  const [branchName, setBranchName] = createSignal("")
  const files = createMemo(() => props.changes.map((change) => change.file))
  // When the list itself changes — a commit landed, the mode was switched — start again from all of
  // it. Keeping a stale selection would leave paths ticked that git no longer reports as changed.
  createEffect(
    on(
      () => files().join("\n"),
      () => setPicked(files()),
    ),
  )
  const isPicked = (file: string) => picked().includes(file)
  const pick = (file: string, on: boolean) =>
    setPicked((current) => (on ? [...current, file] : current.filter((entry) => entry !== file)))
  const committable = () => props.mode === "git" && props.canCommit && props.changes.length > 0

  const createBranch = () => {
    const name = branchName().trim()
    if (!name) return
    props.onBranch(name)
    setBranchName("")
    setNaming(false)
  }

  const submit = () => {
    const paths = picked()
    if (paths.length === 0 || !message().trim()) return
    props.onCommit({ message: message().trim(), paths })
    setMessage("")
  }

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
            <Show when={committable()}>
              <form
                class="fc-commit"
                onSubmit={(event) => {
                  event.preventDefault()
                  submit()
                }}
              >
                <textarea
                  class="fc-commit-message"
                  rows="2"
                  placeholder={t("What this change does, and why")}
                  value={message()}
                  disabled={props.committing}
                  aria-label={t("Commit message")}
                  onInput={(event) => setMessage(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    // The shortcut every commit box has. Return alone still writes a second line.
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      submit()
                    }
                  }}
                />
                <div class="fc-commit-actions">
                  <span class="fc-commit-count">
                    {picked().length !== props.changes.length
                      ? t("{n} of {total}", { n: picked().length, total: props.changes.length })
                      : props.changes.length === 1
                        ? t("1 file")
                        : t("All {n} files", { n: props.changes.length })}
                  </span>
                  {/*
                    A button to ask for the field, and a button to use it. Return works too, but it
                    is not the only way in: this field lives inside the commit form, where Return
                    already means something else, and a control whose only affordance is a key
                    nobody was told about is a control most people never find.
                  */}
                  <Show
                    when={naming()}
                    fallback={
                      <button class="fc-button" type="button" onClick={() => setNaming(true)}>
                        {t("New branch")}
                      </button>
                    }
                  >
                    <input
                      class="fc-input fc-commit-branch"
                      placeholder={t("Branch name")}
                      value={branchName()}
                      aria-label={t("Branch name")}
                      onInput={(event) => setBranchName(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setNaming(false)
                        if (event.key !== "Enter") return
                        // Return in a form's field submits the form, which here would be the commit.
                        event.preventDefault()
                        createBranch()
                      }}
                    />
                    <button
                      class="fc-button"
                      type="button"
                      disabled={!branchName().trim()}
                      onClick={createBranch}
                    >
                      {t("Create")}
                    </button>
                  </Show>
                  <button
                    class="fc-button fc-button-primary"
                    type="submit"
                    disabled={props.committing || picked().length === 0 || !message().trim()}
                  >
                    {props.committing ? t("Committing…") : t("Commit")}
                  </button>
                </div>
              </form>
            </Show>

            <div class="fc-changes-list">
              <For each={props.changes}>
                {(change) => (
                  <FileDiff
                    change={change}
                    open={props.changes.length === 1}
                    selected={committable() ? isPicked(change.file) : undefined}
                    onSelect={committable() ? (value) => pick(change.file, value) : undefined}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </section>
    </Show>
  )
}
