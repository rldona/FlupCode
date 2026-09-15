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

const local: EngineTransport = {
  fetch: (input, init) => globalThis.fetch(input, loopback(init)),
  socket: (url) => new WebSocket(url),
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
