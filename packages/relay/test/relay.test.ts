import { afterAll, describe, expect, test } from "bun:test"
import {
  acceptChannel,
  connectChannel,
  connectRelayClient,
  createHostIdentity,
  createRemoteHost,
  createTunnelClient,
  fromBase64Url,
  HandshakeError,
  loadHostIdentity,
  parsePairingHash,
  random,
  RelayClose,
  RelayConnectError,
  serveTunnel,
  startRelayHost,
  type RelayHostStatus,
  type RemoteHostStore,
} from "@flupcode/remote"
import { startRelay } from "../src/relay"

const engine = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/global/health")
      return Response.json({ healthy: true, auth: request.headers.get("authorization") })
    return new Response("not found", { status: 404 })
  },
})

const relay = startRelay({ port: 0, hostname: "127.0.0.1", maxClientsPerHost: 2 })

afterAll(() => {
  relay.stop()
  engine.stop(true)
})

function waitFor(check: () => boolean, timeout = 3000) {
  const started = Date.now()
  return new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve()
      if (Date.now() - started > timeout) return reject(new Error("timed out"))
      setTimeout(tick, 10)
    }
    tick()
  })
}

async function onlineHost(psk: Uint8Array<ArrayBuffer>) {
  const identity = await createHostIdentity()
  const statuses: RelayHostStatus[] = []
  const host = startRelayHost({
    relay: relay.url,
    identity,
    onStatus: (status) => statuses.push(status),
    onChannel: (wire) =>
      void acceptChannel(wire, () => psk)
        .then((accepted) =>
          serveTunnel(accepted.channel, { target: `http://127.0.0.1:${engine.port}`, credentials: "abc" }),
        )
        .catch(() => undefined),
  })
  await waitFor(() => statuses.at(-1) === "online")
  return { identity, host, hostId: await host.hostId, statuses }
}

describe("relay", () => {
  test("answers health checks", async () => {
    const response = await fetch(relay.url.replace("ws", "http") + "/health")
    expect(await response.json()).toEqual({ ok: true })
  })

  test("routes an end-to-end encrypted tunnel from a client to the host engine", async () => {
    const psk = random(32)
    const { host, hostId } = await onlineHost(psk)
    const wire = await connectRelayClient({ relay: relay.url, hostId })
    const tunnel = createTunnelClient(await connectChannel(wire, { mode: "device", id: "d1", psk }))
    const response = await tunnel.fetch("https://remote.invalid/global/health")
    expect(await response.json()).toEqual({ healthy: true, auth: "Basic abc" })
    tunnel.close()
    await waitFor(() => relay.stats().clients === 0)
    host.stop()
    await waitFor(() => relay.stats().hosts === 0)
  })

  test("a rejected pairing surfaces as a handshake error in browsers", async () => {
    const statuses: RelayHostStatus[] = []
    const host = startRelayHost({
      relay: relay.url,
      identity: await createHostIdentity(),
      onStatus: (status) => statuses.push(status),
      onChannel: (wire) => void acceptChannel(wire, () => undefined).catch(() => undefined),
    })
    await waitFor(() => statuses.at(-1) === "online")
    const hostId = await host.hostId
    // Browsers throw when a script closes a WebSocket with a protocol code such as 1008.
    const browserSocket = (url: string) => {
      const socket = new WebSocket(url)
      const close = socket.close.bind(socket)
      socket.close = (code?: number, reason?: string) => {
        if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999))
          throw new DOMException(`The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`)
        close(code, reason)
      }
      return socket
    }
    const wire = await connectRelayClient({ relay: relay.url, hostId, createSocket: browserSocket })
    const error = await connectChannel(wire, { mode: "pair", id: "unknown", psk: random(32) }).catch(
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(HandshakeError)
    expect((error as HandshakeError).message).toBe("Rejected by host")
    host.stop()
    await waitFor(() => relay.stats().hosts === 0)
  })

  test("closes clients with 4404 when the host is offline", async () => {
    const identity = await loadHostIdentity(await createHostIdentity())
    const error = await connectRelayClient({ relay: relay.url, hostId: identity.hostId }).catch(
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(RelayConnectError)
    expect((error as RelayConnectError).code).toBe(RelayClose.hostOffline)
  })

  test("rejects a host that cannot prove its id", async () => {
    const victim = await loadHostIdentity(await createHostIdentity())
    // Create the attacker before connecting: the challenge can arrive before an awaited step ends.
    const attacker = await loadHostIdentity(await createHostIdentity())
    const socket = new WebSocket(`${relay.url}/host?id=${victim.hostId}`)
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { t: string; nonce: string }
      if (message.t === "challenge")
        void attacker.answer(message.nonce).then((answer) => socket.send(JSON.stringify(answer)))
    }
    const code = await new Promise<number>((resolve) => (socket.onclose = (event) => resolve(event.code)))
    expect(code).toBe(RelayClose.unauthorized)
  })

  test("limits clients per host", async () => {
    const psk = random(32)
    const { host, hostId } = await onlineHost(psk)
    const first = await connectRelayClient({ relay: relay.url, hostId })
    const second = await connectRelayClient({ relay: relay.url, hostId })
    const third = await connectRelayClient({ relay: relay.url, hostId }).catch((cause: unknown) => cause)
    expect((third as RelayConnectError).code).toBe(RelayClose.limit)
    first.close()
    second.close()
    host.stop()
    await waitFor(() => relay.stats().hosts === 0)
  })

  test("a reconnecting host replaces the old socket and drops its clients", async () => {
    const psk = random(32)
    const { identity, host, hostId } = await onlineHost(psk)
    const wire = await connectRelayClient({ relay: relay.url, hostId })
    const closed = new Promise<void>((resolve) => wire.onClose(resolve))
    const statuses: RelayHostStatus[] = []
    const replacement = startRelayHost({
      relay: relay.url,
      identity,
      onChannel: () => {},
      onStatus: (status) => statuses.push(status),
    })
    await closed
    await waitFor(() => statuses.at(-1) === "online")
    expect(relay.stats().hosts).toBe(1)
    host.stop()
    replacement.stop()
    await waitFor(() => relay.stats().hosts === 0)
  })

  test("the host reconnects after the relay restarts", async () => {
    const first = startRelay({ port: 0, hostname: "127.0.0.1" })
    const port = first.server.port
    const statuses: RelayHostStatus[] = []
    const host = startRelayHost({
      relay: first.url,
      identity: await createHostIdentity(),
      onChannel: () => {},
      onStatus: (status) => statuses.push(status),
    })
    await waitFor(() => statuses.at(-1) === "online")
    first.stop()
    await waitFor(() => statuses.at(-1) === "connecting")
    const second = startRelay({ port, hostname: "127.0.0.1" })
    await waitFor(() => statuses.at(-1) === "online" && second.stats().hosts === 1, 5000)
    host.stop()
    second.stop()
  })
})

describe("remote host", () => {
  test("pairs a device, lets it reconnect, and rejects it once revoked", async () => {
    let store: RemoteHostStore = { enabled: true, devices: [] }
    const host = createRemoteHost({
      load: () => store,
      save: (next) => (store = structuredClone(next)),
      engine: `http://127.0.0.1:${engine.port}`,
      engineCredentials: "abc",
      defaultRelay: relay.url,
      appUrl: "https://app.flupcode.test/",
      hostName: "test-mac",
      secureStorage: false,
    })
    await host.ready
    await waitFor(() => host.state().connection === "online")

    const link = parsePairingHash(new URL((await host.createPairing()).pairing!.url).hash)!
    expect(link.name).toBe("test-mac")
    const paired = createTunnelClient(
      await connectChannel(await connectRelayClient({ relay: relay.url, hostId: link.host }), {
        mode: "pair",
        id: link.id,
        psk: fromBase64Url(link.secret),
      }),
    )
    const enrolled = await new Promise<{ deviceId: string; deviceKey: string }>((resolve) =>
      paired.onControl((message) =>
        resolve({ deviceId: String(message.deviceId), deviceKey: String(message.deviceKey) }),
      ),
    )
    expect(host.state().pairing).toBeUndefined()
    expect(store.devices.map((device) => device.id)).toEqual([enrolled.deviceId])
    paired.close()

    const reconnect = async () =>
      createTunnelClient(
        await connectChannel(await connectRelayClient({ relay: relay.url, hostId: link.host }), {
          mode: "device",
          id: enrolled.deviceId,
          psk: fromBase64Url(enrolled.deviceKey),
        }),
      )
    const device = await reconnect()
    const response = await device.fetch("https://remote.invalid/global/health")
    expect(await response.json()).toEqual({ healthy: true, auth: "Basic abc" })
    await waitFor(() => host.state().devices[0]?.connected === true)

    const closed = new Promise<void>((resolve) => device.onClose(resolve))
    host.revokeDevice(enrolled.deviceId)
    await closed
    expect(await reconnect().catch((error: unknown) => error)).toBeInstanceOf(HandshakeError)

    host.stop()
    await waitFor(() => relay.stats().hosts === 0)
  })
})
