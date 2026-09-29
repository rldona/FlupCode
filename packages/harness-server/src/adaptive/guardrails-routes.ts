/**
 * The HTTP contract of the failure/loop guardrails (FH-060–063, ADR-0023 §2).
 *
 * `api.ts` guards this route with the dedicated `adaptive-token` bearer, the same as the relevance
 * route, and here it is only the shape of the request and the answer: it validates that the ids are
 * strings, that the project is an existing directory and that the observation is a well-formed opaque
 * digest, then hands it to the service. Whether the guardrail acts is decided behind the service.
 *
 * No raw argument, message or tool output has a field here: the wire carries a tool name and a
 * `sha256` digest, nothing else.
 */

import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { LoopObservation } from "./guardrails-detector"
import type { GuardrailService } from "./guardrails"

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

/** Engine-shaped ids and tool names are short; the caps keep a caller from handing the caches a key. */
const ID_LIMIT = 200
const TOOL_LIMIT = 200
/** A `sha256` hex digest is exactly 64 lowercase hex chars; anything else is not a digest we produced. */
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

/** The project a guardrail may name: an absolute, normalised, existing real directory, or nothing. */
function usableProject(projectID: string): string | undefined {
  if (!isAbsolute(projectID)) return undefined
  const path = resolve(projectID)
  try {
    return statSync(path).isDirectory() ? path : undefined
  } catch {
    return undefined
  }
}

/** Reads the opaque observation: a tool name and exactly one digest, never content. */
function observationFrom(value: unknown): LoopObservation | undefined {
  if (!isPlainObject(value)) return undefined
  const tool = nonEmptyString(value, "tool")
  if (tool === undefined || tool.length > TOOL_LIMIT) return undefined
  const callID =
    typeof value.callID === "string" && value.callID.length > 0 && value.callID.length <= ID_LIMIT
      ? value.callID
      : undefined
  if (value.kind === "call") {
    const argsDigest = nonEmptyString(value, "argsDigest")
    if (argsDigest === undefined || !DIGEST_PATTERN.test(argsDigest)) return undefined
    return { kind: "call", tool, argsDigest, ...(callID ? { callID } : {}) }
  }
  if (value.kind === "error") {
    const errorDigest = nonEmptyString(value, "errorDigest")
    if (errorDigest === undefined || !DIGEST_PATTERN.test(errorDigest)) return undefined
    return { kind: "error", tool, errorDigest, ...(callID ? { callID } : {}) }
  }
  return undefined
}

export async function handleGuardrailsRequest(request: Request, guardrails: GuardrailService): Promise<Response> {
  if (request.method !== "POST") return error("Not found", "not_found", 404)
  const body = await readBody(request)
  if (!body) return error("A guardrails request needs a JSON body", "bad_request", 400)
  const projectID = nonEmptyString(body, "projectID")
  const sessionID = nonEmptyString(body, "sessionID")
  if (projectID === undefined || sessionID === undefined) {
    return error("A guardrails request needs projectID and sessionID", "bad_request", 400)
  }
  if (projectID.length > ID_LIMIT || sessionID.length > ID_LIMIT) {
    return error("A guardrails request carries an id past its limit", "bad_request", 400)
  }
  const observation = observationFrom(body.observation)
  if (observation === undefined) {
    return error("A guardrails request needs a well-formed call or error observation", "bad_request", 400)
  }
  const project = usableProject(projectID)
  if (project === undefined) return error("The guardrails project is not an existing directory", "bad_request", 400)
  const result = await guardrails.observe({ projectID: project, sessionID, observation })
  return json({ data: result })
}

/**
 * The read-only advisory a browser reads (FH-062): it only names the session, so the session id is
 * the only thing to validate. `null` is a valid answer — no loop is crossing the threshold right
 * now — and is not an error.
 */
export function handleGuardrailsStatusRequest(request: Request, guardrails: GuardrailService): Response {
  if (request.method !== "GET") return error("Not found", "not_found", 404)
  const sessionID = new URL(request.url).searchParams.get("sessionID")
  if (sessionID === null || sessionID.length === 0) {
    return error("A guardrails status request needs a sessionID", "bad_request", 400)
  }
  if (sessionID.length > ID_LIMIT) return error("A guardrails status request carries an id past its limit", "bad_request", 400)
  return json({ data: guardrails.status(sessionID) })
}
