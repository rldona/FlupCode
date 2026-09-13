import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { BrowserWindow, app, ipcMain, safeStorage } from "electron"
import {
  acceptChannel,
  createHostIdentity,
  fromBase64Url,
  PAIRING_TTL,
  pairingUrl,
  random,
  serveTunnel,
  startRelayHost,
  toBase64Url,
  type HostIdentity,
  type RelayHostStatus,
  type RemoteControl,
  type RemoteHostState,
  type SecureChannel,
} from "@flupcode/remote"
import { SERVER_URL } from "./server"

/** Remote control host (ADR-0010): relay connection, pairing and paired devices. */

const DEFAULT_RELAY = process.env.FLUPCODE_RELAY_URL ?? "wss://relay.flupcode.com"
const APP_URL = process.env.FLUPCODE_APP_URL ?? "https://app.flupcode.com/"

type StoredDevice = { id: string; name: string; key: string; createdAt: number; lastSeen: number }
type Stored = { enabled: boolean; relay?: string; identity?: HostIdentity; devices: StoredDevice[] }
type Envelope = { v: 1; encrypted: boolean; data: string }

const EMPTY: Stored = { enabled: false, devices: [] }

function storeFile() {
  return join(app.getPath("userData"), "remote.json")
}

function readStore(): Stored {
  try {
    if (!existsSync(storeFile())) return EMPTY
    const envelope = JSON.parse(readFileSync(storeFile(), "utf8")) as Envelope
    const json = envelope.encrypted
      ? safeStorage.decryptString(Buffer.from(envelope.data, "base64"))
      : Buffer.from(envelope.data, "base64").toString("utf8")
    const stored = JSON.parse(json) as Partial<Stored>
    return {
      enabled: stored.enabled === true,
      relay: stored.relay,
      identity: stored.identity,
      devices: stored.devices ?? [],
    }
  } catch {
    return EMPTY
  }
}

function writeStore(stored: Stored) {
  const encrypted = safeStorage.isEncryptionAvailable()
  const json = JSON.stringify(stored)
  const envelope: Envelope = {
    v: 1,
    encrypted,
    data: encrypted ? safeStorage.encryptString(json).toString("base64") : Buffer.from(json).toString("base64"),
  }
  writeFileSync(storeFile(), JSON.stringify(envelope), { mode: 0o600 })
}

function engineCredentials() {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  return Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`).toString("base64")
}

export function initRemoteHost() {
  let stored = readStore()
  let connection: RelayHostStatus = "offline"
  let detail: string | undefined
  let hostId: string | undefined
  let pairing:
    | { id: string; secret: Uint8Array<ArrayBuffer>; expiresAt: number; url: string; timer: NodeJS.Timeout }
    | undefined
  let relayHost: ReturnType<typeof startRelayHost> | undefined
  const live = new Map<string, Set<SecureChannel>>()

  const save = () => writeStore(stored)

  const state = (): RemoteHostState => ({
    enabled: stored.enabled,
    connection,
    detail,
    relay: stored.relay ?? DEFAULT_RELAY,
    hostId,
    hostName: hostname(),
    devices: stored.devices.map((device) => ({
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      lastSeen: device.lastSeen,
      connected: (live.get(device.id)?.size ?? 0) > 0,
    })),
    pairing: pairing && { url: pairing.url, expiresAt: pairing.expiresAt },
    secureStorage: safeStorage.isEncryptionAvailable(),
  })

  const notify = () => {
    const snapshot = state()
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("flupcode:remote-changed", snapshot))
  }

  const clearPairing = () => {
    if (pairing) clearTimeout(pairing.timer)
    pairing = undefined
  }

  const track = (deviceId: string, channel: SecureChannel) => {
    const channels = live.get(deviceId) ?? new Set()
    channels.add(channel)
    live.set(deviceId, channels)
    channel.onClose(() => {
      channels.delete(channel)
      const device = stored.devices.find((entry) => entry.id === deviceId)
      if (device) {
        device.lastSeen = Date.now()
        save()
      }
      notify()
    })
  }

  const handleChannel = (wire: Parameters<Parameters<typeof startRelayHost>[0]["onChannel"]>[0]) =>
    void acceptChannel(wire, (mode, id) => {
      if (mode === "pair")
        return pairing && pairing.id === id && pairing.expiresAt > Date.now() ? pairing.secret : undefined
      const device = stored.devices.find((entry) => entry.id === id)
      return device ? fromBase64Url(device.key) : undefined
    })
      .then((accepted) => {
        const tunnel = serveTunnel(accepted.channel, { target: SERVER_URL, credentials: engineCredentials() })
        const deviceId =
          accepted.mode === "device"
            ? accepted.id
            : (() => {
                clearPairing()
                const key = random(32)
                const device: StoredDevice = {
                  id: toBase64Url(random(16)),
                  name: "Phone",
                  key: toBase64Url(key),
                  createdAt: Date.now(),
                  lastSeen: Date.now(),
                }
                stored.devices.push(device)
                save()
                tunnel.sendControl({
                  type: "enrolled",
                  deviceId: device.id,
                  deviceKey: device.key,
                  hostName: hostname(),
                } satisfies RemoteControl)
                return device.id
              })()
        tunnel.onControl((message) => {
          if (message.type !== "device" || typeof message.name !== "string") return
          const device = stored.devices.find((entry) => entry.id === deviceId)
          if (!device) return
          device.name = message.name.slice(0, 64) || device.name
          save()
          notify()
        })
        const device = stored.devices.find((entry) => entry.id === deviceId)
        if (device) device.lastSeen = Date.now()
        track(deviceId, accepted.channel)
        notify()
      })
      .catch(() => undefined)

  const start = () => {
    if (relayHost || !stored.enabled) return
    if (!stored.identity) return
    relayHost = startRelayHost({
      relay: stored.relay ?? DEFAULT_RELAY,
      identity: stored.identity,
      onChannel: handleChannel,
      onStatus: (status, reason) => {
        connection = status
        detail = reason
        notify()
      },
    })
    void relayHost.hostId.then((id) => {
      hostId = id
      notify()
    })
  }

  const stop = () => {
    clearPairing()
    relayHost?.stop()
    relayHost = undefined
    live.forEach((channels) => channels.forEach((channel) => channel.close()))
    connection = "offline"
    detail = undefined
  }

  const ready = (async () => {
    if (stored.identity) return
    stored = { ...stored, identity: await createHostIdentity() }
    save()
  })()

  void ready.then(start)

  ipcMain.handle("flupcode:remote-state", async () => {
    await ready
    return state()
  })

  ipcMain.handle("flupcode:remote-enable", async (_event, enabled: boolean) => {
    await ready
    stored.enabled = enabled === true
    save()
    if (stored.enabled) start()
    else stop()
    notify()
    return state()
  })

  ipcMain.handle("flupcode:remote-relay", async (_event, relay: string) => {
    await ready
    const value = String(relay).trim()
    if (!/^wss?:\/\/[^\s]+$/.test(value)) throw new Error("Relay URL must start with wss:// or ws://")
    stored.relay = value === DEFAULT_RELAY ? undefined : value
    save()
    stop()
    start()
    notify()
    return state()
  })

  ipcMain.handle("flupcode:remote-pair", async () => {
    await ready
    if (!stored.enabled) throw new Error("Enable remote control first")
    const id = hostId ?? (await relayHost?.hostId)
    if (!id) throw new Error("Remote control is not running")
    clearPairing()
    const secret = random(32)
    const pairingId = toBase64Url(random(16))
    const expiresAt = Date.now() + PAIRING_TTL
    pairing = {
      id: pairingId,
      secret,
      expiresAt,
      url: pairingUrl(APP_URL, {
        v: 1,
        relay: stored.relay ?? DEFAULT_RELAY,
        host: id,
        id: pairingId,
        secret: toBase64Url(secret),
        name: hostname(),
      }),
      timer: setTimeout(() => {
        clearPairing()
        notify()
      }, PAIRING_TTL),
    }
    notify()
    return state()
  })

  ipcMain.handle("flupcode:remote-cancel-pair", () => {
    clearPairing()
    notify()
    return state()
  })

  ipcMain.handle("flupcode:remote-revoke", (_event, id: string) => {
    stored.devices = stored.devices.filter((device) => device.id !== id)
    save()
    live.get(id)?.forEach((channel) => channel.close())
    live.delete(id)
    notify()
    return state()
  })

  return { stop }
}
