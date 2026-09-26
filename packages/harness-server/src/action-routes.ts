/**
 * The HTTP contract of the action runner (WA-2).
 *
 * `api.ts` guards these routes with the same loopback bearer token the browser runtime uses, and
 * here they are only the shape of the request and the shape of the answer.
 */

import { toActionErrorBody, ActionRunError } from "./action-runner"
import type { ActionRunner, ActionRunRequest } from "./action-runner"
import { validateActionProfile } from "./actions"
import { BrowserError } from "./browser"
import { NavigationBlockedError } from "./browser-egress"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

const bodyFrom = async (request: Request): Promise<Record<string, unknown>> => {
  const value: unknown = await request.json().catch(() => undefined)
  return isPlainObject(value) ? value : {}
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export async function handleActionRequest(
  request: Request,
  segments: string[],
  actions: ActionRunner,
): Promise<Response> {
  try {
    return await dispatch(request, segments, actions)
  } catch (cause) {
    return failure(cause)
  }
}

const dispatch = async (request: Request, segments: string[], actions: ActionRunner): Promise<Response> => {
  const route = segments[0]
  if (route === undefined && request.method === "GET") {
    // No query is the plugin's own catalog: the global config alone. A folder makes it scope-aware,
    // which is what the editor lists so a project profile appears beside the global ones (WA-8).
    const params = new URL(request.url).searchParams
    return json({
      data: actions.list({
        ...(params.get("directory") ? { directory: params.get("directory")! } : {}),
        ...(params.get("project") ? { project: params.get("project")! } : {}),
      }),
    })
  }
  // The editor's inline check (WA-8): the schema alone, before a profile is saved. It reports what is
  // wrong with the draft, which the write itself would refuse with a 422 anyway.
  if (route === "validate" && request.method === "POST") {
    const body = await bodyFrom(request)
    const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : "action"
    const result = validateActionProfile(id, body.profile)
    return result.ok ? json({ data: { ok: true, profile: result.profile } }) : json({ error: result.message, code: result.code }, 422)
  }
  if (route !== "run" || request.method !== "POST") return error("Not found", "not_found", 404)

  const body = await bodyFrom(request)
  const sessionID = typeof body.sessionID === "string" ? body.sessionID : ""
  if (!sessionID) return error("A session is required", "invalid_request", 400)
  const project = typeof body.project === "string" ? body.project : ""
  if (!project) return error("A project is required", "invalid_request", 400)

  const run: ActionRunRequest = {
    inputs: isPlainObject(body.inputs) ? body.inputs : {},
    sessionID,
    project,
    ...(typeof body.action === "string" && body.action !== "" ? { action: body.action } : {}),
    ...(typeof body.directory === "string" && body.directory !== "" ? { directory: body.directory } : {}),
    ...(body.profile !== undefined ? { profile: body.profile } : {}),
    ...(body.headed === true ? { headed: true } : {}),
    ...(body.dryRun === true ? { dryRun: true } : {}),
    ...(body.preview === true ? { preview: true } : {}),
  }
  return json({ data: await actions.run(run) })
}

const failure = (cause: unknown): Response => {
  if (cause instanceof ActionRunError) return json(toActionErrorBody(cause), cause.status)
  if (cause instanceof NavigationBlockedError)
    return json({ error: cause.reason, code: "navigation_blocked", evidence: [] }, 403)
  if (cause instanceof BrowserError)
    return json({ error: cause.message, code: cause.code, evidence: [] }, cause.status)
  return json({ error: cause instanceof Error ? cause.message : String(cause), code: "internal_error", evidence: [] }, 500)
}
