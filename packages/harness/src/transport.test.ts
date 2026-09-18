import { afterEach, describe, expect, test } from "bun:test"
import { annotateLocalNetwork, askLocalNetwork, engineFetch } from "./transport"

const original = globalThis.fetch
type Sent = { input: RequestInfo | URL; init?: RequestInit }

/** A fetch that answers and keeps what it was called with, so the options can be read back. */
const capture = () => {
  const sent: Sent[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ input, init })
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  return sent
}

const space = (init: RequestInit | undefined) => (init as { targetAddressSpace?: string } | undefined)?.targetAddressSpace

afterEach(() => {
  globalThis.fetch = original
  annotateLocalNetwork(undefined)
})

describe("the local network annotation (H-45)", () => {
  // The failure #91 was reverted for: an annotation sent on its own moves every call behind the
  // browser's permission gate, and nothing works until somebody grants it.
  test("sends nothing at all until the permission is granted", async () => {
    const sent = capture()
    await engineFetch("http://127.0.0.1:4096/global/health")
    expect(space(sent[0]!.init)).toBeUndefined()
  })

  test("annotates with the space it was given once it is granted", async () => {
    const sent = capture()
    annotateLocalNetwork("loopback")
    await engineFetch("http://127.0.0.1:4096/global/health")
    expect(space(sent[0]!.init)).toBe("loopback")

    annotateLocalNetwork("local")
    await engineFetch("http://192.168.1.5:4096/global/health")
    expect(space(sent[1]!.init)).toBe("local")
  })

  test("forgets it when the engine is no longer local", async () => {
    const sent = capture()
    annotateLocalNetwork("local")
    annotateLocalNetwork(undefined)
    await engineFetch("http://192.168.1.5:4096/global/health")
    expect(space(sent[0]!.init)).toBeUndefined()
  })

  // The harness server and the engine are different addresses: declaring a remote as loopback makes
  // the browser fail the request, because it checks the resolved space against the declaration.
  test("leaves a request that is not going to that space alone", async () => {
    const sent = capture()
    annotateLocalNetwork("loopback")
    await engineFetch("https://harness.example.com/harness/runs")
    await engineFetch("http://192.168.1.5:4097/harness/runs")
    expect(space(sent[0]!.init)).toBeUndefined()
    expect(space(sent[1]!.init)).toBeUndefined()
  })

  test("the ask declares its space, and a refused or unreachable one is just no", async () => {
    const sent = capture()
    expect(await askLocalNetwork("http://127.0.0.1:4096/global/health", "loopback")).toBe(true)
    expect(space(sent[0]!.init)).toBe("loopback")

    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch")
    }) as unknown as typeof fetch
    expect(await askLocalNetwork("http://127.0.0.1:4096/global/health", "loopback")).toBe(false)
  })
})
