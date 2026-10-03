import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { ATTENTION, type Attention } from "../attention"
import { runTitle } from "../run-title"
import { heldForRequest, runState, stateLabel } from "../run-state"
import type { NearBudgetAnswer, Run } from "../types"
import { nearBudgetText } from "./BudgetMeter"
import { AttentionMark, attentionLabel } from "./AttentionMark"
import { Icon } from "./Icon"

/**
 * The phone's Runs view while controlling a computer (HE-02): what the harness is running and what it
 * ran, most urgent first on the attention scale (UX-02), with the two answers a gate takes — let it
 * through, or stop the run — and the session where a task's request is answered.
 *
 * The phone reaches the harness with the remote scope, so this offers nothing that scope refuses:
 * no deleting, resuming, retrying or starting work.
 */

export type RemoteRunsProps = {
  runs: Run[]
  attention: Record<string, Attention | undefined>
  /** Whether the harness answered; when not, the list is the last it said and the actions wait. */
  serverAvailable: boolean
  /** The run a home card asked for, scrolled to once. */
  focus?: string
  onApprove: (runID: string, answer?: NearBudgetAnswer) => void
  onStop: (runID: string) => Promise<void>
  onOpenSession: (sessionID: string) => void
  onBack: () => void
}

const going = (run: Run) => run.status === "running" || run.status === "awaiting"

/** Where the run's work is: the task running now, else the run's own session. */
const sessionOf = (run: Run) => run.tasks?.find((task) => task.status === "running")?.sessionID ?? run.sessionID

export const RemoteRuns: Component<RemoteRunsProps> = (props) => {
  // Runs asked to stop that the server has not reported stopped yet: the button says so (TI-01).
  const [stopping, setStopping] = createSignal<string[]>([])
  const stop = (id: string) => {
    setStopping((ids) => [...ids, id])
    props.onStop(id).catch(() => setStopping((ids) => ids.filter((entry) => entry !== id)))
  }
  const rank = (run: Run) => {
    const level = props.attention[run.id]
    return level ? ATTENTION.indexOf(level) : ATTENTION.length
  }
  const ordered = createMemo(() =>
    [...props.runs].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt),
  )
  const progress = (run: Run) => {
    const tasks = run.tasks ?? []
    if (!going(run) || tasks.length < 2) return undefined
    return `${tasks.filter((task) => task.status !== "queued" && task.status !== "running").length}/${tasks.length}`
  }
  const current = (run: Run) =>
    going(run)
      ? (run.tasks?.find((task) => task.status === "running") ?? run.tasks?.find((task) => task.status === "queued"))?.name
      : undefined

  return (
    <section class="fc-remote-runs" aria-label={t("Runs")}>
      <header class="fc-mobile-header">
        <button class="fc-icon-button fc-mobile-back" type="button" aria-label={t("Back")} onClick={props.onBack}>
          <Icon name="arrow-left" />
        </button>
        <span class="fc-mobile-heading">
          <span class="fc-mobile-title">{t("Runs")}</span>
        </span>
      </header>
      <div class="fc-remote-home fc-remote-runs-list">
        <Show when={!props.serverAvailable}>
          <p class="fc-remote-empty">{t("The harness server is not reachable, so this is the last it said.")}</p>
        </Show>
        <Show when={ordered().length > 0} fallback={<p class="fc-remote-empty">{t("Nothing has run yet.")}</p>}>
          <For each={ordered()}>
            {(run) => {
              const level = () => props.attention[run.id]
              const session = () => sessionOf(run)
              return (
                <article
                  class="fc-remote-card fc-remote-run"
                  data-run-id={run.id}
                  ref={(element) => {
                    if (props.focus === run.id) queueMicrotask(() => element.scrollIntoView({ block: "center" }))
                  }}
                >
                  <div class="fc-remote-run-head">
                    {/* Nothing to say on the scale: its state is in the line beside it. */}
                    <Show when={level()} fallback={<span class="fc-remote-dot" aria-hidden="true" />}>
                      {(value) => <AttentionMark level={value()} />}
                    </Show>
                    <span class="fc-remote-card-main">
                      <span class="fc-remote-card-title">{runTitle(run)}</span>
                      <span class="fc-remote-card-meta">
                        {/* What it needs on the scale, or else how it stands, said once (UX-04). */}
                        {[level() ? attentionLabel(level()!) : stateLabel(runState(run)), current(run), progress(run)]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </div>
                  {/* What it did at 80% of a budget (CL-2), while it is still going. */}
                  <Show when={going(run) && nearBudgetText(run)}>
                    {(text) => <p class="fc-remote-run-note">{text()}</p>}
                  </Show>
                  <Show when={going(run) || session()}>
                    <div class="fc-remote-run-actions">
                      {/* A gate is a question: let it through, or stop it. There is no third answer. */}
                      <Show when={run.status === "awaiting" && !heldForRequest(run)}>
                        <button
                          class="fc-remote-pill fc-remote-run-primary"
                          type="button"
                          disabled={!props.serverAvailable}
                          onClick={() => props.onApprove(run.id)}
                        >
                          {run.paused === "budget" || run.paused === "threshold" ? t("Carry on") : t("Approve")}
                        </button>
                        {/* Near its budget (CL-2): carry on on the policy's fallback. */}
                        <Show when={run.paused === "threshold" && run.nearBudget?.fallback}>
                          <button
                            class="fc-remote-pill"
                            type="button"
                            disabled={!props.serverAvailable}
                            onClick={() => props.onApprove(run.id, "fallback")}
                          >
                            {t("Carry on with the fallback model")}
                          </button>
                        </Show>
                      </Show>
                      <Show when={going(run)}>
                        <button
                          class="fc-remote-pill fc-remote-run-danger"
                          type="button"
                          disabled={!props.serverAvailable || stopping().includes(run.id)}
                          onClick={() => stop(run.id)}
                        >
                          {stopping().includes(run.id) ? t("Stopping…") : t("Stop")}
                        </button>
                      </Show>
                      <Show when={session()}>
                        {(id) => (
                          <button class="fc-remote-pill" type="button" onClick={() => props.onOpenSession(id())}>
                            {t("Open")}
                          </button>
                        )}
                      </Show>
                    </div>
                  </Show>
                </article>
              )
            }}
          </For>
        </Show>
      </div>
    </section>
  )
}
