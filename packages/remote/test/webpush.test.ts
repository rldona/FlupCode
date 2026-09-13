import { describe, expect, test } from "bun:test"
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto"
import {
  createVapidKeys,
  encodePushNotification,
  encryptPushPayload,
  isPushServiceEndpoint,
  MAX_PUSH_PAYLOAD,
  toBase64Url,
  utf8,
  vapidAuthorization,
} from "../src"

/** A browser-side subscription: its ECDH key pair and auth secret. */
function subscriber() {
  const ecdh = createECDH("prime256v1")
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    ecdh,
    auth,
    subscription: {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(auth) },
    },
  }
}

/** Independent RFC 8291 / RFC 8188 decryption with node:crypto, as a push service client would. */
function decrypt(body: Uint8Array, client: ReturnType<typeof subscriber>) {
  const buffer = Buffer.from(body)
  const salt = buffer.subarray(0, 16)
  const recordSize = buffer.readUInt32BE(16)
  const idLength = buffer[20]!
  const serverPublic = buffer.subarray(21, 21 + idLength)
  const ciphertext = buffer.subarray(21 + idLength)
  const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest()
  const shared = client.ecdh.computeSecret(serverPublic)
  const prkKey = hmac(client.auth, shared)
  const ikm = hmac(
    prkKey,
    Buffer.concat([Buffer.from("WebPush: info\0"), client.ecdh.getPublicKey(), serverPublic, Buffer.from([1])]),
  )
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12)
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  return { recordSize, delimiter: plain[plain.length - 1], text: plain.subarray(0, plain.length - 1).toString("utf8") }
}

describe("web push", () => {
  test("encrypts a payload the subscriber can decrypt", async () => {
    const client = subscriber()
    const notification = {
      kind: "permission" as const,
      host: "h",
      hostName: "mac",
      sessionID: "ses_1",
      session: "Fix login",
      detail: "bash",
    }
    const payload = encodePushNotification(notification)
    const body = await encryptPushPayload(client.subscription, payload)
    const plain = decrypt(body, client)
    expect(plain.recordSize).toBe(4096)
    expect(plain.delimiter).toBe(2)
    expect(JSON.parse(plain.text)).toEqual(notification)
    expect(body.byteLength).toBeLessThanOrEqual(4096)
  })

  test("fits the largest payload in one record and rejects larger ones", async () => {
    const client = subscriber()
    const body = await encryptPushPayload(client.subscription, new Uint8Array(MAX_PUSH_PAYLOAD).fill(97))
    expect(body.byteLength).toBe(4096)
    expect(decrypt(body, client).text.length).toBe(MAX_PUSH_PAYLOAD)
    await expect(encryptPushPayload(client.subscription, new Uint8Array(MAX_PUSH_PAYLOAD + 1))).rejects.toThrow()
  })

  test("signs a VAPID token for the push service origin", async () => {
    const keys = await createVapidKeys()
    const header = await vapidAuthorization({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys,
      subject: "mailto:hello@flupcode.com",
      now: 1_000_000_000_000,
    })
    const match = header.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/)!
    expect(match[4]).toBe(keys.publicKey)
    expect(JSON.parse(Buffer.from(match[2]!, "base64url").toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: 1_000_000_000 + 43_200,
      sub: "mailto:hello@flupcode.com",
    })
    const publicKey = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: keys.privateKey.x!, y: keys.privateKey.y! },
      format: "jwk",
    })
    const valid = verify(
      "sha256",
      utf8(`${match[1]}.${match[2]}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(match[3]!, "base64url"),
    )
    expect(valid).toBe(true)
  })

  test("only allows browser push service endpoints", () => {
    expect(isPushServiceEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true)
    expect(isPushServiceEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true)
    expect(isPushServiceEndpoint("https://web.push.apple.com/x")).toBe(true)
    expect(isPushServiceEndpoint("https://wns2-db5p.notify.windows.com/w/?token=x")).toBe(true)
    expect(isPushServiceEndpoint("http://fcm.googleapis.com/x")).toBe(false)
    expect(isPushServiceEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false)
    expect(isPushServiceEndpoint("https://evil.example/fcm.googleapis.com")).toBe(false)
    expect(isPushServiceEndpoint("https://fcm.googleapis.com.evil.example/x")).toBe(false)
    expect(isPushServiceEndpoint("not a url")).toBe(false)
  })
})
