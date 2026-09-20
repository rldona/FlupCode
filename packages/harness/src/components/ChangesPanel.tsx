import { For, Show, createEffect, createMemo, createSignal, on, type Component } from "solid-js"
import { t } from "../i18n"
import { parseHunks } from "../patch"
import { CheckpointList } from "./CheckpointList"
import { FileDiff, type FileChange } from "./FileDiff"
import type { Checkpoint, Finding, RestorePlan } from "../types"

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
  onCommit: (input: { message: string; paths: string[]; hunks?: Record<string, number[]> }) => void
  /** Throws a change away, or the named hunks of one (H-20). */
  onDiscard: (input: { path: string; hunks?: number[] }) => void
  /** A commit message written from the picked change, by the engine (H-20). */
  onGenerateMessage: (input: { paths: string[]; hunks?: Record<string, number[]> }) => Promise<string | undefined>
  onBranch: (name: string) => void
  /** Checkpoints for this folder (H-15). Absent where the harness server cannot answer. */
  checkpoints: Checkpoint[]
  checkpointBusy: boolean
  onCheckpointPlan: (id: string) => Promise<RestorePlan>
  onCheckpointRestore: (id: string) => void
  onCheckpointTake: (title: string) => void
  onCheckpointRemove: (id: string) => void
  /** A review's points about these files (H-32). */
  findings: Finding[]
  onResolveFinding: (id: string, resolved: boolean) => void
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
  // Which hunks of a file go into the next commit, by index. A file absent here is all of them, so a
  // reader who never touches a hunk commits whole files exactly as before (H-20).
  const [hunkPicks, setHunkPicks] = createSignal<Record<string, number[]>>({})
  const [generating, setGenerating] = createSignal(false)
  const [discarding, setDiscarding] = createSignal(false)
  const files = createMemo(() => props.changes.map((change) => change.file))
  // When the list itself changes — a commit landed, the mode was switched — start again from all of
  // it. Keeping a stale selection would leave paths ticked that git no longer reports as changed.
  createEffect(
    on(
      () => files().join("\n"),
      () => {
        setPicked(files())
        setHunkPicks({})
      },
    ),
  )
  const allHunks = (file: string) =>
    parseHunks(props.changes.find((change) => change.file === file)?.patch).map((_, index) => index)
  const hunksOf = (file: string) => hunkPicks()[file] ?? allHunks(file)
  const toggleHunk = (file: string, index: number, on: boolean) => {
    const current = hunksOf(file)
    const next = on ? [...new Set([...current, index])].sort((left, right) => left - right) : current.filter((it) => it !== index)
    setHunkPicks({ ...hunkPicks(), [file]: next })
  }
  // What the commit should stage: whole files normally, and only the chosen hunks of the ones a
  // reader narrowed down. A file that is not picked is not in here at all.
  const selection = () => {
    const hunks: Record<string, number[]> = {}
    for (const file of picked()) {
      const all = allHunks(file)
      const chosen = hunksOf(file)
      if (all.length > 0 && chosen.length !== all.length) hunks[file] = chosen
    }
    return { paths: picked(), hunks }
  }
  const discard = (path: string, hunks?: number[]) => {
    setDiscarding(true)
    props.onDiscard({ path, ...(hunks ? { hunks } : {}) })
    setHunkPicks({ ...hunkPicks(), [path]: hunks ? hunksOf(path).filter((it) => !hunks.includes(it)) : [] })
    setDiscarding(false)
  }
  const isPicked = (file: string) => picked().includes(file)
  const pick = (file: string, on: boolean) =>
    setPicked((current) => (on ? [...current, file] : current.filter((entry) => entry !== file)))
  const committable = () => props.mode === "git" && props.canCommit && props.changes.length > 0
  // By file, so each diff is handed only its own. A finding names the path as it appears in the
  // diff, which is what the review was asked to use.
  const findingsFor = createMemo(() => {
    const map = new Map<string, Finding[]>()
    for (const finding of props.findings) map.set(finding.file, [...(map.get(finding.file) ?? []), finding])
    return map
  })
  const openFindings = () => props.findings.filter((finding) => !finding.resolved).length

  const createBranch = () => {
    const name = branchName().trim()
    if (!name) return
    props.onBranch(name)
    setBranchName("")
    setNaming(false)
  }

  const submit = () => {
    if (picked().length === 0 || !message().trim()) return
    const chosen = selection()
    props.onCommit({
      message: message().trim(),
      paths: chosen.paths,
      ...(Object.keys(chosen.hunks).length > 0 ? { hunks: chosen.hunks } : {}),
    })
    setMessage("")
  }

  const generate = async () => {
    const pickedNow = selection()
    if (pickedNow.paths.length === 0) return
    setGenerating(true)
    try {
      const written = await props.onGenerateMessage(pickedNow)
      if (written) setMessage(written)
    } finally {
      setGenerating(false)
    }
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
          <Show when={openFindings() > 0}>
            <span class="fc-changes-findings">{t("{n} findings", { n: openFindings() })}</span>
          </Show>
          <Show when={props.changes.length > 0}>
            <span class="fc-changes-totals">
              {props.changes.length === 1 ? t("1 file") : t("{files} files", { files: props.changes.length })}
              <span class="fc-diff-plus">+{totals().additions}</span>
              <span class="fc-diff-minus">−{totals().deletions}</span>
            </span>
          </Show>
        </div>

        <Show when={props.error}>{(error) => <div class="fc-routines-notice">{error()}</div>}</Show>

        {/*
          Checkpoints sit above the diff on purpose. The diff says what changed; this says how to
          get back. Somebody who has just read a diff they did not want is already here.
        */}
        <Show when={props.canCommit && props.directory && props.mode === "git"}>
          <CheckpointList
            checkpoints={props.checkpoints}
            busy={props.checkpointBusy}
            onPlan={props.onCheckpointPlan}
            onRestore={props.onCheckpointRestore}
            onTake={props.onCheckpointTake}
            onRemove={props.onCheckpointRemove}
          />
        </Show>

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
                  <button
                    class="fc-button"
                    type="button"
                    disabled={generating() || picked().length === 0}
                    onClick={() => void generate()}
                  >
                    {generating() ? t("Writing…") : t("Generate message")}
                  </button>
                  <Show
                    when={naming()}
                    fallback={
                      <button class="fc-button" type="button" onClick={() => setNaming(true)}>
                        {t("New branch")}
                      </button>
                    }
                  >                    <input
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
                    selectedHunks={committable() ? hunksOf(change.file) : undefined}
                    onHunk={committable() ? (index, value) => toggleHunk(change.file, index, value) : undefined}
                    onDiscardHunk={props.canCommit ? (index) => discard(change.file, [index]) : undefined}
                    onDiscardFile={props.canCommit ? () => discard(change.file) : undefined}
                    discarding={discarding()}
                    findings={findingsFor().get(change.file)}
                    onResolveFinding={props.onResolveFinding}
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
