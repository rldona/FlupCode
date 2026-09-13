import { asBytes } from "./bytes"
import {
  decodeRelayMessage,
  encodeRelayMessage,
  loadHostIdentity,
  RelayClose,
  splitChannel,
  withChannel,
  type HostIdentity,
} from "./relay"
import { Wire } from "./wire"

/** WebSocket connections to the relay, as a client (phone) or as the host (desktop). */

type SocketFactory = (url: string) => WebSocket

const defaultSocket: SocketFactory = (url) => new WebSocket(url)

function endpoint(relay: string, path: string, params: Record<string, string>) {
  const url = new URL(path, relay.endsWith("/") ? relay : `${relay}/`)
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
  return url.toString()
}

export class RelayConnectError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
  }
}

/** Opens a client channel to `hostId`. Resolves once the relay reports the host is reachable. */
export function connectRelayClient(input: { relay: string; hostId: string; createSocket?: SocketFactory }) {
  return new Promise<Wire>((resolve, reject) => {
    const socket = (input.createSocket ?? defaultSocket)(endpoint(input.relay, "client", { host: input.hostId }))
    socket.binaryType = "arraybuffer"
    let wire: Wire | undefined
    let queue = Promise.resolve()
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        if (wire || decodeRelayMessage(event.data)?.t !== "ready") return
        wire = new Wire(
          (data) => socket.send(data),
          (code, reason) => socket.close(code ?? 1000, reason),
        )
        return resolve(wire)
      }
      const current = wire
      if (!current) return
      queue = queue.then(async () => current.push(await asBytes(event.data as ArrayBuffer)))
    }
    socket.onclose = (event) => {
      if (wire) return void queue.then(() => wire?.end())
      reject(new RelayConnectError(event.reason || "Relay connection closed", event.code))
    }
    socket.onerror = () => undefined
  })
}

export type RelayHostStatus = "offline" | "connecting" | "online"

/**
 * Keeps an authenticated host connection to the relay, reconnecting with backoff, and hands each
 * incoming client channel to `onChannel` as a Wire.
 */
export function startRelayHost(input: {
  relay: string
  identity: HostIdentity
  onChannel: (wire: Wire, channel: number) => void
  onStatus?: (status: RelayHostStatus, detail?: string) => void
  createSocket?: SocketFactory
}) {
  let stopped = false
  let socket: WebSocket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  const channels = new Map<number, Wire>()
  const loaded = loadHostIdentity(input.identity)

  const closeChannels = () => {
    channels.forEach((wire) => wire.end())
    channels.clear()
  }

  const connect = async () => {
    if (stopped) return
    input.onStatus?.("connecting")
    const identity = await loaded
    if (stopped) return
    const current = (input.createSocket ?? defaultSocket)(endpoint(input.relay, "host", { id: identity.hostId }))
    socket = current
    current.binaryType = "arraybuffer"
    let queue = Promise.resolve()

    current.onmessage = (event) => {
      if (typeof event.data !== "string") {
        const data = event.data as ArrayBuffer
        queue = queue.then(async () => {
          const frame = splitChannel(await asBytes(data))
          if (frame) channels.get(frame.channel)?.push(frame.payload.slice())
        })
        return
      }
      const message = decodeRelayMessage(event.data)
      if (!message) return
      if (message.t === "challenge")
        return void identity.answer(message.nonce).then((answer) => current.send(encodeRelayMessage(answer)))
      if (message.t === "ready") {
        attempt = 0
        return input.onStatus?.("online")
      }
      if (message.t === "open") {
        const wire = new Wire(
          (data) => current.send(withChannel(message.channel, data)),
          () => {
            channels.delete(message.channel)
            current.send(encodeRelayMessage({ t: "close", channel: message.channel }))
          },
        )
        channels.set(message.channel, wire)
        return input.onChannel(wire, message.channel)
      }
      if (message.t === "close") {
        const wire = channels.get(message.channel)
        channels.delete(message.channel)
        queue = queue.then(() => wire?.end())
      }
    }

    current.onclose = (event) => {
      if (socket !== current) return
      socket = undefined
      void queue.then(closeChannels)
      if (stopped) return input.onStatus?.("offline")
      if (event.code === RelayClose.hostGone) {
        stopped = true
        return input.onStatus?.("offline", "This host connected to the relay from another place")
      }
      const delay = Math.min(30_000, 1000 * 2 ** attempt++) * (0.75 + Math.random() * 0.5)
      input.onStatus?.("connecting", event.reason || `Relay closed (${event.code})`)
      timer = setTimeout(() => void connect(), delay)
    }
    current.onerror = () => undefined
  }

  void connect()

  return {
    hostId: loaded.then((identity) => identity.hostId),
    stop() {
      stopped = true
      clearTimeout(timer)
      closeChannels()
      const current = socket
      socket = undefined
      current?.close(1000)
      input.onStatus?.("offline")
    },
  }
}
