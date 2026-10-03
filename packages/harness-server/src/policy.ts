/**
 * How a run spends (H-30): which model a role uses and what to fall back to, on a failure or when the
 * run nears a budget or its provider's quota (PI-04). When it stops and asks is the budget's, measured
 * on the ledger (`budget.ts`, UL-08).
 *
 * Kept out of the runner's loop so the rules are plain functions with their own tests: a model is
 * resolved from the task, then the policy.
 */

import type { AdaptiveConfig } from "./adaptive/config"
import { DEFAULT_DECISION_POLICY, type DecisionResult, type ModelRouteState } from "./adaptive/decision"
import type { DecisionService } from "./adaptive/decision-service"
import { modelRoute } from "./adaptive/decisions/model-route"
import { runStandings, type BudgetStanding } from "./budget"
import type { QuotaWindow } from "./quota/adapters"
import { QUOTA_MAX_BACKOFF_MS } from "./quota/poller"
import type { SqliteRoutineRepository } from "./repository"
import type { Run, RunPolicy, TaskRoute } from "./types"

export type Model = { providerID: string; id: string; variant?: string }

/** "provider/model" as the two ids the engine wants. Anything else is not a model. */
export function parseModelKey(key: string | undefined): Model | undefined {
  const value = key?.trim()
  if (!value) return undefined
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

/**
 * The model a task runs on: its own if it names one, else the policy's for the role it runs as.
 *
 * A task that says what it needs is not overruled by a policy — the policy fills the gaps a process
 * leaves, it does not second-guess a decision.
 */
export function modelForTask(
  task: { model?: Model; agent?: string },
  policy: RunPolicy | undefined,
): Model | undefined {
  if (task.model) return task.model
  return parseModelKey(task.agent ? policy?.models?.[task.agent] : undefined)
}

/**
 * The model a retry should use.
 *
 * The fallback, when the policy names one — unless it is the very model the attempt already failed
 * on, in which case repeating it would be repeating the failure.
 */
export function fallbackModel(policy: RunPolicy | undefined, current: Model | undefined): Model | undefined {
  const fallback = parseModelKey(policy?.fallback)
  if (!fallback) return current
  if (current && current.providerID === fallback.providerID && current.id === fallback.id) return current
  return fallback
}

// ---- routing under pressure (PI-04) ------------------------------------------------------------

/** The share of a budget or of a quota window at which a run's next task moves to its fallback. */
export const ROUTE_AT = 0.8

/**
 * How close a run is to what it may spend, as of `now`: the budget that covers it and is furthest
 * spent (its own or a standing one, on the ledger the budget gate reads, UL-08), and the shortest
 * quota window of the provider its next task would use (UL-07).
 *
 * Read on its own so that what a run does about it is a separate rule: routing the next task to the
 * fallback model is one (`routeTask`); other ways a run can react to the same pressure read this too.
 */
export function runPressure(
  ledger: Pick<SqliteRoutineRepository, "budgetSpend" | "listBudgets" | "get" | "quotaSamples">,
  run: Run,
  providerID: string | undefined,
  now = Date.now(),
): Pressure {
  const budget = runStandings(ledger, run, now)
    .filter((standing) => standing.limit > 0)
    .map((standing) => ({ standing, share: standing.spent / standing.limit }))
    .toSorted((a, b) => b.share - a.share)[0]
  const quota = providerID ? shortestWindow(ledger, providerID, now) : undefined
  return { ...(budget ? { budget } : {}), ...(quota ? { quota } : {}) }
}

export type Pressure = {
  budget?: { standing: BudgetStanding; share: number }
  /** A reading of the provider's whole key, use outside FlupCode included. */
  quota?: { providerID: string; window: QuotaWindow; share: number; at: number }
}

/** Asks the `modelRoute` decision through the adaptive layer; see `createRouter`. */
export type Router = (input: {
  runID: string
  taskID: string
  projectID?: string
  state: ModelRouteState
}) => Promise<DecisionResult<"modelRoute">>

/**
 * The model an agent task is sent to and why (PI-04).
 *
 * The task's own model, else its role's, else the engine's default — unless the policy names a
 * fallback and the run has reached `ROUTE_AT` of a budget or of its provider's shortest quota window:
 * then the fallback, for this task and, while the pressure lasts, the ones after it. A task that names
 * its own model is routed too, as a retry is (`fallbackModel`): the budget is the run's, whoever chose
 * the model. A routing model, when one is assigned, may move a task to the fallback before the line,
 * never keep it on the model past it, so a remote opinion cannot spend more than the rule allows.
 */
export async function routeTask(input: {
  task: { model?: Model; agent?: string }
  policy: RunPolicy | undefined
  pressure: Pressure
  router?: (state: ModelRouteState) => Promise<DecisionResult<"modelRoute">>
}): Promise<{ model?: Model; route: TaskRoute }> {
  const chosen = modelForTask(input.task, input.policy)
  const fallback = parseModelKey(input.policy?.fallback)
  const pressure = input.pressure
  const state =
    fallback && !sameModel(chosen, fallback) && (pressure.budget || pressure.quota)
      ? routeState(input.task.agent, chosen, fallback, pressure)
      : undefined
  const rule = state ? modelRoute.baseline({ state, policy: DEFAULT_DECISION_POLICY }) : undefined
  const asked = state && input.router ? await input.router(state).catch(() => undefined) : undefined
  const byModel = asked?.source === "model" && asked.answer.route === "fallback" && rule?.answer.route === "keep"
  if (fallback && (rule?.answer.route === "fallback" || byModel))
    return {
      model: fallback,
      route: {
        model: modelKey(fallback),
        fallback: true,
        reason: byModel
          ? `The routing model (${asked!.provider}) moved this task to the fallback model before the ${percent(ROUTE_AT)} line${figures(pressure)}`
          : `${crossed(pressure)}, so this task runs on the policy's fallback model`,
        source: byModel ? "model" : "rule",
      },
    }
  return {
    ...(chosen ? { model: chosen } : {}),
    route: {
      ...(chosen ? { model: modelKey(chosen) } : {}),
      fallback: false,
      reason: `${origin(input.task, chosen)}${kept(pressure, !!fallback && !sameModel(chosen, fallback))}`,
      source: "rule",
    },
  }
}

/**
 * The router: the `modelRoute` decision, asked of whatever model the adaptive layer assigns it.
 *
 * Through the decision service, so the model, its consent, its budget and its audit row are the ones
 * every other decision uses; with no model assigned the service answers with its rule. The state
 * names no folder (the kind's `egress`), and the project's path only reaches the local consent check.
 */
export function createRouter(service: DecisionService, config: () => AdaptiveConfig): Router {
  return (input) =>
    service.predict(
      {
        kind: "modelRoute",
        policy: config().decisions.modelRoute,
        scopeID: `${input.runID}:${input.taskID}`,
        ...(input.projectID ? { projectID: input.projectID } : {}),
        state: input.state,
      },
      "hot",
      false,
    )
}

function routeState(role: string | undefined, chosen: Model | undefined, fallback: Model, pressure: Pressure): ModelRouteState {
  return {
    ...(role ? { role } : {}),
    ...(chosen ? { model: modelKey(chosen) } : {}),
    fallback: modelKey(fallback),
    threshold: ROUTE_AT,
    ...(pressure.budget
      ? { budget: { scope: pressure.budget.standing.scope, unit: pressure.budget.standing.unit, share: pressure.budget.share } }
      : {}),
    ...(pressure.quota
      ? { quota: { providerID: pressure.quota.providerID, window: pressure.quota.window.id, share: pressure.quota.share } }
      : {}),
  }
}

/** Why the task would run on the model it has, before any pressure. */
function origin(task: { model?: Model; agent?: string }, chosen: Model | undefined) {
  if (task.model) return "The task's own model"
  if (chosen) return `The policy's model for the ${task.agent} role`
  return "The engine's default model"
}

/** What the pressure was, when the task stayed on its model. */
function kept(pressure: Pressure, hasFallback: boolean) {
  const over = [pressure.budget, pressure.quota].some((entry) => entry && entry.share >= ROUTE_AT)
  if (over && !hasFallback) return `. ${crossed(pressure)}, and the policy names no other model to move to`
  if (!hasFallback) return ""
  const said = figures(pressure)
  return said ? `${said}, under the ${percent(ROUTE_AT)} at which the run moves to its fallback` : ""
}

/** The reading that crossed the line, budget first, as the rule checks it. */
function crossed(pressure: Pressure) {
  if (pressure.budget && pressure.budget.share >= ROUTE_AT) return budgetWords(pressure.budget)
  return pressure.quota ? quotaWords(pressure.quota) : ""
}

function figures(pressure: Pressure) {
  const said = [pressure.budget ? budgetWords(pressure.budget) : undefined, pressure.quota ? quotaWords(pressure.quota) : undefined]
  const present = said.filter((entry): entry is string => !!entry)
  return present.length > 0 ? `; ${present.join("; ")}` : ""
}

function budgetWords(budget: NonNullable<Pressure["budget"]>) {
  const standing = budget.standing
  const which = standing.unit === "usd" ? "cost budget" : "token budget"
  const of =
    standing.scope === "run"
      ? `the run's ${which}`
      : standing.scope === "day"
        ? `today's ${which}`
        : `the ${standing.scope} ${standing.name}'s daily ${which}`
  return `${percent(budget.share)} of ${of} is spent`
}

// A provider reports the use of the key as a whole (UL-07): other tools on the same key count too, so
// the reason says so rather than reading as this run's own use (P4).
function quotaWords(quota: NonNullable<Pressure["quota"]>) {
  const resets = quota.window.resetAt !== null ? `, resets ${new Date(quota.window.resetAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""
  return `${percent(quota.share)} of ${quota.providerID}'s shortest quota window (${quota.window.id}${resets}) is used, a reading of the whole key that counts its use outside FlupCode too`
}

/**
 * The provider's shortest window with a share to read, from its latest reading: the one that resets
 * first, a cap or a balance only when there is no other (the window the Cost screen heads a provider
 * with). A reading older than the poller's longest wait is stale and says nothing, and a window whose
 * reset has passed has started again since it was read.
 */
function shortestWindow(ledger: Pick<SqliteRoutineRepository, "quotaSamples">, providerID: string, now: number) {
  const samples = ledger.quotaSamples(providerID, now - QUOTA_MAX_BACKOFF_MS)
  const at = samples.at(-1)?.at
  if (at === undefined || at < now - QUOTA_MAX_BACKOFF_MS) return undefined
  const window = samples
    .filter((sample) => sample.at === at && (sample.window.resetAt === null || sample.window.resetAt > now))
    .map((sample) => sample.window)
    .toSorted((a, b) => (a.resetAt ?? Infinity) - (b.resetAt ?? Infinity))[0]
  const share = window ? windowShare(window) : undefined
  return window && share !== undefined ? { providerID, window, share, at } : undefined
}

function windowShare(window: QuotaWindow) {
  if (window.limit === null || window.limit <= 0) return undefined
  const used = window.used ?? (window.remaining !== null ? window.limit - window.remaining : null)
  return used === null ? undefined : Math.max(0, used / window.limit)
}

const modelKey = (model: Model) => `${model.providerID}/${model.id}`

const sameModel = (a: Model | undefined, b: Model) => a?.providerID === b.providerID && a.id === b.id

const percent = (share: number) => `${Math.round(share * 100)}%`
