/**
 * The HTTP contract of the decision audit (FH-015).
 *
 * `api.ts` guards these routes with the artifacts bearer, and here they are only the shape of the
 * request and the answer. There is no route that decides: in this phase the shadow makes decisions,
 * and a client only lists them and asks why.
 */

import { decodedID } from "./route-id"
import { isDecisionKind } from "./decision"
import type { DecisionService } from "./decision-service"
import { normalizeEpisodeLimit } from "./episode"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

export async function handleDecisionRequest(
  request: Request,
  segments: string[],
  service: DecisionService,
): Promise<Response> {
  if (request.method !== "GET") return error("Not found", "not_found", 404)
  const id = decodedID(segments[1])
  if (segments[0] === "decisions" && id === undefined) {
    const params = new URL(request.url).searchParams
    const kind = params.get("kind")
    const acted = params.get("acted")
    const before = cursorFrom(params.get("before"))
    const rawLimit = params.get("limit")
    const limit = rawLimit === null ? undefined : normalizeEpisodeLimit(Number(rawLimit))
    // One row past the page says whether another page exists without a second COUNT query.
    const rows = service.decisions({
      ...(params.get("id") ? { id: params.get("id")! } : {}),
      ...(params.get("sessionID") ? { sessionID: params.get("sessionID")! } : {}),
      ...(params.get("episodeID") ? { episodeID: params.get("episodeID")! } : {}),
      ...(kind !== null && isDecisionKind(kind) ? { kind } : {}),
      ...(acted === "true" || acted === "false" ? { acted: acted === "true" } : {}),
      ...(before ? { before } : {}),
      ...(limit !== undefined ? { limit: limit + 1 } : {}),
    })
    const data = limit !== undefined ? rows.slice(0, limit) : rows
    const last = data.at(-1)
    return json({
      data,
      ...(limit !== undefined && rows.length > limit && last ? { nextCursor: `${last.createdAt},${last.id}` } : {}),
    })
  }
  if (segments[0] === "decisions" && id !== undefined) {
    const explanation = service.explain(id)
    if (!explanation) return error("Not found", "not_found", 404)
    return json({ data: explanation })
  }
  return error("Not found", "not_found", 404)
}

/**
 * `before=<createdAt>,<id>` as the keyset the repository pages from (AH-E05). The id can itself hold
 * commas, so only the first one splits; a cursor that does not parse is no cursor, not an error.
 */
function cursorFrom(value: string | null) {
  if (!value) return undefined
  const comma = value.indexOf(",")
  if (comma <= 0 || comma === value.length - 1) return undefined
  const createdAt = Number(value.slice(0, comma))
  if (!Number.isSafeInteger(createdAt)) return undefined
  return { createdAt, id: value.slice(comma + 1) }
}
