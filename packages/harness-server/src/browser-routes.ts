/**
 * The HTTP contract of the browser runtime (WA-1).
 *
 * Internal routes, not model tools: `api.ts` guards them with the loopback bearer token before they
 * are reached, and here they are only the shape of the request and the shape of the answer.
 */

import { BrowserError, readSessionID } from "./browser"
import type { BrowserRuntime, WaitUntil } from "./browser"
import { NavigationBlockedError } from "./browser-egress"

const WAIT_UNTIL: WaitUntil[] = ["load", "domcontentloaded", "networkidle", "commit"]

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

const timeoutFrom = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

const waitUntilFrom = (value: unknown) => WAIT_UNTIL.find((entry) => entry === value)

export async function handleBrowserRequest(
  request: Request,
  segments: string[],
  browser: BrowserRuntime,
): Promise<Response> {
  try {
    return await dispatch(request, segments, browser)
  } catch (cause) {
    return failure(cause)
  }
}

const dispatch = async (request: Request, segments: string[], browser: BrowserRuntime): Promise<Response> => {
  const id = readSessionID(request.headers.get("x-flupcode-session") ?? undefined)
  const route = segments[0]
  const method = request.method

  if (route === "start" && method === "POST") {
    const body = await bodyFrom(request)
    return json(
      {
        data: await browser.start({
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

  if (route === "session" && method === "GET") {
    const session = browser.get(id)
    return session ? json({ data: session }) : error("No browser session is open", "no_session", 404)
  }

  if (route === "navigate" && method === "POST") {
    const body = await bodyFrom(request)
    const url = typeof body.url === "string" ? body.url.trim() : ""
    if (!url) return error("A url is required", "url_required", 400)
    return json({ data: await browser.navigate(id, url, waitUntilFrom(body.waitUntil)) })
  }

  if (route === "snapshot" && method === "GET") {
    const html = new URL(request.url).searchParams.get("html") === "1"
    return json({ data: await browser.snapshot(id, html ? { html: true } : undefined) })
  }

  if (route === "click" && method === "POST") {
    const body = await bodyFrom(request)
    const selector = typeof body.selector === "string" ? body.selector : ""
    if (!selector) return error("A selector is required", "selector_required", 400)
    return json({ data: await browser.click(id, selector, timeoutFrom(body.timeoutMs)) })
  }

  if (route === "type" && method === "POST") {
    const body = await bodyFrom(request)
    const selector = typeof body.selector === "string" ? body.selector : ""
    if (!selector) return error("A selector is required", "selector_required", 400)
    if (typeof body.text !== "string") return error("Text is required", "text_required", 400)
    return json({ data: await browser.type(id, selector, body.text, timeoutFrom(body.timeoutMs)) })
  }

  if (route === "submit" && method === "POST") {
    const body = await bodyFrom(request)
    const selector = typeof body.selector === "string" ? body.selector : ""
    if (!selector) return error("A selector is required", "selector_required", 400)
    return json({ data: await browser.submit(id, selector, timeoutFrom(body.timeoutMs)) })
  }

  if (route === "waitFor" && method === "POST") {
    const body = await bodyFrom(request)
    const selector = typeof body.selector === "string" ? body.selector : ""
    if (!selector) return error("A selector is required", "selector_required", 400)
    const state = body.state === "attached" || body.state === "visible" ? body.state : undefined
    return json({ data: await browser.waitFor(id, selector, timeoutFrom(body.timeoutMs), state) })
  }

  if (route === "text" && method === "POST") {
    const body = await bodyFrom(request)
    const selector = typeof body.selector === "string" ? body.selector : ""
    if (!selector) return error("A selector is required", "selector_required", 400)
    const as = body.as === "text" || body.as === "html" || body.as === "attribute" ? body.as : undefined
    const attribute = typeof body.attribute === "string" ? body.attribute : undefined
    const timeoutMs = timeoutFrom(body.timeoutMs)
    return json({
      data: await browser.text(id, selector, {
        ...(as !== undefined ? { as } : {}),
        ...(attribute !== undefined ? { attribute } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }),
    })
  }

  if (route === "screenshot" && method === "POST") {
    const body = await bodyFrom(request)
    const label = typeof body.label === "string" ? body.label : undefined
    return json({ data: await browser.screenshot(id, label) })
  }

  if (route === "frame" && method === "GET") {
    const store = new URL(request.url).searchParams.get("store") !== "0"
    const result = await browser.frame(id, store ? undefined : { store: false })
    // A copy, so the bytes are backed by a plain `ArrayBuffer` a `Response` can take.
    return new Response(new Uint8Array(result.bytes).buffer, {
      headers: {
        "content-type": "image/png",
        "access-control-allow-origin": "*",
        ...(result.artifactId ? { "x-flupcode-artifact": result.artifactId } : {}),
      },
    })
  }

  if (route === "close" && method === "POST") {
    return json({ data: { closed: await browser.close(id) } })
  }

  return error("Not found", "not_found", 404)
}

const failure = (cause: unknown): Response => {
  if (cause instanceof NavigationBlockedError)
    return json({ error: "navigation_blocked", code: "navigation_blocked", reason: cause.reason }, 403)
  if (cause instanceof BrowserError) return error(cause.message, cause.code, cause.status)
  return error(cause instanceof Error ? cause.message : String(cause), "internal_error", 500)
}
