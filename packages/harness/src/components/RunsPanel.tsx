import { For, Show, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import type { Run, Task, TaskStatus } from "../types"

type RunsPanelProps = {
  open: boolean
  runs: Run[]
  serverAvailable: boolean
  onStop: (id: string) => void
  onClear: () => void
  onStopAll: () => void
  onRemove: (id: string) => void
  onOpenSession: (id: string) => void
  onClose: () => void
}

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
}

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
    task.kind === "verify" ? t("verify") : task.agent,
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
            <Show when={props.runs.some((run) => run.status === "running")}>
              <button
                class="fc-button fc-button-danger"
                type="button"
                disabled={!props.serverAvailable}
                onClick={() => setConfirming(ALL_RUNNING)}
              >
                {t("Stop all")}
              </button>
            </Show>
            <Show when={props.runs.some((run) => run.status !== "running")}>
              <button
                class="fc-button fc-button-danger"
                type="button"
                disabled={!props.serverAvailable}
                onClick={() => setConfirming(ALL)}
              >
                {t("Clear finished")}
              </button>
            </Show>
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Back to sessions")}
            </button>
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

        <Show when={props.runs.length > 0} fallback={<div class="fc-runs-empty">{t("Nothing has run yet.")}</div>}>
          <div class="fc-runs-list">
            <For each={props.runs}>
              {(run) => (
                <article class="fc-run-card" classList={{ "fc-run-running": run.status === "running" }}>
                  <header class="fc-run-head">
                    <span class="fc-run-mark" data-status={run.status}>
                      {marks[run.status === "running" ? "running" : run.status]}
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
                    <Show
                      when={run.status === "running"}
                      fallback={
                        <button
                          class="fc-run-open fc-run-danger"
                          type="button"
                          disabled={!props.serverAvailable}
                          onClick={() => setConfirming(run.id)}
                        >
                          {t("Delete")}
                        </button>
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
                  <ol class="fc-run-tasks">
                    <For each={run.tasks ?? []}>
                      {(task) => (
                        <li class="fc-run-task" data-status={task.status}>
                          <span class="fc-run-mark" data-status={task.status}>
                            {marks[task.status]}
                          </span>
                          <span class="fc-run-task-name">{task.name}</span>
                          <span class="fc-run-meta">{facts(task).join(" · ")}</span>
                          <Show when={task.sessionID}>
                            {(id) => (
                              <button class="fc-run-open" type="button" onClick={() => props.onOpenSession(id())}>
                                {t("Open")}
                              </button>
                            )}
                          </Show>
                          <Show when={task.error}>{(error) => <p class="fc-run-error">{error()}</p>}</Show>
                        {/*
                          The evidence (H-22). It lives on the task because H-14's artifact store
                          does not exist yet; folded away because a passing check is read as one
                          line and a failing one is read in full.
                        */}
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
      </section>
    </Show>
  )
}
