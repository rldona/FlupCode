/**
 * The per-session override of the adaptive layer (AH-E02).
 *
 * The switches in the config file are global: turning relevance off to quiet one session turns it off
 * for every other one too, and writes the user's file. The override is the in-session escape hatch
 * the composer's "Adaptive" chip drives instead:
 *
 * - **pause** — every capability that reads it acts as off for that session from its next step:
 *   the relevance line, the loop warnings, the context plan, the compaction anchors, the tool-output
 *   trim and the predictive model behind them all. The per-request routes read it on every call, so a
 *   pause lands on the next provider step; per-step selection is latched by its plugin and follows at
 *   the next cold step (see `docs/ADAPTIVE.md`). A paused decision is still recorded, as the baseline
 *   with `degradedReason: "session-paused"`, so the audit says why nothing acted.
 * - **excluded skills** — "don't suggest X": the relevance line leaves those skills out of the roster
 *   it decides over, for that session only.
 *
 * It lives in memory and is bounded: a restart forgets it, which is the deliberate price of not
 * writing per-session state anywhere. Nothing here is policy beyond the override itself; each
 * capability decides how "off" reads for it.
 */

import { decodedID } from "./route-id"
import type { DecisionService } from "./decision-service"
import type { StoredDecision, StoredPlan } from "../types"

export type SessionOverride = { paused: boolean; excludedSkills: string[] }

export type SessionOverrides = {
  get(sessionID: string): SessionOverride
  set(sessionID: string, patch: Partial<SessionOverride>): SessionOverride
  paused(sessionID: string | undefined): boolean
  /** Every paused session, so a latched plugin (per-step selection) can follow the pause. */
  pausedSessions(): string[]
}

/** Engine-shaped ids and skill names are short; the caps keep a caller from handing the map a key. */
const ID_LIMIT = 200
const SKILL_LIMIT = 200
export const MAX_OVERRIDE_SESSIONS = 1000
export const MAX_EXCLUDED_SKILLS = 50

const NONE: SessionOverride = { paused: false, excludedSkills: [] }

export function createSessionOverrides(limit = MAX_OVERRIDE_SESSIONS): SessionOverrides {
  const overrides = new Map<string, SessionOverride>()

  const get = (sessionID: string) => overrides.get(sessionID) ?? NONE

  const set = (sessionID: string, patch: Partial<SessionOverride>) => {
    const current = get(sessionID)
    const next = {
      paused: patch.paused ?? current.paused,
      excludedSkills: [...new Set(patch.excludedSkills ?? current.excludedSkills)].slice(0, MAX_EXCLUDED_SKILLS),
    }
    overrides.delete(sessionID)
    // An override back at the defaults is no override: the entry is dropped rather than kept.
    if (!next.paused && next.excludedSkills.length === 0) return NONE
    overrides.set(sessionID, next)
    // The oldest write is evicted past the cap, so a caller iterating ids cannot grow the map forever.
    while (overrides.size > limit) {
      const oldest = overrides.keys().next().value
      if (oldest === undefined) break
      overrides.delete(oldest)
    }
    return next
  }

  return {
    get,
    set,
    paused: (sessionID) => sessionID !== undefined && get(sessionID).paused,
    pausedSessions: () => [...overrides].filter((entry) => entry[1].paused).map((entry) => entry[0]),
  }
}

/**
 * What the chip says about the session's latest turn: the skills the relevance decision suggested,
 * the context plan and what it saved, and the predictive model when one was consulted. Built from the
 * audit alone, so reading it never decides or spends anything.
 */
export type SessionTurnSummary = {
  sessionID: string
  override: SessionOverride
  relevance?: {
    decisionID: string
    skills: string[]
    /** False for a paused, shadow or holdout decision: it was recorded, not injected. */
    acted: boolean
    degradedReason?: string
    at: number
  }
  plan?: { id: string; tokensSaved: number; applied: boolean; decisionID?: string; at: number }
  model?: { providerID: string; kind: string; latencyMs: number; decisionID: string; at: number }
}

export type SessionOverrideDeps = {
  overrides: SessionOverrides
  decisions?: Pick<DecisionService, "decisions">
  plans?: { listPlans(filter: { sessionID: string; limit: number }): StoredPlan[] }
}

/** How far back the summary looks for a consulted model: a turn writes a handful of rows at most. */
const MODEL_LOOKBACK = 20

export function sessionTurnSummary(sessionID: string, deps: SessionOverrideDeps): SessionTurnSummary {
  const relevance = deps.decisions?.decisions({ sessionID, kind: "skillRelevance", limit: 1 })[0]
  const plan = deps.plans?.listPlans({ sessionID, limit: 1 })[0]
  const model = deps.decisions
    ?.decisions({ sessionID, limit: MODEL_LOOKBACK })
    .find((row) => row.providerID !== undefined)
  return {
    sessionID,
    override: deps.overrides.get(sessionID),
    ...(relevance ? { relevance: relevanceOf(relevance) } : {}),
    ...(plan
      ? {
          plan: {
            id: plan.id,
            tokensSaved: Math.max(0, plan.tokensBefore - plan.tokensAfter),
            applied: plan.applied,
            ...(plan.decisionID ? { decisionID: plan.decisionID } : {}),
            at: plan.updatedAt,
          },
        }
      : {}),
    ...(model?.providerID
      ? {
          model: {
            providerID: model.providerID,
            kind: model.kind,
            latencyMs: model.latencyMs,
            decisionID: model.id,
            at: model.updatedAt,
          },
        }
      : {}),
  }
}

function relevanceOf(row: StoredDecision): NonNullable<SessionTurnSummary["relevance"]> {
  const load =
    typeof row.answer === "object" && row.answer !== null ? (row.answer as { load?: unknown }).load : undefined
  return {
    decisionID: row.id,
    skills: Array.isArray(load) ? load.filter((name): name is string => typeof name === "string") : [],
    acted: !row.shadow && row.arm !== "control",
    ...(row.degradedReason ? { degradedReason: row.degradedReason } : {}),
    at: row.updatedAt,
  }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

/**
 * `GET|PUT /harness/adaptive/sessions/:id/override` and `GET /harness/adaptive/sessions/:id/turn`.
 * `api.ts` guards them with the browser bearer like the other UI-facing adaptive routes; here they are
 * only the shape of the request and the answer. `segments` starts at `sessions`.
 */
export async function handleSessionOverrideRequest(
  request: Request,
  segments: string[],
  deps: SessionOverrideDeps,
): Promise<Response> {
  const sessionID = decodedID(segments[1])
  if (segments[0] !== "sessions" || segments.length !== 3 || !sessionID || sessionID.length > ID_LIMIT)
    return error("Not found", "not_found", 404)
  if (segments[2] === "turn" && request.method === "GET") return json({ data: sessionTurnSummary(sessionID, deps) })
  if (segments[2] !== "override") return error("Not found", "not_found", 404)
  if (request.method === "GET") return json({ data: deps.overrides.get(sessionID) })
  if (request.method !== "PUT") return error("Not found", "not_found", 404)
  const patch = patchFrom(await request.json().catch(() => undefined))
  if (!patch) return error("An override takes paused (boolean) and excludedSkills (skill names)", "bad_request", 400)
  return json({ data: deps.overrides.set(sessionID, patch) })
}

/** A partial override, or nothing when any field it names is not the shape the override keeps. */
function patchFrom(body: unknown): Partial<SessionOverride> | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined
  const value = body as Record<string, unknown>
  if (value.paused !== undefined && typeof value.paused !== "boolean") return undefined
  const skills = value.excludedSkills
  if (
    skills !== undefined &&
    (!Array.isArray(skills) ||
      skills.length > MAX_EXCLUDED_SKILLS ||
      !skills.every((name) => typeof name === "string" && name.length > 0 && name.length <= SKILL_LIMIT))
  )
    return undefined
  return {
    ...(typeof value.paused === "boolean" ? { paused: value.paused } : {}),
    ...(Array.isArray(skills) ? { excludedSkills: skills as string[] } : {}),
  }
}
