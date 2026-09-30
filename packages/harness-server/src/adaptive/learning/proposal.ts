/**
 * The lint a drafted skill must pass before it is stored (FH-033).
 *
 * A draft can be structurally valid and still be something the harness must not turn into a skill:
 * it can carry a secret, try to widen permissions, paste a transcript, or collide with a skill a
 * person wrote. This module is the single, pure check — no store, no egress, no model — and its
 * answer is a typed rejection with a reason, so a rejected proposal is visible rather than silent.
 *
 * The rules encode the trust invariant of the phase: a learned skill is `self-authored` only and
 * never touches a human skill (a `patch` target must be one of ours, an `add` name must not collide
 * with one), and it never carries the things a skill should not have. `merge`/`drop` are declared but
 * rejected here: Phase 3b implements `add`/`patch` only (ADR-0020 §9).
 */

import type { ReflectionIntent } from "../decision"
import { isReflectionIntent } from "../decision"
import { NAME } from "../../skills"
import { redactText } from "../redaction"
import { DRAFT_LIMITS } from "./draft"
import type { DraftLimits } from "./draft"
import { CONTENT_RULES, filterSkillContent } from "./content-filter"

export type SkillProposal = {
  projectID: string
  episodeID: string
  decisionID?: string
  intent: ReflectionIntent
  /** The existing learned skill a `patch` targets, or the umbrella a `merge` names. */
  targetSkill?: string
  name: string
  description: string
  body: string
  evidenceRefs: string[]
  confidence?: number
  modelVersion?: string
  /**
   * The episode's evidence text, read only by the URL filter (AH-F04) and never stored. Absent means
   * there is nothing to check a link against, and the URL rule is skipped.
   */
  evidence?: readonly string[]
}

export type ProposalContext = {
  /** Existing learned skills, so a `patch` can only target one of ours. */
  learnedSkills?: readonly string[]
  /** Existing human skills, so a learned name never collides with a person's. */
  humanSkills?: readonly string[]
  limits?: Partial<DraftLimits>
}

export const PROPOSAL_REJECTIONS = [
  "invalid-intent",
  "unsupported-intent",
  "no-project",
  "missing-provenance",
  "missing-evidence",
  "invalid-name",
  "name-collision",
  "duplicate-skill",
  "not-self-authored",
  "merge-target-missing",
  "invalid-description",
  "description-trigger-missing",
  "invalid-body",
  "transcript-shaped",
  "contains-secrets",
  ...CONTENT_RULES,
] as const
export type ProposalRejection = (typeof PROPOSAL_REJECTIONS)[number]

export type ProposalValidation =
  | { ok: true; proposal: SkillProposal }
  | { ok: false; reason: ProposalRejection }

/**
 * The trigger must come early, or the description does not say when to load the skill. A short
 * window keeps "Use when…"/"When…" honest without pretending to understand longer prose.
 */
const TRIGGER_PATTERN = /^(?:use|when|before|after|for)\b/i
const TRIGGER_WINDOW = 48

/**
 * Validates one drafted proposal, returning the cleaned proposal or the first reason it fails.
 *
 * Pure and order-independent from the caller's point of view: a rejection carries no proposal, so
 * there is nothing for a writer to store. The order of the checks is deliberate — a deferred intent
 * is refused before its fields are read, and provenance before content.
 */
export function validateProposal(proposal: SkillProposal, context: ProposalContext = {}): ProposalValidation {
  const limits = { ...DRAFT_LIMITS, ...context.limits }
  const learned = new Set(context.learnedSkills ?? [])
  const human = new Set(context.humanSkills ?? [])
  const reject = (reason: ProposalRejection): ProposalValidation => ({ ok: false, reason })

  if (!isReflectionIntent(proposal.intent)) return reject("invalid-intent")
  if (proposal.intent === "drop") return reject("unsupported-intent")
  // `merge` must name a live umbrella even though 3b will not perform it; naming nothing is its own
  // reason, and naming a real one is still deferred to the merge phase.
  if (proposal.intent === "merge") {
    if (!proposal.targetSkill || !learned.has(proposal.targetSkill)) return reject("merge-target-missing")
    return reject("unsupported-intent")
  }

  if (!proposal.projectID?.trim()) return reject("no-project")
  if (!proposal.episodeID?.trim()) return reject("missing-provenance")
  if (
    !Array.isArray(proposal.evidenceRefs) ||
    proposal.evidenceRefs.length === 0 ||
    proposal.evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim())
  ) {
    return reject("missing-evidence")
  }

  const name = proposal.name?.trim() ?? ""
  if (!name || name.length > limits.maxNameChars || !NAME.test(name)) return reject("invalid-name")
  if (proposal.intent === "patch") {
    // Only a skill we wrote may be patched; a human skill is never touched.
    if (!proposal.targetSkill || !learned.has(proposal.targetSkill)) return reject("not-self-authored")
  } else {
    if (human.has(name)) return reject("name-collision")
    if (learned.has(name)) return reject("duplicate-skill")
  }

  const description = proposal.description?.trim() ?? ""
  if (!description || description.includes("\n") || description.length > limits.maxDescriptionChars) {
    return reject("invalid-description")
  }
  if (!TRIGGER_PATTERN.test(description.slice(0, TRIGGER_WINDOW))) return reject("description-trigger-missing")

  const body = proposal.body?.trim() ?? ""
  if (body.length < limits.minBodyChars || body.length > limits.maxBodyChars) return reject("invalid-body")
  if (body.split("\n").length > limits.maxBodyLines || body.split("\n").some((line) => /^(?:user|assistant|human|system)\s*:/i.test(line.trim()))) {
    return reject("transcript-shaped")
  }

  if ([name, description, body].some((text) => redactText(text) !== text)) return reject("contains-secrets")
  // Shapes that change harness behaviour rather than describe a task (AH-F04): never a learned skill.
  const content = filterSkillContent({
    texts: [description, body],
    ...(proposal.evidence ? { evidence: proposal.evidence } : {}),
  })
  if (content) return reject(content.rule)

  return { ok: true, proposal: { ...proposal, name, description, body } }
}
