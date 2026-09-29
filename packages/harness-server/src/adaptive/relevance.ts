/**
 * The relevance service: the one policy point behind the acting line (FH-04, ADR-0021).
 *
 * It reuses the whole Phase 2–3b substrate and adds no second decision path: `curator.roster` for
 * the names, `DecisionService.predict` for the selection and the audit, the runtime probe for the
 * fail-closed hook gate. It only projects the decision onto the line: `rankSkills` orders the chosen
 * names against the roster and `renderSkillLine` writes the fixed box.
 *
 * It is inert — a null line — whenever the feature is off, the master kill switch is on, the runtime
 * is not legacy, there is no objective or roster, nothing was selected, or anything throws. In all of
 * those cases `system` is left byte-identical; that is the guarantee ADR-0021 §3 fixes.
 */

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

export type RelevanceReason = "ok" | "disabled" | "runtime-not-legacy" | "no-roster" | "no-match" | "error"

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
 * A decision lives for the whole turn, not just `rosterTtlMs`: the hook fires per step of the loop,
 * and a turn with slow steps can outlive the roster TTL. Reusing the row for the same
 * `sessionID:messageID` is what stops the second step from spending Jev again and rewriting the
 * audit row. The cap, not the clock, is what bounds an engine that never restarts.
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
  now?: () => number
  /** Test seams for the eviction bound; production uses the module constants. */
  limits?: { rosters?: number; decisions?: number }
}): RelevanceService {
  const now = deps.now ?? Date.now
  const rosterLimit = deps.limits?.rosters ?? MAX_ROSTER_CACHE
  const decisionLimit = deps.limits?.decisions ?? MAX_DECISION_CACHE
  const rosters = new Map<string, { at: number; entries: ReturnType<typeof dedupeRoster> }>()
  const decisions = new Map<string, { at: number; result: RelevanceResult }>()

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
      // An empty objective would only spend on Jev to select nothing; it is the same as no match.
      if (!input.objective.trim()) return inert(id, "no-match", startedAt)

      // The same turn (a title and the turn itself) shares one id; the cache stops the second spend.
      // It survives the whole turn (`DECISION_TTL_MS`), so a slow step does not re-spend.
      const cached = decisions.get(id)
      if (cached && now() - cached.at < DECISION_TTL_MS) {
        remember(decisions, id, cached, decisionLimit)
        return { ...cached.result, latencyMs: now() - startedAt }
      }

      const roster = rosterFor(input.projectID, config.relevance.rosterTtlMs)
      if (roster.length === 0) return inert(id, "no-roster", startedAt)

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
      }
      // One audited acting decision per turn: `shadow: false` (ADR-0021 §5).
      const result = await deps.service.predict(request, "hot", false)
      const names = rankSkills({
        objective: input.objective,
        chosen: result.answer.load,
        roster,
        ...(result.probabilities !== undefined ? { probabilities: result.probabilities } : {}),
        maxSkills: config.relevance.maxSkills,
      })
      const line = renderSkillLine(names) ?? null
      const relevance: RelevanceResult = {
        line,
        decisionID: id,
        source: result.source,
        degraded: result.degraded,
        skills: names,
        reason: line === null ? "no-match" : "ok",
        latencyMs: now() - startedAt,
      }
      remember(decisions, id, { at: now(), result: relevance }, decisionLimit)
      return relevance
    } catch {
      // The hot path never throws toward the hook: any failure is the inert "error" result.
      return inert(id, "error", startedAt)
    }
  }

  return { suggest }
}
