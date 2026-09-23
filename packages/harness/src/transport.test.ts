import { afterEach, describe, expect, test } from "bun:test"
import {
  annotateLocalNetwork,
  anonymousFetch,
  askLocalNetwork,
  engineFetch,
  setEngineTransport,
  withRequestTimeout,
} from "./transport"

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

describe("requests without the engine credentials", () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  // The desktop app hands the page the engine password; the harness server never asked for it, and
  // the header trips a CORS preflight it does not allow, which reads as "not reachable".
  const withEngineAuth = () => {
    ;(globalThis as { window?: unknown }).window = { flupcode: { engineAuth: "secret" } }
  }
  const authOf = (init: RequestInit | undefined) => new Headers(init?.headers).get("authorization")

  afterEach(() => {
    ;(globalThis as { window?: unknown }).window = originalWindow
    setEngineTransport(undefined)
  })

  test("the engine call carries them, the harness one does not", async () => {
    const sent = capture()
    withEngineAuth()
    await engineFetch("http://127.0.0.1:4096/global/health")
    await anonymousFetch("http://127.0.0.1:4097/harness/usage?days=30")
    expect(authOf(sent[0]!.init)).toBe("Basic secret")
    expect(authOf(sent[1]!.init)).toBeNull()
  })

  test("keeps the local network annotation", async () => {
    const sent = capture()
    annotateLocalNetwork("loopback")
    withEngineAuth()
    await anonymousFetch("http://127.0.0.1:4097/harness/runs")
    expect(space(sent[0]!.init)).toBe("loopback")
    expect(authOf(sent[0]!.init)).toBeNull()
  })

  test("still goes through the remote tunnel when one is active", async () => {
    const sent: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    setEngineTransport({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ input, init })
        return new Response("{}", { status: 200 })
      }) as typeof fetch,
      socket: () => {
        throw new Error("no socket in this test")
      },
    })
    await anonymousFetch("http://127.0.0.1:4097/harness/runs")
    expect(sent).toHaveLength(1)
    expect(String(sent[0]!.input)).toContain("/harness/runs")
  })
})

describe("the engine call deadline", () => {
  // A keep-alive socket the engine left behind after a restart never answers: without a deadline the
  // caller stays busy forever and the page stops sending.
  test("adds a signal when the caller gave none and the call is not a stream", () => {
    const init = withRequestTimeout("http://127.0.0.1:4096/global/health", undefined)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init?.signal?.aborted).toBe(false)
  })

  // The streams are meant to stay open, so the deadline must not reach them.
  test("leaves a request that asks for an event stream alone", () => {
    const init = { headers: { accept: "text/event-stream" } }
    expect(withRequestTimeout("http://127.0.0.1:4096/event", init)).toBe(init)
  })

  test("respects a signal the caller already provided", () => {
    const signal = AbortSignal.timeout(10)
    const init = { signal }
    expect(withRequestTimeout("http://127.0.0.1:4096/global/health", init)).toBe(init)
  })

  test("injects the deadline into what the transport actually receives", async () => {
    const sent = capture()
    await engineFetch("http://127.0.0.1:4096/global/health")
    expect(sent[0]!.init?.signal).toBeInstanceOf(AbortSignal)
    expect(sent[0]!.init?.signal?.aborted).toBe(false)
  })

  test("a Request that asks for an event stream gets no deadline", async () => {
    const sent = capture()
    await engineFetch(new Request("http://127.0.0.1:4096/event", { headers: { accept: "text/event-stream" } }))
    expect(sent[0]!.init?.signal).toBeUndefined()
  })

  // The generated SDK builds a `Request` for every call, and a `Request` always carries a signal of
  // its own. Reading that as "the caller brought a deadline" left every engine call without one, and
  // a dead socket after an engine restart pinned the composer on Stop until a reload.
  test("a Request from the SDK still gets the deadline", async () => {
    const sent = capture()
    await engineFetch(new Request("http://127.0.0.1:4096/session/ses_1/prompt_async", { method: "POST" }))
    expect(sent[0]!.init?.signal).toBeInstanceOf(AbortSignal)
    expect(sent[0]!.init?.signal?.aborted).toBe(false)
  })

  // These hold the connection open while a model answers or a shell command runs: slow work, not a
  // dead socket.
  test("leaves the routes that are legitimately long alone", async () => {
    const sent = capture()
    await engineFetch(new Request("http://127.0.0.1:4096/session/ses_1/shell", { method: "POST" }))
    await engineFetch(new Request("http://127.0.0.1:4096/session/ses_1/prompt", { method: "POST" }))
    await engineFetch(new Request("http://127.0.0.1:4096/api/session/ses_1/wait", { method: "POST" }))
    expect(sent.map((call) => call.init?.signal)).toEqual([undefined, undefined, undefined])
  })
})
