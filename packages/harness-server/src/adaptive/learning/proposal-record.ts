/**
 * The stored row of a skill proposal, encoded and decoded (FH-034).
 *
 * A proposal is the reviewable step between a reflection and a learned skill: the manager persists
 * it before the curator promotes it, and a route serves it to a person. The `body` is the one place
 * this row carries observed text, so it is redacted and bounded before it is written (ADR-0020 §3);
 * this module only serializes what it is handed, exactly like `decision-record.ts`.
 *
 * The id is deterministic (`proposal:<episodeID>`), so a re-close or a sweep converges on the same
 * row. Every decode is defensive: a row edited by hand or written by an older build reads as missing
 * rather than as a guess, and an unknown intent or status drops the row instead of inventing one.
 */

import type { ReflectionIntent } from "../decision"
import { isReflectionIntent } from "../decision"

/** The one proposal an episode owns: the deterministic id is the episode's own id (FH-034). */
export const proposalID = (episodeID: string): string => `proposal:${episodeID}`

export const SKILL_PROPOSAL_STATUSES = ["proposed", "promoted", "rejected"] as const
export type SkillProposalStatus = (typeof SKILL_PROPOSAL_STATUSES)[number]

export const isSkillProposalStatus = (value: unknown): value is SkillProposalStatus =>
  SKILL_PROPOSAL_STATUSES.some((status) => status === value)

/** One proposal: what a reflection drafted, before and after the curator decided on it. */
export type StoredSkillProposal = {
  id: string
  episodeID: string
  sessionID?: string
  projectID: string
  decisionID?: string
  intent: ReflectionIntent
  targetSkill?: string
  name?: string
  description?: string
  /** Redacted and bounded by the manager before it is stored; never a raw draft. */
  body?: string
  /** The SHA-256 of `body`, so a reader can compare versions without diffing text. */
  bodyHash?: string
  evidenceRefs: string[]
  confidence?: number
  modelVersion?: string
  status: SkillProposalStatus
  reason?: string
  createdAt: number
  updatedAt: number
}

export type StoredSkillProposalInput = Omit<StoredSkillProposal, "createdAt" | "updatedAt">

export type SkillProposalFilter = {
  episodeID?: string
  projectID?: string
  status?: SkillProposalStatus
  limit?: number
}

/** The shape SQLite hands back; every nullable column is `null`, never absent. */
export type SkillProposalRow = {
  id: string
  episode_id: string
  session_id: string | null
  project_id: string
  decision_id: string | null
  intent: string
  target_skill: string | null
  name: string | null
  description: string | null
  body: string | null
  body_hash: string | null
  evidence_refs_json: string
  confidence: number | null
  model_version: string | null
  status: string
  reason: string | null
  created_at: number
  updated_at: number
}

const parseStringList = (value: string | null): string[] => {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    // A row edited by hand or written by an older build must not take a reader down.
    return []
  }
}

/** The row as it is written: JSON fields serialized, absent optionals stored as `null`. */
export const proposalRowFrom = (input: StoredSkillProposalInput, now: number): SkillProposalRow => ({
  id: input.id,
  episode_id: input.episodeID,
  session_id: input.sessionID ?? null,
  project_id: input.projectID,
  decision_id: input.decisionID ?? null,
  intent: input.intent,
  target_skill: input.targetSkill ?? null,
  name: input.name ?? null,
  description: input.description ?? null,
  body: input.body ?? null,
  body_hash: input.bodyHash ?? null,
  evidence_refs_json: JSON.stringify(input.evidenceRefs),
  confidence: input.confidence ?? null,
  model_version: input.modelVersion ?? null,
  status: input.status,
  reason: input.reason ?? null,
  created_at: now,
  updated_at: now,
})

/** The row as it is read: an unknown intent or status is dropped rather than guessed at. */
export const proposalFromRow = (row: SkillProposalRow): StoredSkillProposal | undefined => {
  if (!isReflectionIntent(row.intent) || !isSkillProposalStatus(row.status)) return undefined
  return {
    id: row.id,
    episodeID: row.episode_id,
    ...(row.session_id ? { sessionID: row.session_id } : {}),
    projectID: row.project_id,
    ...(row.decision_id ? { decisionID: row.decision_id } : {}),
    intent: row.intent,
    ...(row.target_skill ? { targetSkill: row.target_skill } : {}),
    ...(row.name ? { name: row.name } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.body ? { body: row.body } : {}),
    ...(row.body_hash ? { bodyHash: row.body_hash } : {}),
    evidenceRefs: parseStringList(row.evidence_refs_json),
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    ...(row.model_version ? { modelVersion: row.model_version } : {}),
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
