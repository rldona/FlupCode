import { For, Show, createResource, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { formatDateTime } from "../dates"
import type { Checkpoint, CheckpointPlan, ForkPlan, Run } from "../types"
import { CostFigure } from "./CostFigure"
import { RestoreConversation, RestoreFiles, empty, unchanged } from "./CheckpointList"

/** What a run's checkpoints can do (CL-3): list them, and restore or fork from one after its plan. */
export type RunCheckpointActions = {
  list: (runID: string) => Promise<Checkpoint[]>
  plan: (id: string) => Promise<CheckpointPlan>
  restore: (id: string) => Promise<unknown>
  forkPlan: (id: string) => Promise<ForkPlan>
  fork: (id: string) => Promise<unknown>
}

type RunCheckpointsProps = {
  run: Run
  /** How many points the run took, known before the list is read. */
  count: number
  actions: RunCheckpointActions
  busy: boolean
  /** Opens the folder's changes screen, where every checkpoint of the folder is listed. */
  onOpenChanges?: () => void
}

/**
 * A run's timeline of checkpoints (CL-3): one point after each task, oldest first, each with what had
 * been decided by then — labelled as written from the run's record or by the small model (P4) — and
 * what the run had spent by then, as the ledger has it. From any point the run can be restored (the
 * files and the task's conversation together) or forked into a new run; both show their plan first,
 * as a resume does (RP-04). Read when opened, not with every card.
 */
export const RunCheckpoints: Component<RunCheckpointsProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [tick, setTick] = createSignal(0)
  const [points] = createResource(
    () => (open() ? `${props.run.id}\n${props.count}\n${tick()}` : undefined),
    () => props.actions.list(props.run.id).then((list) => [...list].reverse()),
  )
  const [asking, setAsking] = createSignal<{ id: string; action: "restore" | "fork" }>()
  // A run still going writes in the folder; neither a restore nor a fork starts under it.
  const idle = () => props.run.status !== "running" && props.run.status !== "awaiting"
  const done = () => {
    setAsking(undefined)
    setTick((value) => value + 1)
  }
  return (
    <details class="fc-run-files fc-run-timeline" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {t("Checkpoints")} <span class="fc-run-count">{props.count}</span>
      </summary>
      <Show when={points.loading && !points()}>
        <p class="fc-checkpoints-empty">{t("Loading…")}</p>
      </Show>
      <Show when={points.error}>
        {(cause) => <p class="fc-run-error">{cause() instanceof Error ? cause().message : String(cause())}</p>}
      </Show>
      <ol class="fc-timeline">
        <For each={points() ?? []}>
          {(point) => (
            <li class="fc-timeline-point">
              <div class="fc-timeline-head">
                <span class="fc-checkpoint-title">{point.title}</span>
                <span class="fc-checkpoint-when">{formatDateTime(point.createdAt)}</span>
                <Show when={point.cost}>
                  {(cost) => (
                    <span class="fc-run-cost">
                      <span class="fc-run-meta">{t("By then")}</span>
                      <CostFigure bucket={cost()} />
                    </span>
                  )}
                </Show>
                <Show when={idle()}>
                  <span class="fc-timeline-actions">
                    <button
                      class="fc-run-open"
                      type="button"
                      disabled={props.busy}
                      onClick={() => setAsking({ id: point.id, action: "restore" })}
                    >
                      {t("Restore")}
                    </button>
                    <Show when={!props.run.worktrees && point.taskID}>
                      <button
                        class="fc-run-open"
                        type="button"
                        disabled={props.busy}
                        onClick={() => setAsking({ id: point.id, action: "fork" })}
                      >
                        {t("Fork from here")}
                      </button>
                    </Show>
                  </span>
                </Show>
              </div>
              <Show when={point.decided}>
                {(decided) => (
                  <div class="fc-timeline-decided">
                    <span class="fc-timeline-by">
                      {decided().by === "facts" ? t("From what the run recorded") : t("Written by the small model")}
                    </span>
                    <pre>{decided().text}</pre>
                  </div>
                )}
              </Show>
              <Show when={asking()?.id === point.id && asking()?.action === "restore"}>
                <RestoreAsk
                  load={() => props.actions.plan(point.id)}
                  busy={props.busy}
                  onCancel={() => setAsking(undefined)}
                  onConfirm={() => void props.actions.restore(point.id).finally(done)}
                />
              </Show>
              <Show when={asking()?.id === point.id && asking()?.action === "fork"}>
                <ForkAsk
                  load={() => props.actions.forkPlan(point.id)}
                  busy={props.busy}
                  onCancel={() => setAsking(undefined)}
                  onConfirm={() => void props.actions.fork(point.id).finally(done)}
                />
              </Show>
            </li>
          )}
        </For>
      </ol>
      <Show when={props.onOpenChanges}>
        <button class="fc-run-open" type="button" onClick={() => props.onOpenChanges?.()}>
          {t("Every checkpoint of this folder")}
        </button>
      </Show>
    </details>
  )
}

/** Restoring a point: the files and the conversation, said before either is touched. */
const RestoreAsk: Component<{ load: () => Promise<CheckpointPlan>; busy: boolean; onCancel: () => void; onConfirm: () => void }> = (
  props,
) => {
  const [plan] = createResource(props.load)
  return (
    <div class="fc-checkpoint-plan">
      <Show when={plan.loading}>
        <p class="fc-checkpoints-empty">{t("Working out what would change…")}</p>
      </Show>
      <Show when={plan.error}>
        {(cause) => <p class="fc-run-error">{cause() instanceof Error ? cause().message : String(cause())}</p>}
      </Show>
      <Show when={!plan.loading && !plan.error ? plan() : undefined}>
        {(what) => (
          <Show
            when={!unchanged(what())}
            fallback={<p class="fc-checkpoints-empty">{t("This folder already looks like that.")}</p>}
          >
            <RestoreFiles plan={what().files} />
            <RestoreConversation plan={what()} />
            <div class="fc-confirm-inline">
              <button class="fc-button" type="button" onClick={props.onCancel}>
                {t("Cancel")}
              </button>
              <button class="fc-button fc-button-danger" type="button" disabled={props.busy} onClick={props.onConfirm}>
                {t("Restore")}
              </button>
            </div>
          </Show>
        )}
      </Show>
    </div>
  )
}

/** Forking from a point: what the new run carries over, what it runs, and what the folder becomes. */
const ForkAsk: Component<{ load: () => Promise<ForkPlan>; busy: boolean; onCancel: () => void; onConfirm: () => void }> = (props) => {
  const [plan] = createResource(props.load)
  return (
    <div class="fc-checkpoint-plan">
      <Show when={plan.loading}>
        <p class="fc-checkpoints-empty">{t("Working out what would change…")}</p>
      </Show>
      <Show when={plan.error}>
        {(cause) => <p class="fc-run-error">{cause() instanceof Error ? cause().message : String(cause())}</p>}
      </Show>
      <Show when={!plan.loading && !plan.error ? plan() : undefined}>
        {(what) => (
          <>
            <p class="fc-run-meta">{t("A new run starts from this checkpoint. This run and its conversations stay as they are.")}</p>
            <Show when={what().kept.length > 0}>
              <p class="fc-run-meta">
                {t("Carried over as done: {names}", { names: what().kept.map((task) => task.name).join(", ") })}
              </p>
            </Show>
            <p class="fc-run-meta">{t("Runs: {names}", { names: what().tasks.map((task) => task.name).join(" → ") })}</p>
            <Show
              when={!empty(what().plan)}
              fallback={<p class="fc-checkpoints-empty">{t("This folder already looks like that.")}</p>}
            >
              <RestoreFiles plan={what().plan} />
              <p class="fc-checkpoints-empty">
                {t("A checkpoint of how things are now is recorded first, so this can be undone.")}
              </p>
            </Show>
            <div class="fc-confirm-inline">
              <button class="fc-button" type="button" onClick={props.onCancel}>
                {t("Cancel")}
              </button>
              <button
                class="fc-button"
                classList={{ "fc-button-danger": !empty(what().plan) }}
                type="button"
                disabled={props.busy || what().tasks.length === 0}
                onClick={props.onConfirm}
              >
                {t("Fork from here")}
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
