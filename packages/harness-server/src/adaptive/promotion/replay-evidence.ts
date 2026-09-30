/**
 * Replay as primary evidence (ADR-0025 R15): reads a replay report (`bun run replay`, AH-B04) and turns
 * it into the paired estimates the criteria's `paired` checks read.
 *
 * A replay runs the same fixtures under a baseline and a treatment variant, so each fixture is its own
 * control: the estimate is over fixture pairs, and the bootstrap resamples pairs whole. A fixture
 * counts only when both variants finished it `EVALUATION.replayRepetitions` times. The report says
 * which capability it measures through its variants' `adaptive` patches: the treatment turns the
 * capability on and the baseline turns it off explicitly, or the report is not evidence for it.
 * Nothing here runs a replay, asks a model or writes a file.
 */

import type { ReplayReport, ReplayRun } from "../../replay/runner"
import { CRITERIA, EVALUATION, METRICS, checkKey } from "./criteria"
import type { Check, Estimate, MetricID, PromotionCapability } from "./criteria"
import { bootstrap } from "./stats"
import type { Statistic } from "./stats"

export type ReplayEvidence = {
  file: string
  startedAt: number
  baseline: string
  variant: string
  /** Fixture pairs that count towards the minimum. */
  fixtures: number
  estimates: Partial<Record<string, Estimate>>
}

type Side = { uncachedInput: number; usd: number; completion: number; compactions: number; rereads: number; summaryTokens: number }
type Pair = { fixture: string; treatment: Side; baseline: Side }

/** The `adaptive` switch each replay-decided capability's variants set. */
const SWITCHES: Partial<Record<PromotionCapability, (patch: Record<string, unknown>) => unknown>> = {
  toolTrim: (patch) => field(patch.toolTrim, "enabled"),
  selection: (patch) => field(patch.selection, "enabled"),
  anchors: (patch) => field(patch.compaction, "anchors"),
}

/** Every capability the report measures, with its paired estimates. */
export function replayEvidence(report: ReplayReport, file: string): Array<{ capability: PromotionCapability; evidence: ReplayEvidence }> {
  requireReport(report, file)
  const baseline = report.variants.find((variant) => variant.name === report.baseline)
  return CRITERIA.flatMap((criteria) => {
    const read = SWITCHES[criteria.id]
    if (!read || !baseline || state(baseline.adaptive, read) !== "off") return []
    const treatments = report.variants.filter((variant) => variant.name !== report.baseline && state(variant.adaptive, read) === "on")
    if (treatments.length === 0) return []
    if (treatments.length > 1)
      throw new Error(`${file}: variants ${treatments.map((variant) => variant.name).join(", ")} all turn ${criteria.id} on; keep one`)
    const variant = treatments[0]!.name
    const pairs = pairsOf(report.runs, report.baseline, variant).filter(
      // Anchors only act at a compaction: a fixture that did not compact in both variants says nothing.
      (pair) => criteria.id !== "anchors" || (pair.treatment.compactions > 0 && pair.baseline.compactions > 0),
    )
    const estimates = Object.fromEntries(
      [...criteria.primary, ...criteria.guardrails]
        .filter((check) => check.measure === "paired")
        .map((check) => [checkKey(check), estimate(check, pairs)]),
    )
    return [
      {
        capability: criteria.id,
        evidence: { file, startedAt: report.startedAt, baseline: report.baseline, variant, fixtures: pairs.length, estimates },
      },
    ]
  })
}

/** The fixtures both variants finished `replayRepetitions` times, each side averaged over its runs. */
export function pairsOf(runs: readonly ReplayRun[], baseline: string, variant: string): Pair[] {
  const side = (fixture: string, name: string) => {
    const all = runs.filter((run) => run.fixture === fixture && run.variant === name)
    const ok = all.filter((run) => run.status === "ok")
    if (ok.length < EVALUATION.replayRepetitions) return undefined
    const mean = (value: (run: ReplayRun) => number) => ok.reduce((sum, run) => sum + value(run), 0) / ok.length
    const total = (value: (run: ReplayRun) => number) => ok.reduce((sum, run) => sum + value(run), 0)
    return {
      uncachedInput: mean((run) => run.tokens.input),
      usd: mean((run) => run.usd),
      // Completion counts every run, as the replay's own aggregate does: an errored run did not complete.
      completion: all.filter((run) => run.completed).length / all.length,
      compactions: total((run) => run.compaction?.compactions ?? 0),
      rereads: total((run) => run.compaction?.rereadsAfterCompaction ?? 0),
      summaryTokens: total((run) => run.compaction?.summaryTokens ?? 0),
    }
  }
  return [...new Set(runs.map((run) => run.fixture))].toSorted().flatMap((fixture) => {
    const treatment = side(fixture, variant)
    const reference = side(fixture, baseline)
    return treatment && reference ? [{ fixture, treatment, baseline: reference }] : []
  })
}

function estimate(check: Check, pairs: Pair[]): Estimate {
  return bootstrap({
    measure: "paired",
    control: [],
    treatment: pairs,
    statistic: pairedStatistic(check.metric),
    resamples: EVALUATION.resamples,
    seed: `${EVALUATION.seed}:replay:${checkKey(check)}`,
    confidence: EVALUATION.confidence,
  })
}

/**
 * The paired statistic of a metric: for a heavy-tailed sum, the geometric mean of the per-fixture
 * ratios − 1 (so one long fixture cannot carry the result); for a share, the mean per-fixture
 * difference; for a per-compaction rate, Σ treatment ÷ Σ baseline − 1 (a rate can be 0, which a log
 * cannot take).
 */
export function pairedStatistic(metric: MetricID): Statistic<Pair> {
  const value = SIDE_VALUES[metric]
  if (!value) return () => undefined
  if (METRICS[metric].log)
    return (pairs) =>
      pairs.length === 0
        ? undefined
        : Math.exp(pairs.reduce((sum, pair) => sum + Math.log((value(pair.treatment) + 1) / (value(pair.baseline) + 1)), 0) / pairs.length) - 1
  if (METRICS[metric].unit === "share")
    return (pairs) =>
      pairs.length === 0 ? undefined : pairs.reduce((sum, pair) => sum + value(pair.treatment) - value(pair.baseline), 0) / pairs.length
  return (pairs) => {
    const bottom = pairs.reduce((sum, pair) => sum + value(pair.baseline), 0)
    return bottom === 0 ? undefined : pairs.reduce((sum, pair) => sum + value(pair.treatment), 0) / bottom - 1
  }
}

const perCompaction = (value: number, side: Side) => (side.compactions === 0 ? 0 : value / side.compactions)

const SIDE_VALUES: Partial<Record<MetricID, (side: Side) => number>> = {
  uncachedInputPerSession: (side) => side.uncachedInput,
  usdPerSession: (side) => side.usd,
  completion: (side) => side.completion,
  rereadsPerCompaction: (side) => perCompaction(side.rereads, side),
  summaryTokensPerCompaction: (side) => perCompaction(side.summaryTokens, side),
}

function state(patch: Record<string, unknown> | undefined, read: (patch: Record<string, unknown>) => unknown) {
  if (!patch) return "unset"
  // The kill switch turns every capability off, whatever its own switch says.
  if (patch.enabled === false) return "off"
  const value = read(patch)
  return value === true ? "on" : value === false ? "off" : "unset"
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined
}

function requireReport(report: ReplayReport, file: string) {
  if (
    report?.version !== 1 ||
    typeof report.startedAt !== "number" ||
    typeof report.baseline !== "string" ||
    !Array.isArray(report.variants) ||
    !Array.isArray(report.runs)
  )
    throw new Error(`${file}: not a replay report (version 1, from \`bun run replay\`)`)
}
