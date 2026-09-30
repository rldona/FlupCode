/**
 * The human review of a staged skill proposal (AH-A04).
 *
 * A proposal is drafted from an episode's objective and evidence, and evidence can carry untrusted
 * tool output (a web page, a README, an issue). Installing it unreviewed would be a prompt injection
 * that persists into every later session of the project, so the manager only stages it and this is
 * the one door from `proposed` to the disk: a person approves, and the curator — the single writer —
 * installs through the store, which signs the provenance.
 *
 * Approval re-validates at approval time rather than trusting the lint of the draft: the roster may
 * have changed since (a human skill with the same name, another approval), and the row may have been
 * edited (`bodyHash`). Everything is synchronous from the read to the write, so two approvals of one
 * proposal in this process cannot interleave; the second sees `promoted` and is a no-op.
 */

import type { LearningRepository } from "../../types"
import type { PromoteRejection, SkillCurator } from "../skills/curator"
import { contentHashOf } from "../skills/learned-store"
import type { StoredSkillProposal } from "./proposal-record"

export type ProposalReviewResult =
  | { ok: true; proposal: StoredSkillProposal; changed: boolean }
  | { ok: false; status: 404 | 409; code: string; proposal?: StoredSkillProposal }

export type ProposalReview = {
  /** Installs a `proposed` proposal; a `promoted` one is a no-op, anything else a conflict. */
  approve(id: string): ProposalReviewResult
  /** Marks a `proposed` proposal `rejected` with `human-rejected`; a `rejected` one is a no-op. */
  reject(id: string): ProposalReviewResult
}

/** The reason a person's rejection is recorded with. */
export const HUMAN_REJECTED = "human-rejected"

/**
 * Refusals that say nothing about the proposal itself: learning is off, the project folder is not
 * there right now, or the disk failed. The proposal stays `proposed` so it can be approved later.
 */
const TRANSIENT: ReadonlySet<PromoteRejection> = new Set<PromoteRejection>(["disabled", "no-project", "write-failed"])

export function createProposalReview(deps: {
  repository: Pick<LearningRepository, "getProposal" | "createProposal">
  curator: Pick<SkillCurator, "promote">
  now?: () => number
}): ProposalReview {
  const now = deps.now ?? Date.now

  const refuse = (proposal: StoredSkillProposal, reason: string): ProposalReviewResult => ({
    ok: false,
    status: 409,
    code: reason,
    proposal: deps.repository.createProposal({ ...proposal, status: "rejected", reason }, now()),
  })

  const approve = (id: string): ProposalReviewResult => {
    const proposal = deps.repository.getProposal(id)
    if (!proposal) return { ok: false, status: 404, code: "not_found" }
    if (proposal.status === "promoted") return { ok: true, proposal, changed: false }
    if (proposal.status !== "proposed") return { ok: false, status: 409, code: "not-proposed", proposal }
    const body = proposal.body ?? ""
    // The person reviewed the stored text; a row whose body no longer matches its hash is not it.
    if (proposal.bodyHash && contentHashOf(body) !== proposal.bodyHash) return refuse(proposal, "body-hash-mismatch")
    const promoted = deps.curator.promote(
      {
        projectID: proposal.projectID,
        episodeID: proposal.episodeID,
        ...(proposal.decisionID ? { decisionID: proposal.decisionID } : {}),
        intent: proposal.intent,
        ...(proposal.targetSkill ? { targetSkill: proposal.targetSkill } : {}),
        name: proposal.name ?? "",
        description: proposal.description ?? "",
        body,
        evidenceRefs: proposal.evidenceRefs,
        ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}),
        ...(proposal.modelVersion ? { modelVersion: proposal.modelVersion } : {}),
      },
      now(),
    )
    if (!promoted.ok) {
      if (TRANSIENT.has(promoted.reason)) return { ok: false, status: 409, code: promoted.reason, proposal }
      // The roster or the row changed since the draft: the proposal can no longer be installed as is.
      return refuse(proposal, promoted.reason)
    }
    return {
      ok: true,
      proposal: deps.repository.createProposal({ ...proposal, status: "promoted" }, now()),
      changed: true,
    }
  }

  const reject = (id: string): ProposalReviewResult => {
    const proposal = deps.repository.getProposal(id)
    if (!proposal) return { ok: false, status: 404, code: "not_found" }
    if (proposal.status === "rejected") return { ok: true, proposal, changed: false }
    // An installed skill is withdrawn by archiving it, not by rewriting its proposal's history.
    if (proposal.status !== "proposed") return { ok: false, status: 409, code: "not-proposed", proposal }
    return {
      ok: true,
      proposal: deps.repository.createProposal({ ...proposal, status: "rejected", reason: HUMAN_REJECTED }, now()),
      changed: true,
    }
  }

  return { approve, reject }
}
