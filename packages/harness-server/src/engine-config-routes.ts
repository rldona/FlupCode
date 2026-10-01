/**
 * The HTTP contract of the engine config writer (V2-24).
 *
 * `GET /harness/engine-config?scope=global|project&directory=` reads one scope's file and
 * `PATCH /harness/engine-config` with `{scope, directory?, patch}` merges into it. `api.ts` guards
 * both with the writer bearer; the file is always derived by `engine-config.ts`, never taken from
 * the request.
 */

import { ConfigWriteError } from "./config-write"
import { patchEngineConfig, readEngineConfig, type EngineConfigScope } from "./engine-config"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

export async function handleEngineConfigRequest(request: Request): Promise<Response> {
  try {
    if (request.method === "GET") {
      const params = new URL(request.url).searchParams
      return json({
        data: readEngineConfig({ scope: scopeFrom(params.get("scope")), ...folder(params.get("directory")) }),
      })
    }
    if (request.method === "PATCH") {
      const body: unknown = await request.json().catch(() => undefined)
      if (!isRecord(body) || !isRecord(body.patch)) return error("A patch object is required", "invalid_request", 400)
      return json({
        data: await patchEngineConfig({ scope: scopeFrom(body.scope), patch: body.patch, ...folder(body.directory) }),
      })
    }
    return error("Not found", "not_found", 404)
  } catch (cause) {
    if (cause instanceof ConfigWriteError) return error(cause.message, cause.code, cause.status)
    return error(cause instanceof Error ? cause.message : String(cause), "internal_error", 500)
  }
}

const scopeFrom = (value: unknown): EngineConfigScope => (value === "project" ? "project" : "global")

const folder = (value: unknown) => (typeof value === "string" && value ? { directory: value } : {})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
