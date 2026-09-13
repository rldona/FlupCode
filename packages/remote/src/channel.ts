import { concat, equal, fromBase64Url, random, text, toBase64Url, utf8, type Bytes } from "./bytes"
import { Wire } from "./wire"

/** End-to-end secure channel (ADR-0010): ECDH P-256 + PSK handshake, AES-GCM sealed frames. */

export type ChannelMode = "pair" | "device"

const LABEL = "flupcode-remote-v1"
const HANDSHAKE_TIMEOUT = 15_000

const Kind = {
  hello: 1,
  welcome: 2,
  finish: 3,
  reject: 4,
  sealed: 5,
} as const

export class HandshakeError extends Error {}

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>
type KeyPair = { privateKey: Key; publicKey: Key }

export type SecureChannel = {
  send(data: Bytes): void
  onMessage(listener: (data: Bytes) => void): void
  onClose(handler: () => void): void
  close(): void
  readonly closed: boolean
}

function frame(kind: number, body: Bytes): Bytes {
  return concat(Uint8Array.of(kind), body)
}

function json(kind: number, value: Record<string, string>) {
  return frame(kind, utf8(JSON.stringify(value)))
}

function parse(data: Bytes | undefined, kind: number) {
  if (!data) throw new HandshakeError("Connection closed during handshake")
  if (data[0] === Kind.reject) throw new HandshakeError("Rejected by host")
  if (data[0] !== kind) throw new HandshakeError("Unexpected handshake message")
  const value: unknown = JSON.parse(text(data.subarray(1)))
  if (typeof value !== "object" || value === null) throw new HandshakeError("Malformed handshake message")
  return value as Record<string, unknown>
}

function field(value: Record<string, unknown>, name: string) {
  const raw = value[name]
  if (typeof raw !== "string") throw new HandshakeError(`Missing ${name}`)
  return raw
}

function bytesField(value: Record<string, unknown>, name: string, size: number) {
  const bytes = fromBase64Url(field(value, name))
  if (bytes.byteLength !== size) throw new HandshakeError(`Invalid ${name}`)
  return bytes
}

async function ephemeral() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ])) as KeyPair
  return { pair, raw: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) }
}

async function derive(input: {
  mode: ChannelMode
  id: string
  psk: Bytes
  own: KeyPair
  peer: Bytes
  ephC: Bytes
  nonceC: Bytes
  ephH: Bytes
  nonceH: Bytes
}) {
  const peer = await crypto.subtle.importKey("raw", input.peer, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, input.own.privateKey, 256),
  )
  const transcript = concat(
    utf8(LABEL),
    Uint8Array.of(0),
    utf8(input.mode),
    Uint8Array.of(0),
    utf8(input.id),
    Uint8Array.of(0),
    input.ephC,
    input.nonceC,
    input.ephH,
    input.nonceH,
  )
  const material = await crypto.subtle.importKey("raw", concat(input.psk, shared), "HKDF", false, ["deriveBits"])
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: await crypto.subtle.digest("SHA-256", transcript),
        info: utf8(`${LABEL} keys`),
      },
      material,
      32 * 4 * 8,
    ),
  )
  const aes = (offset: number) =>
    crypto.subtle.importKey("raw", bits.slice(offset, offset + 32), "AES-GCM", false, ["encrypt", "decrypt"])
  const hmac = (offset: number) =>
    crypto.subtle.importKey("raw", bits.slice(offset, offset + 32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return {
    transcript,
    c2h: await aes(0),
    h2c: await aes(32),
    hostConfirm: await hmac(64),
    clientConfirm: await hmac(96),
  }
}

async function prove(key: Key, transcript: Bytes) {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, transcript))
}

function iv(counter: bigint) {
  const bytes = new Uint8Array(12)
  new DataView(bytes.buffer).setBigUint64(4, counter)
  return bytes
}

function seal(wire: Wire, outbound: Key, inbound: Key): SecureChannel {
  let sendCounter = 0n
  let receiveCounter = 0n
  let sending = Promise.resolve()
  let receiving = Promise.resolve()
  let listener: ((data: Bytes) => void) | undefined
  const backlog: Bytes[] = []

  wire.listen((data) => {
    receiving = receiving
      .then(async () => {
        if (wire.closed) return
        if (data[0] !== Kind.sealed) return wire.close(1002, "Unexpected frame")
        const counter = receiveCounter++
        const plain = await crypto.subtle
          .decrypt({ name: "AES-GCM", iv: iv(counter) }, inbound, data.subarray(1))
          .then((buffer) => new Uint8Array(buffer))
          .catch(() => undefined)
        if (!plain) return wire.close(1002, "Invalid frame")
        if (listener) return listener(plain)
        backlog.push(plain)
      })
      .catch(() => wire.close(1011, "Protocol error"))
  })

  return {
    send(data) {
      if (wire.closed) return
      const counter = sendCounter++
      const encrypted = crypto.subtle.encrypt({ name: "AES-GCM", iv: iv(counter) }, outbound, data)
      sending = sending
        .then(async () => wire.send(frame(Kind.sealed, new Uint8Array(await encrypted))))
        .catch(() => wire.close(1011, "Encryption failed"))
    },
    onMessage(next) {
      listener = next
      backlog.splice(0).forEach(next)
    },
    onClose(handler) {
      wire.onClose(handler)
    },
    close() {
      wire.close(1000)
    },
    get closed() {
      return wire.closed
    },
  }
}

function withTimeout<T>(wire: Wire, work: Promise<T>) {
  const timer = setTimeout(() => wire.close(1008, "Handshake timeout"), HANDSHAKE_TIMEOUT)
  return work
    .finally(() => clearTimeout(timer))
    .catch((error: unknown) => {
      wire.close(1008, "Handshake failed")
      throw error instanceof HandshakeError ? error : new HandshakeError(String(error))
    })
}

/** Client side: open a channel to a host with a pairing secret or a device key. */
export function connectChannel(wire: Wire, input: { mode: ChannelMode; id: string; psk: Bytes }) {
  return withTimeout(
    wire,
    (async () => {
      const own = await ephemeral()
      const nonceC = random(32)
      wire.send(
        json(Kind.hello, { mode: input.mode, id: input.id, eph: toBase64Url(own.raw), nonce: toBase64Url(nonceC) }),
      )
      const welcome = parse(await wire.next(), Kind.welcome)
      const ephH = bytesField(welcome, "eph", 65)
      const nonceH = bytesField(welcome, "nonce", 32)
      const keys = await derive({ ...input, own: own.pair, peer: ephH, ephC: own.raw, nonceC, ephH, nonceH })
      if (!equal(await prove(keys.hostConfirm, keys.transcript), bytesField(welcome, "proof", 32)))
        throw new HandshakeError("Host proof mismatch")
      wire.send(json(Kind.finish, { proof: toBase64Url(await prove(keys.clientConfirm, keys.transcript)) }))
      return seal(wire, keys.c2h, keys.h2c)
    })(),
  )
}

/** Host side: accept a channel, resolving the pre-shared key for the requested mode and id. */
export function acceptChannel(
  wire: Wire,
  lookup: (mode: ChannelMode, id: string) => Promise<Bytes | undefined> | Bytes | undefined,
) {
  return withTimeout(
    wire,
    (async () => {
      const hello = parse(await wire.next(), Kind.hello)
      const mode = field(hello, "mode")
      if (mode !== "pair" && mode !== "device") throw new HandshakeError("Invalid mode")
      const id = field(hello, "id")
      const ephC = bytesField(hello, "eph", 65)
      const nonceC = bytesField(hello, "nonce", 32)
      const psk = await lookup(mode, id)
      if (!psk) {
        wire.send(frame(Kind.reject, new Uint8Array(0)))
        throw new HandshakeError("Unknown id")
      }
      const own = await ephemeral()
      const nonceH = random(32)
      const keys = await derive({ mode, id, psk, own: own.pair, peer: ephC, ephC, nonceC, ephH: own.raw, nonceH })
      wire.send(
        json(Kind.welcome, {
          eph: toBase64Url(own.raw),
          nonce: toBase64Url(nonceH),
          proof: toBase64Url(await prove(keys.hostConfirm, keys.transcript)),
        }),
      )
      const finish = parse(await wire.next(), Kind.finish)
      if (!equal(await prove(keys.clientConfirm, keys.transcript), bytesField(finish, "proof", 32)))
        throw new HandshakeError("Client proof mismatch")
      return { channel: seal(wire, keys.h2c, keys.c2h), mode, id }
    })(),
  )
}
