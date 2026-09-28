/**
 * The outcome an episode left behind (FH-005).
 *
 * The episode already carries the evidence — the run's state, the checks it ran, the failures, the
 * files and the commands — so the outcome is a reading of that aggregate, never a second execution:
 * nothing here runs a check, touches git or reads the model's findings. The precedence below is the
 * whole policy, and it is pure so the same evidence always reads the same.
 */

import { outcomeForRun } from "./episode"
import type { EpisodeFailure, EpisodeOutcome, EpisodeVerification } from "./episode"

/** How many refs a derived reading keeps: enough to trace it, not a second index. */
export const OUTCOME_REF_LIMIT = 20

export type EpisodeOutcomeInput = {
  runStatus?: string
  verifications: EpisodeVerification[]
  failures: EpisodeFailure[]
  files: string[]
  commands: string[]
}

export type EpisodeOutcomeReading = { outcome: EpisodeOutcome; evidenceRefs: string[] }

/** The distinct steps in first-appearance order, with the verdict their last appearance left. */
const finalVerdicts = (verifications: EpisodeVerification[]) => {
  const order: string[] = []
  const byStep = new Map<string, boolean>()
  for (const { step, ok } of verifications) {
    if (!byStep.has(step)) order.push(step)
    byStep.set(step, ok)
  }
  return { order, byStep }
}

const cap = (refs: string[]): string[] => refs.slice(0, OUTCOME_REF_LIMIT)

const verifyRef = (step: string): string => `verify:${step}`

/** One ref per failure anchor, in order, without repeating the same place twice. */
const failureRefs = (failures: EpisodeFailure[]): string[] => {
  const seen = new Set<string>()
  const refs: string[] = []
  for (const failure of failures) {
    const ref = `failure:${failure.file ?? "unknown"}:${failure.line ?? 0}`
    if (seen.has(ref)) continue
    seen.add(ref)
    refs.push(ref)
  }
  return refs
}

/** Pura: mismo input → mismo output. Sin I/O, sin reloj, sin azar. */
export function deriveOutcome(input: EpisodeOutcomeInput): EpisodeOutcomeReading {
  const { order, byStep } = finalVerdicts(input.verifications)
  const redSteps = order.filter((step) => byStep.get(step) === false)

  // A run that settled is the harness's own verdict; a check it ran can only make that verdict more
  // careful, never more confident.
  if (input.runStatus !== undefined) {
    const statusOutcome = outcomeForRun(input.runStatus)
    if (statusOutcome === "success") {
      if (redSteps.length > 0) return { outcome: "partial", evidenceRefs: cap(redSteps.map(verifyRef)) }
      return { outcome: "success", evidenceRefs: cap(order.map(verifyRef)) }
    }
    return { outcome: statusOutcome, evidenceRefs: [] }
  }

  // With no run to speak for the work, the checks do; failing one is the only concrete evidence.
  if (order.length > 0) {
    if (redSteps.length > 0) return { outcome: "partial", evidenceRefs: cap(redSteps.map(verifyRef)) }
    return { outcome: "success", evidenceRefs: cap(order.map(verifyRef)) }
  }
  if (input.failures.length > 0) return { outcome: "partial", evidenceRefs: cap(failureRefs(input.failures)) }
  if (input.files.length > 0 || input.commands.length > 0) return { outcome: "partial", evidenceRefs: [] }
  return { outcome: "unknown", evidenceRefs: [] }
}
