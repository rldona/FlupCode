import { concat, fromBase64Url, random, toBase64Url, utf8, type Bytes } from "./bytes"

/**
 * Web Push for remote control (ADR-0011). The host encrypts the payload for the phone (RFC 8291,
 * `aes128gcm`); the relay only signs the VAPID token (RFC 8292) and delivers the opaque body.
 */

export type PushSubscriptionKeys = { endpoint: string; keys: { p256dh: string; auth: string } }

/** What the phone shows; its service worker words it in the phone's language. */
export type PushNotification = {
  kind: "permission" | "question" | "finished" | "failed"
  /** Relay host id and name of the computer that sent it. */
  host: string
  hostName: string
  sessionID: string
  /** Session title. */
  session: string
  /** The permission action or the question, when there is one. */
  detail?: string
}

/** The private key is a P-256 JWK (`kty`, `crv`, `x`, `y`, `d`). */
export type VapidKeys = {
  publicKey: string
  privateKey: { kty?: string; crv?: string; x?: string; y?: string; d?: string }
}

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>

const RECORD_SIZE = 4096
/** Push services accept 4096 bytes of body; header (86) + padding delimiter (1) + tag (16) leave this. */
export const MAX_PUSH_PAYLOAD = RECORD_SIZE - 86 - 1 - 16

/** Hosts of the browser push services a relay may deliver to. */
const PUSH_SERVICE_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
]

export function isPushServiceEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint)
    return url.protocol === "https:" && url.port === "" && PUSH_SERVICE_HOSTS.some((host) => host.test(url.hostname))
  } catch {
    return false
  }
}

export function isPushSubscription(value: unknown): value is PushSubscriptionKeys {
  if (typeof value !== "object" || value === null) return false
  const subscription = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  return (
    typeof subscription.endpoint === "string" &&
    typeof subscription.keys?.p256dh === "string" &&
    typeof subscription.keys.auth === "string"
  )
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>) {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data))
}

/** Encrypts `payload` for a push subscription as an `aes128gcm` body (RFC 8291, RFC 8188). */
export async function encryptPushPayload(subscription: PushSubscriptionKeys, payload: Uint8Array) {
  if (payload.byteLength > MAX_PUSH_PAYLOAD) throw new Error("Push payload too large")
  const clientPublic = fromBase64Url(subscription.keys.p256dh)
  const authSecret = fromBase64Url(subscription.keys.auth)
  if (clientPublic.byteLength !== 65 || authSecret.byteLength < 16) throw new Error("Invalid push subscription keys")

  const server = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as {
    privateKey: Key
    publicKey: Key
  }
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", server.publicKey))
  const client = await crypto.subtle.importKey("raw", clientPublic, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: client }, server.privateKey, 256),
  )

  const prkKey = await hmac(authSecret, shared)
  const ikm = await hmac(
    prkKey,
    concat(utf8("WebPush: info"), Uint8Array.of(0), clientPublic, serverPublic, Uint8Array.of(1)),
  )
  const salt = random(16)
  const prk = await hmac(salt, ikm)
  const cek = (await hmac(prk, concat(utf8("Content-Encoding: aes128gcm"), Uint8Array.of(0, 1)))).slice(0, 16)
  const nonce = (await hmac(prk, concat(utf8("Content-Encoding: nonce"), Uint8Array.of(0, 1)))).slice(0, 12)

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(payload, Uint8Array.of(2))),
  )
  const header = new Uint8Array(21)
  header.set(salt)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = serverPublic.byteLength
  return concat(header, serverPublic, ciphertext)
}

export async function createVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as {
    privateKey: Key
    publicKey: Key
  }
  return {
    publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as VapidKeys["privateKey"],
  }
}

/** The `Authorization` header for a push request (RFC 8292). */
export async function vapidAuthorization(input: { endpoint: string; keys: VapidKeys; subject: string; now?: number }) {
  const segment = (value: unknown) => toBase64Url(utf8(JSON.stringify(value)))
  const exp = Math.floor((input.now ?? Date.now()) / 1000) + 12 * 60 * 60
  const unsigned = `${segment({ typ: "JWT", alg: "ES256" })}.${segment({ aud: new URL(input.endpoint).origin, exp, sub: input.subject })}`
  const key = await crypto.subtle.importKey(
    "jwk",
    input.keys.privateKey as Parameters<typeof crypto.subtle.importKey>[1] & { kty?: string },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(unsigned)))
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${input.keys.publicKey}`
}

export function encodePushNotification(notification: PushNotification): Bytes {
  const clip = (text: string, size: number) => (text.length > size ? `${text.slice(0, size - 1)}…` : text)
  return utf8(
    JSON.stringify({
      ...notification,
      hostName: clip(notification.hostName, 80),
      session: clip(notification.session, 120),
      ...(notification.detail === undefined ? {} : { detail: clip(notification.detail, 300) }),
    }),
  )
}
