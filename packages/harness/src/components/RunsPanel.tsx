import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import type { ModelInfo } from "../engine-types"
import type { Artifact, Run, Task, TaskActivity, TaskStatus, TaskTools, TouchedFiles } from "../types"
import { RunTaskDetail } from "./RunTaskDetail"
import { RunTimeline } from "./RunTimeline"

type RunsPanelProps = {
  open: boolean
  runs: Run[]
  serverAvailable: boolean
  onStop: (id: string) => void
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
  /** Picks up a run that ended with work still queued (HF-5). */
  onResume: (id: string) => void
  /** Opens the best-of-n launcher: one task, several models, then compare them (H-44). */
  onBestOfN: () => void
  onClose: () => void
}

/**
 * How long a single tool call may run before it is worth saying so.
 *
 * Not a limit and not a kill: a test suite legitimately takes minutes, and stopping somebody's
 * build on a guess is worse than the problem. H-47 was eighteen minutes inside one `glob` that
 * looked exactly like work — this is the point at which it stops looking like work.
 */
const LONG_MS = 3 * 60_000

/** Minutes and seconds, or seconds alone: a run is read while it happens, not measured. */
const elapsed = (from: number, to: number | undefined) => {
  const seconds = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}

const marks: Record<TaskStatus, string> = {
  queued: "○",
  running: "◐",
  success: "●",
  failed: "✕",
  stopped: "■",
  // A task the graph never ran because a dependency failed or a `when` was false (H-28).
  skipped: "–",
}

/** Running, or held at a gate: either way it has not finished and cannot be forgotten yet. */
const going = (run: Run) => run.status === "running" || run.status === "awaiting"

const money = (value: number | undefined) => (value === undefined ? undefined : `$${value.toFixed(2)}`)
const thousands = (value: number | undefined) =>
  value === undefined ? undefined : value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(value)

/**
 * The run's own report: what its tasks add up to.
 *
 * This is where the summary of a run lives. The audit (§6.3) puts it in the run's session as a
 * message too, but the engine has no way to append one without running a turn — writing it would
 * mean paying a model to restate what the harness already knows exactly. The session stays the
 * thread that groups the work; the numbers are here.
 */
const totals = (run: Run) => {
  const tasks = run.tasks ?? []
  const tokens = tasks.reduce((sum, task) => sum + (task.tokens ?? 0), 0)
  const cost = tasks.reduce((sum, task) => sum + (task.cost ?? 0), 0)
  const done = tasks.filter((task) => task.status !== "queued" && task.status !== "running").length
  return [
    tasks.length ? `${done}/${tasks.length}` : undefined,
    thousands(tokens || undefined),
    cost ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : undefined,
  ].filter((value): value is string => !!value)
}

/** What a task is worth saying on one line, with the parts the engine did not report left out. */
const facts = (task: Task) => {
  const started = task.startedAt
  return [
    task.kind === "verify" ? t("verify") : task.kind === "external" ? t("external") : task.agent,
    // Only from the second: saying "attempt 1" on every task is noise on the runs that went fine.
    (task.attempt ?? 1) > 1 ? t("attempt {n}", { n: task.attempt! }) : undefined,
    started ? elapsed(started, task.finishedAt) : undefined,
    thousands(task.tokens),
    money(task.cost),
  ].filter((value): value is string => !!value)
}

/** Stand for the whole list where a run's id would be. No run can be called either of these. */
const ALL = "*"
const ALL_RUNNING = "*running"

/**
 * The supervisor (§6.4): a run and the tasks it is made of, as a tree.
 *
 * It shows what the server actually knows. The audit's sketch also has files touched, tool counts and
 * a budget bar; none of those exist yet, and drawing them empty would say the harness knows something
 * it does not.
 */
export const RunsPanel: Component<RunsPanelProps> = (props) => {
  // Which run has been asked about, or ALL for the whole finished list. The question is drawn where
  // the button is: the list scrolls, and a confirmation at the foot of it is one nobody sees.
  const [confirming, setConfirming] = createSignal<string>()
  // The task opened in the detail panel (§6.4). Its run is looked up, because a task carries only
  // its run's id.
  const [selectedTask, setSelectedTask] = createSignal<string>()
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
                <article class="fc-run-card" classList={{ "fc-run-running": going(run) }}>
                  <header class="fc-run-head">
                    <span class="fc-run-mark" data-status={run.status}>
                      {going(run) ? marks.running : marks[run.status as TaskStatus]}
                    </span>
                    <span class="fc-run-title">{run.source.type === "routine" ? t("Routine") : t("Manual run")}</span>
                    <span class="fc-run-meta">
                      {[run.status, elapsed(run.startedAt, run.finishedAt), ...totals(run)].join(" · ")}
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
                      <Show when={run.paused === "budget"}>
                        <span class="fc-run-meta">{t("Paused at its budget")}</span>
                      </Show>
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
                          {/* A run that ended with work still queued can be picked up (HF-5). */}
                          <Show
                            when={(run.status === "failed" || run.status === "stopped") &&
                              (run.tasks ?? []).some((task) => task.status === "queued")}
                          >
                            <button
                              class="fc-run-open"
                              type="button"
                              disabled={!props.serverAvailable}
                              onClick={() => props.onResume(run.id)}
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
                        disabled={!props.serverAvailable}
                        onClick={() => props.onStop(run.id)}
                      >
                        {t("Stop")}
                      </button>
                    </Show>
                  </header>
                  <Show when={confirming() === run.id}>
                    <div class="fc-confirm-inline">
                      <span>{t("Delete this run?")}</span>
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
                  <Show when={run.error}>{(error) => <p class="fc-run-error">{error()}</p>}</Show>
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
                  {/* What ran at the same time as what (H-28), before the list that names it. */}
                  <RunTimeline tasks={run.tasks ?? []} />
                  <ol class="fc-run-tasks">
                    <For each={run.tasks ?? []}>
                      {(task) => (
                        <li class="fc-run-task" data-status={task.status}>
                          <span class="fc-run-mark" data-status={task.status}>
                            {marks[task.status]}
                          </span>
                          <span class="fc-run-task-name">{task.name}</span>
                          <span class="fc-run-meta">{facts(task).join(" · ")}</span>
                          {/*
                            What it is doing right now, and for how long. Without this a call that
                            never returns is indistinguishable from work getting done.
                          */}
                          <Show when={props.activity[task.id]}>
                            {(doing) => (
                              <span
                                class="fc-run-doing"
                                classList={{ "fc-run-doing-long": doing().waitingMs >= LONG_MS }}
                                title={doing().detail}
                              >
                                <span class="fc-run-doing-tool">{doing().tool ?? t("working")}</span>
                                <Show when={doing().detail}>
                                  <span class="fc-run-doing-detail">{doing().detail}</span>
                                </Show>
                                <span class="fc-run-doing-since">{elapsed(Date.now() - doing().waitingMs, undefined)}</span>
                              </span>
                            )}
                          </Show>
                          <Show when={task.sessionID}>
                            {(id) => (
                              <button class="fc-run-open" type="button" onClick={() => props.onOpenSession(id())}>
                                {t("Open")}
                              </button>
                            )}
                          </Show>
                          <button
                            class="fc-run-open"
                            classList={{ "fc-run-open-active": selectedTask() === task.id }}
                            type="button"
                            onClick={() => setSelectedTask(selectedTask() === task.id ? undefined : task.id)}
                          >
                            {t("Details")}
                          </button>
                          <Show when={task.error}>{(error) => <p class="fc-run-error">{error()}</p>}</Show>
                        {/*
                          The evidence (H-22). It lives on the task because H-14's artifact store
                          does not exist yet; folded away because a passing check is read as one
                          line and a failing one is read in full.
                        */}
                        {/*
                          The point taken after this task (H-15): the marker the audit asked for,
                          with the step's own summary so it says what the point was for, and a way
                          to the folder's checkpoints to restore it.
                        */}
                        <Show when={props.touched[task.id]}>
                          {(changed) => (
                            <div class="fc-run-checkpoint">
                              <span class="fc-run-checkpoint-mark" aria-hidden="true">
                                ◆
                              </span>
                              <span class="fc-run-checkpoint-title">{changed().title}</span>
                              <Show when={changed().summary}>
                                {(summary) => (
                                  <details class="fc-run-checkpoint-summary">
                                    <summary>{t("What this point holds")}</summary>
                                    <pre>{summary()}</pre>
                                  </details>
                                )}
                              </Show>
                              <Show when={props.onOpenChanges}>
                                <button
                                  class="fc-run-open"
                                  type="button"
                                  // The task's tree, when it had one of its own (H-29): a worktree
                                  // task's points are anchored there, not in the run's folder (H-32).
                                  onClick={() => props.onOpenChanges?.(task.directory ?? run.directory)}
                                >
                                  {t("Checkpoints")}
                                </button>
                              </Show>
                            </div>
                          )}
                        </Show>
                        {/*
                          What this task changed on disk (H-12), from the checkpoints around it —
                          which catches a file written by a shell command as well as one edited by a
                          tool. A task that changed nothing says so rather than showing nothing.
                        */}
                        <Show when={props.touched[task.id]}>
                          {(changed) => (
                            <Show
                              when={changed().files.length > 0}
                              fallback={<p class="fc-run-files-none">{t("Changed no files")}</p>}
                            >
                              <details class="fc-run-files">
                                <summary>{t("{n} files", { n: changed().files.length })}</summary>
                                <ul>
                                  <For each={changed().files}>
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
                          )}
                        </Show>
                        <Show when={task.kind === "verify" && task.output}>
                          {(evidence) => (
                            <details class="fc-run-evidence" open={task.status === "failed"}>
                              <summary>{t("Evidence")}</summary>
                              <pre>{evidence()}</pre>
                            </details>
                          )}
                        </Show>
                        </li>
                      )}
                    </For>
                  </ol>
                </article>
              )}
            </For>
          </div>
        </Show>
          <Show when={detail()}>
            {(picked) => (
              <RunTaskDetail
                run={picked().run}
                task={picked().task}
                activity={props.activity[picked().task.id]}
                touched={props.touched[picked().task.id]}
                tools={props.tools?.[picked().task.id]}
                artifacts={props.artifacts?.[picked().run.id] ?? []}
                models={props.models}
                serverAvailable={props.serverAvailable}
                onOpenSession={props.onOpenSession}
                onRetry={props.onRetry}
                onSteer={props.onSteer}
                onCancel={props.onCancelTask}
                onOpenChanges={props.onOpenChanges ?? (() => undefined)}
                onClose={() => setSelectedTask(undefined)}
              />
            )}
          </Show>
        </div>
      </section>
    </Show>
  )
}
