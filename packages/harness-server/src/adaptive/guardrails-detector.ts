/**
 * The deterministic failure/loop detector (FH-060, ADR-0023 §3).
 *
 * This module is pure: it holds no clock, no store and no model. It appends opaque observations to a
 * per-session ring, counts the **consecutive identical** tail and maps the signal to a
 * `FailureState`. Only digests ever reach it — never an argument, a message or a tool output.
 *
 * A different argument, an interleaved error or an observation that fell out of the window breaks a
 * streak, so an ordinary retry (same tool, one changed argument) is never read as a loop.
 */

import type { FailureState } from "./decision"

export type LoopObservation =
  | { kind: "call"; tool: string; argsDigest: string; callID?: string }
  | { kind: "error"; tool: string; errorDigest: string; callID?: string }

export type LoopSignal = {
  repeatedCalls: number
  repeatedErrors: number
  tool?: string
  argsDigest?: string
  errorDigest?: string
}

/** One observation in a session's ring, with the clock the ring ordered it by. */
export type RingEntry = { at: number; obs: LoopObservation }

export const DETECTOR_LIMITS = { windowMs: 600_000, maxObservations: 200 } as const

/**
 * Adds an observation to the ring: entries outside the window are dropped first, then the ring is
 * trimmed to its newest `maxObservations`. The returned array is new; the input is not mutated.
 */
export function appendObservation(
  ring: readonly RingEntry[],
  obs: LoopObservation,
  now: number,
  limits: { windowMs: number; maxObservations: number },
): RingEntry[] {
  const fresh = ring.filter((entry) => now - entry.at < limits.windowMs)
  fresh.push({ at: now, obs })
  return fresh.slice(Math.max(0, fresh.length - limits.maxObservations))
}

/** How many entries at the tail of the ring match, until the first that does not. */
function countTail(ring: readonly RingEntry[], matches: (obs: LoopObservation) => boolean): number {
  const reversed = [...ring].reverse()
  const brokenAt = reversed.findIndex((entry) => !matches(entry.obs))
  return brokenAt === -1 ? reversed.length : brokenAt
}

/**
 * The consecutive identical run that ends at the last observation.
 *
 * Only the last observation can be the end of a run, so exactly one of `repeatedCalls` and
 * `repeatedErrors` is ever non-zero: the other run would have to end somewhere in the middle, and a
 * run is defined by where it ends.
 */
export function detectLoop(ring: readonly RingEntry[]): LoopSignal {
  const last = ring[ring.length - 1]
  if (last === undefined) return { repeatedCalls: 0, repeatedErrors: 0 }
  const tail = last.obs
  if (tail.kind === "call") {
    const tool = tail.tool
    const digest = tail.argsDigest
    const repeatedCalls = countTail(
      ring,
      (obs) => obs.kind === "call" && obs.tool === tool && obs.argsDigest === digest,
    )
    return { repeatedCalls, repeatedErrors: 0, tool, argsDigest: digest }
  }
  const tool = tail.tool
  const digest = tail.errorDigest
  const repeatedErrors = countTail(
    ring,
    (obs) => obs.kind === "error" && obs.tool === tool && obs.errorDigest === digest,
  )
  return { repeatedCalls: 0, repeatedErrors, tool, errorDigest: digest }
}

/** The bounded state a `failure` decision is asked about; `stepsUsed` is unsupported (ADR-0023 §4). */
export function failureState(signal: LoopSignal): FailureState {
  return { repeatedCalls: signal.repeatedCalls, repeatedErrors: signal.repeatedErrors, stepsUsed: 0 }
}
