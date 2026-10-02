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

import type { HoldoutCapability } from "@flupcode/harness-server/adaptive/holdout"

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

/** The rules every capability shares (ADR-0025 §4, revised by R12–R16). */
export const EVALUATION = {
  /** The fixed window: the analysis runs once, at the later of this and the minimum sample. */
  windowDays: 14,
  /**
   * The cap (R16): a sample still short this many days after `start` is a final "insufficient data",
   * and the window is not extended. Data after the cap is never read.
   */
  maxWindowDays: 42,
  /**
   * One-sided α = 0.05 (R12): the report prints the 90% two-sided CI, and a primary is significant
   * when the bound on its good side clears zero.
   */
  confidence: 0.9,
  /** Bootstrap resamples by unit (the session, or the proposal for learning), with a fixed seed. */
  resamples: 2000,
  seed: "ah-g01",
  /** The share the ADR recommends during the window; `holdout.fraction` accepts up to 0.5. */
  recommendedHoldoutFraction: 0.5,
  /** A safety stop on a session metric only fires once each arm has this many sessions behind it. */
  safetyMinSessionsPerArm: 30,
  /** CUPED covariate (R13): each project's mean over the sessions that started this long before `start`. */
  cupedPriorDays: 28,
  /** A covariate needs this many prior sessions of the same project; with fewer the session is not adjusted. */
  cupedMinPriorSessions: 2,
  /** A replay fixture counts once both variants finished it this many times (R15). */
  replayRepetitions: 3,
  /**
   * The owner's budget: ~100 real top-level sessions a week, `holdout.fraction` 0.5, about 4 weeks of
   * window, so at most 150 sessions per arm (300 without arms) for every live minimum.
   */
  budget: { sessionsPerWeek: 100, weeks: 4, sessionsPerArm: 150 },
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

/**
 * How a metric is read: its unit and the plain name the report prints. `log` marks the heavy-tailed
 * per-session sums (R13): they are compared as a ratio of geometric means, never of raw means.
 */
export const METRICS: Record<
  MetricID,
  { label: string; unit: "tokens" | "usd" | "count" | "share" | "ms" | "ratio"; log?: true }
> = {
  uncachedInputPerSession: { label: "Uncached input tokens per session", unit: "tokens", log: true },
  usdPerSession: { label: "USD per session", unit: "usd", log: true },
  toolCallsPerSession: { label: "Tool calls per session", unit: "count", log: true },
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
  approvedSkillsUsed: { label: "Approved skills used in 2+ sessions within 14 days", unit: "share" },
  contentIncidents: { label: "Content incidents (attested)", unit: "count" },
}

/**
 * What a check compares. `relative` is treatment ÷ control − 1 and `difference` is treatment − control,
 * both between holdout arms; `geometric` is the ratio of geometric means − 1, on the log scale with the
 * CUPED project adjustment (R13); `treatment` and `control` read one arm alone; `overall` is a
 * capability with no holdout arm (the predictive model's counterfactual label, learning's human
 * review); `paired` comes from a replay report, the treatment variant against the baseline paired by
 * fixture (R15): a difference for a share, a ratio − 1 otherwise.
 */
export type Measure = "relative" | "difference" | "geometric" | "treatment" | "control" | "overall" | "paired"

export type Check = {
  metric: MetricID
  measure: Measure
  op: "<" | "<=" | ">" | ">="
  threshold: number
  /** The 90% CI must also exclude zero on the good side, a one-sided test at α = 0.05 (primary metrics only). */
  significant?: boolean
  /** No data for it (e.g. no model answered) leaves the check out instead of blocking the decision. */
  optional?: boolean
  /** The threshold is read from the config snapshot at `start` (the VOI gate's own value). */
  thresholdFrom?: "voi.valueOfCorrect"
  /**
   * A deterministic defect rather than a noisy estimate (a rejected tool pair, an attested content
   * incident): it fails or stops on its value alone, without the evidence-of-harm bound (R18).
   */
  absolute?: true
}

/** A sample the decision needs before it may be read; `perArm` counts each arm separately. */
export type SampleRequirement = { counter: SampleCounter; min: number; perArm: boolean }

export type SampleCounter =
  | "sessions"
  | "replayFixtures"
  | "judgedRelevance"
  | "judgedLoops"
  | "judgedDisagreements"
  | "decidedProposals"
  | "promotedWithClosedWindow"

export const SAMPLE_LABELS: Record<SampleCounter, string> = {
  sessions: "sessions",
  replayFixtures: "paired replay fixtures (3 repetitions per variant)",
  judgedRelevance: "judged relevance decisions",
  judgedLoops: "judged loop detections",
  judgedDisagreements: "judged disagreements",
  decidedProposals: "decided proposals",
  promotedWithClosedWindow: "approved skills with a closed 14-day window",
}

export type CapabilityCriteria = {
  id: PromotionCapability
  title: string
  /** The holdout capability whose arm splits the sessions, or null when there is no holdout arm. */
  holdout: HoldoutCapability | null
  /**
   * Where the primary evidence comes from: the live holdout, or a paired replay (R15) whose report is
   * passed to `report --replay`; the live arm then only reads the guardrails and the safety stops.
   */
  instrument: "live" | "replay"
  /** The replay command that produces the primary evidence, for `replay` capabilities. */
  replay?: string
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

/** The live sample every session-randomised capability needs before its guardrails are read (R16). */
const LIVE_SESSIONS: SampleRequirement = { counter: "sessions", min: EVALUATION.budget.sessionsPerArm, perArm: true }

/** A replay-decided capability does not lose completion in the replay either (the replay's own rule). */
const REPLAY_COMPLETION: Check = { metric: "completion", measure: "paired", op: ">=", threshold: -0.01 }

const replayCommand = (variants: string) =>
  `bun run replay -- --variants fixtures/replay/variants/${variants} --repeat ${EVALUATION.replayRepetitions} --yes`

export const CRITERIA: readonly CapabilityCriteria[] = [
  {
    id: "toolTrim",
    title: "Tool-output trim",
    holdout: "toolTrim",
    instrument: "replay",
    replay: replayCommand("tool-trim.json"),
    primaryMode: "all",
    primary: [{ metric: "uncachedInputPerSession", measure: "paired", op: "<=", threshold: -0.15, significant: true }],
    guardrails: [
      REPLAY_COMPLETION,
      ...SESSION_GUARDRAILS,
      { metric: "recallMiss", measure: "treatment", op: "<", threshold: 0.05 },
    ],
    safety: SESSION_SAFETY,
    sample: [{ counter: "replayFixtures", min: 22, perArm: false }, LIVE_SESSIONS],
    manual: ["Added p95 latency of the trim hook < 20 ms (not stored per call; measured offline)."],
  },
  {
    id: "selection",
    title: "Per-step selection",
    holdout: "selection",
    instrument: "replay",
    replay: replayCommand("selection.json"),
    primaryMode: "all",
    primary: [{ metric: "usdPerSession", measure: "paired", op: "<", threshold: 0, significant: true }],
    guardrails: [
      REPLAY_COMPLETION,
      ...SESSION_GUARDRAILS,
      { metric: "pairingErrors", measure: "treatment", op: "<=", threshold: 0, absolute: true },
    ],
    safety: [...SESSION_SAFETY, { metric: "pairingErrors", measure: "treatment", op: ">", threshold: 0, absolute: true }],
    sample: [{ counter: "replayFixtures", min: 22, perArm: false }, LIVE_SESSIONS],
    manual: [],
  },
  {
    id: "relevance",
    title: "Skill suggestion",
    holdout: "relevance",
    instrument: "live",
    primaryMode: "any",
    primary: [
      { metric: "relevanceCorrect", measure: "relative", op: ">=", threshold: 0.1, significant: true },
      { metric: "toolCallsPerSession", measure: "geometric", op: "<=", threshold: -0.1, significant: true },
    ],
    guardrails: [
      ...SESSION_GUARDRAILS,
      { metric: "relevanceLatencyP95", measure: "treatment", op: "<", threshold: 50, optional: true },
      { metric: "relevanceModelLatencyP95", measure: "treatment", op: "<", threshold: 300, optional: true },
    ],
    safety: SESSION_SAFETY,
    sample: [{ counter: "judgedRelevance", min: 313, perArm: true }, LIVE_SESSIONS],
    manual: [],
  },
  {
    id: "model",
    title: "Predictive model (per kind and provider)",
    holdout: null,
    instrument: "live",
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
    sample: [{ counter: "judgedDisagreements", min: 97, perArm: false }],
    manual: ["Otherwise the VOI gate's auto-pause (AH-C05) stays the default for that kind."],
  },
  {
    id: "guardrails",
    title: "Loop warnings",
    holdout: "guardrails",
    instrument: "live",
    primaryMode: "all",
    primary: [{ metric: "loopStopped", measure: "difference", op: ">=", threshold: 0.3, significant: true }],
    guardrails: [...SESSION_GUARDRAILS, { metric: "loopStopped", measure: "control", op: "<", threshold: 0.1 }],
    safety: SESSION_SAFETY,
    sample: [{ counter: "judgedLoops", min: 16, perArm: true }, LIVE_SESSIONS],
    manual: [
      "Aborts and the engine's native doom_loop are not recorded where the harness can read them; compare with doom_loop by hand before retiring.",
    ],
  },
  {
    id: "anchors",
    title: "Compaction anchors",
    holdout: "anchors",
    instrument: "replay",
    replay: replayCommand("anchors.json"),
    primaryMode: "all",
    primary: [{ metric: "rereadsPerCompaction", measure: "paired", op: "<", threshold: 0, significant: true }],
    guardrails: [
      REPLAY_COMPLETION,
      { metric: "summaryTokensPerCompaction", measure: "paired", op: "<=", threshold: 0.1 },
      ...SESSION_GUARDRAILS,
    ],
    safety: SESSION_SAFETY,
    sample: [{ counter: "replayFixtures", min: 19, perArm: false }, LIVE_SESSIONS],
    manual: ["The replay corpus needs fixtures long enough to compact; only fixtures that compacted in both variants count."],
  },
  {
    id: "learning",
    title: "Learning",
    holdout: null,
    instrument: "live",
    primaryMode: "all",
    primary: [
      { metric: "approvalRate", measure: "overall", op: ">=", threshold: 0.1 },
      { metric: "approvedSkillsUsed", measure: "overall", op: ">=", threshold: 0.5 },
    ],
    guardrails: [{ metric: "contentIncidents", measure: "overall", op: "<=", threshold: 0, absolute: true }],
    safety: [{ metric: "contentIncidents", measure: "overall", op: ">", threshold: 0, absolute: true }],
    sample: [
      { counter: "decidedProposals", min: 10, perArm: false },
      { counter: "promotedWithClosedWindow", min: 2, perArm: false },
    ],
    manual: ["0 installations without approval (ADR-0022) stays enforced by tests, not measured here."],
  },
]

export const criteriaFor = (id: PromotionCapability): CapabilityCriteria => CRITERIA.find((entry) => entry.id === id)!

// ---- power (ADR-0025 §5, revised by R12–R15) --------------------------------------------------------

/** One-sided α = 0.05 (R12) and power 0.8. */
const Z_ALPHA = 1.644854
const Z_BETA = 0.841621

/**
 * Sessions per arm to detect a relative change `effect` in a ratio of geometric means, when the
 * per-session log value has standard deviation `sigmaLog` (R13).
 */
export function sampleForLogMeans(sigmaLog: number, effect: number): number {
  return Math.ceil(2 * (Z_ALPHA + Z_BETA) ** 2 * (sigmaLog / Math.log(1 + effect)) ** 2)
}

/**
 * Fixtures to detect a relative change `effect` in a paired replay, when the per-fixture log ratio
 * (treatment ÷ baseline, each the mean of its repetitions) has standard deviation `sigmaPaired` (R15).
 */
export function sampleForPaired(sigmaPaired: number, effect: number): number {
  return Math.ceil((Z_ALPHA + Z_BETA) ** 2 * (sigmaPaired / Math.log(1 + effect)) ** 2)
}

/**
 * Units per arm to detect a move from proportion `p0` to `p1`, inflated by `designEffect` when several
 * units come from one session (1 + (m − 1) × ICC).
 */
export function sampleForProportions(p0: number, p1: number, designEffect = 1): number {
  return Math.ceil((designEffect * (Z_ALPHA + Z_BETA) ** 2 * (p0 * (1 - p0) + p1 * (1 - p1))) / (p1 - p0) ** 2)
}

/** Units to tell a one-sample proportion `p1` from `p0`. */
export function sampleForOneProportion(p0: number, p1: number): number {
  return Math.ceil(((Z_ALPHA * Math.sqrt(p0 * (1 - p0)) + Z_BETA * Math.sqrt(p1 * (1 - p1))) / (p1 - p0)) ** 2)
}

const PER_ARM = EVALUATION.budget.sessionsPerArm
/** Sessions without arms in the same four weeks: both arms' budget. */
const WITHOUT_ARMS = 2 * PER_ARM

const LIVE_GUARDRAIL_SAMPLE = {
  minimum: PER_ARM,
  budget: PER_ARM,
  assumption: "the budget itself: the live arm reads guardrails and safety stops on the point estimate (R3), not a test",
}

/**
 * Where each minimum sample comes from and what the budget allows (R14): `minimum` is recomputed from
 * `assumption` by the test, and `budget` is what ~150 sessions per arm (300 without arms) plausibly
 * yield under the stated rate. A capability whose minimum exceeds its budget cannot be judged live.
 */
export const POWER_ASSUMPTIONS = {
  toolTrim: {
    replayFixtures: {
      minimum: sampleForPaired(0.3, -0.15),
      budget: 30,
      assumption:
        "paired replay: SD of the per-fixture log ratio of uncached input 0.3; true effect −15%; budget: the corpus of 30 fixtures the replay README aims for",
    },
    sessions: LIVE_GUARDRAIL_SAMPLE,
  },
  selection: {
    replayFixtures: {
      minimum: sampleForPaired(0.3, -0.15),
      budget: 30,
      assumption: "paired replay: SD of the per-fixture log ratio of USD 0.3; true effect −15%; budget: a 30-fixture corpus",
    },
    sessions: LIVE_GUARDRAIL_SAMPLE,
  },
  relevance: {
    judgedRelevance: {
      minimum: sampleForProportions(0.5, 0.62, 1.5),
      budget: 3 * PER_ARM,
      assumption:
        "correct-load rate 0.50 in control, true effect +12 pp (0.62, +24% relative); ~3 judged relevance decisions per session, design effect 1.5 for their correlation within a session",
    },
    sessions: {
      minimum: sampleForLogMeans(1, -0.25),
      budget: PER_ARM,
      assumption: "tool calls per session: SD of log(1 + calls) 1.0; true effect −25% on the geometric mean",
    },
  },
  model: {
    judgedDisagreements: {
      minimum: sampleForOneProportion(0.5, 0.625),
      budget: Math.floor(0.35 * WITHOUT_ARMS),
      assumption:
        "model right on 62.5% of disagreements (uplift 0.25) against 50%; ~0.35 judged disagreements per session for a per-turn kind (~6 decisions × 15% disagreement × 40% judged)",
    },
  },
  guardrails: {
    judgedLoops: {
      minimum: sampleForProportions(0.2, 0.6),
      budget: Math.floor(0.15 * PER_ARM),
      assumption: "20% of detected loops stop in control, true uplift +40 pp; ~0.15 judged loop detections per session",
    },
    sessions: LIVE_GUARDRAIL_SAMPLE,
  },
  anchors: {
    replayFixtures: {
      minimum: sampleForPaired(0.5, -0.25),
      budget: 20,
      assumption:
        "paired replay over fixtures that compact: SD of the per-fixture log ratio of re-reads per compaction 0.5; true effect −25%; budget: 20 compacting fixtures",
    },
    sessions: LIVE_GUARDRAIL_SAMPLE,
  },
  learning: {
    decidedProposals: {
      minimum: 10,
      budget: 3 * 6,
      assumption: "not a test: at 10 decided, one approval is 10%; budget: ~3 decided proposals a week for 6 weeks",
    },
    promotedWithClosedWindow: {
      minimum: 2,
      budget: 2,
      assumption: "not a test; budget: ~12 decided by day 28 (the last day whose 14-day window closes by the cap) × 20% approved",
    },
  },
} satisfies Record<PromotionCapability, Partial<Record<SampleCounter, { minimum: number; budget: number; assumption: string }>>>

// ---- the decision (ADR-0025 §7) --------------------------------------------------------------------

export type Estimate = { estimate?: number; low?: number; high?: number }

export type Decision = "promote" | "keep observing" | "retire" | "insufficient data"

export type Evidence = {
  /** Keyed by `checkKey(check)`. */
  estimates: Partial<Record<string, Estimate>>
  /** Keyed by counter, then arm (or `overall`). */
  samples: Partial<Record<SampleCounter, { control?: number; treatment?: number; overall?: number }>>
  windowComplete: boolean
  /** The 6-week cap passed (R16): a sample still short is final, not "wait longer". */
  windowCapped?: boolean
  /** Thresholds resolved from the config snapshot, for checks with `thresholdFrom`. */
  thresholds?: Partial<Record<string, number>>
}

/** `inconclusive`: a guardrail whose point estimate crossed its margin without evidence of harm (R18). */
export type CheckVerdict = "pass" | "fail" | "inconclusive" | "unknown"

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

/**
 * A guardrail (R18): it passes on its point estimate; past its margin it fails only with evidence of
 * harm, and is otherwise inconclusive, which blocks promotion but never retires. An `absolute` check
 * (a deterministic defect) fails on its value alone.
 */
export function guardrailVerdict(check: Check, estimate: Estimate | undefined, threshold = check.threshold): CheckVerdict {
  if (estimate?.estimate === undefined) return "unknown"
  if (compare(estimate.estimate, check.op, threshold)) return "pass"
  if (check.absolute) return "fail"
  // A guardrail's op says what passes, so a floor (≥) is harmed by low values.
  return harmEvident(check, estimate, threshold, check.op === ">" || check.op === ">=") ? "fail" : "inconclusive"
}

/**
 * The 90% CI lies wholly on the harmful side (one-sided α = 0.05, R12/R18). The reference is zero for
 * a comparison between arms or variants, where zero is "no effect", and the threshold itself for a
 * level read on one arm (e.g. recall miss < 5%), where no zero exists to compare with.
 */
export function harmEvident(check: Check, estimate: Estimate | undefined, threshold: number, harmIsLow: boolean): boolean {
  if (estimate?.low === undefined || estimate.high === undefined) return false
  const comparison = check.measure === "relative" || check.measure === "difference" || check.measure === "geometric" || check.measure === "paired"
  const reference = comparison ? 0 : threshold
  return harmIsLow ? estimate.high < reference : estimate.low > reference
}

/**
 * A safety check fires when its stop condition holds on the point estimate and, for a noisy estimate,
 * its 90% CI shows the harm (R18), once each arm has 30 sessions. An `absolute` check (a rejected tool
 * pair, a content incident) fires on its value alone.
 */
export function safetyTriggered(check: Check, evidence: Evidence): boolean {
  const estimate = evidence.estimates[checkKey(check)]
  if (estimate?.estimate === undefined) return false
  if (!compare(estimate.estimate, check.op, check.threshold)) return false
  if (check.absolute) return true
  // A stop's op says what stops, so a stop below a line (<) is harmed by low values.
  if (!harmEvident(check, estimate, check.threshold, check.op === "<" || check.op === "<=")) return false
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
 * minimum sample is reached nothing is read; a guardrail that fails with evidence of harm retires; the
 * primary checks then promote (only with every required guardrail passing), retire when their CI
 * cannot reach the threshold, or leave the capability where it is.
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
        ...(evidence.windowCapped && missing.length > 0
          ? [`the ${EVALUATION.maxWindowDays / 7}-week cap passed: final, the window is not extended`]
          : []),
      ],
    }
  const verdict = (check: Check) => verdictOf(check, evidence.estimates[checkKey(check)], thresholdOf(check, evidence))
  const guardrail = (check: Check) => guardrailVerdict(check, evidence.estimates[checkKey(check)], thresholdOf(check, evidence))
  const failed = criteria.guardrails.filter((check) => guardrail(check) === "fail")
  if (failed.length > 0)
    return {
      decision: "retire",
      reasons: failed.map((check) =>
        check.absolute ? `guardrail failed: ${describeCheck(check)}` : `guardrail failed with evidence of harm: ${describeCheck(check)}`,
      ),
    }
  const unknown = criteria.guardrails.filter((check) => !check.optional && guardrail(check) === "unknown")
  const inconclusive = criteria.guardrails.filter((check) => guardrail(check) === "inconclusive")
  const passed = criteria.primary.filter((check) => verdict(check) === "pass")
  const hopeless = criteria.primary.filter((check) =>
    futile(check, evidence.estimates[checkKey(check)], thresholdOf(check, evidence)),
  )
  const promote = criteria.primaryMode === "all" ? passed.length === criteria.primary.length : passed.length > 0
  if (promote && unknown.length === 0 && inconclusive.length === 0)
    return { decision: "promote", reasons: passed.map((check) => `met: ${describeCheck(check)}`) }
  const retire = criteria.primaryMode === "all" ? hopeless.length > 0 : hopeless.length === criteria.primary.length
  if (retire)
    return { decision: "retire", reasons: hopeless.map((check) => `cannot reach: ${describeCheck(check)}`) }
  return {
    decision: "keep observing",
    reasons: [
      ...inconclusive.map((check) => `guardrail inconclusive (margin crossed without evidence of harm): ${describeCheck(check)}`),
      ...unknown.map((check) => `guardrail not measurable: ${describeCheck(check)}`),
      ...(promote ? [] : [`the primary metric did not reach its threshold with a ${EVALUATION.confidence * 100}% CI clear of zero`]),
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
  geometric: "ratio of geometric means (T ÷ C − 1, log scale, CUPED by project)",
  paired: "replay (paired by fixture)",
  treatment: "treatment arm",
  control: "control arm",
  overall: "all units",
}

export function describeCheck(check: Check): string {
  const op = { "<": "<", "<=": "≤", ">": ">", ">=": "≥" }[check.op]
  const value = formatThreshold(check)
  const level = `${EVALUATION.confidence * 100}% CI`
  const ci = check.significant ? (check.op === "<" || check.op === "<=" ? `; ${level} upper < 0` : `; ${level} lower > 0`) : ""
  const paired = check.measure === "paired" ? (METRICS[check.metric].unit === "share" ? " Δ (T − B)" : " Δ (T ÷ B − 1)") : ""
  return `${METRICS[check.metric].label}, ${MEASURE_LABELS[check.measure]}${paired} ${op} ${value}${ci}`
}

function formatThreshold(check: Check): string {
  const unit = METRICS[check.metric].unit
  const from = check.thresholdFrom ? ` (\`${check.thresholdFrom}\`, default)` : ""
  const change = check.measure === "difference" || check.measure === "paired"
  if (unit === "share" && change) return `${signed(check.threshold * 100)} pp`
  if (check.measure === "relative" || check.measure === "geometric" || check.measure === "paired")
    return `${signed(check.threshold * 100)}%`
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
    const instrument = criteria.replay ? `replay: \`${criteria.replay}\`; live: guardrails and safety` : "live"
    const sample = criteria.sample
      .map((requirement) => `${requirement.min} ${SAMPLE_LABELS[requirement.counter]}${requirement.perArm ? " per arm" : ""}`)
      .join("; ")
    const cell = (checks: Check[], joiner: string) => checks.map(describeCheck).join(joiner) || "—"
    return [
      `| ${criteria.title} | ${unit} | ${instrument} | ${cell(criteria.primary, criteria.primaryMode === "any" ? " **or** " : " **and** ")} | ${cell(criteria.guardrails, "; ")} | ${cell(criteria.safety, "; ")} | ${sample} |`,
    ]
  })
  return [
    `Window: ${EVALUATION.windowDays} days or the minimum sample, whichever is later, capped at ${EVALUATION.maxWindowDays} days (then insufficient data). CI: ${EVALUATION.confidence * 100}% percentile bootstrap by unit (one-sided α = ${((1 - EVALUATION.confidence) / 2).toFixed(2)}), ${EVALUATION.resamples} resamples, seed \`${EVALUATION.seed}\`. Budget: ${EVALUATION.budget.sessionsPerArm} sessions per arm.`,
    "",
    "| Capability | Randomisation | Primary instrument | Primary (promote when met) | Guardrails | Safety stop | Minimum sample |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n")
}
