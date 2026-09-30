/**
 * The HTTP contract of the learning audit (FH-034).
 *
 * `api.ts` guards these routes with the artifacts bearer, and here they are only the shape of the
 * request and the answer. There is no route that reflects: the manager does that off the episode
 * boundary and only stages what it drafted. The one write is the human review (AH-A04): `approve`
 * installs a staged proposal through the curator and `reject` closes it; `api.ts` requires the bearer
 * for both, and approval also requires `confirm: true` in the body.
 */

import { decodedID } from "./route-id"
import type { LearningRepository } from "../types"
import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { SkillRosterEntry } from "./skills/curator"
import { isSkillProposalStatus } from "./learning/proposal-record"
import { normalizeEpisodeLimit } from "./episode"
import type { ProposalReview } from "./learning/review"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

/**
 * The project a learned-skills read may scan: an absolute, normalised, existing real directory, or
 * nothing.
 *
 * The route reads a filesystem path from the query and the curator walks it for skills, so an
 * unvalidated `projectID` let a caller point the scan anywhere it could name (or nowhere, which is
 * still a read). A relative or missing path is refused; the list is empty and a detail is a 404
 * rather than a scan of an arbitrary route.
 */
function usableProject(projectID: string | null): string | undefined {
  if (!projectID || !isAbsolute(projectID)) return undefined
  const path = resolve(projectID)
  try {
    return statSync(path).isDirectory() ? path : undefined
  } catch {
    return undefined
  }
}

/** What a proposals route reads: the repository's own proposal methods. */
export type ProposalReader = Pick<LearningRepository, "listProposals" | "getProposal">

/** What a learned-skills route reads: the curator's roster, with each entry's sidecar state. */
export type LearnedSkillReader = { roster(projectID: string): SkillRosterEntry[] }

export async function handleProposalRequest(
  request: Request,
  segments: string[],
  reader: ProposalReader,
): Promise<Response> {
  if (request.method !== "GET") return error("Not found", "not_found", 404)
  const id = segments[1]
  if (segments[0] === "proposals" && id === undefined) {
    const params = new URL(request.url).searchParams
    const status = params.get("status")
    const rawLimit = params.get("limit")
    const limit = rawLimit === null ? undefined : normalizeEpisodeLimit(Number(rawLimit))
    return json({
      data: reader.listProposals({
        ...(params.get("episodeID") ? { episodeID: params.get("episodeID")! } : {}),
        ...(params.get("projectID") ? { projectID: params.get("projectID")! } : {}),
        ...(status !== null && isSkillProposalStatus(status) ? { status } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    })
  }
  if (segments[0] === "proposals" && id !== undefined) {
    const proposal = reader.getProposal(decodedID(id) ?? "")
    if (!proposal) return error("Not found", "not_found", 404)
    return json({ data: proposal })
  }
  return error("Not found", "not_found", 404)
}

/**
 * `POST /harness/adaptive/proposals/:id/approve` and `/reject`. Approval changes what the engine loads
 * in every later session, so it needs an explicit `confirm: true` like a widening config write.
 */
export async function handleProposalReviewRequest(
  request: Request,
  segments: string[],
  review: ProposalReview,
): Promise<Response> {
  const action = segments[2]
  if (request.method !== "POST" || segments.length !== 3 || (action !== "approve" && action !== "reject"))
    return error("Not found", "not_found", 404)
  if (action === "approve") {
    const body: unknown = await request.json().catch(() => undefined)
    const confirmed = typeof body === "object" && body !== null && "confirm" in body && body.confirm === true
    if (!confirmed) return error("Installing a learned skill needs confirmation", "confirmation-required", 422)
  }
  const id = decodedID(segments[1]) ?? ""
  const result = action === "approve" ? review.approve(id) : review.reject(id)
  if (!result.ok)
    return json(
      { error: `The proposal cannot be reviewed: ${result.code}`, code: result.code, ...(result.proposal ? { data: result.proposal } : {}) },
      result.status,
    )
  return json({ data: result.proposal, changed: result.changed })
}

export async function handleLearnedSkillRequest(
  request: Request,
  segments: string[],
  reader: LearnedSkillReader,
): Promise<Response> {
  if (request.method !== "GET") return error("Not found", "not_found", 404)
  const projectID = usableProject(new URL(request.url).searchParams.get("projectID"))
  const learned = (projectID ? reader.roster(projectID) : []).filter((entry) => entry.learned)
  const id = segments[1]
  if (segments[0] === "learned-skills" && id === undefined) return json({ data: learned })
  if (segments[0] === "learned-skills" && id !== undefined) {
    const entry = learned.find((candidate) => candidate.name === id)
    if (!entry) return error("Not found", "not_found", 404)
    return json({ data: entry })
  }
  return error("Not found", "not_found", 404)
}
