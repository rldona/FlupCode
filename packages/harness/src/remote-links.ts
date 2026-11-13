import { createSignal } from "solid-js"
import type { TunnelClient } from "@flupcode/remote"
import type { LinkStatus, RemoteHost } from "./remote"
import type { EngineTransport } from "./transport"

/**
 * The background links of the desktop app (ADR-0029): one end-to-end tunnel to each paired computer
 * the window is not driving, so their sessions can be listed and followed. The window still drives
 * one engine at a time, through `remote.ts`'s own tunnel. A phone never loads this: one computer at
 * a time is what it shows, and a link per computer would cost it battery.
 */

type Link = {
  host: RemoteHost
  tunnel?: TunnelClient
  attempt: number
  timer?: ReturnType<typeof setTimeout>
  closed: boolean
  waiters: { resolve: (tunnel: TunnelClient) => void; reject: (error: Error) => void }[]
}

export type Links = ReturnType<typeof createLinks>

export function createLinks(input: {
  open: (host: RemoteHost) => Promise<TunnelClient>
  /** Whether a failed connection means the computer removed this device. */
  revoked: (error: unknown) => boolean
  deviceName: () => string
  /** How long a call waits for a link that is still connecting. */
  wait: number
}) {
  const links = new Map<string, Link>()
  const [status, setStatus] = createSignal<Record<string, LinkStatus>>({})

  const mark = (hostId: string, next: LinkStatus | undefined) =>
    setStatus(({ [hostId]: _previous, ...rest }) => (next ? { ...rest, [hostId]: next } : rest))

  const close = (link: Link) => {
    link.closed = true
    clearTimeout(link.timer)
    link.tunnel?.close()
    link.tunnel = undefined
    link.waiters.splice(0).forEach((waiter) => waiter.reject(new TypeError("Remote connection closed")))
  }

  const connect = async (link: Link) => {
    if (link.closed) return
    if (link.attempt === 0) mark(link.host.hostId, "connecting")
    const result = await input.open(link.host).then(
      (next) => ({ next }),
      (error: unknown) => ({ error }),
    )
    if (link.closed) {
      if ("next" in result) result.next.close()
      return
    }
    if ("error" in result) {
      mark(link.host.hostId, "offline")
      // Nobody waits for a computer that is not there: the sidebar shows its sessions as unavailable.
      link.waiters.splice(0).forEach((waiter) => waiter.reject(new TypeError("Remote computer unavailable")))
      // A computer that removed this device will not take it back by being asked again.
      if (input.revoked(result.error)) return
      link.timer = setTimeout(() => void connect(link), Math.min(30_000, 1000 * 2 ** link.attempt++))
      return
    }
    const next = result.next
    link.tunnel = next
    link.attempt = 0
    next.sendControl({ type: "device", name: input.deviceName() })
    mark(link.host.hostId, "online")
    link.waiters.splice(0).forEach((waiter) => waiter.resolve(next))
    next.onClose(() => {
      if (link.tunnel !== next || link.closed) return
      link.tunnel = undefined
      mark(link.host.hostId, "connecting")
      link.timer = setTimeout(() => void connect(link), 1000)
    })
  }

  /** Resolves with the link's tunnel, waiting while it connects; at once refused while it is offline. */
  const tunnel = (link: Link) => {
    if (link.tunnel && !link.tunnel.closed) return Promise.resolve(link.tunnel)
    if (status()[link.host.hostId] === "offline") return Promise.reject(new TypeError("Remote computer unavailable"))
    return new Promise<TunnelClient>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.waiters = link.waiters.filter((entry) => entry !== waiter)
        reject(new TypeError("Remote connection not ready"))
      }, input.wait)
      const waiter = {
        resolve: (next: TunnelClient) => {
          clearTimeout(timer)
          resolve(next)
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      link.waiters.push(waiter)
    })
  }

  return {
    /** Links exactly these computers: new ones connect, the rest are closed. */
    sync(wanted: RemoteHost[]) {
      links.forEach((link, hostId) => {
        if (wanted.some((host) => host.hostId === hostId)) return
        close(link)
        links.delete(hostId)
        mark(hostId, undefined)
      })
      wanted
        .filter((host) => !links.has(host.hostId))
        .forEach((host) => {
          const link: Link = { host, attempt: 0, closed: false, waiters: [] }
          links.set(host.hostId, link)
          void connect(link)
        })
    },
    status: (hostId: string) => status()[hostId],
    /** Calls to that computer's engine, through its link; nothing when it is not linked. */
    transport(hostId: string): EngineTransport | undefined {
      const link = links.get(hostId)
      if (!link) return undefined
      return {
        fetch: async (request, init) => (await tunnel(link)).fetch(request, init),
        socket: (url) => {
          if (!link.tunnel || link.tunnel.closed) throw new Error("Remote connection not ready")
          return link.tunnel.socket(url)
        },
      }
    },
  }
}
