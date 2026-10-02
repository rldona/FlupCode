import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import type { ModelInfo } from "../engine-types"
import type { Artifact, ResumePlan, Run, Task, TaskActivity, TaskTools, TouchedFiles, UsageRunReport } from "../types"
import { RunTaskDetail } from "./RunTaskDetail"
import { RunGraph, elapsed } from "./RunGraph"
import { StateBadge } from "./StateBadge"
import { CostFigure } from "./CostFigure"
import { purposeName } from "../cost"
import { AttentionMark } from "./AttentionMark"
import type { Attention } from "../attention"
import { runInputs, runTitle } from "../run-title"
import { runReason, runState } from "../run-state"
import { ResumeConfirm } from "./ResumeConfirm"

type RunsPanelProps = {
  open: boolean
  runs: Run[]
  /** What each run needs from the reader (UX-02), by run id: the sidebar's mark, on its card. */
  attention: Record<string, Attention | undefined>
  serverAvailable: boolean
  /** Resolves once the server has interrupted the run's sessions; rejects when it could not. */
  onStop: (id: string) => Promise<void>
  onApprove: (id: string) => void
  onClear: () => void
  onStopAll: () => void
  onRemove: (id: string) => void
  /** Merges the run's task worktrees back into its folder (H-29). */
  onMergeWorktrees: (id: string) => void
  /** Removes the run's task worktrees once they are not needed (H-29). */
  onCleanupWorktrees: (id: string) => void
  onOpenSession: (id: string) => void
  /** What the running tasks are doing right now (H-12), by task id. */
  activity: Record<string, TaskActivity>
  /** What each task changed on disk, by task id. Absent until a run has finished a task. */
  touched: Record<string, TouchedFiles>
  /** The timed calls of each task, by task id (H-16). */
  tools?: Record<string, TaskTools>
  /** What the runs left behind, by run id (H-14). */
  artifacts?: Record<string, Artifact[]>
  /** What each run spent, from the usage ledger (UL-06), by run id. A run not in it shows a dash. */
  usage?: Record<string, UsageRunReport>
  /** What a retry can run on, if the reader wants a different model (H-12). */
  models: ModelInfo[]
  /** Opens the changes screen for a run's folder, where its checkpoints can be restored (H-15). */
  onOpenChanges?: (directory?: string) => void
  /** Does a task again, as a new task of the same run (H-12). */
  onRetry: (taskID: string, model?: { providerID: string; id: string; variant?: string }) => void
  /** Sends a message to a running task's own session, which steers it (H-12). */
  onSteer: (taskID: string, text: string) => void
  /** Takes a queued task off the run without stopping the rest (HF-4). */
  onCancelTask: (taskID: string) => void
  /**
   * Picks up a run that failed, was stopped or lost its process (HF-5, RP-04): from a task, or from
   * where it broke.
   */
  onResume: (id: string, fromTask?: string) => void
  /** What resuming would do, asked before it is done (RP-04). */
  onResumePlan: (id: string, fromTask?: string) => Promise<ResumePlan>
  /** Opens the best-of-n launcher: one task, several models, then compare them (H-44). */
  onBestOfN: () => void
  /** Each routine's name, by id, so a routine's run is called what the reader called it (UX-04). */
  routineNames?: Record<string, string>
  /**
   * A run to bring into view when the screen opens, and the task whose detail to show, e.g. the
   * ones that produced an artifact (RP-03). `onFocused` lets it go once it is shown.
   */
  focus?: { runID: string; taskID?: string }
  onFocused?: () => void
}

/** Running, or held at a gate: either way it has not finished and cannot be forgotten yet. */
const going = (run: Run) => run.status === "running" || run.status === "awaiting"

/**
 * How far a run that is still going has got. What it cost is the ledger's (UL-06), drawn beside it
 * by `CostFigure` so the card, the Cost screen and the session show the same figure; how each task
 * stands is its node on the graph, so a finished run needs no count.
 */
const progress = (run: Run) => {
  const tasks = run.tasks ?? []
  if (!going(run) || tasks.length === 0) return []
  const done = tasks.filter((task) => task.status !== "queued" && task.status !== "running").length
  return [`${done}/${tasks.length}`]
}

/**
 * Whether a run that ended has anything to pick up (RP-04): work still queued, or a task that failed or
 * was stopped and has not been done again since.
 */
const resumable = (run: Run) => {
  const tasks = run.tasks ?? []
  const retried = new Set(tasks.flatMap((task) => (task.retryOf ? [task.retryOf] : [])))
  return (
    (run.status === "failed" || run.status === "stopped") &&
    tasks.some(
      (task) => task.status === "queued" || ((task.status === "failed" || task.status === "stopped") && !retried.has(task.id)),
    )
  )
}

/** A task's own rows of its run's ledger report: a retry is a task of its own, so its own bill. */
const taskUsage = (report: UsageRunReport | undefined, task: Task) => report?.byTask.find((group) => group.key === task.id)

/** Stand for the whole list where a run's id would be. No run can be called either of these. */
const ALL = "*"
const ALL_RUNNING = "*running"

/**
 * The supervisor (§6.4): a run and the tasks it is made of.
 *
 * Each run is one card that reads as one thing (UX-04): a header that says what ran, how it stands
 * and what it cost, once each; its tasks on the workflow's graph in their live state, each opening
 * its detail; and a footer with what it left behind — checkpoints, files and artifacts.
 *
 * It shows what the server actually knows. The audit's sketch also has files touched, tool counts and
 * a budget bar; none of those exist yet, and drawing them empty would say the harness knows something
 * it does not.
 */
export const RunsPanel: Component<RunsPanelProps> = (props) => {
  const title = (run: Run) =>
    runTitle(run, run.source.type === "routine" ? props.routineNames?.[run.source.routineID] : undefined)
  // Which run has been asked about, or ALL for the whole finished list. The question is drawn where
  // the button is: the list scrolls, and a confirmation at the foot of it is one nobody sees.
  const [confirming, setConfirming] = createSignal<string>()
  // The run whose resume is being asked about (RP-04), drawn in its card for the same reason.
  const [resuming, setResuming] = createSignal<string>()
  // Runs asked to stop that the server has not yet reported as stopped (TI-01): the card stays
  // "running" until the engine has let go, and the button says so instead of offering Stop again.
  const [stopping, setStopping] = createSignal<string[]>([])
  const stop = (id: string) => {
    setStopping((ids) => [...ids, id])
    props.onStop(id).catch(() => setStopping((ids) => ids.filter((entry) => entry !== id)))
  }
  // The task opened in the detail panel (§6.4). Its run is looked up, because a task carries only
  // its run's id.
  const [selectedTask, setSelectedTask] = createSignal<string>()
  createEffect(() => {
    const focus = props.focus
    if (!props.open || !focus || !props.runs.some((run) => run.id === focus.runID)) return
    if (focus.taskID) setSelectedTask(focus.taskID)
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`.fc-run-card[data-run-id="${CSS.escape(focus.runID)}"]`)
        ?.scrollIntoView({ block: "start" }),
    )
    props.onFocused?.()
  })
  const detail = createMemo(() => {
    const id = selectedTask()
    if (!id) return undefined
    const run = props.runs.find((entry) => (entry.tasks ?? []).some((task) => task.id === id))
    const task = run?.tasks?.find((entry) => entry.id === id)
    return run && task ? { run, task } : undefined
  })

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Runs")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{t("Automation")}</div>
            <h1>{t("Runs")}</h1>
            <p>{t("What the harness server is working on, task by task.")}</p>
          </div>
          <div class="fc-routines-header-actions">
            <button
              class="fc-button"
              type="button"
              disabled={!props.serverAvailable}
              onClick={props.onBestOfN}
            >
              {t("Best of N")}
            </button>
            <Show when={props.runs.some((run) => going(run))}>
              <button
                class="fc-button fc-button-danger"
                type="button"
                disabled={!props.serverAvailable}
                onClick={() => setConfirming(ALL_RUNNING)}
              >
                {t("Stop all")}
              </button>
            </Show>
            <Show when={props.runs.some((run) => !going(run))}>
              <button
                class="fc-button fc-button-danger"
                type="button"
                disabled={!props.serverAvailable}
                onClick={() => setConfirming(ALL)}
              >
                {t("Clear finished")}
              </button>
            </Show>
          </div>
        </div>

        <Show when={confirming() === ALL_RUNNING}>
          <div class="fc-confirm-inline">
            <span>{t("Stop every run that is going?")}</span>
            <button class="fc-button" type="button" onClick={() => setConfirming(undefined)}>
              {t("Cancel")}
            </button>
            <button
              class="fc-button fc-button-danger"
              type="button"
              onClick={() => {
                props.onStopAll()
                setConfirming(undefined)
              }}
            >
              {t("Stop")}
            </button>
          </div>
        </Show>

        <Show when={confirming() === ALL}>
          <div class="fc-confirm-inline">
            <span>{t("Delete every finished run?")}</span>
            {/* What a delete takes and what it keeps (RP-02), said before it happens. */}
            <span class="fc-run-meta">
              {t("Their tasks, findings, checkpoints and the evidence they left go too. Pinned artifacts, and anything an agent or you made, are kept.")}
            </span>
            <button class="fc-button" type="button" onClick={() => setConfirming(undefined)}>
              {t("Cancel")}
            </button>
            <button
              class="fc-button fc-button-danger"
              type="button"
              onClick={() => {
                props.onClear()
                setConfirming(undefined)
              }}
            >
              {t("Delete")}
            </button>
          </div>
        </Show>

        <Show when={!props.serverAvailable}>
          <div class="fc-routines-notice">{t("The harness server is not reachable, so this is the last it said.")}</div>
        </Show>

        <div class="fc-runs-layout">
        <Show when={props.runs.length > 0} fallback={<div class="fc-runs-empty">{t("Nothing has run yet.")}</div>}>
          <div class="fc-runs-list">
            <For each={props.runs}>
              {(run) => (
                <article class="fc-run-card" data-run-id={run.id} classList={{ "fc-run-running": going(run) }}>
                  <header class="fc-run-head">
                    <Show when={props.attention[run.id]}>{(level) => <AttentionMark level={level()} />}</Show>
                    <span class="fc-run-title">{title(run)}</span>
                    {/* How it stands, once: its verdict when it ended, never "success" beside it (P4). */}
                    <StateBadge state={runState(run)} reason={runReason(run)} />
                    <span class="fc-run-meta">{[elapsed(run.startedAt, run.finishedAt), ...progress(run)].join(" · ")}</span>
                    <span class="fc-run-cost">
                      <CostFigure bucket={props.usage?.[run.id]?.total} />
                    </span>
                    <Show when={run.sessionID}>
                      {(id) => (
                        <button class="fc-run-open" type="button" onClick={() => props.onOpenSession(id())}>
                          {t("Open")}
                        </button>
                      )}
                    </Show>
                    {/* A gate is a question: let it through, or stop it. There is no third answer. */}
                    <Show when={run.status === "awaiting"}>
                      <button
                        class="fc-run-open"
                        type="button"
                        disabled={!props.serverAvailable}
                        onClick={() => props.onApprove(run.id)}
                      >
                        {run.paused === "budget" ? t("Carry on") : t("Approve")}
                      </button>
                    </Show>
                    {/* A run of worktrees (H-29): its tasks wrote on their own branches, so there is
                        something to merge back and something to clean up. */}
                    <Show when={run.worktrees && !going(run)}>
                      <button
                        class="fc-run-open"
                        type="button"
                        disabled={!props.serverAvailable}
                        onClick={() => props.onMergeWorktrees(run.id)}
                      >
                        {t("Merge worktrees")}
                      </button>
                      <button
                        class="fc-run-open"
                        type="button"
                        disabled={!props.serverAvailable}
                        onClick={() => props.onCleanupWorktrees(run.id)}
                      >
                        {t("Clean up")}
                      </button>
                    </Show>
                    <Show
                      when={going(run)}
                      fallback={
                        <>
                          {/* A run that ended with work left can be picked up where it broke (HF-5, RP-04). */}
                          <Show when={resumable(run)}>
                            <button
                              class="fc-run-open"
                              type="button"
                              disabled={!props.serverAvailable}
                              onClick={() => setResuming(run.id)}
                            >
                              {t("Resume")}
                            </button>
                          </Show>
                          <button
                            class="fc-run-open fc-run-danger"
                            type="button"
                            disabled={!props.serverAvailable}
                            onClick={() => setConfirming(run.id)}
                          >
                            {t("Delete")}
                          </button>
                        </>
                      }
                    >
                      <button
                        class="fc-run-open fc-run-danger"
                        type="button"
                        disabled={!props.serverAvailable || stopping().includes(run.id)}
                        onClick={() => stop(run.id)}
                      >
                        {stopping().includes(run.id) ? t("Stopping…") : t("Stop")}
                      </button>
                    </Show>
                  </header>
                  {/* What a workflow run was given (RP-01): two runs of `feature` differ by their goal. */}
                  <Show when={runInputs(run)}>{(text) => <div class="fc-run-inputs">{text()}</div>}</Show>
                  <Show when={confirming() === run.id}>
                    <div class="fc-confirm-inline">
                      <span>{t("Delete this run?")}</span>
                      <span class="fc-run-meta">
                        {t("Its tasks, findings, checkpoints and the evidence it left go too. Pinned artifacts, and anything an agent or you made, are kept.")}
                      </span>
                      <button class="fc-button" type="button" onClick={() => setConfirming(undefined)}>
                        {t("Cancel")}
                      </button>
                      <button
                        class="fc-button fc-button-danger"
                        type="button"
                        onClick={() => {
                          props.onRemove(run.id)
                          setConfirming(undefined)
                        }}
                      >
                        {t("Delete")}
                      </button>
                    </div>
                  </Show>
                  <Show when={resuming() === run.id && resumable(run)}>
                    <ResumeConfirm
                      load={() => props.onResumePlan(run.id)}
                      busy={!props.serverAvailable}
                      onCancel={() => setResuming(undefined)}
                      onResume={() => {
                        props.onResume(run.id)
                        setResuming(undefined)
                      }}
                    />
                  </Show>
                  <Show when={run.error}>{(error) => <p class="fc-run-error">{error()}</p>}</Show>
                  {/*
                    Why its work was not done (RP-06), in the words of the task that decided it — whose
                    node is drawn in the same colour — unless the error above already says it.
                  */}
                  <Show
                    when={
                      (run.verdict?.value === "failed" || run.verdict?.value === "needs-user") &&
                      run.verdict.reason !== run.error
                        ? run.verdict
                        : undefined
                    }
                  >
                    {(verdict) => <p class="fc-verdict-reason">{verdict().reason}</p>}
                  </Show>
                  {/* A task that failed before anything judged it (a tool over its ceiling, H-47) says
                      why here, when the run itself has not said it yet. */}
                  <Show when={!run.error && !run.verdict ? (run.tasks ?? []).find((task) => task.status === "failed")?.error : undefined}>
                    {(error) => <p class="fc-run-error">{error()}</p>}
                  </Show>
                  {/*
                    What this run was allowed to do (H-47). Confinement is the default and says
                    nothing; reaching outside the project is unusual enough to be on the screen, and
                    a ceiling is worth reading before wondering why a task stopped. A run that
                    refused the shell says so too: a task that could not run a command explains
                    itself better here than in its answer.
                  */}
                  <Show when={run.outside || run.shell === false || run.toolLimitMs}>
                    <p class="fc-run-rules">
                      <Show when={run.outside}>
                        <span class="fc-run-rule fc-run-rule-open">{t("Reaches outside the project")}</span>
                      </Show>
                      <Show when={run.shell === false}>
                        <span class="fc-run-rule">{t("No shell commands")}</span>
                      </Show>
                      <Show when={run.toolLimitMs}>
                        {(limit) => (
                          <span class="fc-run-rule">
                            {t("{n} min limit for one tool call", { n: Math.round(limit() / 60_000) })}
                          </span>
                        )}
                      </Show>
                    </p>
                  </Show>
                  <RunGraph
                    tasks={run.tasks ?? []}
                    title={title(run)}
                    activity={props.activity}
                    selected={selectedTask()}
                    onSelect={setSelectedTask}
                  />
                  {/* What the run spent beyond its tasks (§8.4): handoffs and other purposes apart. */}
                  <Show when={(props.usage?.[run.id]?.byPurpose ?? []).some((group) => group.key !== "run-task")}>
                    <p class="fc-run-cost-breakdown">
                      <For each={props.usage![run.id]!.byPurpose}>
                        {(group) => (
                          <span class="fc-run-cost">
                            <span class="fc-run-meta">{group.key ? purposeName(group.key) : t("Not attributed")}</span>
                            <CostFigure bucket={group} />
                          </span>
                        )}
                      </For>
                    </p>
                  </Show>
                  <RunFooter
                    run={run}
                    tasks={run.tasks ?? []}
                    touched={(run.tasks ?? []).flatMap((task) => props.touched[task.id] ?? [])}
                    artifacts={props.artifacts?.[run.id] ?? []}
                    onOpenChanges={props.onOpenChanges}
                  />
                </article>
              )}
            </For>
          </div>
        </Show>
        </div>
        <Show when={detail()}>
          {(picked) => (
            <div class="fc-modal-backdrop" onClick={() => setSelectedTask(undefined)}>
              <div
                class="fc-modal fc-detail-modal"
                role="dialog"
                aria-modal="true"
                aria-label={t("Task detail")}
                onClick={(event) => event.stopPropagation()}
              >
                <div class="fc-modal-body">
                  <RunTaskDetail
                    run={picked().run}
                    task={picked().task}
                    activity={props.activity[picked().task.id]}
                    touched={props.touched[picked().task.id]}
                    tools={props.tools?.[picked().task.id]}
                    artifacts={(props.artifacts?.[picked().run.id] ?? []).filter((artifact) => artifact.taskID === picked().task.id)}
                    cost={taskUsage(props.usage?.[picked().run.id], picked().task)}
                    models={props.models}
                    serverAvailable={props.serverAvailable}
                    onOpenSession={props.onOpenSession}
                    onRetry={props.onRetry}
                    onSteer={props.onSteer}
                    onCancel={props.onCancelTask}
                    onResumePlan={(taskID) => props.onResumePlan(picked().run.id, taskID)}
                    onResume={(taskID) => {
                      props.onResume(picked().run.id, taskID)
                      setSelectedTask(undefined)
                    }}
                    onOpenChanges={props.onOpenChanges ?? (() => undefined)}
                    onClose={() => setSelectedTask(undefined)}
                  />
                </div>
              </div>
            </div>
          )}
        </Show>
      </section>
    </Show>
  )
}

/**
 * What a run left behind (UX-04): the checkpoints taken after its tasks (H-15), the files they
 * changed (H-12) and its artifacts (H-14), counted by kind. Each task's own point, files and
 * artifacts are in its detail, where its name is not said again.
 */
const RunFooter: Component<{
  run: Run
  tasks: Task[]
  touched: TouchedFiles[]
  artifacts: Artifact[]
  onOpenChanges?: (directory?: string) => void
}> = (props) => {
  // A file two tasks changed is one file the run changed; the last change says what happened to it.
  const files = createMemo(() => [
    ...new Map(props.touched.flatMap((point) => point.files).map((file) => [file.path, file])).values(),
  ])
  // Where the points live: a worktree task's are in its own tree (H-29, H-32), so when every point
  // was taken in one tree that is the one opened; a run spread over several opens its folder, and
  // each task's detail opens its own.
  const directory = () => {
    const trees = new Set(
      props.touched.map((point) => props.tasks.find((task) => task.id === point.taskID)?.directory ?? props.run.directory),
    )
    return trees.size === 1 ? [...trees][0] : props.run.directory
  }
  const kinds = createMemo(() =>
    [...new Set(props.artifacts.map((artifact) => artifact.kind))].map((kind) => ({
      kind,
      count: props.artifacts.filter((artifact) => artifact.kind === kind).length,
    })),
  )
  return (
    <Show when={props.touched.length > 0 || props.artifacts.length > 0}>
      <footer class="fc-run-foot">
        <Show when={props.touched.length > 0}>
          <Show when={props.onOpenChanges}>
            <button class="fc-run-open" type="button" onClick={() => props.onOpenChanges?.(directory())}>
              {t("Checkpoints")} <span class="fc-run-count">{props.touched.length}</span>
            </button>
          </Show>
          {/* A run that changed nothing says so rather than showing nothing. */}
          <Show when={files().length > 0} fallback={<span class="fc-run-files-none">{t("Changed no files")}</span>}>
            <details class="fc-run-files">
              <summary>{t("{n} files", { n: files().length })}</summary>
              <ul>
                <For each={files()}>
                  {(file) => (
                    <li data-status={file.status}>
                      <span class="fc-run-file-mark">
                        {file.status === "added" ? "+" : file.status === "deleted" ? "−" : "~"}
                      </span>
                      {file.path}
                    </li>
                  )}
                </For>
              </ul>
            </details>
          </Show>
        </Show>
        <Show when={kinds().length > 0}>
          <span class="fc-run-artifacts">
            <span class="fc-run-meta">{t("Artifacts")}</span>
            <For each={kinds()}>
              {(entry) => (
                <span class="fc-artifact-kind">
                  {t(entry.kind)}
                  <Show when={entry.count > 1}>
                    <span class="fc-run-count">{entry.count}</span>
                  </Show>
                </span>
              )}
            </For>
          </span>
        </Show>
      </footer>
    </Show>
  )
}
