/**
 * The live evaluation report (AH-G02): reads the stored fields ADR-0025 names, splits them by holdout
 * arm, bootstraps every metric by session and applies the preregistered criteria.
 *
 * Everything here reads a `Database` it is handed; the CLI opens it read-only, so nothing in this
 * module can migrate or write the harness database. The episode events are read from their JSON
 * files, also without writing. No model is asked and no setting is touched.
 */

import type { Database } from "bun:sqlite"
import type { AdaptiveConfig } from "@flupcode/harness-server/adaptive/config"
import type { DecisionKind } from "@flupcode/harness-server/adaptive/decision"
import { episodeEvents } from "@flupcode/harness-server/adaptive/events"
import type { EpisodeEvent } from "@flupcode/harness-server/adaptive/events"
import { HOLDOUT_CAPABILITIES } from "@flupcode/harness-server/adaptive/holdout"
import type { Arm, HoldoutCapability } from "@flupcode/harness-server/adaptive/holdout"
import { LABELED_KINDS, LABEL_SETTLE_MS } from "@flupcode/harness-server/adaptive/labeler"
import { canonical } from "@flupcode/harness-server/adaptive/value-gate"
import {
  CRITERIA,
  EVALUATION,
  METRICS,
  SAMPLE_LABELS,
  checkKey,
  decide,
  describeCheck,
  guardrailVerdict,
  safetyTriggered,
  thresholdOf,
  verdictOf,
} from "./criteria"
import type {
  CapabilityCriteria,
  Check,
  CheckVerdict,
  Decision,
  Estimate,
  Evidence,
  MetricID,
  PromotionCapability,
} from "./criteria"
import type { ReplayEvidence } from "./replay-evidence"
import { bootstrap, cuped, ratio } from "./stats"
import type { Statistic } from "./stats"

const DAY = 24 * 60 * 60 * 1000
/** Learning's usage signal: an approved skill counts as used when 2+ sessions load it within this (R17). */
export const USAGE_WINDOW_MS = 14 * DAY
/** A provider error whose message names a tool pair: what a broken selection would be rejected with. */
const PAIRING_ERROR = /tool_use|tool_result|tool use|tool result|tool_call_id|tool call id/i

export const FINAL_DECISION_CAVEAT =
  "These are suggested decisions from the preregistered criteria (ADR-0025). The decision is a person's (AH-G03): nothing here changes a default or a setting."

export type EvaluationWindow = { since: number; until: number }

/** The config the evaluation started under, recorded by `start` and read back by `report`. */
export type ConfigSnapshot = {
  enabled: boolean
  holdoutFraction: number
  capabilities: Record<PromotionCapability, boolean>
  models: Partial<Record<DecisionKind, string>>
  voi: Partial<Record<DecisionKind, { valueOfCorrect: number; latencyCostUsdPerSecond: number }>>
}

export function configSnapshot(config: AdaptiveConfig): ConfigSnapshot {
  const models = Object.fromEntries(
    Object.entries(config.models).filter(([, model]) => model !== undefined && model !== "baseline"),
  ) as Partial<Record<DecisionKind, string>>
  return {
    enabled: config.enabled,
    holdoutFraction: config.holdout.fraction,
    capabilities: {
      toolTrim: config.enabled && config.toolTrim.enabled,
      selection: config.enabled && config.selection.enabled,
      relevance: config.enabled && config.relevance.enabled,
      model: config.enabled && Object.keys(models).length > 0,
      guardrails: config.enabled && config.guardrails.enabled,
      anchors: config.enabled && config.compaction.anchors,
      learning: config.enabled && config.learning.enabled,
    },
    models,
    voi: Object.fromEntries(
      Object.entries(config.voi.kinds).map(([kind, weights]) => [
        kind,
        { valueOfCorrect: weights.valueOfCorrect, latencyCostUsdPerSecond: weights.latencyCostUsdPerSecond },
      ]),
    ),
  }
}

// ---- the dataset ------------------------------------------------------------------------------------

export type SessionUnit = {
  sessionID: string
  /** The project of the session's first turn: the CUPED stratum (R13). */
  projectID?: string
  arms: Partial<Record<HoldoutCapability, Arm>>
  turns: number
  uncachedInput: number
  usd: number
  toolCalls: number
  errorTurns: number
  turnMs: number[]
  compactions: number
  rereads: number
  summaryTokens: number
  evidenceReads: number
  trimmed: number
  episodes: number
  /** Every closed episode with a known outcome was a success with green checks; undefined without one. */
  completion?: boolean
  pairingErrors: number
}

export type DecisionUnit = {
  id: string
  sessionID: string
  kind: string
  arm?: Arm
  source: string
  providerID?: string
  providerVersion?: string
  latencyMs: number
  costUsd: number
  answer: unknown
  baselineAnswer: unknown
  outcome?: string
  baselineOutcome?: string
  degradedReason?: string
}

export type ProposalUnit = {
  id: string
  status: string
  skill?: string
  createdAt: number
  updatedAt: number
  /** Distinct sessions that loaded the approved skill within 30 days of its approval. */
  usedSessions: number
  /** The 30-day usage window ended before `until`. */
  windowClosed: boolean
}

/** A session from the CUPED prior period, before `start`: only what the covariates read. */
export type PriorSession = { projectID?: string; uncachedInput: number; usd: number; toolCalls: number }

export type Dataset = {
  window: EvaluationWindow
  sessions: SessionUnit[]
  /** Sessions whose first turn started in the `cupedPriorDays` before the window: the covariate. */
  prior: PriorSession[]
  decisions: DecisionUnit[]
  proposals: ProposalUnit[]
  coverage: Array<{ kind: string; eligible: number; labeled: number; judged: number }>
}

/** Reads the window's rows. Sessions are those whose first turn started inside the window. */
export function loadDataset(db: Database, window: EvaluationWindow, eventsDir: string, now = Date.now()): Dataset {
  const turns = db
    .query(
      `SELECT m.* FROM session_metrics m
       JOIN (SELECT session_id FROM session_metrics GROUP BY session_id
             HAVING MIN(started_at) >= ?1 AND MIN(started_at) < ?2) s ON s.session_id = m.session_id
       WHERE m.started_at < ?2
       ORDER BY m.session_id, m.turn`,
    )
    .all(window.since, window.until) as TurnRow[]
  const trimmed = new Map(
    (
      db
        .query(
          `SELECT session_id, COUNT(*) AS n FROM tool_evidence WHERE created_at >= ?1 AND created_at < ?2 GROUP BY session_id`,
        )
        .all(window.since, window.until) as Array<{ session_id: string; n: number }>
    ).map((row) => [row.session_id, row.n]),
  )
  const episodes = db
    .query(
      `SELECT session_id, outcome, verifications_json FROM session_episodes
       WHERE ended_at IS NOT NULL AND started_at < ?2 AND ended_at >= ?1`,
    )
    .all(window.since, window.until) as Array<{ session_id: string; outcome: string; verifications_json: string }>
  const bySession = Map.groupBy(turns, (row) => row.session_id)
  const episodesBySession = Map.groupBy(episodes, (row) => row.session_id)
  const sessions = [...bySession].map(([sessionID, rows]) =>
    sessionUnit(sessionID, rows, episodesBySession.get(sessionID) ?? [], trimmed.get(sessionID) ?? 0, episodeEvents(sessionID, eventsDir).events, window),
  )

  const decisions = (
    db
      .query(
        `SELECT id, session_id, kind, arm, source, provider_id, provider_version, latency_ms, cost_usd,
                answer_json, baseline_answer_json, label, degraded_reason
         FROM adaptive_decision WHERE created_at >= ?1 AND created_at < ?2 AND session_id IS NOT NULL`,
      )
      .all(window.since, window.until) as DecisionRow[]
  ).map(decisionUnit)

  const proposals = loadProposals(db, window)
  const prior = loadPrior(db, window.since)
  const coverage = LABELED_KINDS.map((kind) => {
    const row = db
      .query(
        `SELECT COUNT(*) AS eligible,
                COALESCE(SUM(CASE WHEN label IS NOT NULL THEN 1 ELSE 0 END), 0) AS labeled,
                COALESCE(SUM(CASE WHEN json_extract(CASE WHEN json_valid(label) THEN label END, '$.outcome') IN ('correct', 'incorrect') THEN 1 ELSE 0 END), 0) AS judged
         FROM adaptive_decision WHERE kind = ?1 AND created_at >= ?2 AND created_at <= ?3`,
      )
      .get(kind, window.since, Math.min(window.until, now) - LABEL_SETTLE_MS[kind]) as {
      eligible: number
      labeled: number
      judged: number
    }
    return { kind, ...row }
  })
  return { window, sessions, prior, decisions, proposals, coverage }
}

/** The sessions of the prior period, summed per session; they only feed the CUPED covariate. */
function loadPrior(db: Database, since: number): PriorSession[] {
  const rows = db
    .query(
      `SELECT m.session_id, m.project_id, m.input_tokens, m.cost, m.tool_calls FROM session_metrics m
       JOIN (SELECT session_id FROM session_metrics GROUP BY session_id
             HAVING MIN(started_at) >= ?1 AND MIN(started_at) < ?2) s ON s.session_id = m.session_id
       WHERE m.started_at < ?2
       ORDER BY m.session_id, m.turn`,
    )
    .all(since - EVALUATION.cupedPriorDays * DAY, since) as Array<{
    session_id: string
    project_id: string | null
    input_tokens: number
    cost: number
    tool_calls: number
  }>
  return [...Map.groupBy(rows, (row) => row.session_id).values()].map((turns) => ({
    ...(turns[0]?.project_id ? { projectID: turns[0].project_id } : {}),
    uncachedInput: sum(turns, (row) => row.input_tokens),
    usd: sum(turns, (row) => row.cost),
    toolCalls: sum(turns, (row) => row.tool_calls),
  }))
}

type TurnRow = {
  session_id: string
  turn: number
  project_id: string | null
  input_tokens: number
  cost: number
  tool_calls: number
  tool_errors: number
  tools_json: string
  compactions: number
  rereads_after_compaction: number | null
  summary_tokens: number | null
  started_at: number
  ended_at: number
  arms_json: string | null
}

type DecisionRow = {
  id: string
  session_id: string
  kind: string
  arm: string | null
  source: string
  provider_id: string | null
  provider_version: string | null
  latency_ms: number
  cost_usd: number | null
  answer_json: string
  baseline_answer_json: string
  label: string | null
  degraded_reason: string | null
}

function sessionUnit(
  sessionID: string,
  rows: TurnRow[],
  episodes: Array<{ outcome: string; verifications_json: string }>,
  trimmed: number,
  events: EpisodeEvent[],
  window: EvaluationWindow,
): SessionUnit {
  const errors = events.filter((event) => event.kind === "session.error")
  const known = episodes.filter((episode) => episode.outcome !== "unknown")
  return {
    sessionID,
    ...(rows[0]?.project_id ? { projectID: rows[0].project_id } : {}),
    // The arms recorded when the session's first turn was heard of; a capability missing from them
    // was not held out when that session started, so the session is left out of its comparison.
    arms: armsOf(rows[0]?.arms_json ?? null),
    turns: rows.length,
    uncachedInput: sum(rows, (row) => row.input_tokens),
    usd: sum(rows, (row) => row.cost),
    toolCalls: sum(rows, (row) => row.tool_calls),
    errorTurns: rows.filter(
      (row, index) =>
        row.tool_errors > 0 ||
        errors.some((event) => event.at >= row.started_at && event.at < (rows[index + 1]?.started_at ?? window.until)),
    ).length,
    turnMs: rows.map((row) => Math.max(0, row.ended_at - row.started_at)),
    compactions: sum(rows, (row) => row.compactions),
    rereads: sum(rows, (row) => row.rereads_after_compaction ?? 0),
    summaryTokens: sum(rows, (row) => row.summary_tokens ?? 0),
    evidenceReads: sum(rows, (row) => toolCalls(row.tools_json, "evidence_read")),
    trimmed,
    episodes: episodes.length,
    ...(known.length > 0
      ? { completion: known.every((episode) => episode.outcome === "success" && greenChecks(episode.verifications_json)) }
      : {}),
    pairingErrors: errors.filter(
      (event) => event.at >= window.since && event.at < window.until && PAIRING_ERROR.test(event.message),
    ).length,
  }
}

function decisionUnit(row: DecisionRow): DecisionUnit {
  const label = parseObject(row.label)
  return {
    id: row.id,
    sessionID: row.session_id,
    kind: row.kind,
    ...(row.arm === "control" || row.arm === "treatment" ? { arm: row.arm } : {}),
    source: row.source,
    ...(row.provider_id ? { providerID: row.provider_id } : {}),
    ...(row.provider_version ? { providerVersion: row.provider_version } : {}),
    latencyMs: row.latency_ms,
    costUsd: row.cost_usd ?? 0,
    answer: parseJSON(row.answer_json),
    baselineAnswer: parseJSON(row.baseline_answer_json),
    ...(typeof label?.outcome === "string" ? { outcome: label.outcome } : {}),
    ...(typeof label?.baselineOutcome === "string" ? { baselineOutcome: label.baselineOutcome } : {}),
    ...(row.degraded_reason ? { degradedReason: row.degraded_reason } : {}),
  }
}

function loadProposals(db: Database, window: EvaluationWindow): ProposalUnit[] {
  const rows = db
    .query(
      `SELECT id, status, name, target_skill, created_at, updated_at FROM skill_proposals
       WHERE created_at >= ?1 AND created_at < ?2`,
    )
    .all(window.since, window.until) as Array<{
    id: string
    status: string
    name: string | null
    target_skill: string | null
    created_at: number
    updated_at: number
  }>
  const loads = (
    db
      .query(`SELECT session_id, started_at, skills_json FROM session_metrics WHERE started_at >= ?1 AND started_at < ?2`)
      .all(window.since, window.until + USAGE_WINDOW_MS) as Array<{ session_id: string; started_at: number; skills_json: string }>
  ).flatMap((row) => {
    const skills = parseJSON(row.skills_json)
    return Array.isArray(skills)
      ? skills.flatMap((skill) => (typeof skill === "string" ? [{ sessionID: row.session_id, at: row.started_at, skill }] : []))
      : []
  })
  return rows.map((row) => {
    const skill = row.name ?? row.target_skill ?? undefined
    // The approval is the proposal's last update: a promoted proposal is not edited afterwards.
    const promotedAt = row.updated_at
    const used =
      row.status === "promoted" && skill
        ? new Set(
            loads
              .filter((load) => load.skill === skill && load.at >= promotedAt && load.at < promotedAt + USAGE_WINDOW_MS)
              .map((load) => load.sessionID),
          ).size
        : 0
    return {
      id: row.id,
      status: row.status,
      ...(skill ? { skill } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      usedSessions: used,
      windowClosed: row.status === "promoted" && promotedAt + USAGE_WINDOW_MS <= window.until,
    }
  })
}

// ---- metrics ----------------------------------------------------------------------------------------

type Group<T> = { sessionID: string; items: T[] }

const perSession = (value: (unit: SessionUnit) => number) => ratio<SessionUnit>(value, () => 1)

const SESSION_STATISTICS: Partial<Record<MetricID, Statistic<SessionUnit>>> = {
  uncachedInputPerSession: perSession((unit) => unit.uncachedInput),
  usdPerSession: perSession((unit) => unit.usd),
  toolCallsPerSession: perSession((unit) => unit.toolCalls),
  completion: ratio(
    (unit) => (unit.completion ? 1 : 0),
    (unit) => (unit.completion === undefined ? 0 : 1),
  ),
  errorRate: ratio(
    (unit) => unit.errorTurns,
    (unit) => unit.turns,
  ),
  p95TurnMs: (units) => percentile(units.flatMap((unit) => unit.turnMs), 95),
  recallMiss: ratio(
    (unit) => unit.evidenceReads,
    (unit) => unit.trimmed,
  ),
  pairingErrors: (units) => sum(units, (unit) => unit.pairingErrors),
  rereadsPerCompaction: ratio(
    (unit) => unit.rereads,
    (unit) => unit.compactions,
  ),
  summaryTokensPerCompaction: ratio(
    (unit) => unit.summaryTokens,
    (unit) => unit.compactions,
  ),
}

const judged = (decision: DecisionUnit) => decision.outcome === "correct" || decision.outcome === "incorrect"

/** For a loop detection the label judges the verdict; whether the loop persisted is read back from it. */
const loopStopped = (decision: DecisionUnit) => {
  const verdict = isObject(decision.answer) ? decision.answer.verdict : undefined
  return (verdict === "intervene") !== (decision.outcome === "correct")
}

const DECISION_STATISTICS: Partial<Record<MetricID, Statistic<Group<DecisionUnit>>>> = {
  relevanceCorrect: ratio(
    (group) => group.items.filter((decision) => decision.outcome === "correct").length,
    (group) => group.items.filter(judged).length,
  ),
  relevanceLatencyP95: (groups) =>
    percentile(
      groups.flatMap((group) => group.items.filter((decision) => decision.source !== "model").map((decision) => decision.latencyMs)),
      95,
    ),
  relevanceModelLatencyP95: (groups) =>
    percentile(
      groups.flatMap((group) => group.items.filter((decision) => decision.source === "model").map((decision) => decision.latencyMs)),
      95,
    ),
  loopStopped: ratio(
    (group) => group.items.filter((decision) => judged(decision) && loopStopped(decision)).length,
    (group) => group.items.filter(judged).length,
  ),
}

// ---- evaluation -------------------------------------------------------------------------------------

export type CheckResult = {
  role: "primary" | "guardrail" | "safety"
  key: string
  description: string
  threshold: number
  verdict: CheckVerdict
} & Estimate

export type CapabilityResult = {
  id: PromotionCapability
  title: string
  instrument: CapabilityCriteria["instrument"]
  /** For a replay-decided capability: the command that produces its primary evidence. */
  replayCommand?: string
  /** The replay report its paired checks were read from, when one was passed. */
  replay?: Omit<ReplayEvidence, "estimates">
  /** For the predictive model: the kind, provider and version the result is about. */
  instance?: string
  enabled: boolean
  holdout: HoldoutCapability | null
  arms?: { control: number; treatment: number; excluded: number }
  samples: Evidence["samples"]
  checks: CheckResult[]
  /** Primary and guardrail estimates are withheld until the window closes and the sample is reached. */
  withheld: boolean
  decision: Decision
  reasons: string[]
  manual: string[]
}

export type LiveReport = {
  generatedAt: number
  window: EvaluationWindow & { days: number; complete: boolean; capped: boolean }
  holdoutFraction: number
  criteria: typeof EVALUATION
  coverage: Dataset["coverage"]
  capabilities: CapabilityResult[]
  caveat: string
}

export function evaluate(input: {
  dataset: Dataset
  snapshot: ConfigSnapshot
  contentIncidents?: number
  /** Replay reports read with `--replay`, per capability they measure (R15). */
  replay?: Partial<Record<PromotionCapability, ReplayEvidence>>
  now?: number
}): LiveReport {
  const window = input.dataset.window
  const closed: WindowState = {
    complete: window.until - window.since >= EVALUATION.windowDays * DAY,
    capped: window.until - window.since >= EVALUATION.maxWindowDays * DAY,
  }
  const capabilities = CRITERIA.flatMap((criteria): CapabilityResult[] => {
    if (criteria.id === "model") return modelResults(criteria, input.dataset, input.snapshot, closed)
    if (criteria.id === "learning") return [learningResult(criteria, input.dataset, input.snapshot, closed, input.contentIncidents)]
    return criteria.holdout
      ? [holdoutResult(criteria, criteria.holdout, input.dataset, input.snapshot, closed, input.replay?.[criteria.id])]
      : []
  })
  return {
    generatedAt: input.now ?? Date.now(),
    window: { ...window, days: (window.until - window.since) / DAY, ...closed },
    holdoutFraction: input.snapshot.holdoutFraction,
    criteria: EVALUATION,
    coverage: input.dataset.coverage,
    capabilities,
    caveat: FINAL_DECISION_CAVEAT,
  }
}

type WindowState = { complete: boolean; capped: boolean }

function holdoutResult(
  criteria: CapabilityCriteria,
  capability: HoldoutCapability,
  dataset: Dataset,
  snapshot: ConfigSnapshot,
  closed: WindowState,
  replay: ReplayEvidence | undefined,
): CapabilityResult {
  const inArm = (arm: Arm) => dataset.sessions.filter((unit) => unit.arms[capability] === arm)
  const control = inArm("control")
  const treatment = inArm("treatment")
  const groups = (arm: Arm) =>
    groupBySession(dataset.decisions.filter((decision) => decisionKindFor(criteria.id) === decision.kind && decision.arm === arm))
  const decisionArms = { control: groups("control"), treatment: groups("treatment") }
  const estimate = (check: Check): Estimate => {
    // The replay's paired checks come from its report; without one they stay unknown (R15).
    if (check.measure === "paired") return replay?.estimates[checkKey(check)] ?? {}
    if (check.measure === "geometric") return geometric(check, control, treatment, dataset.prior)
    // Every live session check is intention to treat over the whole arm, anchors included: their
    // compacted-session comparison moved to the replay (R15).
    const sessionStatistic = SESSION_STATISTICS[check.metric]
    if (sessionStatistic) return run(check, control, treatment, sessionStatistic)
    const decisionStatistic = DECISION_STATISTICS[check.metric]
    if (decisionStatistic) return run(check, decisionArms.control, decisionArms.treatment, decisionStatistic)
    return {}
  }
  const counted = (items: Group<DecisionUnit>[]) => sum(items, (group) => group.items.filter(judged).length)
  const samples: Evidence["samples"] = {
    sessions: { control: control.length, treatment: treatment.length },
    judgedRelevance: { control: counted(decisionArms.control), treatment: counted(decisionArms.treatment) },
    judgedLoops: { control: counted(decisionArms.control), treatment: counted(decisionArms.treatment) },
    replayFixtures: { overall: replay?.fixtures ?? 0 },
  }
  return {
    ...resultOf(criteria, samples, closed, estimate, {}),
    ...(replay ? { replay: { file: replay.file, startedAt: replay.startedAt, baseline: replay.baseline, variant: replay.variant, fixtures: replay.fixtures } } : {}),
    enabled: snapshot.capabilities[criteria.id],
    arms: { control: control.length, treatment: treatment.length, excluded: dataset.sessions.length - control.length - treatment.length },
  }
}

/**
 * A log-scale metric (R13): log(1 + value) per session, CUPED-adjusted by the mean of the same log
 * value over the project's prior sessions, then exp(mean T − mean C) − 1 by bootstrap. A session whose
 * project has fewer than `cupedMinPriorSessions` prior sessions keeps its unadjusted value.
 */
function geometric(check: Check, control: SessionUnit[], treatment: SessionUnit[], prior: PriorSession[]): Estimate {
  const value = LOG_VALUES[check.metric]
  if (!value) return {}
  const byProject = Map.groupBy(prior, (session) => session.projectID ?? "")
  const covariate = (unit: SessionUnit) => {
    const sessions = unit.projectID ? byProject.get(unit.projectID) : undefined
    if (!sessions || sessions.length < EVALUATION.cupedMinPriorSessions) return undefined
    return sum(sessions, (session) => Math.log1p(value(session))) / sessions.length
  }
  const adjusted = cuped(
    [...control, ...treatment].map((unit) => {
      const x = covariate(unit)
      return { y: Math.log1p(value(unit)), ...(x === undefined ? {} : { x }) }
    }),
  ).values
  const mean = ratio<number>((unit) => unit, () => 1)
  return run(check, adjusted.slice(0, control.length), adjusted.slice(control.length), mean)
}

const LOG_VALUES: Partial<Record<MetricID, (unit: PriorSession) => number>> = {
  uncachedInputPerSession: (unit) => unit.uncachedInput,
  usdPerSession: (unit) => unit.usd,
  toolCallsPerSession: (unit) => unit.toolCalls,
}

function modelResults(
  criteria: CapabilityCriteria,
  dataset: Dataset,
  snapshot: ConfigSnapshot,
  closed: WindowState,
): CapabilityResult[] {
  const answered = dataset.decisions.filter((decision) => decision.providerID && decision.source !== "baseline")
  const instances = Map.groupBy(answered, (decision) => `${decision.kind} · ${decision.providerID} · ${decision.providerVersion ?? "?"}`)
  if (instances.size === 0)
    return [
      {
        ...resultOf(criteria, { judgedDisagreements: { overall: 0 } }, closed, () => ({}), {}),
        enabled: snapshot.capabilities.model,
      },
    ]
  return [...instances].map(([instance, rows]) => {
    const kind = rows[0]!.kind as DecisionKind
    const weights = snapshot.voi[kind] ?? { valueOfCorrect: 0.05, latencyCostUsdPerSecond: 0.001 }
    // The model's own answers, judged on both sides by the C06 label: the counterfactual per decision.
    const scored = rows.filter(
      (decision) => decision.source === "model" && judged(decision) && (decision.baselineOutcome === "correct" || decision.baselineOutcome === "incorrect"),
    )
    const disagrees = (decision: DecisionUnit) => canonical(decision.answer) !== canonical(decision.baselineAnswer)
    const units = groupBySession(rows)
    const statistics: Partial<Record<MetricID, Statistic<Group<DecisionUnit>>>> = {
      uplift: (groups) => {
        const disagreeing = groups.flatMap((group) => group.items.filter((decision) => scored.includes(decision) && disagrees(decision)))
        if (disagreeing.length === 0) return undefined
        const accuracy = (pick: (decision: DecisionUnit) => string | undefined) =>
          disagreeing.filter((decision) => pick(decision) === "correct").length / disagreeing.length
        return accuracy((decision) => decision.outcome) - accuracy((decision) => decision.baselineOutcome)
      },
      costPerUsefulDecision: (groups) => {
        const items = groups.flatMap((group) => group.items)
        const cost = sum(items, (decision) => decision.costUsd + (weights.latencyCostUsdPerSecond * decision.latencyMs) / 1000)
        const useful = items.filter(
          (decision) => scored.includes(decision) && disagrees(decision) && decision.outcome === "correct" && decision.baselineOutcome === "incorrect",
        ).length
        if (useful === 0) return cost === 0 ? undefined : Number.POSITIVE_INFINITY
        return cost / useful
      },
    }
    const estimate = (check: Check): Estimate => {
      const statistic = statistics[check.metric]
      if (!statistic) return {}
      // No useful decision at all is not noise: the cost is infinite whatever the resample, so the
      // interval is the point and the guardrail can fail on it (R18).
      const whole = statistic(units)
      if (whole === Number.POSITIVE_INFINITY) return { estimate: whole, low: whole, high: whole }
      return run(check, [], units, statistic)
    }
    const thresholds = { [checkKey({ metric: "costPerUsefulDecision", measure: "overall" })]: weights.valueOfCorrect }
    return {
      ...resultOf(criteria, { judgedDisagreements: { overall: scored.filter(disagrees).length } }, closed, estimate, thresholds),
      instance,
      enabled: snapshot.models[kind] === rows[0]!.providerID,
    }
  })
}

function learningResult(
  criteria: CapabilityCriteria,
  dataset: Dataset,
  snapshot: ConfigSnapshot,
  closed: WindowState,
  contentIncidents: number | undefined,
): CapabilityResult {
  const decided = dataset.proposals.filter((proposal) => proposal.status === "promoted" || proposal.status === "rejected")
  const windowClosed = dataset.proposals.filter((proposal) => proposal.windowClosed)
  const statistics: Partial<Record<MetricID, Statistic<ProposalUnit>>> = {
    approvalRate: ratio(
      (proposal) => (proposal.status === "promoted" ? 1 : 0),
      () => 1,
    ),
    approvedSkillsUsed: ratio(
      (proposal) => (proposal.usedSessions >= 2 ? 1 : 0),
      () => 1,
    ),
  }
  const estimate = (check: Check): Estimate => {
    // Content incidents are not stored: they are what the person attests with `--content-incidents`.
    if (check.metric === "contentIncidents") return contentIncidents === undefined ? {} : { estimate: contentIncidents }
    const statistic = statistics[check.metric]
    if (!statistic) return {}
    return run(check, [], check.metric === "approvalRate" ? decided : windowClosed, statistic)
  }
  return {
    ...resultOf(
      criteria,
      { decidedProposals: { overall: decided.length }, promotedWithClosedWindow: { overall: windowClosed.length } },
      closed,
      estimate,
      {},
    ),
    enabled: snapshot.capabilities.learning,
  }
}

function resultOf(
  criteria: CapabilityCriteria,
  samples: Evidence["samples"],
  closed: WindowState,
  estimate: (check: Check) => Estimate,
  thresholds: Record<string, number>,
): Omit<CapabilityResult, "enabled"> {
  const roles = [
    ...criteria.primary.map((check) => ({ role: "primary" as const, check })),
    ...criteria.guardrails.map((check) => ({ role: "guardrail" as const, check })),
    ...criteria.safety.map((check) => ({ role: "safety" as const, check })),
  ]
  const estimates = Object.fromEntries(roles.map((entry) => [checkKey(entry.check), estimate(entry.check)]))
  const evidence: Evidence = { estimates, samples, windowComplete: closed.complete, windowCapped: closed.capped, thresholds }
  const outcome = decide(criteria, evidence)
  // No peeking (ADR-0025 §6): before the analysis may run, only the safety checks are shown.
  const withheld = outcome.decision === "insufficient data"
  const checks = roles.flatMap((entry): CheckResult[] => {
    if (withheld && entry.role !== "safety") return []
    const threshold = thresholdOf(entry.check, evidence)
    const value = estimates[checkKey(entry.check)] ?? {}
    return [
      {
        role: entry.role,
        key: checkKey(entry.check),
        description: describeCheck({ ...entry.check, threshold }),
        threshold,
        // A safety check "fails" when its stop condition fired.
        verdict:
          entry.role === "primary"
            ? verdictOf(entry.check, value, threshold)
            : entry.role === "guardrail"
              ? guardrailVerdict(entry.check, value, threshold)
              : safetyVerdict(entry.check, value, evidence),
        ...value,
      },
    ]
  })
  return {
    id: criteria.id,
    title: criteria.title,
    instrument: criteria.instrument,
    ...(criteria.replay ? { replayCommand: criteria.replay } : {}),
    holdout: criteria.holdout,
    samples,
    checks,
    withheld,
    decision: outcome.decision,
    reasons: outcome.reasons,
    manual: criteria.manual,
  }
}

/** A stop that fired is `fail`; past its line without evidence of harm (or 30 sessions per arm), `inconclusive`. */
function safetyVerdict(check: Check, value: Estimate, evidence: Evidence): CheckVerdict {
  if (value.estimate === undefined) return "unknown"
  if (safetyTriggered(check, evidence)) return "fail"
  return safetyTriggered({ ...check, absolute: true }, evidence) ? "inconclusive" : "pass"
}

function run<T>(check: Check, control: readonly T[], treatment: readonly T[], statistic: Statistic<T>): Estimate {
  return bootstrap({
    measure: check.measure,
    // A control-arm check reads the control set; `bootstrap` takes it from `control`.
    control,
    treatment,
    statistic,
    resamples: EVALUATION.resamples,
    seed: `${EVALUATION.seed}:${checkKey(check)}`,
    confidence: EVALUATION.confidence,
  })
}

const decisionKindFor = (capability: PromotionCapability) =>
  capability === "relevance" ? "skillRelevance" : capability === "guardrails" ? "failure" : undefined

function groupBySession(decisions: DecisionUnit[]): Group<DecisionUnit>[] {
  return [...Map.groupBy(decisions, (decision) => decision.sessionID)].map(([sessionID, items]) => ({ sessionID, items }))
}

// ---- status -----------------------------------------------------------------------------------------

export type StatusRow = {
  id: PromotionCapability
  title: string
  enabled: boolean
  holdout: HoldoutCapability | null
  replayCommand?: string
  sessions?: { control: number; treatment: number }
  episodes?: { control: number; treatment: number }
  progress: Array<{
    label: string
    have: number | { control: number; treatment: number }
    need: number
    perArm: boolean
    /** Days until the minimum at the pace observed since `start`; undefined without a pace, or for a replay count. */
    etaDays?: number
    fromReplay: boolean
  }>
  safety: string[]
}

/**
 * Days until `need` at the pace `have` took over `elapsedDays`: 0 once reached, undefined with nothing
 * to extrapolate from yet. A per-arm counter passes its slower arm.
 */
export function etaDays(have: number, need: number, elapsedDays: number): number | undefined {
  if (have >= need) return 0
  if (have <= 0 || elapsedDays <= 0) return undefined
  return Math.ceil((need - have) / (have / elapsedDays))
}

/** What `status` prints: counts, progress and the pace, never an effect estimate (ADR-0025 §6). */
export function status(report: LiveReport, dataset: Dataset): StatusRow[] {
  return report.capabilities.map((result) => {
    const criteria = CRITERIA.find((entry) => entry.id === result.id)!
    const capability = criteria.holdout
    const inArm = (arm: Arm) => dataset.sessions.filter((unit) => capability && unit.arms[capability] === arm)
    return {
      id: result.id,
      title: result.instance ? `${result.title}: ${result.instance}` : result.title,
      enabled: result.enabled,
      holdout: capability,
      ...(result.replayCommand ? { replayCommand: result.replayCommand } : {}),
      ...(capability
        ? {
            sessions: { control: inArm("control").length, treatment: inArm("treatment").length },
            episodes: { control: sum(inArm("control"), (unit) => unit.episodes), treatment: sum(inArm("treatment"), (unit) => unit.episodes) },
          }
        : {}),
      progress: criteria.sample.map((requirement) => {
        const counts = result.samples[requirement.counter]
        const fromReplay = requirement.counter === "replayFixtures"
        const least = requirement.perArm ? Math.min(counts?.control ?? 0, counts?.treatment ?? 0) : (counts?.overall ?? 0)
        const eta = fromReplay ? undefined : etaDays(least, requirement.min, report.window.days)
        return {
          label: SAMPLE_LABELS[requirement.counter],
          have: requirement.perArm ? { control: counts?.control ?? 0, treatment: counts?.treatment ?? 0 } : (counts?.overall ?? 0),
          need: requirement.min,
          perArm: requirement.perArm,
          ...(eta === undefined ? {} : { etaDays: eta }),
          fromReplay,
        }
      }),
      safety: result.checks.filter((check) => check.role === "safety" && check.verdict === "fail").map((check) => check.description),
    }
  })
}

// ---- rendering --------------------------------------------------------------------------------------

export function renderReport(report: LiveReport): string {
  const date = (at: number) => new Date(at).toISOString()
  const lines = [
    "# Live evaluation report (AH-G02)",
    "",
    `> ${report.caveat}`,
    "",
    `- Window: ${date(report.window.since)} → ${date(report.window.until)} (${report.window.days.toFixed(1)} days; ${report.window.capped ? `capped at ${EVALUATION.maxWindowDays} days: final` : report.window.complete ? "closed" : `open: the ${EVALUATION.windowDays}-day window has not elapsed`})`,
    `- Holdout share at start: ${report.holdoutFraction}`,
    `- CI: ${EVALUATION.confidence * 100}% percentile bootstrap by unit (one-sided α = ${((1 - EVALUATION.confidence) / 2).toFixed(2)}), ${EVALUATION.resamples} resamples, seed \`${EVALUATION.seed}\``,
    `- Generated: ${date(report.generatedAt)}`,
    "",
    "## Suggested decisions",
    "",
    "| Capability | Enabled | Suggested decision | Why |",
    "| --- | --- | --- | --- |",
    ...report.capabilities.map(
      (result) =>
        `| ${result.instance ? `${result.title}: ${result.instance}` : result.title} | ${result.enabled ? "yes" : "no"} | **${result.decision}** | ${result.reasons.join("; ") || "—"} |`,
    ),
    "",
    "## Label coverage",
    "",
    "| Kind | Eligible | Labelled | Judged |",
    "| --- | --- | --- | --- |",
    ...report.coverage.map((row) => `| ${row.kind} | ${row.eligible} | ${row.labeled} | ${row.judged} |`),
    "",
    ...report.capabilities.flatMap((result) => [
      `## ${result.instance ? `${result.title}: ${result.instance}` : result.title}`,
      "",
      ...(result.arms
        ? [`Sessions: control ${result.arms.control}, treatment ${result.arms.treatment}, without a recorded arm ${result.arms.excluded}.`, ""]
        : []),
      ...(result.replayCommand
        ? [
            result.replay
              ? `Primary decided by replay: \`${result.replay.file}\` (${result.replay.variant} against ${result.replay.baseline}, ${result.replay.fixtures} paired fixtures, run ${date(result.replay.startedAt)}). The live arm reads the guardrails and the safety stops.`
              : `Primary decided by replay, and no replay report was passed: run \`${result.replayCommand}\`, then \`report --replay <report.json>\`.`,
            "",
          ]
        : []),
      ...(result.withheld ? ["Primary and guardrail metrics are withheld until the window closes and the minimum sample is reached (no peeking).", ""] : []),
      `| Role | Check | Estimate | ${EVALUATION.confidence * 100}% CI | Verdict |`,
      "| --- | --- | --- | --- | --- |",
      ...result.checks.map(
        (check) =>
          `| ${check.role} | ${check.description} | ${formatValue(check.key, check.estimate)} | ${check.low === undefined || check.high === undefined ? "—" : `${formatValue(check.key, check.low)} … ${formatValue(check.key, check.high)}`} | ${VERDICT_LABELS[check.role][check.verdict]} |`,
      ),
      "",
      ...(result.manual.length > 0 ? ["Checked by hand at G03:", ...result.manual.map((item) => `- ${item}`), ""] : []),
    ]),
  ]
  return lines.join("\n")
}

const VERDICT_LABELS: Record<CheckResult["role"], Record<CheckVerdict, string>> = {
  primary: { pass: "pass", fail: "fail", inconclusive: "inconclusive", unknown: "unknown" },
  guardrail: {
    pass: "pass",
    fail: "fail (evidence of harm)",
    inconclusive: "inconclusive (margin crossed, no evidence of harm)",
    unknown: "unknown",
  },
  safety: { pass: "ok", fail: "STOP", inconclusive: "watch (line crossed, no evidence of harm)", unknown: "no data" },
}

function formatValue(key: string, value: number | undefined): string {
  if (value === undefined) return "—"
  if (!Number.isFinite(value)) return "∞"
  const [metric, measure] = key.split(":") as [MetricID, string]
  const unit = METRICS[metric].unit
  if (unit === "share" && (measure === "difference" || measure === "paired")) return `${(value * 100).toFixed(1)} pp`
  if (measure === "relative" || measure === "geometric" || measure === "paired" || unit === "share" || unit === "ratio")
    return `${(value * 100).toFixed(1)}%`
  if (unit === "usd") return `${value.toFixed(4)} USD`
  if (unit === "ms") return `${Math.round(value)} ms`
  return value.toFixed(1)
}

// ---- helpers ----------------------------------------------------------------------------------------

/**
 * The nearest-rank percentile, as `session-summary.ts` reads it, over a typed array: the bootstrap
 * calls it thousands of times, and a typed sort needs no comparator.
 */
function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = Float64Array.from(values).sort()
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

function armsOf(json: string | null): Partial<Record<HoldoutCapability, Arm>> {
  const parsed = parseObject(json)
  if (!parsed) return {}
  return Object.fromEntries(
    HOLDOUT_CAPABILITIES.flatMap((capability) => {
      const arm = parsed[capability]
      return arm === "control" || arm === "treatment" ? [[capability, arm]] : []
    }),
  )
}

function toolCalls(json: string, tool: string): number {
  const tools = parseObject(json)
  const entry = tools?.[tool]
  return isObject(entry) && typeof entry.calls === "number" ? entry.calls : 0
}

function greenChecks(json: string): boolean {
  const checks = parseJSON(json)
  return !Array.isArray(checks) || checks.every((check) => !isObject(check) || check.ok !== false)
}

function parseJSON(text: string | null): unknown {
  if (text === null) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function parseObject(text: string | null): Record<string, unknown> | undefined {
  const value = parseJSON(text)
  return isObject(value) ? value : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0)
}
