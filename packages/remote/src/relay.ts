import { concat, fromBase64Url, random, toBase64Url, utf8, type Bytes } from "./bytes"

/** Relay framing and host authentication (ADR-0010). Everything here is visible to the relay. */

const LABEL = "flupcode-relay-v1"

export const RelayClose = {
  hostOffline: 4404,
  hostGone: 4410,
  limit: 4429,
  unauthorized: 4401,
} as const

export type RelayMessage =
  | { t: "challenge"; nonce: string }
  | { t: "auth"; key: string; signature: string }
  | { t: "ready" }
  | { t: "open"; channel: number }
  | { t: "close"; channel: number }
  /** Host asks the relay to deliver an already encrypted Web Push body (ADR-0011). */
  | { t: "push"; id: number; endpoint: string; body: string; ttl: number; urgency: PushUrgency }
  | { t: "push-result"; id: number; status: number }

export type PushUrgency = "very-low" | "low" | "normal" | "high"
const URGENCIES = new Set(["very-low", "low", "normal", "high"])

export function encodeRelayMessage(message: RelayMessage) {
  return JSON.stringify(message)
}

export function decodeRelayMessage(raw: string): RelayMessage | undefined {
  const value = (() => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  })()
  if (typeof value !== "object" || value === null || !("t" in value)) return undefined
  const message = value as Record<string, unknown>
  if (message.t === "challenge" && typeof message.nonce === "string") return { t: "challenge", nonce: message.nonce }
  if (message.t === "auth" && typeof message.key === "string" && typeof message.signature === "string")
    return { t: "auth", key: message.key, signature: message.signature }
  if (message.t === "ready") return { t: "ready" }
  if ((message.t === "open" || message.t === "close") && Number.isInteger(message.channel))
    return { t: message.t, channel: message.channel as number }
  if (
    message.t === "push" &&
    Number.isInteger(message.id) &&
    typeof message.endpoint === "string" &&
    typeof message.body === "string" &&
    Number.isInteger(message.ttl) &&
    URGENCIES.has(message.urgency as string)
  )
    return {
      t: "push",
      id: message.id as number,
      endpoint: message.endpoint,
      body: message.body,
      ttl: message.ttl as number,
      urgency: message.urgency as PushUrgency,
    }
  if (message.t === "push-result" && Number.isInteger(message.id) && Number.isInteger(message.status))
    return { t: "push-result", id: message.id as number, status: message.status as number }
  return undefined
}

/** Host→relay and relay→host binary frames carry a 4-byte big-endian channel prefix. */
export function withChannel(channel: number, data: Uint8Array) {
  const head = new Uint8Array(4)
  new DataView(head.buffer).setUint32(0, channel)
  return concat(head, data)
}

export function splitChannel(data: Bytes) {
  if (data.byteLength < 4) return undefined
  return { channel: new DataView(data.buffer, data.byteOffset).getUint32(0), payload: data.subarray(4) }
}

export async function hostIdFromKey(raw: Uint8Array<ArrayBuffer>) {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", raw))).slice(0, 22)
}

function signedData(hostId: string, nonce: string) {
  return concat(utf8(LABEL), Uint8Array.of(0), utf8(hostId), Uint8Array.of(0), fromBase64Url(nonce))
}

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const
const SIGNATURE = { name: "ECDSA", hash: "SHA-256" } as const

/** A host identity: an ECDSA P-256 key pair whose public key hash is the relay host id. */
export async function createHostIdentity() {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"])
  return {
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  }
}

export type HostIdentity = Awaited<ReturnType<typeof createHostIdentity>>

export async function loadHostIdentity(identity: HostIdentity) {
  const publicKey = await crypto.subtle.importKey("jwk", identity.publicKey, ALGORITHM, true, ["verify"])
  const privateKey = await crypto.subtle.importKey("jwk", identity.privateKey, ALGORITHM, false, ["sign"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey))
  const hostId = await hostIdFromKey(raw)
  return {
    hostId,
    async answer(nonce: string): Promise<RelayMessage> {
      const signature = new Uint8Array(await crypto.subtle.sign(SIGNATURE, privateKey, signedData(hostId, nonce)))
      return { t: "auth", key: toBase64Url(raw), signature: toBase64Url(signature) }
    },
  }
}

export function createChallenge(): RelayMessage & { t: "challenge" } {
  return { t: "challenge", nonce: toBase64Url(random(32)) }
}

/** Relay side: check that an `auth` answer proves ownership of `hostId`. */
export async function verifyHostAnswer(hostId: string, nonce: string, answer: { key: string; signature: string }) {
  try {
    const raw = fromBase64Url(answer.key)
    if ((await hostIdFromKey(raw)) !== hostId) return false
    const key = await crypto.subtle.importKey("raw", raw, ALGORITHM, false, ["verify"])
    return await crypto.subtle.verify(SIGNATURE, key, fromBase64Url(answer.signature), signedData(hostId, nonce))
  } catch {
    return false
  }
}
