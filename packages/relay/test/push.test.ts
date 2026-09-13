import { afterAll, describe, expect, test } from "bun:test"
import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto"
import {
  connectChannel,
  connectRelayClient,
  createRemoteHost,
  createTunnelClient,
  createHostIdentity,
  createVapidKeys,
  fromBase64Url,
  parsePairingHash,
  startRelayHost,
  toBase64Url,
  type RemoteHostStore,
} from "@flupcode/remote"
import { startRelay } from "../src/relay"

/** A fake engine whose event stream the test drives. */
const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>()
const emit = (type: string, data: Record<string, unknown>) =>
  listeners.forEach((listener) =>
    listener.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "evt", type, data })}\n\n`)),
  )
const engine = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/event") {
      let current: ReadableStreamDefaultController<Uint8Array>
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            current = controller
            listeners.add(controller)
          },
          cancel() {
            listeners.delete(current)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (url.pathname.startsWith("/api/session/")) return Response.json({ data: { title: "Fix the login flow" } })
    return new Response("not found", { status: 404 })
  },
})

/** A fake push service that records deliveries; `status` controls its answer. */
const deliveries: Array<{ path: string; headers: Headers; body: Uint8Array }> = []
let pushStatus = 201
const pushService = Bun.serve({
  port: 0,
  async fetch(request) {
    deliveries.push({
      path: new URL(request.url).pathname,
      headers: request.headers,
      body: new Uint8Array(await request.arrayBuffer()),
    })
    return new Response(null, { status: pushStatus })
  },
})

const vapid = await createVapidKeys()
const relay = startRelay({
  port: 0,
  hostname: "127.0.0.1",
  push: {
    keys: vapid,
    subject: "mailto:test@flupcode.com",
    perMinute: 5,
    allowEndpoint: (endpoint) => endpoint.startsWith(`http://127.0.0.1:${pushService.port}/`),
  },
})

afterAll(() => {
  relay.stop()
  engine.stop(true)
  pushService.stop(true)
})

function waitFor(check: () => boolean, timeout = 5000) {
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

function decrypt(body: Uint8Array, ecdh: ReturnType<typeof createECDH>, auth: Buffer) {
  const buffer = Buffer.from(body)
  const serverPublic = buffer.subarray(21, 21 + buffer[20]!)
  const ciphertext = buffer.subarray(21 + buffer[20]!)
  const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest()
  const ikm = hmac(
    hmac(auth, ecdh.computeSecret(serverPublic)),
    Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), serverPublic, Buffer.from([1])]),
  )
  const prk = hmac(buffer.subarray(0, 16), ikm)
  const decipher = createDecipheriv(
    "aes-128-gcm",
    hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16),
    hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12),
  )
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  return JSON.parse(plain.subarray(0, plain.length - 1).toString("utf8"))
}

describe("push notifications", () => {
  test("serves the VAPID public key to the web app", async () => {
    const response = await fetch(`${relay.url.replace("ws", "http")}/push/key`)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(await response.json()).toEqual({ publicKey: vapid.publicKey })
  })

  test("a paired phone receives encrypted notifications for engine events", async () => {
    let store: RemoteHostStore = { enabled: true, devices: [] }
    const host = createRemoteHost({
      load: () => store,
      save: (next) => (store = structuredClone(next)),
      engine: `http://127.0.0.1:${engine.port}`,
      defaultRelay: relay.url,
      appUrl: "https://app.flupcode.test/",
      hostName: "test-mac",
      secureStorage: false,
      finishDelay: 50,
    })
    await host.ready
    await waitFor(() => host.state().connection === "online" && listeners.size > 0)

    const link = parsePairingHash(new URL((await host.createPairing()).pairing!.url).hash)!
    const phone = createTunnelClient(
      await connectChannel(await connectRelayClient({ relay: relay.url, hostId: link.host }), {
        mode: "pair",
        id: link.id,
        psk: fromBase64Url(link.secret),
      }),
    )
    await new Promise((resolve) => phone.onControl(resolve))

    const ecdh = createECDH("prime256v1")
    ecdh.generateKeys()
    const auth = randomBytes(16)
    const endpoint = `http://127.0.0.1:${pushService.port}/push/phone-1`
    phone.sendControl({
      type: "push-subscription",
      subscription: { endpoint, keys: { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(auth) } },
    })
    await waitFor(() => host.state().devices[0]?.notifications === true)

    emit("permission.v2.asked", { id: "per_1", sessionID: "ses_1", action: "bash", resources: ["rm -rf dist"] })
    await waitFor(() => deliveries.length === 1)
    const delivery = deliveries[0]!
    expect(delivery.path).toBe("/push/phone-1")
    expect(delivery.headers.get("content-encoding")).toBe("aes128gcm")
    expect(delivery.headers.get("urgency")).toBe("high")
    expect(delivery.headers.get("authorization")).toMatch(
      new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`),
    )
    expect(decrypt(delivery.body, ecdh, auth)).toEqual({
      kind: "permission",
      sessionID: "ses_1",
      session: "Fix the login flow",
      detail: "bash: rm -rf dist",
      host: link.host,
      hostName: "test-mac",
    })

    // A step with tool calls does not finish the turn; the next one without them does.
    emit("session.next.step.ended", { sessionID: "ses_1", finish: "tool-calls" })
    emit("session.next.step.started", { sessionID: "ses_1" })
    emit("session.next.step.ended", { sessionID: "ses_1", finish: "stop" })
    await waitFor(() => deliveries.length === 2)
    expect(decrypt(deliveries[1]!.body, ecdh, auth).kind).toBe("finished")
    await Bun.sleep(150)
    expect(deliveries.length).toBe(2)

    // An expired subscription (410) is forgotten.
    pushStatus = 410
    emit("question.v2.asked", { id: "que_1", sessionID: "ses_1", questions: [{ question: "Which branch?" }] })
    await waitFor(() => host.state().devices[0]?.notifications === false)
    expect(store.devices[0]?.push).toBeUndefined()

    phone.close()
    host.stop()
    await waitFor(() => relay.stats().hosts === 0)
  })

  test("only delivers to push services, and only when push is configured", async () => {
    const guarded = startRelay({ port: 0, hostname: "127.0.0.1", push: { keys: vapid, subject: "mailto:x@y.z" } })
    const plain = startRelay({ port: 0, hostname: "127.0.0.1" })
    const send = async (url: string) => {
      const statuses: string[] = []
      const host = startRelayHost({
        relay: url,
        identity: await createHostIdentity(),
        onChannel: () => {},
        onStatus: (status) => statuses.push(status),
      })
      await waitFor(() => statuses.at(-1) === "online")
      const status = await host.sendPush({
        endpoint: `http://127.0.0.1:${pushService.port}/push/phone-1`,
        body: toBase64Url(new Uint8Array(100)),
        ttl: 60,
        urgency: "normal",
      })
      host.stop()
      return status
    }
    const before = deliveries.length
    expect(await send(guarded.url)).toBe(400)
    expect(await send(plain.url)).toBe(501)
    expect(deliveries.length).toBe(before)
    expect((await fetch(`${plain.url.replace("ws", "http")}/push/key`)).status).toBe(404)
    guarded.stop()
    plain.stop()
  })
})
