import type { EngineSocket } from "@flupcode/remote"

/**
 * Every engine call goes through this transport (ADR-0010). Locally it is the browser `fetch` and
 * `WebSocket`; in remote control mode it is swapped for the end-to-end encrypted tunnel.
 */

export type EngineTransport = {
  fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>
  socket: (url: string) => EngineSocket
}

/**
 * A hosted page (https origin) reaching a loopback engine is subject to the browser's mixed-content
 * and Local Network Access rules. Annotating the request as loopback lets Chromium exempt it;
 * engines that do not know the option ignore it.
 */
function loopback(init: RequestInit | undefined): RequestInit {
  const extended: RequestInit & { targetAddressSpace: "loopback" } = { ...init, targetAddressSpace: "loopback" }
  return extended
}

/**
 * The desktop app gives the engine it starts a password, so nothing else on the machine can drive
 * the agent — the engine accepts every `http://localhost:*` origin, so any page served from another
 * local port could otherwise reach it. It hands this page the credentials to use; a browser talking
 * to an engine the user started themselves has none and sends nothing extra. Over remote control the
 * tunnel adds its own, so this only applies to direct calls.
 */
export function engineCredentials() {
  return typeof window === "undefined" ? undefined : window.flupcode?.engineAuth
}

function authorized(input: Request | string | URL, init: RequestInit | undefined): RequestInit {
  const credentials = engineCredentials()
  if (!credentials) return loopback(init)
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set("authorization", `Basic ${credentials}`)
  return loopback({ ...init, headers })
}

/** A socket cannot carry a header, so the engine also reads the same credentials from the query. */
function authorizedSocketUrl(url: string) {
  const credentials = engineCredentials()
  if (!credentials) return url
  const target = new URL(url)
  target.searchParams.set("auth_token", credentials)
  return target.toString()
}

const local: EngineTransport = {
  fetch: (input, init) => globalThis.fetch(input, authorized(input, init)),
  socket: (url) => new WebSocket(authorizedSocketUrl(url)),
}

let current = local

export function setEngineTransport(transport: EngineTransport | undefined) {
  current = transport ?? local
}

export function engineFetch(input: Request | string | URL, init?: RequestInit) {
  return current.fetch(input, init)
}

export function engineSocket(url: string) {
  return current.socket(url)
}
