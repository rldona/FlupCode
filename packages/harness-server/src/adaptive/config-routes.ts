/**
 * The HTTP contract of the adaptive settings surface (FH-070).
 *
 * `api.ts` decides the bearer — the artifacts token for `GET` when one is configured, and the same
 * bearer obligatorily for `PATCH` — and here there is only the shape of the request and the answer.
 * The handler validates an object and delegates; the allowlist, the guards and the file choice all
 * live in `config-surface.ts`, so a shape change here cannot widen what is written.
 */

import { AdaptiveConfigError } from "./config-surface"
import type { AdaptiveConfigSurface } from "./config-surface"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readBody = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  const value: unknown = await request.json().catch(() => undefined)
  if (value === undefined) return undefined
  return isPlainObject(value) ? value : undefined
}

export async function handleAdaptiveConfigRequest(request: Request, surface: AdaptiveConfigSurface): Promise<Response> {
  if (request.method === "GET") return json({ data: surface.read() })

  if (request.method === "PATCH") {
    const body = await readBody(request)
    if (body === undefined) return error("A config patch needs a JSON body", "bad_request", 400)
    if (!isPlainObject(body.patch)) return error("A config patch needs a patch object", "invalid-value", 422)
    const result = await surface
      .update(body.patch, body.confirm === true)
      .catch((cause: unknown) => failure(cause))
    if (result instanceof Response) return result
    return json({ data: result.view, warnings: result.warnings })
  }

  return error("Not found", "not_found", 404)
}

const failure = (cause: unknown): Response => {
  if (cause instanceof AdaptiveConfigError)
    return json(
      {
        error: cause.message,
        code: cause.code,
        ...(cause.fields ? { fields: cause.fields } : {}),
        ...(cause.missing ? { missing: cause.missing } : {}),
      },
      cause.status,
    )
  return error(cause instanceof Error ? cause.message : String(cause), "internal_error", 500)
}
