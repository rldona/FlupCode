/**
 * The HTTP contract of the learning audit (FH-034).
 *
 * `api.ts` guards these routes with the artifacts bearer, and here they are only the shape of the
 * request and the answer. There is no route that reflects: the manager does that off the episode
 * boundary and only stages what it drafted. The one write is the human review (AH-A04): `approve`
 * installs a staged proposal through the curator and `reject` closes it; `api.ts` requires the bearer
 * for both, and approval also requires `confirm: true` in the body. A person can then disable, enable
 * or archive an installed skill (AH-E04), under the same bearer and always with `confirm: true`.
 */

import { decodedID } from "./route-id"
import type { LearningRepository } from "../types"
import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { SkillCurator } from "./skills/curator"
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

/**
 * What a learned-skills route reads: the curator's roster with each entry's sidecar state, the skills
 * a person disabled, where each file is and, for one skill, its text.
 */
export type LearnedSkillReader = Pick<SkillCurator, "roster" | "disabledRoster" | "skillPath" | "show">

/** What the learned-skill actions write through (AH-E04): the curator, the single writer. */
export type LearnedSkillActions = Pick<SkillCurator, "disable" | "enable" | "retire">

const LEARNED_ACTIONS = ["disable", "enable", "archive"] as const
type LearnedAction = (typeof LEARNED_ACTIONS)[number]
const isLearnedAction = (value: string | undefined): value is LearnedAction =>
  LEARNED_ACTIONS.some((action) => action === value)

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
  const skills = projectID ? listed(reader, projectID) : []
  const id = segments[1]
  if (segments[0] === "learned-skills" && id === undefined) return json({ data: skills })
  if (segments[0] === "learned-skills" && id !== undefined && projectID) {
    const entry = skills.find((candidate) => candidate.name === id)
    const text = entry ? reader.show(projectID, entry.name, entry.disabled ? "disabled" : "learned") : undefined
    if (!entry) return error("Not found", "not_found", 404)
    return json({ data: { ...entry, ...(text ? { body: text.body } : {}) } })
  }
  return error("Not found", "not_found", 404)
}

/**
 * `POST /harness/adaptive/learned-skills/:name/disable|enable|archive` with `{ projectID, confirm: true }`.
 *
 * Each one changes what the engine loads in every later session of the project, so like approving a
 * proposal it needs an explicit confirmation. Disabling a disabled skill, or enabling an enabled one,
 * is a `200` no-op (`changed: false`); a skill in neither place is a `404`; a refusal of the store (a
 * human skill took the name, the archive already holds one, the provenance does not verify) is a
 * `409` with its reason as `code`.
 */
export async function handleLearnedSkillAction(
  request: Request,
  segments: string[],
  reader: LearnedSkillReader,
  actions: LearnedSkillActions,
): Promise<Response> {
  const action = segments[2]
  if (request.method !== "POST" || segments.length !== 3 || !isLearnedAction(action))
    return error("Not found", "not_found", 404)
  const body: unknown = await request.json().catch(() => undefined)
  const fields = typeof body === "object" && body !== null ? body : {}
  if (!("confirm" in fields) || fields.confirm !== true)
    return error("Changing a learned skill needs confirmation", "confirmation-required", 422)
  const projectID = usableProject("projectID" in fields && typeof fields.projectID === "string" ? fields.projectID : null)
  const name = decodedID(segments[1]) ?? ""
  const entry = projectID ? listed(reader, projectID).find((candidate) => candidate.name === name) : undefined
  if (!projectID || !entry) return error("Not found", "not_found", 404)
  if ((action === "disable" && entry.disabled) || (action === "enable" && !entry.disabled))
    return json({ data: { name, status: entry.disabled ? "disabled" : "learned" }, changed: false })
  const result =
    action === "disable"
      ? actions.disable(projectID, name)
      : action === "enable"
        ? actions.enable(projectID, name)
        : actions.retire(projectID, name)
  if (!result.ok)
    return error(`The learned skill cannot be changed: ${result.reason}`, result.reason, result.reason === "not-found" ? 404 : 409)
  const status = action === "archive" ? "archived" : action === "disable" ? "disabled" : "learned"
  return json({ data: { name, status }, changed: true })
}

/** The learned skills the engine loads, then the ones a person disabled, each with its file. */
function listed(reader: LearnedSkillReader, projectID: string) {
  return [
    ...reader
      .roster(projectID)
      .filter((entry) => entry.learned)
      .map((entry) => ({ ...entry, disabled: false, path: reader.skillPath(projectID, entry.name, "learned") })),
    ...reader
      .disabledRoster(projectID)
      .map((entry) => ({ ...entry, disabled: true, path: reader.skillPath(projectID, entry.name, "disabled") })),
  ]
}
