import { Show, createResource, type Component } from "solid-js"
import { t } from "../i18n"
import type { ResumePlan } from "../types"
import { RestoreFiles, empty } from "./CheckpointList"

type ResumeConfirmProps = {
  /** Asks the server what resuming would do. Called before anything runs or is written. */
  load: () => Promise<ResumePlan>
  busy: boolean
  onResume: () => void
  onCancel: () => void
}

/**
 * The question before a run picks up again (RP-04).
 *
 * Resuming puts the folder back to how it looked before the work that runs again, and the folder may
 * have changed since the run ended — by hand, or by the half-done attempt. So what runs and what the
 * restore would write and delete are on screen first, the same way a checkpoint's restore asks. A run
 * with no point before that work (its first task) says the folder stays as it is: what an attempt left
 * there is not undone, and claiming otherwise would be the lie (P4).
 */
export const ResumeConfirm: Component<ResumeConfirmProps> = (props) => {
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
            <p class="fc-run-meta">{t("Runs: {names}", { names: what().tasks.map((task) => task.name).join(" → ") })}</p>
            <Show
              when={what().checkpoint && what().plan}
              fallback={<p class="fc-checkpoints-empty">{t("No checkpoint before this work: the folder stays as it is.")}</p>}
            >
              <p class="fc-checkpoints-empty">
                {t("The folder goes back to the checkpoint after {task}.", { task: what().checkpoint!.title })}
              </p>
              <Show
                when={!empty(what().plan!)}
                fallback={<p class="fc-checkpoints-empty">{t("This folder already looks like that.")}</p>}
              >
                <RestoreFiles plan={what().plan!} />
                <p class="fc-checkpoints-empty">
                  {t("A checkpoint of how things are now is recorded first, so this can be undone.")}
                </p>
              </Show>
            </Show>
            <div class="fc-confirm-inline">
              <button class="fc-button" type="button" onClick={props.onCancel}>
                {t("Cancel")}
              </button>
              {/* Red only when it overwrites or deletes something, as a checkpoint's restore is. */}
              <button
                class="fc-button"
                classList={{ "fc-button-danger": !!what().plan && !empty(what().plan!) }}
                type="button"
                disabled={props.busy || what().tasks.length === 0}
                onClick={props.onResume}
              >
                {t("Resume")}
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
