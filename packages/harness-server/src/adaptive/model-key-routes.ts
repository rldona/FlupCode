/**
 * The HTTP contract of the predictive models' keys (ADR-0017, amended 2026-09-30; per provider since PI-01).
 *
 * `api.ts` guards it with the settings writer's bearer. A key goes in and never comes back out:
 * every answer is `{ source, storable, env }`. Saving and removing change what leaves the machine, so
 * both need `confirm: true`, like the settings writer's sensitive switches. The provider is named by
 * `?provider=<id>` on a read and by `provider` in the body of a write; a caller that names none (an
 * older panel) means the only provider that needs a key, when there is exactly one.
 */

import { MAX_CREDENTIAL_SECRET_BYTES } from "../credential-routes"
import { ModelKeyError } from "./model-key"
import type { KeySlot, ModelKeys } from "./model-key"

/** The keys and, by provider id, the slot of every registered provider that needs one. */
export type ProviderKeys = { keys: ModelKeys; slots: () => Record<string, KeySlot> }

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readBody = async (request: Request): Promise<Record<string, unknown>> => {
  const value: unknown = await request.json().catch(() => undefined)
  return isPlainObject(value) ? value : {}
}

export async function handleModelKeyRequest(request: Request, input: ProviderKeys): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE")
    return error("Not found", "not_found", 404)
  const body = request.method === "GET" ? {} : await readBody(request)
  const named = request.method === "GET" ? new URL(request.url).searchParams.get("provider") : body.provider
  const slot = slotFor(input.slots(), named)
  if (!slot) return error("No provider that needs a key has this id", "unknown-provider", 404)
  if (request.method === "GET") return json({ data: input.keys.status(slot) })

  if (body.confirm !== true) return error("This change needs confirmation", "confirmation-required", 422)
  if (request.method === "DELETE") return json({ data: input.keys.remove(slot) })

  const secret = typeof body.key === "string" ? body.key.trim() : ""
  if (secret === "" || Buffer.byteLength(secret, "utf8") > MAX_CREDENTIAL_SECRET_BYTES)
    return error("A non-empty key of at most 8 KiB is required", "invalid-key", 422)
  return Promise.resolve()
    .then(() => json({ data: input.keys.set(slot, secret) }))
    .catch((cause: unknown) => {
      if (cause instanceof ModelKeyError) return error(cause.message, cause.code, cause.status)
      throw cause
    })
}

/** The named provider's slot, or the only one when none is named. */
function slotFor(slots: Record<string, KeySlot>, named: unknown): KeySlot | undefined {
  if (typeof named === "string" && named !== "") return Object.hasOwn(slots, named) ? slots[named] : undefined
  const all = Object.values(slots)
  return all.length === 1 ? all[0] : undefined
}
