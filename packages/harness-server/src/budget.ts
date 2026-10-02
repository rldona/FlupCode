/**
 * Budgets as policy (UL-08): what may be spent, measured on the usage ledger, never on a figure the
 * runner wrote after a turn.
 *
 * Two kinds of budget, one rule. A run's own is its policy's (`RunPolicy.budget`, set at launch or by
 * the routine that starts it). A standing one is a row of `budget` over a day of spend: everything,
 * one workflow by name, or one routine. Each is a limit in USD or in tokens with an optional warning
 * share. The warning (`soft`) is said once; crossing the limit (`hard`) stops the runs it covers at the
 * step that crossed it and pauses them at the budget gate, where a person can carry on or stop.
 *
 * What the ledger cannot see, a budget cannot either, and it is said rather than hidden (P4):
 *
 * - **Unpriced steps** (`cost_basis = unpriced`, a model with no price) add nothing to a cost budget:
 *   their money is unknown, not zero. They count in a token budget like every other step, and the
 *   standing reports how many there were, so the meter can say the cost figure leaves them out.
 * - **Titles** the engine generates are in `SessionInfo.cost` but reach no plugin on 2.0.18 (UL-02),
 *   so they are not in the ledger. A task's session is opened with its title, so the engine writes
 *   none for it and a run's figure is whole; a day's figure misses the title of each conversation.
 * - **Live** means the session-metrics plugin is reporting. Without it, rows arrive by the reconciler
 *   once a session is idle, so a run is caught between tasks instead of at the step.
 *
 * Tokens are input, output and reasoning: cache reads are cheap and repeat the context every step,
 * so a token budget that counted them would be spent by re-reading, not by work.
 */

import type { SqliteRoutineRepository } from "./repository"
import type { Budget, Run, RunBudget } from "./types"

export type BudgetUnit = Budget["unit"]
type Level = "soft" | "hard"

/** One budget that applies, and where it stands on the ledger. */
export type BudgetStanding = {
  /** What a notice is keyed on: the run's limit, or a standing budget on its day. */
  key: string
  scope: "run" | Budget["scope"]
  /** What it is a budget of, in words. */
  name: string
  budgetID?: string
  unit: BudgetUnit
  limit: number
  softPct?: number
  spent: number
  /** Rows with no price, which a cost budget cannot count. */
  unpriced: number
  level?: Level
  /** Why a run stops at it, as the task's error and the gate's reason. */
  reason: string
}

type Ledger = Pick<SqliteRoutineRepository, "budgetSpend" | "listBudgets" | "get">

/** Every budget a run answers to: its own, then the standing ones that cover it, as of `now`. */
export function runStandings(ledger: Ledger, run: Run, now = Date.now()): BudgetStanding[] {
  const own = ledger.budgetSpend({ runID: run.id })
  const limits = [
    ...(run.policy?.budget?.cost !== undefined ? [{ unit: "usd" as const, limit: run.policy.budget.cost }] : []),
    ...(run.policy?.budget?.tokens !== undefined ? [{ unit: "tokens" as const, limit: run.policy.budget.tokens }] : []),
  ]
  const routineID = run.source.type === "routine" ? run.source.routineID : undefined
  return [
    ...limits.map((entry) =>
      standing({
        key: `run:${run.id}:${entry.unit}`,
        scope: "run",
        name: run.workflow?.name ?? "Run",
        unit: entry.unit,
        limit: entry.limit,
        softPct: softPctOf(run.policy?.budget),
        spend: own,
      }),
    ),
    ...standingBudgets(ledger, now).filter(
      (entry) =>
        entry.scope === "day" ||
        (entry.scope === "workflow" && entry.target === run.workflow?.name) ||
        (entry.scope === "routine" && entry.target === routineID),
    ),
  ]
}

/** Every standing budget with what was spent in it today (local time). */
export function standingBudgets(ledger: Ledger, now = Date.now()) {
  const from = dayStart(now)
  const day = new Date(from).toISOString().slice(0, 10)
  return ledger.listBudgets().map((budget) => ({
    ...standing({
      key: `budget:${budget.id}:${day}`,
      scope: budget.scope,
      // A routine is named by its id; a person knows it by its name.
      name: budget.scope === "routine" ? (ledger.get(budget.target ?? "")?.name ?? "routine") : (budget.target ?? "today"),
      budgetID: budget.id,
      unit: budget.unit,
      limit: budget.limit,
      softPct: budget.softPct,
      spend: ledger.budgetSpend({
        from,
        ...(budget.scope === "workflow" ? { workflowName: budget.target ?? "" } : {}),
        ...(budget.scope === "routine" ? { routineID: budget.target ?? "" } : {}),
      }),
    }),
    target: budget.target ?? "",
  }))
}

/** The first budget a run has crossed, if any: what it stops at. */
export const hardReason = (standings: BudgetStanding[]) => standings.find((entry) => entry.level === "hard")?.reason

/**
 * Says a budget was reached, once per key and level: an event on the server's stream, which the app
 * shows and the remote host pushes. Returns whether this call was the one that said it.
 */
export function announce(
  repository: Pick<SqliteRoutineRepository, "raiseBudgetAlert" | "append">,
  entry: BudgetStanding,
  where: { runID?: string; sessionID?: string } = {},
) {
  if (!entry.level || !repository.raiseBudgetAlert(entry.key, entry.level)) return false
  repository.append({
    type: "budget.reached",
    level: entry.level,
    scope: entry.scope,
    name: entry.name,
    unit: entry.unit,
    limit: entry.limit,
    spent: entry.spent,
    ...(entry.budgetID ? { budgetID: entry.budgetID } : {}),
    ...(where.runID ? { runID: where.runID } : {}),
    ...(where.sessionID ? { sessionID: where.sessionID } : {}),
  })
  return true
}

/** Midnight of `now`'s day, in this machine's time zone: when a day's budget starts again. */
export function dayStart(now: number) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** A warning share between 1 and 99, or none: 0 or 100 would warn at nothing or at the stop. */
export function softPctOf(budget: Pick<RunBudget, "softPct"> | undefined) {
  const value = budget?.softPct
  return value !== undefined && value > 0 && value < 100 ? value : undefined
}

function standing(input: {
  key: string
  scope: BudgetStanding["scope"]
  name: string
  budgetID?: string
  unit: BudgetUnit
  limit: number
  softPct?: number
  spend: { usd: number; tokens: number; unpriced: number }
}): BudgetStanding {
  const spent = input.unit === "usd" ? input.spend.usd : input.spend.tokens
  const level: Level | undefined =
    spent >= input.limit
      ? "hard"
      : input.softPct !== undefined && spent >= (input.limit * input.softPct) / 100
        ? "soft"
        : undefined
  return {
    key: input.key,
    scope: input.scope,
    name: input.name,
    ...(input.budgetID ? { budgetID: input.budgetID } : {}),
    unit: input.unit,
    limit: input.limit,
    ...(input.softPct !== undefined ? { softPct: input.softPct } : {}),
    spent,
    unpriced: input.spend.unpriced,
    ...(level ? { level } : {}),
    reason: reasonOf(input.scope, input.name, input.unit, input.limit),
  }
}

function reasonOf(scope: BudgetStanding["scope"], name: string, unit: BudgetUnit, limit: number) {
  const which = unit === "usd" ? "cost budget" : "token budget"
  // Six significant figures: a limit set as a sum of prices must not read as $0.026250000000000002.
  const amount = unit === "usd" ? `$${Number(limit.toPrecision(6))}` : String(limit)
  if (scope === "run") return `Reached the run's ${which} (${amount})`
  if (scope === "day") return `Reached today's ${which} (${amount})`
  return `Reached the ${scope} ${name}'s daily ${which} (${amount})`
}

/**
 * `GET /harness/budgets` (every standing budget with today's spend), `PUT /harness/budgets` (one per
 * scope, target and unit: saving again replaces its limit) and `DELETE /harness/budgets/:id`.
 * `undefined` for any other path, so the caller goes on to its other routes.
 */
export async function handleBudgetRoutes(
  request: Request,
  path: string[],
  repository: Ledger & Pick<SqliteRoutineRepository, "saveBudget" | "removeBudget">,
) {
  if (path[1] !== "budgets") return undefined
  if (request.method === "GET" && path.length === 2) {
    const standings = standingBudgets(repository)
    // Each budget as it was saved, with where it stands today.
    return Response.json({
      data: repository.listBudgets().map((budget) => {
        const entry = standings.find((candidate) => candidate.budgetID === budget.id)!
        return { ...budget, name: entry.name, spent: entry.spent, unpriced: entry.unpriced, ...(entry.level ? { level: entry.level } : {}) }
      }),
    })
  }
  if (request.method === "DELETE" && path[2] && path.length === 3)
    return repository.removeBudget(path[2])
      ? Response.json({ data: true })
      : Response.json({ error: "Budget not found", code: "not_found" }, { status: 404 })
  if (request.method !== "PUT" || path.length !== 2) return undefined
  const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined
  const scope = body?.scope
  if (scope !== "day" && scope !== "workflow" && scope !== "routine") return invalid("scope must be day, workflow or routine")
  const target = typeof body?.target === "string" ? body.target.trim() : ""
  if (scope !== "day" && !target) return invalid(`A ${scope} budget needs the ${scope} it is for`)
  if (scope === "routine" && !repository.get(target)) return invalid("No such routine")
  if (body?.unit !== "usd" && body?.unit !== "tokens") return invalid("unit must be usd or tokens")
  const limit = body.limit
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return invalid("limit must be a positive number")
  const softPct = typeof body.softPct === "number" ? softPctOf({ softPct: body.softPct }) : undefined
  return Response.json({
    data: repository.saveBudget({
      scope,
      ...(scope !== "day" ? { target } : {}),
      unit: body.unit,
      limit: body.unit === "tokens" ? Math.floor(limit) : limit,
      ...(softPct !== undefined ? { softPct } : {}),
    }),
  })
}

function invalid(message: string) {
  return Response.json({ error: message, code: "invalid_request" }, { status: 400 })
}
