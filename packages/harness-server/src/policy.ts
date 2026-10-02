/**
 * How a run spends (H-30): which model a role uses and what to fall back to. When it stops and asks
 * is the budget's, measured on the ledger (`budget.ts`, UL-08).
 *
 * Kept out of the runner's loop so the rules are plain functions with their own tests: a model is
 * resolved from the task, then the policy.
 */

import type { RunPolicy } from "./types"

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
