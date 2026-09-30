/**
 * The HTTP contract of the context plan audit (FH-022).
 *
 * `api.ts` guards these routes with the artifacts bearer, and here they are only the shape of the
 * request and the answer. There is no route that plans: the shadow and, later, the runner make
 * plans; a client only lists them and asks why one turned out the way it did.
 */

import { decodedID } from "./route-id"
import type { ContextManager } from "./context-manager"
import { normalizeEpisodeLimit } from "./episode"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

export async function handleContextPlanRequest(
  request: Request,
  segments: string[],
  context: ContextManager,
): Promise<Response> {
  if (request.method !== "GET") return error("Not found", "not_found", 404)
  const id = decodedID(segments[1])
  if (segments[0] === "plans" && id === undefined) {
    const params = new URL(request.url).searchParams
    const rawLimit = params.get("limit")
    const limit = rawLimit === null ? undefined : normalizeEpisodeLimit(Number(rawLimit))
    return json({
      data: context.listPlans({
        ...(params.get("runID") ? { runID: params.get("runID")! } : {}),
        ...(params.get("taskID") ? { taskID: params.get("taskID")! } : {}),
        ...(params.get("episodeID") ? { episodeID: params.get("episodeID")! } : {}),
        ...(params.get("sessionID") ? { sessionID: params.get("sessionID")! } : {}),
        ...(params.get("projectID") ? { projectID: params.get("projectID")! } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    })
  }
  if (segments[0] === "plans" && id !== undefined) {
    const explanation = context.explainPlan(id)
    if (!explanation) return error("Not found", "not_found", 404)
    return json({ data: explanation })
  }
  return error("Not found", "not_found", 404)
}
