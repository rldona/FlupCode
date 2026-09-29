/**
 * The pure loop detector (FH-060, ADR-0023 §3).
 *
 * The cases pin the false-positive guard: a changed argument, an interleaved error and a
 * non-consecutive repetition all break a streak, while only the run that ends at the last
 * observation is ever counted.
 */

import { describe, expect, test } from "bun:test"
import { appendObservation, detectLoop, failureState } from "./guardrails-detector"
import type { LoopObservation, RingEntry } from "./guardrails-detector"

const LIMITS = { windowMs: 1_000, maxObservations: 3 } as const

const call = (tool: string, argsDigest: string): LoopObservation => ({ kind: "call", tool, argsDigest })
const error = (tool: string, errorDigest: string): LoopObservation => ({ kind: "error", tool, errorDigest })

const ring = (observations: readonly LoopObservation[], startAt = 0): RingEntry[] =>
  observations.map((obs, index) => ({ at: startAt + index, obs }))

describe("appendObservation", () => {
  test("drops entries outside the window and keeps the newest", () => {
    const first = appendObservation([], call("bash", "a"), 0, LIMITS)
    const second = appendObservation(first, call("bash", "b"), 500, LIMITS)
    expect(second).toHaveLength(2)

    // At 1_000 the entry at 0 is exactly at the window edge and is dropped.
    const third = appendObservation(second, call("bash", "c"), 1_000, LIMITS)
    expect(third.map((entry) => entry.obs)).toEqual([call("bash", "b"), call("bash", "c")])
  })

  test("trims to the newest maxObservations", () => {
    const grown = [call("bash", "a"), call("bash", "a"), call("bash", "a"), call("bash", "a")].reduce(
      (acc, obs, index) => appendObservation(acc, obs, index, LIMITS),
      [] as RingEntry[],
    )
    expect(grown).toHaveLength(LIMITS.maxObservations)
    expect(grown.map((entry) => entry.at)).toEqual([1, 2, 3])
  })

  test("does not mutate the input ring", () => {
    const before = ring([call("bash", "a")])
    const after = appendObservation(before, call("bash", "a"), 1, LIMITS)
    expect(before).toHaveLength(1)
    expect(after).toHaveLength(2)
  })
})

describe("detectLoop", () => {
  test("counts identical consecutive calls", () => {
    expect(detectLoop(ring([call("bash", "a"), call("bash", "a"), call("bash", "a")]))).toEqual({
      repeatedCalls: 3,
      repeatedErrors: 0,
      tool: "bash",
      argsDigest: "a",
    })
  })

  test("a changed argument ends the run", () => {
    expect(detectLoop(ring([call("bash", "a"), call("bash", "a"), call("bash", "b")]))).toEqual({
      repeatedCalls: 1,
      repeatedErrors: 0,
      tool: "bash",
      argsDigest: "b",
    })
  })

  test("an interleaved error breaks a run of calls", () => {
    // The same call is seen twice more, but not consecutively: the error in between resets it.
    expect(detectLoop(ring([call("bash", "a"), call("bash", "a"), error("bash", "x")]))).toEqual({
      repeatedCalls: 0,
      repeatedErrors: 1,
      tool: "bash",
      errorDigest: "x",
    })
  })

  test("a non-consecutive repetition only counts its tail", () => {
    // A flaky retry pattern: bash runs, something else runs, bash runs twice. Not a loop of three.
    expect(detectLoop(ring([call("bash", "a"), call("grep", "b"), call("bash", "a"), call("bash", "a")]))).toEqual({
      repeatedCalls: 2,
      repeatedErrors: 0,
      tool: "bash",
      argsDigest: "a",
    })
  })

  test("counts identical consecutive errors", () => {
    expect(detectLoop(ring([error("bash", "x"), error("bash", "x")]))).toEqual({
      repeatedCalls: 0,
      repeatedErrors: 2,
      tool: "bash",
      errorDigest: "x",
    })
  })

  test("a call after errors ends the error run and starts a call run", () => {
    expect(detectLoop(ring([error("bash", "x"), error("bash", "x"), call("bash", "a")]))).toEqual({
      repeatedCalls: 1,
      repeatedErrors: 0,
      tool: "bash",
      argsDigest: "a",
    })
  })

  test("an empty ring is no signal", () => {
    expect(detectLoop([])).toEqual({ repeatedCalls: 0, repeatedErrors: 0 })
  })

  test("a single observation is a run of one", () => {
    expect(detectLoop(ring([call("bash", "a")]))).toEqual({
      repeatedCalls: 1,
      repeatedErrors: 0,
      tool: "bash",
      argsDigest: "a",
    })
  })
})

describe("failureState", () => {
  test("maps the signal and reports stepsUsed as unsupported zero", () => {
    const state = failureState({ repeatedCalls: 4, repeatedErrors: 0 })
    expect(state).toEqual({ repeatedCalls: 4, repeatedErrors: 0, stepsUsed: 0 })
    expect("stepsBudget" in state).toBe(false)
  })
})
