/**
 * The per-session holdout (AH-B05): the split is the configured share, stable per session and drawn
 * independently per capability.
 */

import { describe, expect, test } from "bun:test"
import { resolveAdaptiveConfig } from "./config"
import { HOLDOUT_CAPABILITIES, armFor, armsFor } from "./holdout"

const ids = Array.from({ length: 1000 }, (_, index) => `ses_${index.toString(36)}_${(index * 7919).toString(16)}`)

describe("armFor", () => {
  test("splits 1000 synthetic sessions 80/20 within two points", () => {
    const control = ids.filter((id) => armFor(id, "relevance", 0.2) === "control").length
    expect(control / ids.length).toBeGreaterThanOrEqual(0.18)
    expect(control / ids.length).toBeLessThanOrEqual(0.22)
  })

  test("a session keeps its arm, and the capabilities are drawn independently", () => {
    expect(ids.map((id) => armFor(id, "guardrails", 0.2))).toEqual(ids.map((id) => armFor(id, "guardrails", 0.2)))
    const disagree = ids.filter((id) => armFor(id, "relevance", 0.2) !== armFor(id, "guardrails", 0.2)).length
    expect(disagree).toBeGreaterThan(0)
    expect(armsFor("ses_1", 0.2)).toEqual({
      relevance: armFor("ses_1", "relevance", 0.2),
      guardrails: armFor("ses_1", "guardrails", 0.2),
      toolTrim: armFor("ses_1", "toolTrim", 0.2),
      anchors: armFor("ses_1", "anchors", 0.2),
      selection: armFor("ses_1", "selection", 0.2),
    })
  })

  test("every capability the promotion criteria compare has an arm (AH-G01)", () => {
    expect([...HOLDOUT_CAPABILITIES]).toEqual(["relevance", "guardrails", "toolTrim", "anchors", "selection"])
    for (const capability of HOLDOUT_CAPABILITIES) {
      const control = ids.filter((id) => armFor(id, capability, 0.2) === "control").length
      expect(control / ids.length).toBeGreaterThanOrEqual(0.17)
      expect(control / ids.length).toBeLessThanOrEqual(0.23)
    }
  })

  test("a zero share holds out nothing", () => {
    expect(ids.every((id) => armFor(id, "relevance", 0) === "treatment")).toBe(true)
  })
})

describe("the holdout config", () => {
  test("defaults to a 20% share, accepts [0, 0.5] and ignores anything else", () => {
    expect(resolveAdaptiveConfig({ env: {} }).holdout).toEqual({ fraction: 0.2 })
    expect(resolveAdaptiveConfig({ block: { holdout: { fraction: 0 } }, env: {} }).holdout.fraction).toBe(0)
    expect(resolveAdaptiveConfig({ block: { holdout: { fraction: 0.5 } }, env: {} }).holdout.fraction).toBe(0.5)
    for (const fraction of [0.9, -0.1, "0.3", Number.NaN])
      expect(resolveAdaptiveConfig({ block: { holdout: { fraction } }, env: {} }).holdout.fraction).toBe(0.2)
  })
})
