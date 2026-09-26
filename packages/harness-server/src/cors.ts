/**
 * Who may read the harness from a page (WA-9).
 *
 * The desktop renderer answers to `oc://renderer`, and a development build is served from a loopback
 * port that changes, so any localhost port is allowed. A hosted page is not: `app.flupcode.com` is
 * not trusted by default, and the only way to add an origin is to name it exactly in
 * `FLUPCODE_HARNESS_CORS`.
 */

/** The loopback hosts whose port never matters, in the shape a browser puts in `Origin`. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/** The extra origins a caller allowed, comma-separated and exact: no patterns, no subdomains. */
export function harnessCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.FLUPCODE_HARNESS_CORS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
}

/**
 * Whether a request from `origin` may read the answer.
 *
 * `undefined` is no origin at all — a same-origin call, or a tool like curl — and is allowed. The
 * renderer and any loopback port are always allowed; anything else has to be named.
 */
export function allowedHarnessOrigin(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (origin === undefined) return true
  if (origin === "oc://renderer") return true
  if (harnessCorsOrigins(env).includes(origin)) return true
  return isLoopbackOrigin(origin)
}

function isLoopbackOrigin(origin: string): boolean {
  if (!URL.canParse(origin)) return false
  const url = new URL(origin)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return LOOPBACK.has(url.hostname)
}

/** Adds a `Vary` value without dropping the ones already there. */
function addVary(headers: Headers, value: string): void {
  const current = headers.get("vary")
  if (!current) {
    headers.set("vary", value)
    return
  }
  const seen = current.split(",").map((entry) => entry.trim().toLowerCase())
  if (!seen.includes(value.toLowerCase())) headers.set("vary", `${current}, ${value}`)
}

/**
 * The CORS headers for one answer: echo the origin only when it is allowed.
 *
 * Whatever `access-control-allow-origin` the handler set is removed first, so the `*` the API used to
 * send can never leak past this point. An allowed origin gets its own value echoed, with
 * `Vary: Origin` so a cache does not serve one origin's answer to another.
 */
export function applyHarnessCors(response: Response, request: Request, env: NodeJS.ProcessEnv = process.env): Response {
  const origin = request.headers.get("origin") ?? undefined
  const headers = new Headers(response.headers)
  headers.delete("access-control-allow-origin")
  // Always varied, even when denied: a shared cache must not serve one origin's answer to another.
  addVary(headers, "Origin")
  if (origin !== undefined && allowedHarnessOrigin(origin, env)) {
    headers.set("access-control-allow-origin", origin)
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** The methods a cross-origin caller may use (WA-9). PUT is the action-profile writer's save. */
export const HARNESS_CORS_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS"

/** The request headers a cross-origin caller may send (WA-9). */
export const HARNESS_CORS_HEADERS = "content-type, authorization, x-flupcode-session"

/** The answer to a preflight: no body, and the methods and headers a caller may use. */
export function preflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-methods": HARNESS_CORS_METHODS,
      "access-control-allow-headers": HARNESS_CORS_HEADERS,
    },
  })
}
