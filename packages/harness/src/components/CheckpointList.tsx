import { For, Show, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import type { Checkpoint, RestorePlan } from "../types"

type CheckpointListProps = {
  checkpoints: Checkpoint[]
  busy: boolean
  /** Fetches what restoring would do. Called before anything is written, never after. */
  onPlan: (id: string) => Promise<RestorePlan>
  onRestore: (id: string) => void
  onTake: (title: string) => void
  onRemove: (id: string) => void
}

const when = (at: number) => new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })

/** Nothing to do, said once, rather than a confirmation for a restore that would change nothing. */
const empty = (plan: RestorePlan) => plan.write.length === 0 && plan.remove.length === 0

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
  const [plan, setPlan] = createSignal<RestorePlan>()
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
                  ×
                </button>
              </div>

              <Show when={asking() === checkpoint.id}>
                <div class="fc-checkpoint-plan">
                  <Show when={loading()}>
                    <p class="fc-checkpoints-empty">{t("Working out what would change…")}</p>
                  </Show>
                  <Show when={problem()}>{(message) => <p class="fc-run-error">{message()}</p>}</Show>
                  <Show when={plan()}>
                    {(what) => (
                      <Show
                        when={!empty(what())}
                        fallback={<p class="fc-checkpoints-empty">{t("This folder already looks like that.")}</p>}
                      >
                        {/*
                          Deletions first, named in full and never summarised as a count: a file
                          nobody ever added to git is gone from everywhere once this runs.
                        */}
                        <Show when={what().remove.length > 0}>
                          <div class="fc-checkpoint-group">
                            <strong class="fc-diff-minus">{t("Deleted ({n})", { n: what().remove.length })}</strong>
                            <ul>
                              <For each={what().remove}>{(path) => <li>{path}</li>}</For>
                            </ul>
                          </div>
                        </Show>
                        <Show when={what().write.length > 0}>
                          <div class="fc-checkpoint-group">
                            <strong>{t("Rewritten ({n})", { n: what().write.length })}</strong>
                            <ul>
                              <For each={what().write.slice(0, 20)}>{(path) => <li>{path}</li>}</For>
                            </ul>
                            <Show when={what().write.length > 20}>
                              <li class="fc-checkpoints-empty">
                                {t("and {n} more", { n: what().write.length - 20 })}
                              </li>
                            </Show>
                          </div>
                        </Show>
                        <p class="fc-checkpoints-empty">
                          {t("A checkpoint of how things are now is recorded first, so this can be undone.")}
                        </p>
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
