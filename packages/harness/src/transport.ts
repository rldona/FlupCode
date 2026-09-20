import type { EngineSocket } from "@flupcode/remote"

/**
 * Every engine call goes through this transport (ADR-0010). Locally it is the browser `fetch` and
 * `WebSocket`; in remote control mode it is swapped for the end-to-end encrypted tunnel.
 */

export type EngineTransport = {
  fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>
  socket: (url: string) => EngineSocket
}

const local: EngineTransport = {
  fetch: (input, init) => globalThis.fetch(input, init),
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
