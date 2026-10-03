import { describe, expect, test } from "bun:test"
import { setLocale } from "../i18n"
import { budgetAmount, budgetLabel, budgetNotice, nearBudgetText } from "./BudgetMeter"
import type { NearBudget, Run } from "../types"

describe("a budget, in words (UL-08)", () => {
  test("a run's budget is named as the launcher names it; a standing one says it is per day", () => {
    setLocale("en")
    expect(budgetLabel({ scope: "run", name: "review", unit: "usd" })).toBe("Budget (cost)")
    expect(budgetLabel({ scope: "run", name: "review", unit: "tokens" })).toBe("Budget (tokens)")
    expect(budgetLabel({ scope: "day", name: "today", unit: "usd" })).toBe("Today's budget (cost)")
    expect(budgetLabel({ scope: "routine", name: "nightly", unit: "tokens" })).toBe("nightly, daily budget (tokens)")
  })

  test("money is the ledger's estimate, against a limit that is not one", () => {
    expect(budgetAmount({ unit: "usd", spent: 0.0042, limit: 0.1 })).toBe("~$0.0042 of $0.10")
    // A limit below the cent keeps its precision, and so does what was spent against it.
    expect(budgetAmount({ unit: "usd", spent: 0.0315, limit: 0.0315 })).toBe("~$0.0315 of $0.0315")
    expect(budgetAmount({ unit: "tokens", spent: 1200, limit: 5000 })).toBe("1.2k of 5.0k tokens")
  })

  test("a notice says which budget, warning or limit, and what was spent of it", () => {
    const event = { type: "budget.reached", scope: "run", name: "review", unit: "usd", limit: 0.1, spent: 0.11 }
    expect(budgetNotice({ ...event, level: "hard" })).toBe("review · Budget (cost) reached: ~$0.11 of $0.10")
    expect(budgetNotice({ ...event, level: "soft", spent: 0.08 })).toBe("review · Budget (cost) nearly spent: ~$0.08 of $0.10")
    setLocale("es")
    expect(budgetNotice({ ...event, scope: "day", name: "today", level: "hard" })).toBe(
      "Presupuesto de hoy (coste) alcanzado: ~$0.11 de $0.10",
    )
    setLocale("en")
  })
})

describe("a run near its budget, in words (CL-2)", () => {
  const near = (extra: Partial<NearBudget> = {}): NearBudget => ({
    scope: "run",
    name: "review",
    unit: "usd",
    spent: 0.0083,
    limit: 0.01,
    share: 0.83,
    at: 0,
    serial: true,
    reason: "",
    ...extra,
  })
  const run = (extra: Partial<Run>): Pick<Run, "workflow" | "status" | "paused" | "nearBudget"> => ({
    status: "running",
    workflow: { name: "review", scope: "project", hash: "h", inputs: {} },
    ...extra,
  })

  test("a run that never got there says nothing", () => {
    expect(nearBudgetText(run({}))).toBeUndefined()
  })

  test("it says how far the budget is spent and what the remaining tasks do", () => {
    setLocale("en")
    expect(nearBudgetText(run({ nearBudget: near({ fallback: "cheap/small" }) }))).toBe(
      "This workflow is at 83% of its budget; remaining tasks run one at a time on cheap/small",
    )
    expect(nearBudgetText(run({ workflow: undefined, nearBudget: near({ serial: false, fallback: "cheap/small", scope: "day" }) }))).toBe(
      "This run is at 83% of today's budget; remaining tasks move to cheap/small",
    )
    expect(nearBudgetText(run({ nearBudget: near() }))).toBe("This workflow is at 83% of its budget; remaining tasks run one at a time")
  })

  test("at the gate it says what is left and what it would add; once answered, what was chosen", () => {
    const gate = { remaining: 3, projected: 0.006 }
    expect(nearBudgetText(run({ status: "awaiting", paused: "threshold", nearBudget: near({ gate }) }))).toBe(
      "This workflow is at 83% of its budget; remaining tasks wait for you: 3 left, about ~$0.0060 more at the pace so far",
    )
    expect(nearBudgetText(run({ status: "awaiting", paused: "threshold", nearBudget: near({ gate: { remaining: 2 } }) }))).toBe(
      "This workflow is at 83% of its budget; remaining tasks wait for you: 2 left, and none has finished yet to estimate them from",
    )
    expect(nearBudgetText(run({ nearBudget: near({ serial: false, fallback: "cheap/small", gate: { ...gate, answer: "continue" } }) }))).toBe(
      "This workflow is at 83% of its budget; remaining tasks go on on the run's models",
    )
    setLocale("es")
    expect(nearBudgetText(run({ nearBudget: near({ serial: false, fallback: "cheap/small", gate: { ...gate, answer: "fallback" } }) }))).toBe(
      "Este flujo de trabajo lleva el 83% de su presupuesto; las tareas restantes pasan a cheap/small",
    )
    setLocale("en")
  })
})
