import { fromBase64Url, random, toBase64Url } from "./bytes"
import type { RemoteControl, RemoteHostState } from "./bridge"
import { acceptChannel, type SecureChannel } from "./channel"
import { startRelayHost, type RelayHostStatus } from "./connect"
import { PAIRING_TTL, pairingUrl } from "./pairing"
import { createHostIdentity, type HostIdentity } from "./relay"
import { serveTunnel } from "./tunnel"
import type { Wire } from "./wire"

/**
 * A remote control host: relay connection, one-time pairing, paired devices and the engine tunnel.
 * Runtime-agnostic; the desktop app and the `flupcode remote` CLI supply storage and presentation.
 */

export type StoredDevice = { id: string; name: string; key: string; createdAt: number; lastSeen: number }

export type RemoteHostStore = { enabled: boolean; relay?: string; identity?: HostIdentity; devices: StoredDevice[] }

export type RemoteHostOptions = {
  load: () => RemoteHostStore
  save: (store: RemoteHostStore) => void
  /** Engine base URL, e.g. `http://127.0.0.1:4096`. */
  engine: string
  /** `base64(user:pass)` when the engine requires Basic auth. */
  engineCredentials?: string
  defaultRelay: string
  /** Web app that opens pairing links, e.g. `https://app.flupcode.com/`. */
  appUrl: string
  hostName: string
  /** Whether `save` encrypts secrets at rest; shown to the user. */
  secureStorage: boolean
  onChange?: (state: RemoteHostState) => void
}

export function createRemoteHost(options: RemoteHostOptions) {
  let stored = options.load()
  let connection: RelayHostStatus = "offline"
  let detail: string | undefined
  let hostId: string | undefined
  let pairing: { id: string; secret: Uint8Array<ArrayBuffer>; expiresAt: number; url: string } | undefined
  let pairingTimer: ReturnType<typeof setTimeout> | undefined
  let relayHost: ReturnType<typeof startRelayHost> | undefined
  const live = new Map<string, Set<SecureChannel>>()

  const relay = () => stored.relay ?? options.defaultRelay
  const save = () => options.save(stored)

  const state = (): RemoteHostState => ({
    enabled: stored.enabled,
    connection,
    detail,
    relay: relay(),
    hostId,
    hostName: options.hostName,
    devices: stored.devices.map((device) => ({
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      lastSeen: device.lastSeen,
      connected: (live.get(device.id)?.size ?? 0) > 0,
    })),
    pairing: pairing && { url: pairing.url, expiresAt: pairing.expiresAt },
    secureStorage: options.secureStorage,
  })

  const notify = () => options.onChange?.(state())

  const clearPairing = () => {
    clearTimeout(pairingTimer)
    pairing = undefined
  }

  const findDevice = (id: string) => stored.devices.find((device) => device.id === id)

  const track = (deviceId: string, channel: SecureChannel) => {
    const channels = live.get(deviceId) ?? new Set()
    channels.add(channel)
    live.set(deviceId, channels)
    channel.onClose(() => {
      channels.delete(channel)
      const device = findDevice(deviceId)
      if (device) {
        device.lastSeen = Date.now()
        save()
      }
      notify()
    })
  }

  const enrol = () => {
    clearPairing()
    const device: StoredDevice = {
      id: toBase64Url(random(16)),
      name: "Phone",
      key: toBase64Url(random(32)),
      createdAt: Date.now(),
      lastSeen: Date.now(),
    }
    stored.devices.push(device)
    save()
    return device
  }

  const handleChannel = (wire: Wire) =>
    void acceptChannel(wire, (mode, id) => {
      if (mode === "pair") return pairing?.id === id && pairing.expiresAt > Date.now() ? pairing.secret : undefined
      const device = findDevice(id)
      return device ? fromBase64Url(device.key) : undefined
    })
      .then((accepted) => {
        const tunnel = serveTunnel(accepted.channel, { target: options.engine, credentials: options.engineCredentials })
        const device = accepted.mode === "device" ? findDevice(accepted.id) : enrol()
        if (!device) return accepted.channel.close()
        if (accepted.mode === "pair")
          tunnel.sendControl({
            type: "enrolled",
            deviceId: device.id,
            deviceKey: device.key,
            hostName: options.hostName,
          } satisfies RemoteControl)
        tunnel.onControl((message) => {
          if (message.type !== "device" || typeof message.name !== "string") return
          device.name = message.name.slice(0, 64) || device.name
          save()
          notify()
        })
        device.lastSeen = Date.now()
        track(device.id, accepted.channel)
        notify()
      })
      .catch(() => undefined)

  const start = () => {
    if (relayHost || !stored.enabled || !stored.identity) return
    relayHost = startRelayHost({
      relay: relay(),
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
  })().then(start)

  return {
    ready,
    state,

    async setEnabled(enabled: boolean) {
      await ready
      stored.enabled = enabled
      save()
      if (enabled) start()
      else stop()
      notify()
      return state()
    },

    async setRelay(value: string) {
      await ready
      const next = value.trim()
      if (!/^wss?:\/\/\S+$/.test(next)) throw new Error("Relay URL must start with wss:// or ws://")
      stored.relay = next === options.defaultRelay ? undefined : next
      save()
      stop()
      start()
      notify()
      return state()
    },

    async createPairing() {
      await ready
      if (!stored.enabled) throw new Error("Enable remote control first")
      const id = hostId ?? (await relayHost?.hostId)
      if (!id) throw new Error("Remote control is not running")
      clearPairing()
      const secret = random(32)
      const pairingId = toBase64Url(random(16))
      pairing = {
        id: pairingId,
        secret,
        expiresAt: Date.now() + PAIRING_TTL,
        url: pairingUrl(options.appUrl, {
          v: 1,
          relay: relay(),
          host: id,
          id: pairingId,
          secret: toBase64Url(secret),
          name: options.hostName,
        }),
      }
      pairingTimer = setTimeout(() => {
        clearPairing()
        notify()
      }, PAIRING_TTL)
      notify()
      return state()
    },

    cancelPairing() {
      clearPairing()
      notify()
      return state()
    },

    revokeDevice(id: string) {
      stored.devices = stored.devices.filter((device) => device.id !== id)
      save()
      live.get(id)?.forEach((channel) => channel.close())
      live.delete(id)
      notify()
      return state()
    },

    stop,
  }
}

export type RemoteHost = ReturnType<typeof createRemoteHost>
