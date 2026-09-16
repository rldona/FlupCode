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
 * and Local Network Access rules. `targetAddressSpace` marks the request as one of those, which is
 * what makes it eligible at all — the user still has to grant the permission Chrome asks for.
 *
 * The option takes "local". "loopback", which this sent, is the name of an address space and not a
 * value the option accepts, so the annotation did nothing and every call to the engine was reported
 * as an unannotated local network request.
 *
 * Picking it by asking the browser rather than by version: the option is a WebIDL enum, so a value
 * it does not know throws while building the request, and hard-coding a name a later Chrome renames
 * would break every call to the engine at once. A browser that ignores the option altogether accepts
 * the first candidate, which is the right one anyway.
 */
export function pickAddressSpace(build: (init: RequestInit) => void) {
  for (const value of ["local", "loopback"] as const) {
    try {
      build({ targetAddressSpace: value } as RequestInit)
      return value
    } catch {
      // The browser knows the option and rejects this name for it.
    }
  }
  return undefined
}

const addressSpace =
  typeof Request === "undefined"
    ? undefined
    : pickAddressSpace((init) => {
        new Request("http://127.0.0.1/", init)
      })

function localNetwork(init: RequestInit | undefined): RequestInit {
  if (!addressSpace) return { ...init }
  return { ...init, targetAddressSpace: addressSpace } as RequestInit
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
  if (!credentials) return localNetwork(init)
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set("authorization", `Basic ${credentials}`)
  return localNetwork({ ...init, headers })
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
