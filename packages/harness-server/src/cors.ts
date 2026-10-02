/**
 * Who may read the harness from a page (WA-9).
 *
 * The desktop renderer answers to `oc://renderer`, and a development build is served from a loopback
 * port that changes, so any localhost port is allowed. A hosted page is not: `app.flupcode.com` is
 * not trusted by default. It reads the harness only with a token it paired for (HE-01, `api.ts`
 * decides per request); naming an origin exactly in `FLUPCODE_HARNESS_CORS` trusts it outright.
 */

import { isIP } from "node:net"

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

/** FlupCode's hosted web app. */
export const HOSTED_ORIGIN = "https://app.flupcode.com"

/**
 * Whether `origin` is FlupCode's web app served from somewhere other than this machine: the hosted
 * one, or one `FLUPCODE_WEB_ORIGINS` names (the same list the engine proxy serves, comma-separated
 * and exact). Such a page gets nothing from the harness but pairing until it holds a paired token.
 */
export function hostedWebOrigin(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (origin === undefined) return false
  if (origin === HOSTED_ORIGIN) return true
  return (env.FLUPCODE_WEB_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .includes(origin)
}

function isLoopbackOrigin(origin: string): boolean {
  if (!URL.canParse(origin)) return false
  const url = new URL(origin)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return LOOPBACK.has(url.hostname)
}

/** The extra `Host` names a caller allowed (a reverse proxy, a LAN name), comma-separated and exact. */
export function harnessAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.FLUPCODE_HARNESS_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "")
}

const WILDCARD = new Set(["0.0.0.0", "::", "[::]"])

/**
 * Whether a request's `Host` names this server (AH-A05). DNS rebinding points a name the attacker
 * owns at `127.0.0.1`, so the page is same-origin with the harness but its `Host` is still that name:
 * only the loopback names, the address the server listens on and what `FLUPCODE_HARNESS_ALLOWED_HOSTS`
 * names pass. On a wildcard listener any IP literal also passes — reaching it by address is not a
 * rebinding, which always needs a name. No `Host` at all is an in-process `Request`, not a socket.
 */
export function allowedHarnessHost(
  host: string | undefined,
  listening: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (host === undefined) return true
  if (!URL.canParse(`http://${host}`)) return false
  const hostname = new URL(`http://${host}`).hostname
  if (LOOPBACK.has(hostname) || hostname.endsWith(".localhost")) return true
  const bound = listening.includes(":") && !listening.startsWith("[") ? `[${listening}]` : listening
  if (URL.canParse(`http://${bound}`) && new URL(`http://${bound}`).hostname === hostname) return true
  if (WILDCARD.has(listening) && isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) return true
  const allowed = harnessAllowedHosts(env)
  return allowed.includes(hostname) || allowed.includes(host.toLowerCase())
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
 * `Vary: Origin` so a cache does not serve one origin's answer to another. `grant.origin` lets one
 * more origin read this answer (a paired hosted tab, HE-01), and `grant.credentials` lets it send and
 * receive the pairing cookie.
 */
export function applyHarnessCors(
  response: Response,
  request: Request,
  grant: { origin?: boolean; credentials?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): Response {
  const origin = request.headers.get("origin") ?? undefined
  const headers = new Headers(response.headers)
  headers.delete("access-control-allow-origin")
  headers.delete("access-control-allow-credentials")
  // Always varied, even when denied: a shared cache must not serve one origin's answer to another.
  addVary(headers, "Origin")
  if (origin !== undefined && (grant.origin || allowedHarnessOrigin(origin, env))) {
    headers.set("access-control-allow-origin", origin)
    if (grant.credentials) headers.set("access-control-allow-credentials", "true")
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
