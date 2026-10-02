/**
 * Replay as primary evidence (ADR-0025 R15) on synthetic replay reports: the report names the
 * capability through its variants, a fixture counts only with three repetitions on both sides, and
 * the paired estimates are the geometric mean, the mean difference and the ratio of sums they claim.
 */

import { describe, expect, test } from "bun:test"
import type { ReplayReport, ReplayRun, ReplayVariant } from "@flupcode/harness-server/replay/runner"
import { pairsOf, pairedStatistic, replayEvidence } from "./replay-evidence"

const T0 = Date.parse("2026-10-05T00:00:00Z")

function run(fixture: string, variant: string, repetition: number, over: Partial<ReplayRun> = {}): ReplayRun {
  return {
    fixture,
    variant,
    repetition,
    status: "ok",
    tokens: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 100, reasoning: 0 },
    usd: 0.1,
    wallMs: 1000,
    source: "session_metrics",
    turnErrors: 0,
    completed: true,
    ...over,
  }
}

function report(variants: ReplayVariant[], runs: ReplayRun[]): ReplayReport {
  return {
    version: 1,
    startedAt: T0,
    finishedAt: T0 + 1000,
    engine: "http://127.0.0.1:0",
    repeat: 3,
    seed: null,
    tolerance: 0.05,
    isolation: "worktree",
    variants,
    baseline: variants[0]!.name,
    runs,
    aggregates: [],
    comparisons: [],
  }
}

const TRIM: ReplayVariant[] = [
  { name: "baseline", adaptive: { toolTrim: { enabled: false } } },
  { name: "tool-trim", adaptive: { toolTrim: { enabled: true } } },
]

/** `count` fixtures × 3 repetitions; the treatment's uncached input is `factor(index)` × the baseline's. */
function trimRuns(count: number, factor: (index: number) => number) {
  return Array.from({ length: count }, (_, index) => `fx-${String(index).padStart(2, "0")}`).flatMap((fixture, index) =>
    [1, 2, 3].flatMap((repetition) => {
      const base = 1000 * (index + 1)
      return [
        run(fixture, "baseline", repetition, { tokens: { input: base, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 } }),
        run(fixture, "tool-trim", repetition, { tokens: { input: base * factor(index), cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 } }),
      ]
    }),
  )
}

describe("a replay report as evidence", () => {
  test("names the capability its treatment turns on against a baseline that turns it off", () => {
    const found = replayEvidence(report(TRIM, trimRuns(25, () => 0.8)), "trim.json")
    expect(found.map((entry) => entry.capability)).toEqual(["toolTrim"])
    expect(found[0]!.evidence).toMatchObject({ file: "trim.json", baseline: "baseline", variant: "tool-trim", fixtures: 25, startedAt: T0 })
  })

  test("a baseline that leaves the switch unset is no evidence; two treatments are ambiguous", () => {
    const unset = [{ name: "baseline" }, TRIM[1]!]
    expect(replayEvidence(report(unset, trimRuns(25, () => 0.8)), "x.json")).toEqual([])
    const killed = [{ name: "baseline", adaptive: { enabled: false } }, TRIM[1]!]
    expect(replayEvidence(report(killed, trimRuns(25, () => 0.8)), "x.json").map((entry) => entry.capability)).toEqual(["toolTrim"])
    const twice = [...TRIM, { name: "tool-trim-2", adaptive: { toolTrim: { enabled: true, thresholdBytes: 8192 } } }]
    expect(() => replayEvidence(report(twice, []), "x.json")).toThrow("keep one")
    expect(() => replayEvidence({ version: 2 } as unknown as ReplayReport, "x.json")).toThrow("not a replay report")
  })

  test("the selection and anchors variant files are recognised too", () => {
    const selection = [
      { name: "baseline", idleMs: 390000, adaptive: { selection: { enabled: false } } },
      { name: "selection-cold", idleMs: 390000, adaptive: { selection: { enabled: true, coldGapMs: 360000 } } },
    ]
    const anchors = [
      { name: "baseline", adaptive: { compaction: { anchors: false } } },
      { name: "anchors", adaptive: { compaction: { anchors: true } } },
    ]
    expect(replayEvidence(report(selection, []), "s.json").map((entry) => entry.capability)).toEqual(["selection"])
    expect(replayEvidence(report(anchors, []), "a.json").map((entry) => entry.capability)).toEqual(["anchors"])
  })

  test("a fixture counts only when both variants finished it three times", () => {
    const runs = [
      ...trimRuns(3, () => 0.8),
      // Two good repetitions and one error on the treatment side: not a full pair.
      run("short", "baseline", 1),
      run("short", "baseline", 2),
      run("short", "baseline", 3),
      run("short", "tool-trim", 1),
      run("short", "tool-trim", 2),
      run("short", "tool-trim", 3, { status: "error", completed: false }),
    ]
    expect(pairsOf(runs, "baseline", "tool-trim").map((pair) => pair.fixture)).toEqual(["fx-00", "fx-01", "fx-02"])
  })

  test("a heavy-tailed sum is the geometric mean of the per-fixture ratios", () => {
    // Ratios 0.5 and 0.8 on fixtures of very different size: the geometric mean is √0.4 ≈ 0.632.
    const pairs = pairsOf(trimRuns(2, (index) => (index === 0 ? 0.5 : 0.8)), "baseline", "tool-trim")
    const value = pairedStatistic("uncachedInputPerSession")(pairs)!
    expect(value).toBeCloseTo(Math.exp((Math.log(501 / 1001) + Math.log(1601 / 2001)) / 2) - 1, 12)
    expect(value).toBeCloseTo(Math.sqrt(0.4) - 1, 3)
  })

  test("completion is the mean per-fixture difference, counting errored runs as not completed", () => {
    const runs = [
      ...[1, 2, 3].map((repetition) => run("a", "baseline", repetition)),
      ...[1, 2, 3].map((repetition) => run("a", "tool-trim", repetition, { completed: repetition !== 3 })),
      ...[1, 2, 3, 4].map((repetition) => run("b", "baseline", repetition)),
      ...[1, 2, 3, 4].map((repetition) =>
        run("b", "tool-trim", repetition, repetition === 4 ? { status: "error", completed: false } : {}),
      ),
    ]
    const pairs = pairsOf(runs, "baseline", "tool-trim")
    expect(pairedStatistic("completion")(pairs)).toBeCloseTo((-1 / 3 + -1 / 4) / 2, 12)
  })

  test("re-reads per compaction are Σ treatment ÷ Σ baseline − 1, over fixtures that compacted in both", () => {
    const anchors = [
      { name: "baseline", adaptive: { compaction: { anchors: false } } },
      { name: "anchors", adaptive: { compaction: { anchors: true } } },
    ]
    const compacting = (fixture: string, variant: string, rereads: number, summaryTokens: number) =>
      [1, 2, 3].map((repetition) =>
        run(fixture, variant, repetition, { compaction: { compactions: 1, rereadsAfterCompaction: rereads, summaryTokens } }),
      )
    const runs = [
      ...compacting("long-a", "baseline", 4, 500),
      ...compacting("long-a", "anchors", 2, 520),
      ...compacting("long-b", "baseline", 2, 400),
      ...compacting("long-b", "anchors", 1, 440),
      // Never compacted: left out of the anchors comparison.
      ...[1, 2, 3].flatMap((repetition) => [run("short", "baseline", repetition), run("short", "anchors", repetition)]),
    ]
    const evidence = replayEvidence(report(anchors, runs), "a.json")[0]!.evidence
    expect(evidence.fixtures).toBe(2)
    expect(evidence.estimates["rereadsPerCompaction:paired"]!.estimate).toBeCloseTo((2 + 1) / (4 + 2) - 1, 12)
    expect(evidence.estimates["summaryTokensPerCompaction:paired"]!.estimate).toBeCloseTo((520 + 440) / (500 + 400) - 1, 12)
    expect(evidence.estimates["completion:paired"]!.estimate).toBe(0)
  })

  test("a clear, consistent cut clears zero with its 90% CI; a mixed one does not", () => {
    const clear = replayEvidence(report(TRIM, trimRuns(25, (index) => 0.7 + (index % 5) * 0.02)), "t.json")[0]!.evidence
    const primary = clear.estimates["uncachedInputPerSession:paired"]!
    expect(primary.estimate!).toBeLessThan(-0.2)
    expect(primary.high!).toBeLessThan(0)
    const mixed = replayEvidence(report(TRIM, trimRuns(25, (index) => (index % 2 === 0 ? 0.6 : 1.5))), "t.json")[0]!.evidence
    const noisy = mixed.estimates["uncachedInputPerSession:paired"]!
    expect(noisy.low!).toBeLessThan(0)
    expect(noisy.high!).toBeGreaterThan(0)
  })
})
