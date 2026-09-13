import { describe, expect, test } from "bun:test"
import {
  acceptChannel,
  concat,
  connectChannel,
  HandshakeError,
  random,
  text,
  utf8,
  Wire,
  wirePair,
  type Bytes,
} from "../src"

function tap(wire: Wire, mutate: (data: Bytes) => Bytes | undefined) {
  return new Wire(
    (data) => {
      const next = mutate(data)
      if (next) wire.send(next)
    },
    (code, reason) => wire.close(code, reason),
  )
}

describe("secure channel", () => {
  test("pairs, then exchanges messages both ways", async () => {
    const [client, host] = wirePair()
    const psk = random(32)
    const [connected, accepted] = await Promise.all([
      connectChannel(client, { mode: "pair", id: "p1", psk }),
      acceptChannel(host, (mode, id) => (mode === "pair" && id === "p1" ? psk : undefined)),
    ])
    expect(accepted.mode).toBe("pair")
    expect(accepted.id).toBe("p1")

    const received: string[] = []
    const done = new Promise<void>((resolve) =>
      accepted.channel.onMessage((data) => {
        received.push(text(data))
        if (received.length === 3) resolve()
      }),
    )
    connected.send(utf8("one"))
    connected.send(utf8("two"))
    connected.send(utf8("three"))
    await done
    expect(received).toEqual(["one", "two", "three"])

    const reply = new Promise<string>((resolve) => connected.onMessage((data) => resolve(text(data))))
    accepted.channel.send(utf8("pong"))
    expect(await reply).toBe("pong")
  })

  test("rejects an unknown id", async () => {
    const [client, host] = wirePair()
    const [connected, accepted] = await Promise.allSettled([
      connectChannel(client, { mode: "device", id: "nope", psk: random(32) }),
      acceptChannel(host, () => undefined),
    ])
    expect(connected.status).toBe("rejected")
    expect(accepted.status).toBe("rejected")
    if (connected.status === "rejected") expect(connected.reason).toBeInstanceOf(HandshakeError)
  })

  test("fails when the keys differ", async () => {
    const [client, host] = wirePair()
    const [connected, accepted] = await Promise.allSettled([
      connectChannel(client, { mode: "device", id: "d1", psk: random(32) }),
      acceptChannel(host, () => random(32)),
    ])
    expect(connected.status).toBe("rejected")
    expect(accepted.status).toBe("rejected")
  })

  test("closes on a tampered sealed frame", async () => {
    const [client, host] = wirePair()
    let sealed = 0
    const tampered = tap(client, (data) => {
      if (data[0] !== 5 || ++sealed !== 2) return data
      const copy = data.slice()
      copy[copy.byteLength - 1]! ^= 1
      return copy
    })
    client.listen((data) => tampered.push(data))
    client.onClose(() => tampered.end())
    const psk = random(32)
    const [connected, accepted] = await Promise.all([
      connectChannel(tampered, { mode: "device", id: "d1", psk }),
      acceptChannel(host, () => psk),
    ])
    const received: string[] = []
    accepted.channel.onMessage((data) => received.push(text(data)))
    const closed = new Promise<void>((resolve) => accepted.channel.onClose(resolve))
    connected.send(utf8("ok"))
    connected.send(utf8("evil"))
    await closed
    expect(received).toEqual(["ok"])
  })

  test("closes on a replayed frame", async () => {
    const [client, host] = wirePair()
    let first: Bytes | undefined
    const replaying = tap(client, (data) => {
      if (data[0] !== 5) return data
      if (!first) {
        first = data
        return data
      }
      return first
    })
    client.listen((data) => replaying.push(data))
    const psk = random(32)
    const [connected, accepted] = await Promise.all([
      connectChannel(replaying, { mode: "device", id: "d1", psk }),
      acceptChannel(host, () => psk),
    ])
    const received: string[] = []
    accepted.channel.onMessage((data) => received.push(text(data)))
    const closed = new Promise<void>((resolve) => accepted.channel.onClose(resolve))
    connected.send(utf8("a"))
    connected.send(utf8("b"))
    await closed
    expect(received).toEqual(["a"])
  })

  test("carries large payloads", async () => {
    const [client, host] = wirePair()
    const psk = random(32)
    const [connected, accepted] = await Promise.all([
      connectChannel(client, { mode: "device", id: "d1", psk }),
      acceptChannel(host, () => psk),
    ])
    const payload = concat(random(300_000), utf8("end"))
    const received = new Promise<Bytes>((resolve) => accepted.channel.onMessage(resolve))
    connected.send(payload)
    expect(Buffer.from(await received).equals(Buffer.from(payload))).toBe(true)
  })
})
