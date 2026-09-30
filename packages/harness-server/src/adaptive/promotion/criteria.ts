/**
 * The preregistered promotion criteria (AH-G01, ADR-0025).
 *
 * One place holds every number the live evaluation (AH-G02) is judged by: the primary metric of each
 * capability and its threshold, the guardrails, the safety stops, the minimum sample per arm and the
 * evaluation window. The report reads them from here, and `criteria.test.ts` asserts the table
 * embedded in the ADR is exactly `renderCriteriaTable()`, so the document a person approves and the
 * code that applies it cannot drift apart. Changing a number after the evaluation started is a new
 * ADR, not an edit.
 */

import type { HoldoutCapability } from "../holdout"

export const PROMOTION_CAPABILITIES = [
  "toolTrim",
  "selection",
  "relevance",
  "model",
  "guardrails",
  "anchors",
  "learning",
] as const
export type PromotionCapability = (typeof PROMOTION_CAPABILITIES)[number]

/** The rules every capability shares (ADR-0025 §4). */
export const EVALUATION = {
  /** The fixed window: the analysis runs once, at the later of this and the minimum sample. */
  windowDays: 14,
  confidence: 0.95,
  /** Bootstrap resamples by unit (the session, or the proposal for learning), with a fixed seed. */
  resamples: 2000,
  seed: "ah-g01",
  /** The share the ADR recommends during the window; `holdout.fraction` accepts up to 0.5. */
  recommendedHoldoutFraction: 0.5,
  /** A safety stop on a session metric only fires once each arm has this many sessions behind it. */
  safetyMinSessionsPerArm: 30,
} as const

export type MetricID =
  | "uncachedInputPerSession"
  | "usdPerSession"
  | "toolCallsPerSession"
  | "completion"
  | "errorRate"
  | "p95TurnMs"
  | "recallMiss"
  | "pairingErrors"
  | "relevanceCorrect"
  | "relevanceLatencyP95"
  | "relevanceModelLatencyP95"
  | "loopStopped"
  | "rereadsPerCompaction"
  | "summaryTokensPerCompaction"
  | "uplift"
  | "costPerUsefulDecision"
  | "approvalRate"
  | "approvedSkillsUsed"
  | "contentIncidents"

/** How a metric is read: its unit and the plain name the report prints. */
export const METRICS: Record<MetricID, { label: string; unit: "tokens" | "usd" | "count" | "share" | "ms" | "ratio" }> = {
  uncachedInputPerSession: { label: "Uncached input tokens per session", unit: "tokens" },
  usdPerSession: { label: "USD per session", unit: "usd" },
  toolCallsPerSession: { label: "Tool calls per session", unit: "count" },
  completion: { label: "Task completion", unit: "share" },
  errorRate: { label: "Turns with a tool or provider error", unit: "share" },
  p95TurnMs: { label: "p95 turn duration", unit: "ms" },
  recallMiss: { label: "Recall miss (evidence reads per trimmed output)", unit: "ratio" },
  pairingErrors: { label: "Requests rejected for a broken tool pair", unit: "count" },
  relevanceCorrect: { label: "Correct skill load", unit: "share" },
  relevanceLatencyP95: { label: "p95 relevance decision latency, no model", unit: "ms" },
  relevanceModelLatencyP95: { label: "p95 relevance decision latency, with a model", unit: "ms" },
  loopStopped: { label: "Detected loops that stopped", unit: "share" },
  rereadsPerCompaction: { label: "Re-reads after compaction per compaction", unit: "ratio" },
  summaryTokensPerCompaction: { label: "Summary tokens per compaction", unit: "tokens" },
  uplift: { label: "Uplift conditional on disagreement", unit: "share" },
  costPerUsefulDecision: { label: "USD per useful decision", unit: "usd" },
  approvalRate: { label: "Proposals approved", unit: "share" },
  approvedSkillsUsed: { label: "Approved skills used in 2+ sessions within 30 days", unit: "share" },
  contentIncidents: { label: "Content incidents (attested)", unit: "count" },
}

/**
 * What a check compares. `relative` is treatment ÷ control − 1 and `difference` is treatment − control,
 * both between holdout arms; `treatment` and `control` read one arm alone; `overall` is a capability
 * with no holdout arm (the predictive model's counterfactual label, learning's human review).
 */
export type Measure = "relative" | "difference" | "treatment" | "control" | "overall"

export type Check = {
  metric: MetricID
  measure: Measure
  op: "<" | "<=" | ">" | ">="
  threshold: number
  /** The 95% CI must also exclude zero on the good side (primary metrics only). */
  significant?: boolean
  /** No data for it (e.g. no model answered) leaves the check out instead of blocking the decision. */
  optional?: boolean
  /** The threshold is read from the config snapshot at `start` (the VOI gate's own value). */
  thresholdFrom?: "voi.valueOfCorrect"
}

/** A sample the decision needs before it may be read; `perArm` counts each arm separately. */
export type SampleRequirement = { counter: SampleCounter; min: number; perArm: boolean }

export type SampleCounter =
  | "sessions"
  | "sessionsWithCompaction"
  | "judgedRelevance"
  | "judgedLoops"
  | "judgedDisagreements"
  | "decidedProposals"
  | "promotedWithClosedWindow"

export const SAMPLE_LABELS: Record<SampleCounter, string> = {
  sessions: "sessions",
  sessionsWithCompaction: "sessions with a compaction",
  judgedRelevance: "judged relevance decisions",
  judgedLoops: "judged loop detections",
  judgedDisagreements: "judged disagreements",
  decidedProposals: "decided proposals",
  promotedWithClosedWindow: "approved skills with a closed 30-day window",
}

export type CapabilityCriteria = {
  id: PromotionCapability
  title: string
  /** The holdout capability whose arm splits the sessions, or null when there is no holdout arm. */
  holdout: HoldoutCapability | null
  /** `all` promotes when every primary check passes; `any` when one does (§14.3's "or"). */
  primaryMode: "all" | "any"
  primary: Check[]
  guardrails: Check[]
  /** A check that, once true, stops the evaluation and retires the capability before the window ends. */
  safety: Check[]
  sample: SampleRequirement[]
  /** Criteria the stored fields cannot measure; the person checks them at G03. */
  manual: string[]
}

/** The guardrails every session-randomised capability carries (§14.2). */
const SESSION_GUARDRAILS: Check[] = [
  { metric: "completion", measure: "difference", op: ">=", threshold: -0.01 },
  { metric: "errorRate", measure: "difference", op: "<=", threshold: 0.01 },
  { metric: "p95TurnMs", measure: "relative", op: "<=", threshold: 0.1 },
]

const SESSION_SAFETY: Check[] = [
  { metric: "completion", measure: "difference", op: "<", threshold: -0.05 },
  { metric: "errorRate", measure: "difference", op: ">", threshold: 0.05 },
]

export const CRITERIA: readonly CapabilityCriteria[] = [
  {
    id: "toolTrim",
    title: "Tool-output trim",
    holdout: "toolTrim",
    primaryMode: "all",
    primary: [{ metric: "uncachedInputPerSession", measure: "relative", op: "<=", threshold: -0.15, significant: true }],
    guardrails: [...SESSION_GUARDRAILS, { metric: "recallMiss", measure: "treatment", op: "<", threshold: 0.05 }],
    safety: SESSION_SAFETY,
    sample: [{ counter: "sessions", min: 698, perArm: true }],
    manual: ["Added p95 latency of the trim hook < 20 ms (not stored per call; measured offline)."],
  },
  {
    id: "selection",
    title: "Per-step selection",
    holdout: "selection",
    primaryMode: "all",
    primary: [{ metric: "usdPerSession", measure: "relative", op: "<", threshold: 0, significant: true }],
    guardrails: [...SESSION_GUARDRAILS, { metric: "pairingErrors", measure: "treatment", op: "<=", threshold: 0 }],
    safety: [...SESSION_SAFETY, { metric: "pairingErrors", measure: "treatment", op: ">", threshold: 0 }],
    sample: [{ counter: "sessions", min: 698, perArm: true }],
    manual: [],
  },
  {
    id: "relevance",
    title: "Skill suggestion",
    holdout: "relevance",
    primaryMode: "any",
    primary: [
      { metric: "relevanceCorrect", measure: "relative", op: ">=", threshold: 0.1, significant: true },
      { metric: "toolCallsPerSession", measure: "relative", op: "<=", threshold: -0.05, significant: true },
    ],
    guardrails: [
      ...SESSION_GUARDRAILS,
      { metric: "relevanceLatencyP95", measure: "treatment", op: "<", threshold: 50, optional: true },
      { metric: "relevanceModelLatencyP95", measure: "treatment", op: "<", threshold: 300, optional: true },
    ],
    safety: SESSION_SAFETY,
    sample: [{ counter: "judgedRelevance", min: 1562, perArm: true }],
    manual: [],
  },
  {
    id: "model",
    title: "Predictive model (per kind and provider)",
    holdout: null,
    primaryMode: "all",
    primary: [{ metric: "uplift", measure: "overall", op: ">", threshold: 0, significant: true }],
    guardrails: [
      {
        metric: "costPerUsefulDecision",
        measure: "overall",
        op: "<=",
        threshold: 0.05,
        thresholdFrom: "voi.valueOfCorrect",
      },
    ],
    safety: [],
    sample: [{ counter: "judgedDisagreements", min: 194, perArm: false }],
    manual: ["Otherwise the VOI gate's auto-pause (AH-C05) stays the default for that kind."],
  },
  {
    id: "guardrails",
    title: "Loop warnings",
    holdout: "guardrails",
    primaryMode: "all",
    primary: [{ metric: "loopStopped", measure: "difference", op: ">=", threshold: 0.3, significant: true }],
    guardrails: [...SESSION_GUARDRAILS, { metric: "loopStopped", measure: "control", op: "<", threshold: 0.1 }],
    safety: SESSION_SAFETY,
    sample: [{ counter: "judgedLoops", min: 36, perArm: true }],
    manual: [
      "Aborts and the engine's native doom_loop are not recorded where the harness can read them; compare with doom_loop by hand before retiring.",
    ],
  },
  {
    id: "anchors",
    title: "Compaction anchors",
    holdout: "anchors",
    primaryMode: "all",
    primary: [{ metric: "rereadsPerCompaction", measure: "relative", op: "<", threshold: 0, significant: true }],
    guardrails: [
      ...SESSION_GUARDRAILS,
      { metric: "summaryTokensPerCompaction", measure: "relative", op: "<=", threshold: 0.1 },
    ],
    safety: SESSION_SAFETY,
    sample: [{ counter: "sessionsWithCompaction", min: 252, perArm: true }],
    manual: [],
  },
  {
    id: "learning",
    title: "Learning",
    holdout: null,
    primaryMode: "all",
    primary: [
      { metric: "approvalRate", measure: "overall", op: ">=", threshold: 0.1 },
      { metric: "approvedSkillsUsed", measure: "overall", op: ">=", threshold: 0.5 },
    ],
    guardrails: [{ metric: "contentIncidents", measure: "overall", op: "<=", threshold: 0 }],
    safety: [{ metric: "contentIncidents", measure: "overall", op: ">", threshold: 0 }],
    sample: [
      { counter: "decidedProposals", min: 10, perArm: false },
      { counter: "promotedWithClosedWindow", min: 3, perArm: false },
    ],
    manual: ["0 installations without approval (ADR-0022) stays enforced by tests, not measured here."],
  },
]

export const criteriaFor = (id: PromotionCapability): CapabilityCriteria => CRITERIA.find((entry) => entry.id === id)!

// ---- power (ADR-0025 §5) ----------------------------------------------------------------------------

/** Two-sided α = 0.05 and power 0.8. */
const Z_ALPHA = 1.959964
const Z_BETA = 0.841621

/** Sessions per arm to detect a relative change `effect` in a mean whose coefficient of variation is `cv`. */
export function sampleForMeans(cv: number, effect: number): number {
  return Math.ceil(2 * (Z_ALPHA + Z_BETA) ** 2 * (cv / effect) ** 2)
}

/** Units per arm to detect a move from proportion `p0` to `p1`. */
export function sampleForProportions(p0: number, p1: number): number {
  return Math.ceil(((Z_ALPHA + Z_BETA) ** 2 * (p0 * (1 - p0) + p1 * (1 - p1))) / (p1 - p0) ** 2)
}

/** Units to tell a one-sample proportion `p1` from `p0`. */
export function sampleForOneProportion(p0: number, p1: number): number {
  return Math.ceil(((Z_ALPHA * Math.sqrt(p0 * (1 - p0)) + Z_BETA * Math.sqrt(p1 * (1 - p1))) / (p1 - p0)) ** 2)
}

/** The assumptions each minimum sample comes from, so the test can recompute it. */
export const POWER_ASSUMPTIONS = {
  toolTrim: { minimum: sampleForMeans(1, 0.15), assumption: "CV of uncached input per session = 1.0; true effect −15%" },
  selection: { minimum: sampleForMeans(1, 0.15), assumption: "CV of USD per session = 1.0; true effect −15%" },
  relevance: {
    minimum: sampleForProportions(0.5, 0.55),
    assumption: "correct-load rate 0.50 in control; true effect +10% relative (0.55)",
  },
  model: { minimum: sampleForOneProportion(0.5, 0.6), assumption: "model right on 60% of disagreements (uplift 0.2)" },
  guardrails: { minimum: sampleForProportions(0.2, 0.5), assumption: "20% of loops stop in control; true uplift +30 pp" },
  anchors: {
    minimum: sampleForMeans(1, 0.25),
    assumption: "CV of re-reads per compacted session = 1.0; true effect −25%",
  },
  learning: { minimum: 10, assumption: "not a test: 10 decided proposals make one approval 10%" },
} satisfies Record<PromotionCapability, { minimum: number; assumption: string }>

// ---- the decision (ADR-0025 §7) --------------------------------------------------------------------

export type Estimate = { estimate?: number; low?: number; high?: number }

export type Decision = "promote" | "keep observing" | "retire" | "insufficient data"

export type Evidence = {
  /** Keyed by `checkKey(check)`. */
  estimates: Partial<Record<string, Estimate>>
  /** Keyed by counter, then arm (or `overall`). */
  samples: Partial<Record<SampleCounter, { control?: number; treatment?: number; overall?: number }>>
  windowComplete: boolean
  /** Thresholds resolved from the config snapshot, for checks with `thresholdFrom`. */
  thresholds?: Partial<Record<string, number>>
}

export type CheckVerdict = "pass" | "fail" | "unknown"

export const checkKey = (check: Pick<Check, "metric" | "measure">) => `${check.metric}:${check.measure}`

export function thresholdOf(check: Check, evidence: Pick<Evidence, "thresholds">): number {
  return evidence.thresholds?.[checkKey(check)] ?? check.threshold
}

/** Whether a point estimate meets a check, and for a significant one whether the CI clears zero. */
export function verdictOf(check: Check, estimate: Estimate | undefined, threshold = check.threshold): CheckVerdict {
  if (estimate?.estimate === undefined) return "unknown"
  if (!compare(estimate.estimate, check.op, threshold)) return "fail"
  if (!check.significant) return "pass"
  if (estimate.low === undefined || estimate.high === undefined) return "unknown"
  const lower = check.op === "<" || check.op === "<="
  return (lower ? estimate.high < 0 : estimate.low > 0) ? "pass" : "fail"
}

/** The CI lies wholly on the wrong side of the threshold: more data would not reach it. */
export function futile(check: Check, estimate: Estimate | undefined, threshold = check.threshold): boolean {
  if (estimate?.low === undefined || estimate.high === undefined) return false
  const lower = check.op === "<" || check.op === "<="
  return lower ? estimate.low > threshold : estimate.high < threshold
}

export function sampleMet(requirement: SampleRequirement, evidence: Evidence): boolean {
  const counts = evidence.samples[requirement.counter]
  if (!requirement.perArm) return (counts?.overall ?? 0) >= requirement.min
  return (counts?.control ?? 0) >= requirement.min && (counts?.treatment ?? 0) >= requirement.min
}

/** A safety check fires when its stop condition holds on the point estimate. */
export function safetyTriggered(check: Check, evidence: Evidence): boolean {
  const estimate = evidence.estimates[checkKey(check)]?.estimate
  if (estimate === undefined) return false
  if (!compare(estimate, check.op, check.threshold)) return false
  // A session metric needs a few sessions in each arm, or a single bad session would stop it.
  if (check.measure !== "difference" && check.measure !== "relative") return true
  const sessions = evidence.samples.sessions
  return (
    (sessions?.control ?? 0) >= EVALUATION.safetyMinSessionsPerArm &&
    (sessions?.treatment ?? 0) >= EVALUATION.safetyMinSessionsPerArm
  )
}

/**
 * The preregistered decision table, in order: a safety stop retires; before the window closes or the
 * minimum sample is reached nothing is read; a guardrail that fails retires; the primary checks then
 * promote, retire when their CI cannot reach the threshold, or leave the capability where it is.
 */
export function decide(criteria: CapabilityCriteria, evidence: Evidence): { decision: Decision; reasons: string[] } {
  const stops = criteria.safety.filter((check) => safetyTriggered(check, evidence))
  if (stops.length > 0) return { decision: "retire", reasons: stops.map((check) => `safety stop: ${describeCheck(check)}`) }
  const missing = criteria.sample.filter((requirement) => !sampleMet(requirement, evidence))
  if (!evidence.windowComplete || missing.length > 0)
    return {
      decision: "insufficient data",
      reasons: [
        ...(evidence.windowComplete ? [] : [`the ${EVALUATION.windowDays}-day window has not closed`]),
        ...missing.map((requirement) => `below ${requirement.min} ${SAMPLE_LABELS[requirement.counter]}${requirement.perArm ? " per arm" : ""}`),
      ],
    }
  const verdict = (check: Check) => verdictOf(check, evidence.estimates[checkKey(check)], thresholdOf(check, evidence))
  const failed = criteria.guardrails.filter((check) => verdict(check) === "fail")
  if (failed.length > 0) return { decision: "retire", reasons: failed.map((check) => `guardrail failed: ${describeCheck(check)}`) }
  const unknown = criteria.guardrails.filter((check) => !check.optional && verdict(check) === "unknown")
  const passed = criteria.primary.filter((check) => verdict(check) === "pass")
  const hopeless = criteria.primary.filter((check) =>
    futile(check, evidence.estimates[checkKey(check)], thresholdOf(check, evidence)),
  )
  const promote = criteria.primaryMode === "all" ? passed.length === criteria.primary.length : passed.length > 0
  if (promote && unknown.length === 0)
    return { decision: "promote", reasons: passed.map((check) => `met: ${describeCheck(check)}`) }
  const retire = criteria.primaryMode === "all" ? hopeless.length > 0 : hopeless.length === criteria.primary.length
  if (retire)
    return { decision: "retire", reasons: hopeless.map((check) => `cannot reach: ${describeCheck(check)}`) }
  return {
    decision: "keep observing",
    reasons: [
      ...unknown.map((check) => `guardrail not measurable: ${describeCheck(check)}`),
      ...(promote ? [] : ["the primary metric did not reach its threshold with a 95% CI clear of zero"]),
    ],
  }
}

function compare(value: number, op: Check["op"], threshold: number) {
  if (op === "<") return value < threshold
  if (op === "<=") return value <= threshold
  if (op === ">") return value > threshold
  return value >= threshold
}

// ---- the table the ADR embeds ----------------------------------------------------------------------

const MEASURE_LABELS: Record<Measure, string> = {
  relative: "relative Δ (T ÷ C − 1)",
  difference: "Δ (T − C)",
  treatment: "treatment arm",
  control: "control arm",
  overall: "all units",
}

export function describeCheck(check: Check): string {
  const op = { "<": "<", "<=": "≤", ">": ">", ">=": "≥" }[check.op]
  const value = formatThreshold(check)
  const ci = check.significant
    ? check.op === "<" || check.op === "<="
      ? "; 95% CI upper < 0"
      : "; 95% CI lower > 0"
    : ""
  return `${METRICS[check.metric].label}, ${MEASURE_LABELS[check.measure]} ${op} ${value}${ci}`
}

function formatThreshold(check: Check): string {
  const unit = METRICS[check.metric].unit
  const from = check.thresholdFrom ? ` (\`${check.thresholdFrom}\`, default)` : ""
  if (check.measure === "relative") return `${signed(check.threshold * 100)}%`
  if (unit === "share" && check.measure === "difference") return `${signed(check.threshold * 100)} pp`
  if (unit === "share" || unit === "ratio") return `${round(check.threshold * 100)}%`
  if (unit === "ms") return `${check.threshold} ms`
  if (unit === "usd") return `${check.threshold} USD${from}`
  return `${check.threshold}`
}

const round = (value: number) => Number(value.toFixed(4)).toString()
const signed = (value: number) => (value > 0 ? `+${round(value)}` : value < 0 ? `−${round(-value)}` : "0")

/** The markdown table ADR-0025 embeds between its `criteria` markers. */
export function renderCriteriaTable(): string {
  const rows = CRITERIA.flatMap((criteria) => {
    const unit = criteria.holdout ? `session (\`armFor(…, "${criteria.holdout}")\`)` : "none (no holdout arm)"
    const sample = criteria.sample
      .map((requirement) => `${requirement.min} ${SAMPLE_LABELS[requirement.counter]}${requirement.perArm ? " per arm" : ""}`)
      .join("; ")
    const cell = (checks: Check[], joiner: string) => checks.map(describeCheck).join(joiner) || "—"
    return [
      `| ${criteria.title} | ${unit} | ${cell(criteria.primary, criteria.primaryMode === "any" ? " **or** " : " **and** ")} | ${cell(criteria.guardrails, "; ")} | ${cell(criteria.safety, "; ")} | ${sample} |`,
    ]
  })
  return [
    `Window: ${EVALUATION.windowDays} days or the minimum sample, whichever is later. CI: ${EVALUATION.confidence * 100}% percentile bootstrap by unit, ${EVALUATION.resamples} resamples, seed \`${EVALUATION.seed}\`.`,
    "",
    "| Capability | Randomisation | Primary (promote when met) | Guardrails | Safety stop | Minimum sample |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n")
}
