import type { EngineSocket } from "@flupcode/remote"
import { addressSpaceOf, type AddressSpace } from "./local-network"

/**
 * Every engine call goes through this transport (ADR-0010). Locally it is the browser `fetch` and
 * `WebSocket`; in remote control mode it is swapped for the end-to-end encrypted tunnel.
 */

export type EngineTransport = {
  fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>
  socket: (url: string) => EngineSocket
}

/**
 * The address space engine calls are annotated with, when the browser has granted the local network
 * permission (H-45).
 *
 * `targetAddressSpace` is what declares a request as local and moves it behind Chrome's permission
 * gate, so it is only sent once the permission exists. Sending an annotation blind is what took the
 * hosted app off its engine in #91, and leaving a name that a later Chrome starts accepting is a
 * landmine of the same kind, which is why the old `"loopback"` sentinel is gone.
 */
let annotation: AddressSpace | undefined

export function annotateLocalNetwork(space: AddressSpace | undefined) {
  annotation = space
}

/**
 * Annotated only when the request is actually going to that space.
 *
 * The engine is local in the case this exists for, but the harness server and the engine are two
 * different addresses and either can point somewhere else: declaring a remote as loopback makes the
 * browser fail the request (it checks the resolved space against the declaration). A target whose
 * name says public is left alone.
 */
function localNetwork(input: Request | string | URL, init: RequestInit | undefined): RequestInit {
  const target = addressSpaceOf(input instanceof Request ? input.url : String(input))
  if (!annotation || !target || target !== annotation) return { ...init }
  return { ...init, targetAddressSpace: annotation } as RequestInit
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

/**
 * Ask the browser for local network access, from a user gesture (H-45).
 *
 * The prompt only appears while a connection to a local destination is being made, and only if it
 * succeeds, so the question is a request to the engine itself — annotated with the space it is in,
 * because that is what tells the browser where this is going. A granted answer lets this very
 * request through, which is why a response can be treated as the permission.
 */
export async function askLocalNetwork(url: string, space: AddressSpace) {
  const headers = new Headers()
  const credentials = engineCredentials()
  if (credentials) headers.set("authorization", `Basic ${credentials}`)
  const init = {
    headers,
    targetAddressSpace: space,
    signal: AbortSignal.timeout(10_000),
  } as RequestInit
  return globalThis.fetch(url, init).then(
    (response) => response.ok,
    () => false,
  )
}

function authorized(input: Request | string | URL, init: RequestInit | undefined): RequestInit {
  const credentials = engineCredentials()
  if (!credentials) return localNetwork(input, init)
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set("authorization", `Basic ${credentials}`)
  return localNetwork(input, { ...init, headers })
}

/** A socket cannot carry a header, so the engine also reads the same credentials from the query. */
function authorizedSocketUrl(url: string) {
  const credentials = engineCredentials()
  if (!credentials) return url
  const target = new URL(url)
  target.searchParams.set("auth_token", credentials)
  return target.toString()
}

/**
 * A keep-alive socket the engine left behind after a restart never answers, and a request without a
 * deadline hangs forever — the caller stays busy and the page stops sending. The streams are the
 * exception: they are meant to stay open, so they are left alone and detected by their accept header.
 */
export const ENGINE_REQUEST_TIMEOUT = 60_000

function isEventStream(input: Request | string | URL, init: RequestInit | undefined) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  return (headers.get("accept") ?? "").includes("text/event-stream")
}

/**
 * The routes that hold the connection open while a model answers, a shell command runs or the
 * engine waits for a session to go idle. They are slow because the work is slow, not because the
 * socket is dead, so no deadline of ours fits them. `prompt_async` is not one of them: it admits the
 * input and returns, which is what the composer waits on.
 */
const LONG_ROUTES = /\/(prompt|shell|command|summarize|init|wait|compact)$/

function isLongRoute(input: Request | string | URL) {
  const url = input instanceof Request ? input.url : String(input)
  const path = URL.canParse(url) ? new URL(url).pathname : url
  return LONG_ROUTES.test(path)
}

/**
 * The deadline cannot be decided from `input.signal`: the generated SDK builds a `Request` for every
 * call, and a `Request` always carries a signal of its own. Reading it as "the caller brought a
 * deadline" left every engine call without one — which is how a dead socket after an engine restart
 * pinned `busy` and stopped the composer from sending. Only an explicit `init.signal` counts.
 */
export function withRequestTimeout(input: Request | string | URL, init: RequestInit | undefined): RequestInit | undefined {
  if (init?.signal || isEventStream(input, init) || isLongRoute(input)) return init
  return { ...init, signal: AbortSignal.timeout(ENGINE_REQUEST_TIMEOUT) }
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
  return current.fetch(input, withRequestTimeout(input, init))
}

/**
 * Without the engine's credentials, for services that are not the engine. The harness server
 * never asked for them, and the `authorization` header trips a CORS preflight it does not allow:
 * in the desktop app every harness screen then reads as "not reachable" while curl answers fine.
 * Routing is unchanged, so remote control still goes through the tunnel.
 */
export function anonymousFetch(input: Request | string | URL, init?: RequestInit) {
  if (current !== local) return current.fetch(input, init)
  return globalThis.fetch(input, localNetwork(input, init))
}

export function engineSocket(url: string) {
  return current.socket(url)
}
