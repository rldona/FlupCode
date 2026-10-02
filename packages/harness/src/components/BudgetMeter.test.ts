import { describe, expect, test } from "bun:test"
import { setLocale } from "../i18n"
import { budgetAmount, budgetLabel, budgetNotice } from "./BudgetMeter"

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
