import { createSignal } from "solid-js"
import {
  connectChannel,
  connectRelayClient,
  createTunnelClient,
  fromBase64Url,
  HandshakeError,
  parsePairingHash,
  RelayClose,
  RelayConnectError,
  type ChannelMode,
  type PairingLink,
  type RemoteHostBridge,
  type TunnelClient,
} from "@flupcode/remote"
import { readStorage, STORAGE_KEYS, writeStorage } from "./storage"
import { setEngineTransport, type EngineTransport } from "./transport"

/** Remote control client (ADR-0010): pairs with a desktop and routes engine traffic through it. */

export type RemoteHost = {
  hostId: string
  relay: string
  name: string
  deviceId: string
  deviceKey: string
  pairedAt: number
}

export type RemoteStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error"

export type RemoteErrorCode = "insecure" | "offline" | "revoked" | "expired" | "failed"

declare global {
  interface Window {
    flupcode?: { chooseFolder?: () => Promise<string | undefined>; remote?: RemoteHostBridge }
  }
}

/** The desktop app hosts remote control; everywhere else the harness can act as a client. */
export function desktopRemote() {
  return typeof window !== "undefined" ? window.flupcode?.remote : undefined
}

export function remoteBaseUrl(hostId: string) {
  return `https://${hostId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.remote.flupcode.invalid`
}

function deviceName() {
  const agent = navigator.userAgent
  if (/iPhone/.test(agent)) return "iPhone"
  if (/iPad/.test(agent)) return "iPad"
  if (/Android/.test(agent)) return /Mobile/.test(agent) ? "Android phone" : "Android tablet"
  if (/Macintosh/.test(agent)) return "Mac browser"
  if (/Windows/.test(agent)) return "Windows browser"
  return "Browser"
}

const [hosts, setHosts] = createSignal<RemoteHost[]>(readStorage<RemoteHost[]>(STORAGE_KEYS.remoteHosts, []))
const [activeHostId, setActiveHostId] = createSignal<string | undefined>(
  readStorage<string>(STORAGE_KEYS.remoteActive, "") || undefined,
)
const [status, setStatus] = createSignal<RemoteStatus>("idle")
const [errorCode, setErrorCode] = createSignal<RemoteErrorCode | undefined>()

/** Used while a remote host is selected but not reachable, so engine calls fail fast. */
const pending: EngineTransport = {
  fetch: () => Promise.reject(new TypeError("Remote connection not ready")),
  socket: () => {
    throw new Error("Remote connection not ready")
  },
}

let tunnel: TunnelClient | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let attempt = 0
let generation = 0

function saveHosts(next: RemoteHost[]) {
  setHosts(next)
  writeStorage(STORAGE_KEYS.remoteHosts, next)
}

function saveActive(hostId: string | undefined) {
  setActiveHostId(hostId)
  writeStorage(STORAGE_KEYS.remoteActive, hostId ?? "")
}

function classify(error: unknown): RemoteErrorCode {
  if (error instanceof RelayConnectError && error.code === RelayClose.hostOffline) return "offline"
  if (error instanceof HandshakeError && error.message === "Rejected by host") return "revoked"
  return "failed"
}

async function open(input: { relay: string; hostId: string; mode: ChannelMode; id: string; psk: string }) {
  if (!globalThis.crypto?.subtle) throw Object.assign(new Error("insecure"), { code: "insecure" as const })
  const wire = await connectRelayClient({ relay: input.relay, hostId: input.hostId })
  const channel = await connectChannel(wire, { mode: input.mode, id: input.id, psk: fromBase64Url(input.psk) })
  return createTunnelClient(channel)
}

function attach(next: TunnelClient, host: RemoteHost, current: number) {
  tunnel?.close()
  tunnel = next
  attempt = 0
  next.sendControl({ type: "device", name: deviceName() })
  setEngineTransport({ fetch: next.fetch, socket: next.socket })
  setErrorCode(undefined)
  setStatus("connected")
  next.onClose(() => {
    if (tunnel !== next || current !== generation) return
    tunnel = undefined
    schedule(host, current)
  })
}

function schedule(host: RemoteHost, current: number) {
  clearTimeout(retryTimer)
  setStatus("reconnecting")
  const delay = Math.min(30_000, 1000 * 2 ** attempt++)
  retryTimer = setTimeout(() => void connectHost(host.hostId, current), delay)
}

async function connectHost(hostId: string, current = ++generation) {
  const host = hosts().find((entry) => entry.hostId === hostId)
  if (!host) return
  clearTimeout(retryTimer)
  if (!tunnel) setEngineTransport(pending)
  if (status() !== "reconnecting") setStatus("connecting")
  const result = await open({
    relay: host.relay,
    hostId: host.hostId,
    mode: "device",
    id: host.deviceId,
    psk: host.deviceKey,
  })
    .then((next) => ({ next }))
    .catch((error: unknown) => ({ error }))
  if (current !== generation) {
    if ("next" in result) result.next.close()
    return
  }
  if ("next" in result) return attach(result.next, host, current)
  const code = (result.error as { code?: RemoteErrorCode }).code ?? classify(result.error)
  if (code === "offline" || code === "failed") {
    setErrorCode(code)
    return schedule(host, current)
  }
  setErrorCode(code)
  setStatus("error")
}

async function pair(link: PairingLink) {
  const current = ++generation
  clearTimeout(retryTimer)
  setStatus("connecting")
  setErrorCode(undefined)
  const next = await open({ relay: link.relay, hostId: link.host, mode: "pair", id: link.id, psk: link.secret }).catch(
    (error: unknown) => {
      if (current !== generation) return undefined
      const code = (error as { code?: RemoteErrorCode }).code ?? classify(error)
      setErrorCode(code === "revoked" ? "expired" : code)
      setStatus("error")
      return undefined
    },
  )
  if (!next) return false
  const enrolled = await new Promise<RemoteHost | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 15_000)
    next.onControl((message) => {
      if (message.type !== "enrolled" || typeof message.deviceId !== "string" || typeof message.deviceKey !== "string")
        return
      clearTimeout(timer)
      resolve({
        hostId: link.host,
        relay: link.relay,
        name: typeof message.hostName === "string" ? message.hostName : link.name,
        deviceId: message.deviceId,
        deviceKey: message.deviceKey,
        pairedAt: Date.now(),
      })
    })
    next.onClose(() => resolve(undefined))
  })
  if (!enrolled || current !== generation) {
    next.close()
    if (current === generation) {
      setErrorCode("failed")
      setStatus("error")
    }
    return false
  }
  saveHosts([...hosts().filter((entry) => entry.hostId !== enrolled.hostId), enrolled])
  saveActive(enrolled.hostId)
  attach(next, enrolled, current)
  return true
}

export const remote = {
  hosts,
  status,
  errorCode,
  activeHost: () => hosts().find((host) => host.hostId === activeHostId()),

  connect(hostId: string) {
    saveActive(hostId)
    void connectHost(hostId)
  },

  retry() {
    const hostId = activeHostId()
    if (hostId) void connectHost(hostId)
  },

  disconnect() {
    generation++
    clearTimeout(retryTimer)
    saveActive(undefined)
    tunnel?.close()
    tunnel = undefined
    setEngineTransport(undefined)
    setErrorCode(undefined)
    setStatus("idle")
  },

  forget(hostId: string) {
    if (activeHostId() === hostId) remote.disconnect()
    saveHosts(hosts().filter((host) => host.hostId !== hostId))
  },

  pair,

  /** Pairs from a `#remote=` link in the current URL, removing it from the address bar. */
  consumePairingLink() {
    if (desktopRemote()) return undefined
    const link = parsePairingHash(window.location.hash)
    if (!link) return undefined
    history.replaceState(null, "", window.location.pathname + window.location.search)
    return pair(link)
  },

  /** Reconnects to the last active host on startup. */
  resume() {
    if (desktopRemote()) return
    const hostId = activeHostId()
    if (hostId && hosts().some((host) => host.hostId === hostId)) void connectHost(hostId)
  },
}
