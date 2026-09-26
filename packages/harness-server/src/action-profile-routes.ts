/**
 * The HTTP contract of the action config writer (WA-8).
 *
 * `api.ts` guards these routes with the same loopback bearer the action runner uses, and here they
 * are only the shape of the request and the shape of the answer. The file a write lands in is always
 * derived by `action-config.ts`, never taken from the request.
 */

import {
  ActionConfigError,
  listActionProfiles,
  removeActionProfile,
  writeActionProfile,
} from "./action-config"
import type { ActionProfileScope } from "./config-files"

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

const scopeFrom = (value: unknown): ActionProfileScope => (value === "project" ? "project" : "global")

export async function handleActionProfileRequest(request: Request, segments: string[]): Promise<Response> {
  try {
    return await dispatch(request, segments)
  } catch (cause) {
    return failure(cause)
  }
}

const dispatch = async (request: Request, segments: string[]): Promise<Response> => {
  const params = new URL(request.url).searchParams
  const id = segments[0]

  if (id === undefined && request.method === "GET") {
    return json({
      data: listActionProfiles({
        ...(params.get("directory") ? { directory: params.get("directory")! } : {}),
        ...(params.get("project") ? { project: params.get("project")! } : {}),
      }),
    })
  }

  if (id === undefined || id === "") return error("Not found", "not_found", 404)

  if (request.method === "PUT") {
    const body = await bodyFrom(request)
    const written = await writeActionProfile({
      scope: scopeFrom(body.scope),
      profile: body.profile,
      id,
      ...(typeof body.directory === "string" && body.directory ? { directory: body.directory } : {}),
      ...(typeof body.project === "string" && body.project ? { project: body.project } : {}),
    })
    return json({ data: written }, 201)
  }

  if (request.method === "DELETE") {
    const removed = await removeActionProfile({
      id,
      scope: scopeFrom(params.get("scope")),
      ...(params.get("directory") ? { directory: params.get("directory")! } : {}),
      ...(params.get("project") ? { project: params.get("project")! } : {}),
    })
    return removed ? json({ data: removed }) : error(`No action profile "${id}"`, "not_found", 404)
  }

  return error("Not found", "not_found", 404)
}

const failure = (cause: unknown): Response => {
  if (cause instanceof ActionConfigError) return error(cause.message, cause.code, cause.status)
  return error(cause instanceof Error ? cause.message : String(cause), "internal_error", 500)
}
