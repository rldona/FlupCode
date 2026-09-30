/**
 * The HTTP contract of the predictive model's key (ADR-0017, amended 2026-09-30).
 *
 * `api.ts` guards it with the settings writer's bearer. A key goes in and never comes back out:
 * every answer is `{ source, storable }`. Saving and removing change what leaves the machine, so
 * both need `confirm: true`, like the settings writer's sensitive switches.
 */

import { MAX_CREDENTIAL_SECRET_BYTES } from "../credential-routes"
import { ModelKeyError } from "./model-key"
import type { ModelKey } from "./model-key"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readBody = async (request: Request): Promise<Record<string, unknown>> => {
  const value: unknown = await request.json().catch(() => undefined)
  return isPlainObject(value) ? value : {}
}

export async function handleModelKeyRequest(request: Request, key: ModelKey): Promise<Response> {
  if (request.method === "GET") return json({ data: key.status() })
  if (request.method !== "PUT" && request.method !== "DELETE") return error("Not found", "not_found", 404)

  const body = await readBody(request)
  if (body.confirm !== true) return error("This change needs confirmation", "confirmation-required", 422)
  if (request.method === "DELETE") return json({ data: key.remove() })

  const secret = typeof body.key === "string" ? body.key.trim() : ""
  if (secret === "" || Buffer.byteLength(secret, "utf8") > MAX_CREDENTIAL_SECRET_BYTES)
    return error("A non-empty key of at most 8 KiB is required", "invalid-key", 422)
  return Promise.resolve()
    .then(() => json({ data: key.set(secret) }))
    .catch((cause: unknown) => {
      if (cause instanceof ModelKeyError) return error(cause.message, cause.code, cause.status)
      throw cause
    })
}
