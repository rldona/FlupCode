/**
 * The HTTP contract of the acting relevance line (FH-04, ADR-0021 §1).
 *
 * `api.ts` guards this route with the artifacts bearer, and here it is only the shape of the request
 * and the answer. The service is the one policy point: this handler validates that the four fields
 * are strings and hands them over; whether the line acts is decided behind it.
 *
 * The project is validated here, before the service is reached: the curator walks `projectID` for
 * skills, so an unchecked value lets a caller point the scan anywhere it can name. Absolute and an
 * existing directory, or nothing — the same rule `learning-routes.ts` applies. `skills` is dropped
 * from the answer too: the plugin reads only `line`, and the list of names is an enumeration surface
 * the caller does not need.
 */

import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { RelevanceResult, RelevanceService } from "./relevance"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readBody = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  try {
    const parsed: unknown = await request.json()
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const nonEmptyString = (body: Record<string, unknown>, key: string): string | undefined => {
  const value = body[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Engine-shaped ids are short; the cap keeps a caller from handing the caches an unbounded key. */
const ID_LIMIT = 200
/** The plugin already bounds the objective to 500; the route refuses anything wider. */
const OBJECTIVE_LIMIT = 500

/**
 * The project a relevance turn may scan: an absolute, normalised, existing real directory, or
 * nothing. A relative or missing path is refused rather than handed to the curator.
 */
function usableProject(projectID: string): string | undefined {
  if (!isAbsolute(projectID)) return undefined
  const path = resolve(projectID)
  try {
    return statSync(path).isDirectory() ? path : undefined
  } catch {
    return undefined
  }
}

/** The wire answer: everything the caller may see, without the skill-name list. */
const wireResult = (result: RelevanceResult): Omit<RelevanceResult, "skills"> => ({
  line: result.line,
  decisionID: result.decisionID,
  source: result.source,
  degraded: result.degraded,
  reason: result.reason,
  latencyMs: result.latencyMs,
})

export async function handleRelevanceRequest(request: Request, relevance: RelevanceService): Promise<Response> {
  if (request.method !== "POST") return error("Not found", "not_found", 404)
  const body = await readBody(request)
  if (!body) return error("A relevance request needs a JSON body", "bad_request", 400)
  const projectID = nonEmptyString(body, "projectID")
  const sessionID = nonEmptyString(body, "sessionID")
  const messageID = nonEmptyString(body, "messageID")
  // The objective may be blank: the service treats it as no match rather than refusing the call.
  const objective = typeof body.objective === "string" ? body.objective : undefined
  if (projectID === undefined || sessionID === undefined || messageID === undefined || objective === undefined) {
    return error("A relevance request needs projectID, sessionID, messageID and objective", "bad_request", 400)
  }
  if (projectID.length > ID_LIMIT || sessionID.length > ID_LIMIT || messageID.length > ID_LIMIT) {
    return error("A relevance request carries an id past its limit", "bad_request", 400)
  }
  if (objective.length > OBJECTIVE_LIMIT) {
    return error("A relevance objective is past its limit", "bad_request", 400)
  }
  const project = usableProject(projectID)
  if (project === undefined) return error("The relevance project is not an existing directory", "bad_request", 400)
  const result = await relevance.suggest({ projectID: project, sessionID, messageID, objective })
  return json({ data: wireResult(result) })
}
