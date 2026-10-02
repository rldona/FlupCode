/**
 * The predictive models' monthly budget, persisted so a restart cannot reset what was already spent
 * (FH-013). One ledger counts every provider's spend; a provider's own `budget.monthlyTokens` (PI-01)
 * is a lower cap on that same total, past which that provider is no longer asked.
 *
 * The policy is a soft cap: when the month is exhausted the models are not asked and it is logged, and
 * the session is never refused. A fraction of the budget is reserved for the hot path, so a background batch
 * cannot spend what a live turn needs. Spend is reserved before every attempt, with the estimate of
 * the caller's input as the unit. The limits are read on every check, so a budget changed in the
 * live config is enforced without a restart.
 */

export type BudgetUsage = { tokens: number; calls: number }

export type BudgetStore = {
  adaptiveUsage(month: string): BudgetUsage
  addAdaptiveUsage(month: string, tokens: number, calls: number, now: number): void
}

export type BudgetMode = "hot" | "batch"

export type Budget = {
  month(): string
  spent(): BudgetUsage
  /** What may still be spent; `cap` lowers the month's limit for one provider. */
  remaining(mode: BudgetMode, cap?: number): number
  /**
   * Reserves the estimate before a call: it fits, so it is persisted and the call may go; or it does
   * not, and nothing is written.
   *
   * The reservation *is* the spend. Persisting it before the call is what keeps a failure after
   * tokens were sent from counting zero, and what stops concurrent callers from both passing the cap.
   * A model that does not report input usage is charged the estimate, so the estimate is the unit and
   * there is nothing to reconcile beyond counting it once.
   */
  reserve(tokens: number, mode: BudgetMode, cap?: number): boolean
}

/** `YYYY-MM` in UTC, so every process on the machine agrees on where the month ends. */
export const budgetMonth = (now: number): string => new Date(now).toISOString().slice(0, 7)

export function createBudget(input: {
  limits: () => { monthlyTokens: number; hotReserveFraction: number }
  store: BudgetStore
  now?: () => number
}): Budget {
  const now = input.now ?? Date.now
  // The batch may only spend what is left once the hot path's reserve is set aside.
  const cap = (mode: BudgetMode, provider?: number): number => {
    const limits = input.limits()
    const monthlyTokens = Math.max(0, Math.min(limits.monthlyTokens, provider ?? Number.POSITIVE_INFINITY))
    if (mode === "hot") return monthlyTokens
    return monthlyTokens - monthlyTokens * Math.min(1, Math.max(0, limits.hotReserveFraction))
  }

  const month = () => budgetMonth(now())
  const spent = () => input.store.adaptiveUsage(month())
  const remaining = (mode: BudgetMode, provider?: number) => Math.max(0, cap(mode, provider) - spent().tokens)

  return {
    month,
    spent,
    remaining,
    reserve: (tokens, mode, provider) => {
      if (tokens > remaining(mode, provider)) return false
      input.store.addAdaptiveUsage(month(), tokens, 1, now())
      return true
    },
  }
}
