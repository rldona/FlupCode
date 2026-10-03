import { For, Show, type Component } from "solid-js"
import { t } from "../i18n"
import { money } from "../cost"
import { formatTokens } from "../metrics"
import type { BudgetScope, BudgetStanding, Run } from "../types"

/**
 * A budget as a labelled meter (UL-08): what it is a budget of, how much of it the ledger says was
 * spent, and the warning share as a tick. The fill turns the warning colour at that share and the
 * danger colour at the limit. Money is the ledger's estimate (`~`, the app's mark for one); steps
 * with no price are named, because a cost budget cannot see them (P4).
 */
export const BudgetMeter: Component<{ standings: BudgetStanding[] | undefined }> = (props) => (
  <Show when={(props.standings ?? []).length > 0}>
    <div class="fc-budget-meters">
      <For each={props.standings}>
        {(standing) => (
          <div class="fc-budget-meter" data-level={standing.level ?? "under"}>
            <span class="fc-budget-meter-label">{budgetLabel(standing)}</span>
            <span
              class="fc-budget-meter-bar"
              role="meter"
              aria-label={budgetLabel(standing)}
              aria-valuemin={0}
              aria-valuemax={standing.limit}
              aria-valuenow={Math.min(standing.spent, standing.limit)}
              aria-valuetext={budgetAmount(standing)}
            >
              <span class="fc-budget-meter-fill" style={{ width: `${Math.min(100, (standing.spent / standing.limit) * 100)}%` }} />
              <Show when={standing.softPct}>
                {(share) => <span class="fc-budget-meter-tick" style={{ left: `${share()}%` }} />}
              </Show>
            </span>
            <span class="fc-budget-meter-figure">{budgetAmount(standing)}</span>
            <Show when={standing.unit === "usd" && standing.unpriced > 0}>
              <span class="fc-budget-meter-note">
                {t("{count} unpriced model calls not counted", { count: standing.unpriced })}
              </span>
            </Show>
          </div>
        )}
      </For>
    </div>
  </Show>
)

/** What a budget is of, in the app's words: the launcher's own for a run's (P5). */
export function budgetLabel(standing: Pick<BudgetStanding, "scope" | "name" | "unit">) {
  const cost = standing.unit === "usd"
  if (standing.scope === "run") return cost ? t("Budget (cost)") : t("Budget (tokens)")
  if (standing.scope === "day") return cost ? t("Today's budget (cost)") : t("Today's budget (tokens)")
  return t(cost ? "{name}, daily budget (cost)" : "{name}, daily budget (tokens)", { name: standing.name })
}

/** Spent of the limit: `~$0.04 of $0.10`, or `1.2K of 5K tokens`. */
export function budgetAmount(standing: Pick<BudgetStanding, "unit" | "spent" | "limit">) {
  // A limit set below the cent is written to its own precision, and what was spent to the same:
  // rounding $0.0315 to $0.03 would move the line the run stops at (P4).
  const fine = Number(standing.limit.toFixed(2)) !== standing.limit
  const usd = (value: number) => (fine ? `$${Number(value.toPrecision(4))}` : money(value))
  if (standing.unit === "usd") return t("{spent} of {limit}", { spent: `~${usd(standing.spent)}`, limit: usd(standing.limit) })
  return t("{spent} of {limit} tokens", { spent: formatTokens(standing.spent), limit: formatTokens(standing.limit) })
}

/**
 * What the app says when the server raises a budget notice (UL-08): which budget, whether it is the
 * warning or the limit, and what was spent of it. A run's budget is named after the run.
 */
export function budgetNotice(event: Record<string, unknown>) {
  const scope = (["run", "day", "workflow", "routine"].includes(String(event.scope)) ? event.scope : "run") as BudgetScope
  const standing = {
    scope,
    name: String(event.name ?? ""),
    unit: event.unit === "tokens" ? ("tokens" as const) : ("usd" as const),
    spent: Number(event.spent ?? 0),
    limit: Number(event.limit ?? 0),
  }
  const budget = scope === "run" ? `${standing.name} · ${budgetLabel(standing)}` : budgetLabel(standing)
  return t(event.level === "hard" ? "{budget} reached: {amount}" : "{budget} nearly spent: {amount}", {
    budget,
    amount: budgetAmount(standing),
  })
}

/**
 * What a run did at 80% of a budget (CL-2), as one sentence for its card: which budget and how far,
 * and what its remaining tasks do — wait for the person with what they would add, run one at a time,
 * move to the fallback. Undefined for a run that never got there.
 */
export function nearBudgetText(run: Pick<Run, "workflow" | "status" | "paused" | "nearBudget">) {
  const near = run.nearBudget
  if (!near) return undefined
  const budget =
    near.scope === "run"
      ? t("its budget")
      : near.scope === "day"
        ? t("today's budget")
        : t("{name}'s daily budget", { name: near.name })
  return t("{subject} is at {share} of {budget}; remaining tasks {action}", {
    subject: run.workflow ? t("This workflow") : t("This run"),
    share: `${Math.round(near.share * 100)}%`,
    budget,
    action: nearBudgetAction(run, near),
  })
}

function nearBudgetAction(run: Pick<Run, "status" | "paused">, near: NonNullable<Run["nearBudget"]>) {
  const gate = near.gate
  if (gate && !gate.answer && run.status === "awaiting" && run.paused === "threshold") {
    if (gate.projected === undefined) return t("wait for you: {count} left, and none has finished yet to estimate them from", { count: gate.remaining })
    const projected =
      near.unit === "usd" ? `~${money(gate.projected)}` : t("{tokens} tokens", { tokens: formatTokens(gate.projected) })
    return t("wait for you: {count} left, about {projected} more at the pace so far", { count: gate.remaining, projected })
  }
  // A person who chose to keep the run's models at the gate keeps them (PI-04 would move them).
  const model = gate?.answer === "continue" ? undefined : near.fallback
  if (near.serial && model) return t("run one at a time on {model}", { model })
  if (model) return t("move to {model}", { model })
  if (near.serial) return t("run one at a time")
  return t("go on on the run's models")
}
