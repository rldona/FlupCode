/**
 * The HTTP contract of the credential vault (WA-5).
 *
 * `api.ts` guards these routes with the same loopback bearer token the browser and the runner use.
 * A secret goes in and never comes back out: every answer carries names, origins and times only.
 */

import { normalizeActionOrigin } from "./actions"
import { CREDENTIAL_NAME } from "./vault"
import type { CredentialVault } from "./vault"

/** An 8 KiB ceiling on a secret: enough for a token or a password, not a file passed by mistake. */
export const MAX_CREDENTIAL_SECRET_BYTES = 8 * 1024

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

export async function handleCredentialRequest(
  request: Request,
  segments: string[],
  vault: CredentialVault,
): Promise<Response> {
  const route = segments[0]
  if (request.method === "GET" && route === undefined) return json({ data: vault.list() })
  if (request.method === "POST" && route === undefined) return create(request, vault)
  if (request.method === "DELETE" && route !== undefined && segments.length === 1)
    return vault.remove(route) ? json({ data: { removed: true } }) : error("Not found", "not_found", 404)
  return error("Not found", "not_found", 404)
}

const create = async (request: Request, vault: CredentialVault): Promise<Response> => {
  const body = await bodyFrom(request)
  if (Object.keys(body).length === 0) return error("A name, an origin and a secret are required", "invalid_request", 400)

  const { name } = body
  if (typeof name !== "string" || !CREDENTIAL_NAME.test(name))
    return error("A credential name must match ^[A-Za-z0-9_-]{1,64}$", "invalid_name", 400)

  const origin = normalizeActionOrigin(body.origin)
  if (!origin.ok) return error(origin.message, "invalid_origin", 400)

  const { secret } = body
  if (typeof secret !== "string" || secret === "" || Buffer.byteLength(secret, "utf8") > MAX_CREDENTIAL_SECRET_BYTES)
    return error("A non-empty secret of at most 8 KiB is required", "invalid_secret", 400)

  // The secret never appears in this answer, and neither does anything derived from it.
  return json({ data: vault.set({ name, origin: origin.origin, secret }) }, 201)
}