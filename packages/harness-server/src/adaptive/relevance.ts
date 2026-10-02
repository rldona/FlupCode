/**
 * The relevance service: the one policy point behind the acting line (FH-04, ADR-0021).
 *
 * It reuses the whole Phase 2–3b substrate and adds no second decision path: `curator.roster` for
 * the names, `DecisionService.predict` for the selection and the audit, the runtime probe for the
 * fail-closed hook gate. It only projects the decision onto the line: `rankSkills` orders the chosen
 * names against the roster and `renderSkillLine` writes the fixed box.
 *
 * It is inert — a null line — whenever the feature is off, the master kill switch is on, the runtime
 * is not legacy, the session's override paused it (AH-E02), there is no objective or roster, nothing
 * was selected, or anything throws. In all of those cases nothing is added to the turn; that is the
 * guarantee ADR-0021 §3 fixes. The line now rides on the turn's user message rather than the system
 * prompt, so it never rewrites the prompt cache (ADR-0024, "Relevance line").
 */

import { armFor } from "./holdout"
import type { AdaptiveConfig } from "./config"
import type { DecisionRequest, DecisionSource } from "./decision"
import type { DecisionService } from "./decision-service"
import { decisionID } from "./decision-record"
import type { RuntimeCapabilities } from "./runtime"
import type { SkillRosterEntry } from "./skills/curator"
import { dedupeRoster, rankSkills, renderSkillLine } from "./skill-line"

export type RelevanceRequest = {
  projectID: string
  sessionID: string
  messageID: string
  objective: string
}

export type RelevanceReason =
  | "ok"
  | "disabled"
  | "runtime-not-legacy"
  | "no-roster"
  | "no-match"
  | "holdout"
  | "session-paused"
  | "error"

export type RelevanceResult = {
  line: string | null
  decisionID: string
  source: DecisionSource | "none"
  degraded: boolean
  skills: string[]
  reason: RelevanceReason
  latencyMs: number
}

export type RelevanceService = { suggest(input: RelevanceRequest): Promise<RelevanceResult> }

/** The two capabilities the legacy injection seam needs; anything else stays inert. */
const canInject = (capabilities: RuntimeCapabilities): boolean =>
  capabilities.canInjectSystemPrompt && capabilities.canTransformMessages

/**
 * Real size bounds on the in-process caches: without them a caller iterating project ids or message
 * ids grows a `Map` for the life of the engine, and the read TTL frees nothing. The bound evicts the
 * oldest entry (LRU on write and on hit), so the newest turns are the ones that stay.
 */
export const MAX_ROSTER_CACHE = 500
export const MAX_DECISION_CACHE = 500

/**
 * A decision lives for the whole turn, not just `rosterTtlMs`. The current plugin asks once per user
 * turn and pins the answer itself (ADR-0024, "Relevance line"), but an older plugin asked on every
 * step, and a repeated `sessionID:messageID` must still not spend a model again or rewrite the audit row.
 * The cap, not the clock, is what bounds an engine that never restarts.
 */
export const DECISION_TTL_MS = 10 * 60 * 1000

/** Writes into a bounded LRU: the newest key is last, the oldest is evicted past the cap. */
function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function createRelevanceService(deps: {
  service: DecisionService
  curator: { roster(projectID: string): SkillRosterEntry[] }
  runtimeProbe: { capabilities(): RuntimeCapabilities }
  config: () => AdaptiveConfig
  /** The per-session override (AH-E02): a pause and the skills a person asked not to be suggested. */
  overrides?: { get(sessionID: string): { paused: boolean; excludedSkills: string[] } }
  now?: () => number
  /** Test seams for the eviction bound; production uses the module constants. */
  limits?: { rosters?: number; decisions?: number }
}): RelevanceService {
  const now = deps.now ?? Date.now
  const rosterLimit = deps.limits?.rosters ?? MAX_ROSTER_CACHE
  const decisionLimit = deps.limits?.decisions ?? MAX_DECISION_CACHE
  const rosters = new Map<string, { at: number; entries: ReturnType<typeof dedupeRoster> }>()
  const decisions = new Map<string, { at: number; excluded: string; result: RelevanceResult }>()

  /** The roster with a TTL, so a turn does not `readdir`/`readFile` on the hot path. */
  const rosterFor = (projectID: string, ttlMs: number): ReturnType<typeof dedupeRoster> => {
    const cached = rosters.get(projectID)
    if (cached && now() - cached.at < ttlMs) {
      remember(rosters, projectID, cached, rosterLimit)
      return cached.entries
    }
    const entries = dedupeRoster(deps.curator.roster(projectID))
    remember(rosters, projectID, { at: now(), entries }, rosterLimit)
    return entries
  }

  const inert = (id: string, reason: RelevanceReason, startedAt: number): RelevanceResult => ({
    line: null,
    decisionID: id,
    source: "none",
    degraded: false,
    skills: [],
    reason,
    latencyMs: now() - startedAt,
  })

  const suggest = async (input: RelevanceRequest): Promise<RelevanceResult> => {
    const startedAt = now()
    const id = decisionID("skillRelevance", `${input.sessionID}:${input.messageID}`)
    // The contract is inert on **any** throw, so the whole body — `config()`, the roster read and the
    // decision — sits inside the try; a bad reader must not turn into a failed turn.
    try {
      const config = deps.config()
      if (!config.enabled || !config.relevance.enabled) return inert(id, "disabled", startedAt)
      // Fail-closed on the runtime: with v2/unknown the legacy hooks will not fire anyway, so the line
      // must not be computed as if they would (FH-000, ADR-0021 §6).
      if (!canInject(deps.runtimeProbe.capabilities())) return inert(id, "runtime-not-legacy", startedAt)
      // An empty objective would only spend on a model to select nothing; it is the same as no match.
      if (!input.objective.trim()) return inert(id, "no-match", startedAt)
      // The override is read on every call, before the cache. The plugin calls once per user turn and
      // pins that answer for the turn's steps, so a pause or an exclusion lands on the next user turn
      // (ADR-0024, "Relevance line"): dropping a line mid-turn would rewrite the prompt cache.
      const override = deps.overrides?.get(input.sessionID) ?? { paused: false, excludedSkills: [] }
      const excluded = [...override.excludedSkills].sort().join("\n")

      // The same turn (a title and the turn itself) shares one id; the cache stops the second spend.
      // It survives the whole turn (`DECISION_TTL_MS`), so a slow step does not re-spend. A changed
      // exclusion list is a different question, so it is decided again.
      const cached = decisions.get(id)
      if (!override.paused && cached && cached.excluded === excluded && now() - cached.at < DECISION_TTL_MS) {
        remember(decisions, id, cached, decisionLimit)
        return { ...cached.result, latencyMs: now() - startedAt }
      }

      const roster = rosterFor(input.projectID, config.relevance.rosterTtlMs).filter(
        (entry) => !override.excludedSkills.includes(entry.name),
      )
      if (roster.length === 0) return inert(id, "no-roster", startedAt)
      const arm = armFor(input.sessionID, "relevance", config.holdout.fraction)

      const request: DecisionRequest<"skillRelevance"> = {
        kind: "skillRelevance",
        state: {
          sessionID: input.sessionID,
          objective: input.objective,
          skills: roster.map((entry) => ({
            name: entry.name,
            description: entry.description,
            learned: entry.learned === true,
          })),
        },
        // The hot deadline the actor promises; it is the request policy the service applies.
        policy: { ...config.decisions.skillRelevance, timeoutMs: config.relevance.timeoutMs },
        scopeID: `${input.sessionID}:${input.messageID}`,
        sessionID: input.sessionID,
        projectID: input.projectID,
        arm,
      }
      // One audited acting decision per turn: `shadow: false` (ADR-0021 §5). A paused session is
      // still decided and recorded — the service asks no model and marks the row `session-paused` —
      // so the audit says why no line was injected; nothing is cached, so a resume decides afresh.
      const result = await deps.service.predict(request, "hot", false)
      if (override.paused) {
        decisions.delete(id)
        return { ...inert(id, "session-paused", startedAt), source: result.source }
      }
      const names = rankSkills({
        objective: input.objective,
        chosen: result.answer.load,
        roster,
        ...(result.probabilities !== undefined ? { probabilities: result.probabilities } : {}),
        maxSkills: config.relevance.maxSkills,
      })
      const rendered = renderSkillLine(names) ?? null
      // A control session gets the same audited decision and no line: that is the comparison (AH-B05).
      const line = arm === "control" ? null : rendered
      const relevance: RelevanceResult = {
        line,
        decisionID: id,
        source: result.source,
        degraded: result.degraded,
        skills: names,
        reason: rendered === null ? "no-match" : arm === "control" ? "holdout" : "ok",
        latencyMs: now() - startedAt,
      }
      remember(decisions, id, { at: now(), excluded, result: relevance }, decisionLimit)
      return relevance
    } catch {
      // The hot path never throws toward the hook: any failure is the inert "error" result.
      return inert(id, "error", startedAt)
    }
  }

  return { suggest }
}
