import { For, Show, type Component } from "solid-js"
import { t } from "../i18n"
import type { Run, Task, TaskStatus } from "../types"

type RunsPanelProps = {
  open: boolean
  runs: Run[]
  serverAvailable: boolean
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

/** What a task is worth saying on one line, with the parts the engine did not report left out. */
const facts = (task: Task) => {
  const started = task.startedAt
  return [
    task.agent,
    started ? elapsed(started, task.finishedAt) : undefined,
    thousands(task.tokens),
    money(task.cost),
  ].filter((value): value is string => !!value)
}

/**
 * The supervisor (§6.4): a run and the tasks it is made of, as a tree.
 *
 * It shows what the server actually knows. The audit's sketch also has files touched, tool counts and
 * a budget bar; none of those exist yet, and drawing them empty would say the harness knows something
 * it does not.
 */
export const RunsPanel: Component<RunsPanelProps> = (props) => (
  <Show when={props.open}>
    <section class="fc-routines-screen" aria-label={t("Runs")}>
      <div class="fc-routines-header">
        <div>
          <div class="fc-routines-kicker">{t("Automation")}</div>
          <h1>{t("Runs")}</h1>
          <p>{t("What the harness server is working on, task by task.")}</p>
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
                    {run.status} · {elapsed(run.startedAt, run.finishedAt)}
                  </span>
                  <Show when={run.sessionID}>
                    {(id) => (
                      <button class="fc-run-open" type="button" onClick={() => props.onOpenSession(id())}>
                        {t("Open")}
                      </button>
                    )}
                  </Show>
                </header>
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
