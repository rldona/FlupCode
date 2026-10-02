import { For, Show, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { createHarnessClient } from "../client"
import { createResource } from "../resource"
import { BudgetMeter } from "./BudgetMeter"
import type { Budget, BudgetInput } from "../types"

type BudgetsBlockProps = {
  serverUrl: string
  serverAvailable: boolean
  routines: Array<{ id: string; name: string }>
  /** Workflow names the app knows of, offered as the workflow a budget is for. */
  workflows: string[]
}

/**
 * The standing budgets of the Cost screen (UL-08): today's, a workflow's or a routine's, each over a
 * day of spend and each a meter of what today spent. A run's own budget is set where the run is
 * launched (the launcher, a routine), so it is not here; this is the policy over all of them.
 */
export const BudgetsBlock: Component<BudgetsBlockProps> = (props) => {
  const [budgets, { refetch }] = createResource(
    () => props.serverAvailable && props.serverUrl,
    (url) => createHarnessClient(url).budgets.list(),
  )
  const [scope, setScope] = createSignal<Budget["scope"]>("day")
  const [target, setTarget] = createSignal("")
  const [unit, setUnit] = createSignal<Budget["unit"]>("usd")
  const [limit, setLimit] = createSignal("")
  const [warn, setWarn] = createSignal("80")
  const [problem, setProblem] = createSignal<string>()
  const client = () => createHarnessClient(props.serverUrl)

  const add = async () => {
    const amount = Number(limit().replace(/[\s,_]/g, ""))
    if (!limit().trim() || !Number.isFinite(amount) || amount <= 0) return setProblem(t("A budget needs a limit above zero"))
    if (scope() !== "day" && !target().trim()) return setProblem(t("Pick what the budget is for"))
    const share = Number(warn().trim())
    const input: BudgetInput = {
      scope: scope(),
      ...(scope() !== "day" ? { target: target().trim() } : {}),
      unit: unit(),
      limit: amount,
      ...(warn().trim() && share > 0 && share < 100 ? { softPct: share } : {}),
    }
    const saved = await client()
      .budgets.save(input)
      .then(() => true)
      .catch((cause: unknown) => (setProblem(cause instanceof Error ? cause.message : String(cause)), false))
    if (!saved) return
    setProblem(undefined)
    setLimit("")
    void refetch()
  }

  const remove = (id: string) => void client().budgets.remove(id).then(() => refetch(), () => refetch())

  return (
    <section class="fc-usage-block" aria-labelledby="fc-usage-budgets">
      <h2 id="fc-usage-budgets">{t("Budgets")}</h2>
      <p class="fc-usage-note">
        {t("Spend over a day, from the usage ledger. Reaching one stops the runs it covers at the step that crossed it; a conversation is warned, not stopped.")}
      </p>
      <Show when={(budgets() ?? []).length > 0}>
        <div class="fc-budget-list">
          <For each={budgets()}>
            {(budget) => (
              <div class="fc-budget-row">
                <BudgetMeter standings={[{ ...budget, reason: "" }]} />
                <button class="fc-run-open" type="button" disabled={!props.serverAvailable} onClick={() => remove(budget.id)}>
                  {t("Remove")}
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <form
        class="fc-budget-form"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <label class="fc-usage-select">
          <span>{t("Scope")}</span>
          <select
            value={scope()}
            onChange={(event) => {
              setScope(event.currentTarget.value as Budget["scope"])
              setTarget("")
            }}
          >
            <option value="day">{t("Everything, per day")}</option>
            <option value="workflow">{t("A workflow, per day")}</option>
            <option value="routine" disabled={props.routines.length === 0}>
              {t("A routine, per day")}
            </option>
          </select>
        </label>
        <Show when={scope() === "workflow"}>
          <label class="fc-usage-select">
            <span>{t("Workflow")}</span>
            <input
              class="fc-question-custom"
              list="fc-budget-workflows"
              value={target()}
              onInput={(event) => setTarget(event.currentTarget.value)}
            />
            <datalist id="fc-budget-workflows">
              <For each={props.workflows}>{(name) => <option value={name} />}</For>
            </datalist>
          </label>
        </Show>
        <Show when={scope() === "routine"}>
          <label class="fc-usage-select">
            <span>{t("Routine")}</span>
            <select value={target()} onChange={(event) => setTarget(event.currentTarget.value)}>
              <option value="">{t("Choose a routine")}</option>
              <For each={props.routines}>{(routine) => <option value={routine.id}>{routine.name}</option>}</For>
            </select>
          </label>
        </Show>
        <label class="fc-usage-select">
          <span>{t("Unit")}</span>
          <select value={unit()} onChange={(event) => setUnit(event.currentTarget.value as Budget["unit"])}>
            <option value="usd">{t("Cost (USD)")}</option>
            <option value="tokens">{t("Tokens")}</option>
          </select>
        </label>
        <label class="fc-usage-select">
          <span>{t("Limit")}</span>
          <input
            class="fc-question-custom"
            inputMode="decimal"
            value={limit()}
            onInput={(event) => setLimit(event.currentTarget.value)}
          />
        </label>
        <label class="fc-usage-select">
          <span>{t("Warn at (%)")}</span>
          <input
            class="fc-question-custom"
            inputMode="numeric"
            value={warn()}
            onInput={(event) => setWarn(event.currentTarget.value)}
          />
        </label>
        <button class="fc-button fc-button-primary" type="submit" disabled={!props.serverAvailable}>
          {t("Add")}
        </button>
      </form>
      <Show when={problem() ?? budgets.failure()?.message}>{(message) => <p class="fc-usage-note fc-budget-problem">{message()}</p>}</Show>
    </section>
  )
}
