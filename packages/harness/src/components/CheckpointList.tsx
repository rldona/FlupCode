import { For, Show, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { formatDateTime } from "../dates"
import type { Checkpoint, CheckpointPlan, RestorePlan } from "../types"
import { Icon } from "./Icon"

type CheckpointListProps = {
  checkpoints: Checkpoint[]
  busy: boolean
  /** Fetches what restoring would do. Called before anything is written, never after. */
  onPlan: (id: string) => Promise<CheckpointPlan>
  onRestore: (id: string) => void
  onTake: (title: string) => void
  onRemove: (id: string) => void
}

const when = (at: number) => formatDateTime(at)

/** Nothing to do, said once, rather than a confirmation for a restore that would change nothing. */
export const empty = (plan: RestorePlan) => plan.write.length === 0 && plan.remove.length === 0

/** A restore that would change neither the files nor the conversation (CL-3). */
export const unchanged = (plan: CheckpointPlan) =>
  empty(plan.files) && !(plan.conversation.state === "kept" && plan.conversation.revertTo)

/**
 * Checkpoints (H-15), and the confirmation that guards restoring one.
 *
 * Restoring overwrites files and deletes others, so this asks the server what it would do and puts
 * the answer on screen before anything happens — the deletions first and in full, because those are
 * the ones nobody can get back from anywhere else. A restore then records where it came from, so
 * the way back from an undo is another row in this same list.
 */
export const CheckpointList: Component<CheckpointListProps> = (props) => {
  const [asking, setAsking] = createSignal<string>()
  const [plan, setPlan] = createSignal<CheckpointPlan>()
  const [problem, setProblem] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)

  const ask = (id: string) => {
    setAsking(id)
    setPlan(undefined)
    setProblem(undefined)
    setLoading(true)
    props
      .onPlan(id)
      .then(setPlan)
      .catch((cause) => setProblem(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false))
  }
  const close = () => {
    setAsking(undefined)
    setPlan(undefined)
    setProblem(undefined)
  }

  return (
    <section class="fc-checkpoints">
      <div class="fc-checkpoints-head">
        <span class="fc-section-label">{t("Checkpoints")}</span>
        <span class="fc-checkpoints-hint">{t("A way back to how this folder looked.")}</span>
        <button class="fc-button" type="button" disabled={props.busy} onClick={() => props.onTake(t("Manual"))}>
          {t("Take one now")}
        </button>
      </div>

      <Show
        when={props.checkpoints.length > 0}
        fallback={<p class="fc-checkpoints-empty">{t("Nothing recorded here yet.")}</p>}
      >
        <For each={props.checkpoints}>
          {(checkpoint) => (
            <article class="fc-checkpoint">
              <div class="fc-checkpoint-row">
                <span class="fc-checkpoint-title">{checkpoint.title}</span>
                <span class="fc-checkpoint-when">{when(checkpoint.createdAt)}</span>
                <code class="fc-checkpoint-sha">{checkpoint.sha.slice(0, 7)}</code>
                <button class="fc-button" type="button" disabled={props.busy} onClick={() => ask(checkpoint.id)}>
                  {t("Restore")}
                </button>
                <button
                  class="fc-icon-button"
                  type="button"
                  aria-label={t("Forget this checkpoint")}
                  title={t("Forget this checkpoint")}
                  disabled={props.busy}
                  onClick={() => props.onRemove(checkpoint.id)}
                >
                  <Icon name="close" />
                </button>
              </div>

              {/*
                What the step concluded (H-15). Folded away because a point is usually read as a
                line, but there when the name alone does not say what changed.
              */}
              <Show when={checkpoint.summary}>
                {(summary) => (
                  <details class="fc-checkpoint-summary">
                    <summary>{t("What this point holds")}</summary>
                    <pre>{summary()}</pre>
                  </details>
                )}
              </Show>

              <Show when={asking() === checkpoint.id}>
                <div class="fc-checkpoint-plan">
                  <Show when={loading()}>
                    <p class="fc-checkpoints-empty">{t("Working out what would change…")}</p>
                  </Show>
                  <Show when={problem()}>{(message) => <p class="fc-run-error">{message()}</p>}</Show>
                  <Show when={plan()}>
                    {(what) => (
                      <Show
                        when={!unchanged(what())}
                        fallback={<p class="fc-checkpoints-empty">{t("This folder already looks like that.")}</p>}
                      >
                        <RestoreFiles plan={what().files} />
                        <RestoreConversation plan={what()} />
                        <div class="fc-confirm-inline">
                          <button class="fc-button" type="button" onClick={close}>
                            {t("Cancel")}
                          </button>
                          <button
                            class="fc-button fc-button-danger"
                            type="button"
                            disabled={props.busy}
                            onClick={() => {
                              props.onRestore(checkpoint.id)
                              close()
                            }}
                          >
                            {t("Restore")}
                          </button>
                        </div>
                      </Show>
                    )}
                  </Show>
                </div>
              </Show>
            </article>
          )}
        </For>
      </Show>
    </section>
  )
}

/**
 * What a restore would do to the conversation the point was taken in (CL-3), and what the point of
 * the present recorded first can bring back. A committed revert is final in the engine, so when
 * prompts go, the way back is for the files only, and that is said before anything happens (P4).
 */
export const RestoreConversation: Component<{ plan: CheckpointPlan }> = (props) => {
  const dropped = () => (props.plan.conversation.state === "kept" ? props.plan.conversation.prompts : 0)
  return (
    <>
      <p class="fc-checkpoints-empty">
        {props.plan.conversation.state === "none"
          ? t("Only the files go back: this point was not taken in a conversation.")
          : props.plan.conversation.state === "gone"
            ? t("Only the files go back: the conversation this point was taken in is gone.")
            : dropped() === 0
              ? t("The conversation is already at this point.")
              : dropped() === 1
                ? t("The conversation goes back too: the prompt made since, and its answer, are removed.")
                : t("The conversation goes back too: the {n} prompts made since, and their answers, are removed.", {
                    n: dropped(),
                  })}
      </p>
      <p class="fc-checkpoints-empty">
        {dropped() > 0
          ? t("A checkpoint of how the files are now is recorded first, so they can be put back; the removed prompts cannot.")
          : t("A checkpoint of how things are now is recorded first, so this can be undone.")}
      </p>
    </>
  )
}

/**
 * What a restore would do to the folder: deletions first, named in full and never summarised as a
 * count — a file nobody ever added to git is gone from everywhere once this runs.
 */
export const RestoreFiles: Component<{ plan: RestorePlan }> = (props) => (
  <>
    <Show when={props.plan.remove.length > 0}>
      <div class="fc-checkpoint-group">
        <strong class="fc-diff-minus">{t("Deleted ({n})", { n: props.plan.remove.length })}</strong>
        <ul>
          <For each={props.plan.remove}>{(path) => <li>{path}</li>}</For>
        </ul>
      </div>
    </Show>
    <Show when={props.plan.write.length > 0}>
      <div class="fc-checkpoint-group">
        <strong>{t("Rewritten ({n})", { n: props.plan.write.length })}</strong>
        <ul>
          <For each={props.plan.write.slice(0, 20)}>{(path) => <li>{path}</li>}</For>
        </ul>
        <Show when={props.plan.write.length > 20}>
          <li class="fc-checkpoints-empty">{t("and {n} more", { n: props.plan.write.length - 20 })}</li>
        </Show>
      </div>
    </Show>
  </>
)
