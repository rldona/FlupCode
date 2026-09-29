import { describe, expect, test } from "bun:test"
import { DEFAULT_RETENTION_CONFIG } from "./config"
import { retentionCutoffs } from "./retention"

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

describe("retentionCutoffs (FH-082)", () => {
  test("turns each window into its own cutoff from the clock", () => {
    const cutoffs = retentionCutoffs(
      {
        enabled: true,
        decisionsDays: 30,
        actingDays: 90,
        plansDays: 30,
        appliedPlansDays: 90,
        reflectionDays: 10,
        rejectedProposalsDays: 5,
      },
      NOW,
    )
    expect(cutoffs).toEqual({
      decisionsBefore: NOW - 30 * DAY,
      actingBefore: NOW - 90 * DAY,
      plansBefore: NOW - 30 * DAY,
      appliedPlansBefore: NOW - 90 * DAY,
      reflectionBefore: NOW - 10 * DAY,
      proposalsBefore: NOW - 5 * DAY,
    })
  })

  test("the defaults give acting and applied plans the longer window", () => {
    const cutoffs = retentionCutoffs(DEFAULT_RETENTION_CONFIG, NOW)
    expect(cutoffs.actingBefore).toBeLessThan(cutoffs.decisionsBefore)
    expect(cutoffs.appliedPlansBefore).toBeLessThan(cutoffs.plansBefore)
  })

  test("is pure: the same clock always gives the same cutoffs", () => {
    expect(retentionCutoffs(DEFAULT_RETENTION_CONFIG, NOW)).toEqual(retentionCutoffs(DEFAULT_RETENTION_CONFIG, NOW))
  })
})
