/**
 * The HTTP contract of the recipe runner's browser (WA-1).
 *
 * Internal routes, not model tools: `api.ts` guards them with the loopback bearer token before they
 * are reached, and here they are only the shape of the request and the shape of the answer. A page
 * is driven only by an approved action: there is no route to navigate, click, type, submit or read
 * one directly (TI-09), nor to wait on or capture one outside an action, so every action on a page
 * is a `BrowserPolicy` decision (BU-01). What is left is the person's own control of a browser an
 * action opened: its live frame, picking an element for the editor, pausing, taking over, stopping.
 */

import { parseViewport, readSessionID } from "./browser"
import type { RecipeDriver } from "./browser"
import type { BrowserAttach } from "./browser-attach"
import { BrowserError } from "./browser-driver"
import { NavigationBlockedError } from "./browser-egress"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

const bodyFrom = async (request: Request): Promise<Record<string, unknown>> => {
  const value = await request.json().catch(() => undefined)
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export async function handleBrowserRequest(
  request: Request,
  segments: string[],
  browser: RecipeDriver,
  attach?: BrowserAttach,
): Promise<Response> {
  try {
    return await dispatch(request, segments, browser, attach)
  } catch (cause) {
    return failure(cause)
  }
}

const dispatch = async (
  request: Request,
  segments: string[],
  browser: RecipeDriver,
  attach: BrowserAttach | undefined,
): Promise<Response> => {
  const id = readSessionID(request.headers.get("x-flupcode-session") ?? undefined)
  const route = segments[0]
  const method = request.method

  if (route === "start" && method === "POST") {
    const body = await bodyFrom(request)
    return json(
      {
        data: await browser.open({
          id,
          project: typeof body.project === "string" ? body.project : "",
          ...(body.headed === true ? { headed: true } : {}),
          ...(typeof body.idleTimeoutMs === "number" && body.idleTimeoutMs > 0
            ? { idleTimeoutMs: body.idleTimeoutMs }
            : {}),
        }),
      },
      201,
    )
  }

  if (route === "login" && method === "POST") {
    const body = await bodyFrom(request)
    return json(
      {
        data: await browser.openLogin({
          id,
          project: typeof body.project === "string" ? body.project : "",
          ...(typeof body.headed === "boolean" ? { headed: body.headed } : {}),
          ...(typeof body.idleTimeoutMs === "number" && body.idleTimeoutMs > 0
            ? { idleTimeoutMs: body.idleTimeoutMs }
            : {}),
        }),
      },
      201,
    )
  }

  if (route === "clear" && method === "POST") {
    const body = await bodyFrom(request)
    const project = typeof body.project === "string" ? body.project.trim() : ""
    if (!project) return error("A project is required", "project_required", 400)
    return json({ data: { cleared: await browser.clearData(project) } })
  }

  // A person hands the agent a browser for this session (BU-05): the engine's `browser.*` tools then
  // run here, each one under the browser policy.
  if (route === "attach" && method === "POST" && attach) return json({ data: await attach.attach(id) }, 201)

  if (route === "session" && method === "GET") {
    const session = browser.get(id)
    return session ? json({ data: session }) : error("No browser session is open", "no_session", 404)
  }

  if (route === "viewport" && method === "POST") {
    const body = await bodyFrom(request)
    const viewport = parseViewport(body.width, body.height)
    return json({ data: await browser.setViewport(id, viewport) })
  }

  if (route === "capture" && method === "POST") {
    const body = await bodyFrom(request)
    const x = typeof body.x === "number" && Number.isFinite(body.x) ? body.x : undefined
    const y = typeof body.y === "number" && Number.isFinite(body.y) ? body.y : undefined
    if (x === undefined || y === undefined) return error("A point is required", "point_required", 400)
    return json({ data: await browser.capture(id, { x, y }) })
  }

  if (route === "frame" && method === "GET") {
    const store = new URL(request.url).searchParams.get("store") !== "0"
    const result = await browser.screenshot(id, store ? undefined : { store: false })
    // A copy, so the bytes are backed by a plain `ArrayBuffer` a `Response` can take. The
    // artifact id is exposed so a polling viewer can tell a new frame from the one it paints.
    return new Response(new Uint8Array(result.bytes).buffer, {
      headers: {
        "content-type": "image/png",
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "x-flupcode-artifact",
        ...(result.artifactId ? { "x-flupcode-artifact": result.artifactId } : {}),
      },
    })
  }

  if (route === "close" && method === "POST") {
    return json({ data: { closed: await browser.close(id) } })
  }

  if (route === "pause" && method === "POST") return json({ data: browser.pause(id) })
  if (route === "resume" && method === "POST") return json({ data: browser.resume(id) })
  if (route === "takeover" && method === "POST") return json({ data: await browser.takeOver(id) })
  if (route === "stop" && method === "POST") {
    const stopped = await browser.abort(id)
    // The agent's tools go with the browser, now rather than at the next check.
    await attach?.detach(id)
    return stopped ? json({ data: { stopped } }) : error("No browser session is open", "no_session", 404)
  }

  return error("Not found", "not_found", 404)
}

const failure = (cause: unknown): Response => {
  if (cause instanceof NavigationBlockedError)
    return json({ error: "navigation_blocked", code: "navigation_blocked", reason: cause.reason }, 403)
  if (cause instanceof BrowserError) return error(cause.message, cause.code, cause.status)
  return error(cause instanceof Error ? cause.message : String(cause), "internal_error", 500)
}
