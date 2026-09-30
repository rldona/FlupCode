/**
 * The outcome labeler (AH-C06): it joins each decision with what actually happened afterwards and
 * writes the decision's `label` once that outcome is knowable.
 *
 * It is a periodic sweep, like the episode and shadow sweeps. A pass walks the unlabelled backlog
 * oldest first behind a cursor, so it is bounded per pass and a page of still-unknowable rows never
 * starves the rows behind it. A row is only judged once it is older than its kind's settle window; a
 * row whose outcome is still unknowable stays unlabelled until `maxAgeMs`, and is then labelled
 * `unknown`. The write only lands on a row with no label, so a pass is idempotent, and nothing is
 * read or written while the adaptive kill switch is thrown.
 *
 * Each kind observes one truth and scores both the answer and the baseline answer against it, so
 * the label also carries what the baseline would have scored: the counterfactual that
 * uplift = acc(model | disagree) − acc(baseline | disagree) needs (AH-C05). A control-arm row is
 * scored the same way: its answer was never applied, so what happened is the natural course.
 *
 * The rules, per kind:
 * - `skillRelevance`: the truth is the set of skills loaded (`session_metrics.skills`) in the
 *   decided turn and the next `RELEVANCE_LOOKAHEAD_TURNS` turns, and whether the turn ended well (no
 *   `session.error` before the next turn started). An answer that chose exactly the loaded set is
 *   `correct` when the turn ended well and `unknown` when it did not; any skill chosen but not
 *   loaded, or loaded but not chosen, is `incorrect`. A shadow decision taken on a closed episode
 *   compares against the skills loaded in the episode's turns, and "ended well" is an outcome that
 *   is not `failed`.
 * - `completion`: the closed episode's outcome. `success` with no failed verification means the
 *   episode was complete; `failed`, `partial` or a failed verification mean it was not; an episode
 *   still open, or one whose outcome is `unknown`, is not knowable yet.
 * - `contextItem`: recall misses. A `file` item the answer archived or dropped is a miss when the
 *   same session touched that path again after the episode closed (the episode-signals file, hashed
 *   to the same opaque id). No miss after later activity is `correct`. Only `file` items can be
 *   joined this cheaply: commands, errors and a run prompt's parts leave no re-read signal, so a
 *   decision whose session never acted again (or a run-prompt plan) ages into `unknown`.
 * - `failure`: the course of the loop in the `FAILURE_WINDOW_MS` after the decision. The loop was
 *   real when the session hit a `session.error`, or the same tool failed `FAILURE_PERSIST_ERRORS`
 *   more times, inside the window; it resolved on its own when the session was active after the
 *   window with neither. `intervene` is correct for a real loop and `continue` for a resolved one. A
 *   user abort and the engine's native `doom_loop` are not recorded anywhere the harness can read
 *   (the events plugin drops aborts on purpose), so they cannot be counted here; a session that went
 *   silent after the advisory stays ambiguous and ages into `unknown`.
 */

import { locate } from "../failures"
import type { SessionEpisode, StoredDecision } from "../types"
import type { DecisionKind, DecisionLabelCounts, DecisionLabelInput, DecisionLabelOutcome } from "./decision"
import { episodeEvents } from "./events"
import type { EpisodeEvent } from "./events"
import { opaqueItemID } from "./opaque-id"
import type { SessionMetricTurn } from "./session-metrics"
import { episodeSignals } from "./signals"
import type { EpisodeSignal } from "./signals"

/** The kinds that have a real outcome to join; the rest are never labelled by this sweep. */
export const LABELED_KINDS = ["skillRelevance", "completion", "contextItem", "failure"] as const
export type LabeledKind = (typeof LABELED_KINDS)[number]

const MINUTE = 60 * 1000

/**
 * How long a decision is left alone before it is judged. Relevance and completion settle once the
 * turn or the episode is behind them; a failure needs its whole observation window; a recall miss
 * needs the session to have had time to come back to what was archived.
 */
export const LABEL_SETTLE_MS: Record<LabeledKind, number> = {
  skillRelevance: 10 * MINUTE,
  completion: 10 * MINUTE,
  contextItem: 60 * MINUTE,
  failure: 15 * MINUTE,
}

/** Past this age a still-unknowable decision is labelled `unknown` instead of being revisited. */
export const LABEL_MAX_AGE_MS = 6 * 60 * MINUTE
/** How long after a failure decision the loop's course is watched. */
export const FAILURE_WINDOW_MS = 10 * MINUTE
/** How many more failures of the same tool inside the window mean the loop persisted. */
export const FAILURE_PERSIST_ERRORS = 2
/** How many turns after the decided one still count as "loaded for this objective". */
export const RELEVANCE_LOOKAHEAD_TURNS = 2
/** How many decisions one pass looks at. */
export const LABEL_SWEEP_LIMIT = 200
export const LABEL_SWEEP_MS = 5 * MINUTE
/** The window the coverage stat reads. */
export const LABEL_COVERAGE_WINDOW_MS = 24 * 60 * MINUTE

export type LabelerRepository = {
  listUnlabeledDecisions(input: {
    kinds: readonly DecisionKind[]
    settledBefore: number
    after?: { createdAt: number; id: string }
    limit: number
  }): StoredDecision[]
  labelDecision(id: string, label: DecisionLabelInput, at?: number): boolean
  getEpisode(id: string): SessionEpisode | undefined
  listSessionMetrics(sessionID: string): SessionMetricTurn[]
}

/** What a judge may look at; the sweep caches it per session for the length of one pass. */
export type LabelEvidence = {
  episode(id: string): SessionEpisode | undefined
  turns(sessionID: string): SessionMetricTurn[]
  events(sessionID: string): EpisodeEvent[]
  signals(sessionID: string): EpisodeSignal[]
  key(): Buffer
}

export type OutcomeLabeler = {
  /** One bounded pass; returns how many decisions it labelled. */
  sweep(): number
  start(): void
  stop(): void
}

export function createOutcomeLabeler(deps: {
  repository: LabelerRepository
  /** The adaptive kill switch, read on every pass. */
  enabled: () => boolean
  /** The install key the opaque context ids are derived with. */
  key: () => Buffer
  readEvents?: (sessionID: string) => EpisodeEvent[]
  readSignals?: (sessionID: string) => EpisodeSignal[]
  now?: () => number
  limit?: number
  maxAgeMs?: number
  sweepMs?: number
  onError?: (cause: unknown) => void
}): OutcomeLabeler {
  const now = deps.now ?? Date.now
  const limit = deps.limit ?? LABEL_SWEEP_LIMIT
  const maxAgeMs = deps.maxAgeMs ?? LABEL_MAX_AGE_MS
  const readEvents = deps.readEvents ?? ((sessionID: string) => episodeEvents(sessionID).events)
  const readSignals = deps.readSignals ?? ((sessionID: string) => episodeSignals(sessionID).calls)
  const onError = deps.onError ?? (() => {})
  let cursor: { createdAt: number; id: string } | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const sweep = (): number => {
    if (!deps.enabled()) return 0
    try {
      const at = now()
      const page = deps.repository.listUnlabeledDecisions({
        kinds: LABELED_KINDS,
        settledBefore: at - Math.min(...Object.values(LABEL_SETTLE_MS)),
        ...(cursor ? { after: cursor } : {}),
        limit,
      })
      // A short page is the end of the backlog: the next pass starts over from the oldest row.
      cursor = page.length < limit ? undefined : { createdAt: page.at(-1)!.createdAt, id: page.at(-1)!.id }
      const evidence = cachedEvidence(deps.repository, readEvents, readSignals, deps.key)
      return page.filter((decision) => {
        const label = labelFor(decision, evidence, at, maxAgeMs)
        return label !== undefined && deps.repository.labelDecision(decision.id, label, at)
      }).length
    } catch (cause) {
      onError(cause)
      return 0
    }
  }

  const start = () => {
    if (timer) return
    sweep()
    timer = setInterval(sweep, deps.sweepMs ?? LABEL_SWEEP_MS)
    timer.unref()
  }

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  return { sweep, start, stop }
}

/**
 * The label a decision gets now, or nothing while it should be left for a later pass: before its
 * settle window, or while its outcome is unknowable and it is younger than `maxAgeMs`.
 */
export function labelFor(
  decision: StoredDecision,
  evidence: LabelEvidence,
  now: number,
  maxAgeMs = LABEL_MAX_AGE_MS,
): DecisionLabelInput | undefined {
  if (!isLabeledKind(decision.kind)) return undefined
  const age = now - decision.createdAt
  if (age < LABEL_SETTLE_MS[decision.kind]) return undefined
  const judged = judge(decision.kind, decision, evidence, now)
  if (judged) return judged
  if (age < maxAgeMs) return undefined
  return { outcome: "unknown", baselineOutcome: "unknown", source: "max-age" }
}

/** One kind's counts, with the share labelled at all and the share judged correct or incorrect. */
export type LabelCoverage = DecisionLabelCounts & { coverage: number | null; judgedCoverage: number | null }

/** The labeling coverage over a window, per kind: the stat the AC is measured with. */
export function labelCoverage(
  repository: { countDecisionLabels(input: { kind: DecisionKind; since: number; until: number }): DecisionLabelCounts },
  now: number,
  windowMs = LABEL_COVERAGE_WINDOW_MS,
) {
  // `fromEntries` forgets the keys; every labelled kind is mapped, so the record is total.
  const kinds = Object.fromEntries(
    LABELED_KINDS.map((kind) => {
      // A decision younger than its settle window is not eligible yet: it could not have a label.
      const counts = repository.countDecisionLabels({ kind, since: now - windowMs, until: now - LABEL_SETTLE_MS[kind] })
      return [
        kind,
        {
          ...counts,
          coverage: counts.eligible === 0 ? null : counts.labeled / counts.eligible,
          judgedCoverage: counts.eligible === 0 ? null : (counts.correct + counts.incorrect) / counts.eligible,
        },
      ]
    }),
  ) as Record<LabeledKind, LabelCoverage>
  return { windowMs, settleMs: LABEL_SETTLE_MS, maxAgeMs: LABEL_MAX_AGE_MS, kinds }
}

/** The artifacts-bearer GET behind `/harness/adaptive/labels/coverage`; `hours` narrows the window. */
export function handleLabelCoverageRead(
  request: Request,
  repository: Parameters<typeof labelCoverage>[0],
  now = Date.now(),
): Response {
  const hours = Number(new URL(request.url).searchParams.get("hours") ?? 24)
  const windowMs = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 30) * 60 * MINUTE : LABEL_COVERAGE_WINDOW_MS
  return new Response(JSON.stringify({ data: labelCoverage(repository, now, windowMs) }), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })
}

const isLabeledKind = (kind: string): kind is LabeledKind =>
  LABELED_KINDS.some((candidate) => candidate === kind)

/** One truth per kind, scored against both the answer and the baseline answer. */
function judge(kind: LabeledKind, decision: StoredDecision, evidence: LabelEvidence, now: number) {
  const score = (truth: { source: string; score: (answer: unknown) => DecisionLabelOutcome } | undefined) =>
    truth
      ? {
          outcome: truth.score(decision.answer),
          baselineOutcome: truth.score(decision.baselineAnswer),
          source: truth.source,
        }
      : undefined
  if (kind === "skillRelevance") return score(relevanceTruth(decision, evidence, now))
  if (kind === "completion") return score(completionTruth(decision, evidence))
  if (kind === "contextItem") return score(contextTruth(decision, evidence))
  return score(failureTruth(decision, evidence, now))
}

function relevanceTruth(decision: StoredDecision, evidence: LabelEvidence, now: number) {
  const observed = decision.episodeID
    ? episodeLoads(decision.episodeID, evidence)
    : turnLoads(decision, evidence, now)
  if (!observed) return undefined
  return {
    source: "skill-loads",
    score: (answer: unknown): DecisionLabelOutcome => {
      const chosen = stringList(answer, "load")
      if (!chosen) return "unknown"
      const same =
        chosen.every((name) => observed.loaded.has(name)) && [...observed.loaded].every((name) => chosen.includes(name))
      if (!same) return "incorrect"
      return observed.ok ? "correct" : "unknown"
    },
  }
}

/**
 * The acting line decides once per turn under `skillRelevance:<sessionID>:<messageID>`, and the
 * metrics plugin keys the same turn by the same user message id. The turn is judged once it and its
 * lookahead turns were observed, or the session has been quiet for the settle window.
 */
function turnLoads(decision: StoredDecision, evidence: LabelEvidence, now: number) {
  const prefix = `skillRelevance:${decision.sessionID}:`
  if (!decision.sessionID || !decision.id.startsWith(prefix)) return undefined
  const turnID = decision.id.slice(prefix.length)
  const turns = evidence.turns(decision.sessionID)
  const index = turns.findIndex((turn) => turn.turnID === turnID)
  if (index === -1) return undefined
  const window = turns.slice(index, index + 1 + RELEVANCE_LOOKAHEAD_TURNS)
  const quiet = now - Math.max(...turns.map((turn) => turn.endedAt)) >= LABEL_SETTLE_MS.skillRelevance
  if (window.length < 1 + RELEVANCE_LOOKAHEAD_TURNS && !quiet) return undefined
  const started = turns[index]!.startedAt
  const next = turns[index + 1]?.startedAt ?? Number.POSITIVE_INFINITY
  return {
    loaded: new Set(window.flatMap((turn) => turn.skills)),
    ok: !evidence
      .events(decision.sessionID)
      .some((event) => event.kind === "session.error" && event.at >= started && event.at < next),
  }
}

/** A shadow decision on a closed episode compares against the skills its turns loaded. */
function episodeLoads(episodeID: string, evidence: LabelEvidence) {
  const episode = evidence.episode(episodeID)
  if (!episode || episode.endedAt === undefined) return undefined
  const endedAt = episode.endedAt
  const turns = evidence
    .turns(episode.sessionID)
    .filter((turn) => turn.endedAt >= episode.startedAt && turn.startedAt <= endedAt)
  if (turns.length === 0) return undefined
  return { loaded: new Set(turns.flatMap((turn) => turn.skills)), ok: episode.outcome !== "failed" }
}

function completionTruth(decision: StoredDecision, evidence: LabelEvidence) {
  const episode = decision.episodeID ? evidence.episode(decision.episodeID) : undefined
  if (!episode || episode.endedAt === undefined || episode.outcome === "unknown") return undefined
  const complete = episode.outcome === "success" && episode.verifications.every((verification) => verification.ok)
  return {
    source: "episode-outcome",
    score: (answer: unknown): DecisionLabelOutcome => {
      const verdict = stringField(answer, "verdict")
      if (verdict !== "complete" && verdict !== "not_complete") return "unknown"
      return (verdict === "complete") === complete ? "correct" : "incorrect"
    },
  }
}

function contextTruth(decision: StoredDecision, evidence: LabelEvidence) {
  const episode = decision.episodeID ? evidence.episode(decision.episodeID) : undefined
  if (!episode || episode.endedAt === undefined) return undefined
  const endedAt = episode.endedAt
  const later = evidence
    .signals(episode.sessionID)
    .filter((signal) => signal.start !== undefined && signal.start > endedAt)
  // With no later activity nothing could have been re-read yet; that is not the same as no miss.
  if (later.length === 0) return undefined
  const key = evidence.key()
  // The same formula the episode classifier ids its `file` items with, so a re-read converges on it.
  const reread = new Set(
    later.flatMap((signal) => signal.paths.map((path) => opaqueItemID("file", locate(path, episode.projectID), key))),
  )
  return {
    source: "recall",
    score: (answer: unknown): DecisionLabelOutcome => {
      const removed = removedItems(answer)
      if (!removed) return "unknown"
      return removed.some((id) => reread.has(id)) ? "incorrect" : "correct"
    },
  }
}

/**
 * The guardrail decides once per loop under `failure:<sessionID>:<tool>:<digest>`; the tool is read
 * back from the id so the window only counts failures of the tool that looped.
 */
function failureTruth(decision: StoredDecision, evidence: LabelEvidence, now: number) {
  const prefix = `failure:${decision.sessionID}:`
  if (!decision.sessionID || !decision.id.startsWith(prefix)) return undefined
  const rest = decision.id.slice(prefix.length)
  const tool = rest.slice(0, rest.lastIndexOf(":"))
  if (!tool) return undefined
  const from = decision.createdAt
  const until = from + FAILURE_WINDOW_MS
  const events = evidence.events(decision.sessionID)
  const inside = events.filter((event) => event.at > from && event.at <= until)
  const loop =
    inside.some((event) => event.kind === "session.error") ||
    inside.filter((event) => event.kind === "tool.error" && event.tool === tool).length >= FAILURE_PERSIST_ERRORS
  const resolved =
    !loop &&
    now > until &&
    (events.some((event) => event.at > until) ||
      evidence.turns(decision.sessionID).some((turn) => turn.endedAt > until))
  if (!loop && !resolved) return undefined
  return {
    source: "loop-course",
    score: (answer: unknown): DecisionLabelOutcome => {
      const verdict = stringField(answer, "verdict")
      if (verdict !== "intervene" && verdict !== "continue") return "unknown"
      return (verdict === "intervene") === loop ? "correct" : "incorrect"
    },
  }
}

/** One pass's view of the evidence: each session's files and rows are read once, however many rows. */
function cachedEvidence(
  repository: LabelerRepository,
  readEvents: (sessionID: string) => EpisodeEvent[],
  readSignals: (sessionID: string) => EpisodeSignal[],
  key: () => Buffer,
): LabelEvidence {
  const memo = <T>(read: (id: string) => T) => {
    const cache = new Map<string, T>()
    return (id: string) => {
      if (!cache.has(id)) cache.set(id, read(id))
      return cache.get(id)!
    }
  }
  let cachedKey: Buffer | undefined
  return {
    episode: memo((id) => repository.getEpisode(id)),
    turns: memo((sessionID) => repository.listSessionMetrics(sessionID)),
    events: memo(readEvents),
    signals: memo(readSignals),
    key: () => (cachedKey ??= key()),
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringField = (value: unknown, field: string) =>
  isPlainObject(value) && typeof value[field] === "string" ? value[field] : undefined

const stringList = (value: unknown, field: string) => {
  if (!isPlainObject(value) || !Array.isArray(value[field])) return undefined
  return value[field].filter((entry): entry is string => typeof entry === "string")
}

/** The ids a context answer archived or dropped; a malformed answer is "no answer", not "kept all". */
function removedItems(answer: unknown) {
  if (!isPlainObject(answer) || !Array.isArray(answer.decisions)) return undefined
  return answer.decisions.flatMap((entry) =>
    isPlainObject(entry) && typeof entry.id === "string" && (entry.disposition === "archive" || entry.disposition === "drop")
      ? [entry.id]
      : [],
  )
}
