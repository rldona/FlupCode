import { describe, expect, test } from "bun:test"
import {
  createChallenge,
  createHostIdentity,
  decodeRelayMessage,
  loadHostIdentity,
  pairingUrl,
  parsePairingHash,
  splitChannel,
  utf8,
  verifyHostAnswer,
  withChannel,
} from "../src"

describe("relay framing", () => {
  test("prefixes and splits channels", () => {
    const framed = withChannel(70_000, utf8("abc"))
    const split = splitChannel(framed)
    expect(split?.channel).toBe(70_000)
    expect(new TextDecoder().decode(split?.payload)).toBe("abc")
    expect(splitChannel(new Uint8Array(3))).toBeUndefined()
  })

  test("decodes only well-formed messages", () => {
    expect(decodeRelayMessage('{"t":"open","channel":3}')).toEqual({ t: "open", channel: 3 })
    expect(decodeRelayMessage('{"t":"open","channel":"3"}')).toBeUndefined()
    expect(decodeRelayMessage("not json")).toBeUndefined()
  })
})

describe("host identity", () => {
  test("proves ownership of its host id", async () => {
    const identity = await loadHostIdentity(await createHostIdentity())
    const challenge = createChallenge()
    const answer = await identity.answer(challenge.nonce)
    if (answer.t !== "auth") throw new Error("expected auth")
    expect(await verifyHostAnswer(identity.hostId, challenge.nonce, answer)).toBe(true)
    expect(await verifyHostAnswer(identity.hostId, createChallenge().nonce, answer)).toBe(false)
    const other = await loadHostIdentity(await createHostIdentity())
    expect(await verifyHostAnswer(other.hostId, challenge.nonce, answer)).toBe(false)
    expect(await verifyHostAnswer(identity.hostId, challenge.nonce, { key: answer.key, signature: "AAAA" })).toBe(false)
  })
})

describe("pairing links", () => {
  test("round-trips through the URL fragment", () => {
    const link = { v: 1 as const, relay: "wss://relay.flupcode.com", host: "h", id: "p", secret: "s", name: "Mac" }
    const url = new URL(pairingUrl("https://app.flupcode.com/", link))
    expect(url.search).toBe("")
    expect(parsePairingHash(url.hash)).toEqual(link)
    expect(parsePairingHash("#other=1")).toBeUndefined()
    expect(parsePairingHash(`#remote=${btoa('{"v":1,"relay":"http://x"}')}`)).toBeUndefined()
  })
})
