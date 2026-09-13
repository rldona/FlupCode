import {
  createChallenge,
  decodeRelayMessage,
  encodeRelayMessage,
  fromBase64Url,
  isPushServiceEndpoint,
  RelayClose,
  splitChannel,
  vapidAuthorization,
  verifyHostAnswer,
  withChannel,
  type RelayMessage,
  type VapidKeys,
} from "@flupcode/remote"
import type { Server, ServerWebSocket } from "bun"

/** The FlupCode relay (ADR-0010): routes opaque frames between one host and its clients. */

export type RelayOptions = {
  port?: number
  hostname?: string
  /** Maximum simultaneous clients per host. */
  maxClientsPerHost?: number
  /** Maximum simultaneous sockets per remote IP. */
  maxConnectionsPerIp?: number
  /** Maximum bytes per WebSocket frame. */
  maxFrameBytes?: number
  /** Close a socket whose outgoing buffer grows past this many bytes. */
  maxBufferedBytes?: number
  /** Milliseconds a host has to answer the challenge. */
  authTimeout?: number
  /** Read the client IP from this header (e.g. `fly-client-ip`) when behind a proxy. */
  ipHeader?: string
  /** VAPID keys and contact (`mailto:` or `https:`) to deliver Web Push for hosts (ADR-0011). */
  push?: {
    keys: VapidKeys
    subject: string
    /** Pushes each host may send per minute. */
    perMinute?: number
    /** Which endpoints may be delivered to; defaults to the browser push services. */
    allowEndpoint?: (endpoint: string) => boolean
    fetch?: typeof globalThis.fetch
  }
  log?: (message: string) => void
}

/** Largest encrypted push body accepted from a host (push services cap bodies at 4096 bytes). */
const MAX_PUSH_BODY = 4096

type HostData = { role: "host"; hostId: string; ip: string; nonce: string; authed: boolean; timer?: Timer }
type ClientData = { role: "client"; hostId: string; ip: string; channel: number }
type Socket = ServerWebSocket<HostData | ClientData>

type HostEntry = { socket: Socket; clients: Map<number, Socket>; nextChannel: number }

const ID = /^[A-Za-z0-9_-]{22}$/

export function startRelay(options: RelayOptions = {}) {
  const maxClients = options.maxClientsPerHost ?? 16
  const maxPerIp = options.maxConnectionsPerIp ?? 64
  const maxBuffered = options.maxBufferedBytes ?? 16 * 1024 * 1024
  const log = options.log ?? (() => {})
  const hosts = new Map<string, HostEntry>()
  const pushBudget = new Map<string, { windowStart: number; count: number }>()

  const deliverPush = async (hostId: string, request: Extract<RelayMessage, { t: "push" }>) => {
    const push = options.push
    if (!push) return 501
    if (!(push.allowEndpoint ?? isPushServiceEndpoint)(request.endpoint)) return 400
    const body = fromBase64Url(request.body)
    if (body.byteLength === 0 || body.byteLength > MAX_PUSH_BODY) return 413
    const now = Date.now()
    const budget = pushBudget.get(hostId)
    const current = budget && now - budget.windowStart < 60_000 ? budget : { windowStart: now, count: 0 }
    if (current.count >= (push.perMinute ?? 30)) return 429
    pushBudget.set(hostId, { ...current, count: current.count + 1 })
    const response = await (push.fetch ?? globalThis.fetch)(request.endpoint, {
      method: "POST",
      headers: {
        authorization: await vapidAuthorization({ endpoint: request.endpoint, keys: push.keys, subject: push.subject }),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(Math.max(0, Math.min(request.ttl, 24 * 60 * 60))),
        urgency: request.urgency,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
    return response?.status ?? 502
  }
  const perIp = new Map<string, number>()

  const deliver = (socket: Socket, data: string | Uint8Array) => {
    socket.send(data)
    if (socket.getBufferedAmount() > maxBuffered) socket.close(1013, "Too slow")
  }

  const release = (ip: string) => {
    const count = (perIp.get(ip) ?? 1) - 1
    if (count <= 0) return perIp.delete(ip)
    perIp.set(ip, count)
  }

  const dropHost = (entry: HostEntry, code: number, reason: string) => {
    entry.clients.forEach((client) => client.close(code, reason))
    entry.clients.clear()
  }

  const server: Server<HostData | ClientData> = Bun.serve<HostData | ClientData>({
    port: options.port ?? 8787,
    hostname: options.hostname ?? "0.0.0.0",
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/health") return Response.json({ ok: true })
      if (url.pathname === "/push/key") {
        // Public: phones fetch it from the web app origin to subscribe.
        const headers = { "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" }
        if (!options.push) return Response.json({ error: "Push is not configured" }, { status: 404, headers })
        return Response.json({ publicKey: options.push.keys.publicKey }, { headers })
      }
      const ip =
        (options.ipHeader && request.headers.get(options.ipHeader)) || server.requestIP(request)?.address || "unknown"
      const role = url.pathname === "/host" ? "host" : url.pathname === "/client" ? "client" : undefined
      if (!role) return new Response("Not found", { status: 404 })
      const hostId = url.searchParams.get(role === "host" ? "id" : "host") ?? ""
      if (!ID.test(hostId)) return new Response("Invalid host id", { status: 400 })
      if ((perIp.get(ip) ?? 0) >= maxPerIp) return new Response("Too many connections", { status: 429 })
      const data: HostData | ClientData =
        role === "host"
          ? { role, hostId, ip, nonce: createChallenge().nonce, authed: false }
          : { role, hostId, ip, channel: 0 }
      if (!server.upgrade(request, { data })) return new Response("Upgrade required", { status: 426 })
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1)
      return undefined
    },
    websocket: {
      maxPayloadLength: options.maxFrameBytes ?? 1024 * 1024,
      idleTimeout: 60,
      sendPings: true,
      open(socket) {
        const data = socket.data
        if (data.role === "host") {
          data.timer = setTimeout(
            () => socket.close(RelayClose.unauthorized, "Authentication timeout"),
            options.authTimeout ?? 10_000,
          )
          return void socket.send(encodeRelayMessage({ t: "challenge", nonce: data.nonce }))
        }
        const entry = hosts.get(data.hostId)
        if (!entry) return socket.close(RelayClose.hostOffline, "Host offline")
        if (entry.clients.size >= maxClients) return socket.close(RelayClose.limit, "Too many clients")
        data.channel = entry.nextChannel++
        entry.clients.set(data.channel, socket)
        entry.socket.send(encodeRelayMessage({ t: "open", channel: data.channel }))
        socket.send(encodeRelayMessage({ t: "ready" }))
      },
      async message(socket, message) {
        const data = socket.data
        if (data.role === "client") {
          if (typeof message === "string") return
          const entry = hosts.get(data.hostId)
          if (!entry || entry.clients.get(data.channel) !== socket)
            return socket.close(RelayClose.hostGone, "Host gone")
          return deliver(entry.socket, withChannel(data.channel, message))
        }
        if (!data.authed) {
          const parsed = typeof message === "string" ? decodeRelayMessage(message) : undefined
          if (parsed?.t !== "auth" || !(await verifyHostAnswer(data.hostId, data.nonce, parsed)))
            return socket.close(RelayClose.unauthorized, "Authentication failed")
          if (socket.readyState !== 1) return
          clearTimeout(data.timer)
          data.authed = true
          const previous = hosts.get(data.hostId)
          if (previous) {
            dropHost(previous, RelayClose.hostGone, "Host reconnected")
            previous.socket.close(RelayClose.hostGone, "Replaced by a newer connection")
          }
          hosts.set(data.hostId, { socket, clients: new Map(), nextChannel: 1 })
          log(`host online ${data.hostId}`)
          return void socket.send(encodeRelayMessage({ t: "ready" }))
        }
        const entry = hosts.get(data.hostId)
        if (entry?.socket !== socket) return
        if (typeof message === "string") {
          const parsed = decodeRelayMessage(message)
          if (parsed?.t === "push") {
            const status = await deliverPush(data.hostId, parsed)
            if (socket.readyState === 1) socket.send(encodeRelayMessage({ t: "push-result", id: parsed.id, status }))
            return
          }
          if (parsed?.t !== "close") return
          const client = entry.clients.get(parsed.channel)
          entry.clients.delete(parsed.channel)
          return client?.close(RelayClose.hostGone, "Closed by host")
        }
        const frame = splitChannel(message as Uint8Array<ArrayBuffer>)
        const client = frame && entry.clients.get(frame.channel)
        if (client) deliver(client, frame.payload)
      },
      close(socket) {
        const data = socket.data
        release(data.ip)
        if (data.role === "host") {
          clearTimeout(data.timer)
          const entry = hosts.get(data.hostId)
          if (entry?.socket !== socket) return
          hosts.delete(data.hostId)
          dropHost(entry, RelayClose.hostGone, "Host disconnected")
          return log(`host offline ${data.hostId}`)
        }
        const entry = hosts.get(data.hostId)
        if (!entry || entry.clients.get(data.channel) !== socket) return
        entry.clients.delete(data.channel)
        entry.socket.send(encodeRelayMessage({ t: "close", channel: data.channel }))
      },
    },
  })

  return {
    server,
    url: `ws://${server.hostname === "0.0.0.0" ? "127.0.0.1" : server.hostname}:${server.port}`,
    stats: () => ({
      hosts: hosts.size,
      clients: [...hosts.values()].reduce((sum, entry) => sum + entry.clients.size, 0),
    }),
    stop: () => server.stop(true),
  }
}
