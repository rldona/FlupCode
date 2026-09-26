import { afterEach, expect, test } from "bun:test"
import { createClient, createHarnessClient, isSessionGone, probeServer, subscribeEvents } from "./client"
import { setEngineTransport } from "./transport"

afterEach(() => setEngineTransport(undefined))

/** An event stream that emits what it is given and then stays open without ever closing. */
function stream(frames: string[], onCancel?: () => void) {
  setEngineTransport({
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame))
          },
          cancel: onCancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    socket: () => {
      throw new Error("not used")
    },
  })
}

test("a stream that goes quiet is dropped instead of waited on forever", async () => {
  let cancelled = false
  stream([`data: ${JSON.stringify({ type: "server.connected" })}\n\n`], () => {
    cancelled = true
  })

  const seen: string[] = []
  const read = async () => {
    for await (const event of subscribeEvents("http://engine", undefined, "/api/event", 40)) {
      seen.push((event as { type?: string }).type ?? "")
    }
  }

  await expect(read()).rejects.toThrow()
  expect(seen).toEqual(["server.connected"])
  expect(cancelled).toBe(true)
})

test("a stream that keeps beating is not dropped", async () => {
  // Comment frames carry no event, which is exactly what `/api/event` beats with.
  stream([": heartbeat\n\n", `data: ${JSON.stringify({ type: "session.idle" })}\n\n`])

  const seen: string[] = []
  const controller = new AbortController()
  const read = async () => {
    for await (const event of subscribeEvents("http://engine", controller.signal, "/api/event", 40)) {
      seen.push((event as { type?: string }).type ?? "")
      controller.abort()
    }
  }

  await read().catch(() => undefined)
  expect(seen).toEqual(["session.idle"])
})

/** A transport that answers every message read with the same status and body. */
function engine(status: number, body: unknown) {
  setEngineTransport({
    fetch: async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      const payload = /\/message$/.test(url.pathname) ? body : { data: [] }
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
    },
    socket: () => {
      throw new Error("not used")
    },
  })
}

test("a session the engine no longer has is told apart from an engine that is away", async () => {
  engine(404, { _tag: "SessionNotFoundError", sessionID: "gone", message: "no such session" })
  const missing = await createClient("http://engine").message.list({ sessionID: "gone" }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(isSessionGone(missing)).toBe(true)

  // An engine that is away must not look like a session that is gone: the session stays put and the
  // transcript goes stale instead of being dropped.
  engine(503, { message: "engine away" })
  const away = await createClient("http://engine").message.list({ sessionID: "away" }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(isSessionGone(away)).toBe(false)
})

test("an engine that answers 401 is named as needing authentication, not as stopped", async () => {
  const answer = (status: number) => {
    setEngineTransport({
      fetch: async () => new Response("{}", { status }),
      socket: () => {
        throw new Error("not used")
      },
    })
    return probeServer("http://engine")
  }

  // A password-protected engine is reachable and handing back a refusal; the browser has no way to
  // send credentials, so the fix is neither "start it" nor "allow the origin".
  expect(await answer(401)).toBe("unauthorized")
  expect(await answer(403)).toBe("unauthorized")
  expect(await answer(200)).toBe("online")
})

test("an engine that does not answer at all is offline", async () => {
  setEngineTransport({
    fetch: async () => {
      throw new TypeError("Failed to fetch")
    },
    socket: () => {
      throw new Error("not used")
    },
  })

  expect(await probeServer("http://engine")).toBe("offline")
})

test("saving a credential drops the engine's cached providers, so the new key is the one used", async () => {
  const calls: string[] = []
  setEngineTransport({
    fetch: async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      calls.push(url.pathname)
      return new Response(JSON.stringify(true), { status: 200, headers: { "content-type": "application/json" } })
    },
    socket: () => {
      throw new Error("not used")
    },
  })

  const client = createClient("http://engine")
  await client.auth.set({ providerID: "opencode-go", key: "oc_sk_new" })
  await client.auth.reload()

  expect(calls).toEqual(["/auth/opencode-go", "/global/dispose"])
})

/** Records every request, and answers with an empty object the generated calls can unwrap. */
function recordingEngine(calls: Array<{ method: string; path: string }>) {
  setEngineTransport({
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      calls.push({ method: request.method.toUpperCase(), path: new URL(request.url).pathname })
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })
    },
    socket: () => {
      throw new Error("not used")
    },
  })
}

test("an MCP server added with the global scope is written to the global configuration", async () => {
  const calls: Array<{ method: string; path: string }> = []
  recordingEngine(calls)

  await createClient("http://engine").mcp.add({
    server: "srv",
    config: { type: "remote", url: "https://mcp.example" },
    scope: "global",
  })

  expect(calls.filter((call) => call.method === "PATCH")).toEqual([{ method: "PATCH", path: "/global/config" }])
})

test("an MCP server added with the project scope is written to the directory configuration", async () => {
  const calls: Array<{ method: string; path: string }> = []
  recordingEngine(calls)

  await createClient("http://engine").mcp.add({
    server: "srv",
    config: { type: "remote", url: "https://mcp.example" },
    scope: "project",
  })

  expect(calls.filter((call) => call.method === "PATCH")).toEqual([{ method: "PATCH", path: "/config" }])
})

test("updateGlobalConfig writes to the global configuration", async () => {
  const calls: Array<{ method: string; path: string }> = []
  recordingEngine(calls)

  await createClient("http://engine").updateGlobalConfig({ flupcode: { composeTools: [] } })

  expect(calls).toEqual([{ method: "PATCH", path: "/global/config" }])
})

test("reloadConfig re-reads the configuration for the directory it is given", async () => {
  const calls: Array<{ method: string; path: string; search: string }> = []
  setEngineTransport({
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(request.url)
      calls.push({ method: request.method.toUpperCase(), path: url.pathname, search: url.search })
      return new Response("true", { status: 200, headers: { "content-type": "application/json" } })
    },
    socket: () => {
      throw new Error("not used")
    },
  })

  await createClient("http://engine").reloadConfig({ directory: "/work/demo" })

  expect(calls).toEqual([{ method: "POST", path: "/config/reload", search: "?directory=%2Fwork%2Fdemo" }])
})

test("reloadConfig reports a response that is not ok", async () => {
  setEngineTransport({
    fetch: async () => new Response("{}", { status: 500 }),
    socket: () => {
      throw new Error("not used")
    },
  })

  await expect(createClient("http://engine").reloadConfig()).rejects.toThrow()
})

test("removing an MCP server clears it from both configurations and disconnects it", async () => {
  const calls: Array<{ method: string; path: string }> = []
  recordingEngine(calls)

  await createClient("http://engine").mcp.remove({ server: "srv" })

  const patches = calls
    .filter((call) => call.method === "PATCH")
    .map((call) => call.path)
    .sort()
  expect(patches).toEqual(["/config", "/global/config"])
  expect(calls.some((call) => call.path.endsWith("/disconnect"))).toBe(true)
})

type HarnessCall = { method: string; path: string; search: string; body?: unknown }

/** Records every harness-server request, and answers with an empty list the calls can unwrap. */
function recordingHarness(calls: HarnessCall[]) {
  setEngineTransport({
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(request.url)
      const text = request.method === "GET" ? "" : await request.text()
      calls.push({
        method: request.method.toUpperCase(),
        path: url.pathname,
        search: url.search,
        body: text ? JSON.parse(text) : undefined,
      })
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })
    },
    socket: () => {
      throw new Error("not used")
    },
  })
}

test("configFiles.list asks the harness for the folder's config files", async () => {
  const calls: HarnessCall[] = []
  recordingHarness(calls)

  await createHarnessClient("http://harness").configFiles.list({ directory: "/work/demo" })

  expect(calls).toEqual([
    { method: "GET", path: "/harness/config-files", search: "?directory=%2Fwork%2Fdemo", body: undefined },
  ])
})

test("configFiles.list with no folder asks for the global layers only", async () => {
  const calls: HarnessCall[] = []
  recordingHarness(calls)

  await createHarnessClient("http://harness").configFiles.list()

  expect(calls).toEqual([{ method: "GET", path: "/harness/config-files", search: "", body: undefined }])
})

test("configFiles.read names the file it wants to read", async () => {
  const calls: HarnessCall[] = []
  recordingHarness(calls)

  await createHarnessClient("http://harness").configFiles.read({ path: "/c/tool/hello.js", directory: "/work/demo" })

  expect(calls).toEqual([
    {
      method: "GET",
      path: "/harness/config-files/read",
      search: "?path=%2Fc%2Ftool%2Fhello.js&directory=%2Fwork%2Fdemo",
      body: undefined,
    },
  ])
})

test("agentBrowser control sends the loopback token and the session", async () => {
  const seen: Array<{ method: string; path: string; auth: string | null; session: string | null }> = []
  setEngineTransport({
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(request.url)
      seen.push({
        method: request.method.toUpperCase(),
        path: url.pathname,
        auth: request.headers.get("authorization"),
        session: request.headers.get("x-flupcode-session"),
      })
      return new Response(JSON.stringify({ data: { stopped: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    socket: () => {
      throw new Error("not used")
    },
  })
  const globalWindow = globalThis as { window?: unknown }
  const previous = globalWindow.window
  globalWindow.window = { flupcode: { browserToken: "tok" } }
  try {
    await createHarnessClient("http://harness").agentBrowser.stop("ses_1")
  } finally {
    globalWindow.window = previous
  }

  expect(seen).toEqual([{ method: "POST", path: "/harness/browser/stop", auth: "Bearer tok", session: "ses_1" }])
})

test("agentBrowser.frame returns the PNG blob and its artifact", async () => {
  setEngineTransport({
    fetch: async () =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png", "x-flupcode-artifact": "art1" },
      }),
    socket: () => {
      throw new Error("not used")
    },
  })

  const frame = await createHarnessClient("http://harness").agentBrowser.frame("ses_1")
  expect(frame.artifactId).toBe("art1")
  expect(frame.blob.size).toBe(4)
})

test("configFiles.export posts the chosen paths, and confirm only when asked", async () => {
  const calls: HarnessCall[] = []
  recordingHarness(calls)

  const client = createHarnessClient("http://harness")
  await client.configFiles.export({ directory: "/work/demo", paths: ["/c/tool/hello.js"] })
  await client.configFiles.export({ directory: "/work/demo", paths: ["/c/tool/hello.js"], confirm: true })

  expect(calls).toEqual([
    {
      method: "POST",
      path: "/harness/config-files/export",
      search: "",
      body: { directory: "/work/demo", paths: ["/c/tool/hello.js"] },
    },
    {
      method: "POST",
      path: "/harness/config-files/export",
      search: "",
      body: { directory: "/work/demo", paths: ["/c/tool/hello.js"], confirm: true },
    },
  ])
})

test("creating a routine keeps the warnings the server sent beside it", async () => {
  setEngineTransport({
    fetch: async () =>
      new Response(JSON.stringify({ data: { id: "r1", name: "Publish" }, warnings: ["Instructions are ignored."] }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    socket: () => {
      throw new Error("not used")
    },
  })

  const result = await createHarnessClient("http://harness").routines.create({
    name: "Publish",
    description: "",
    prompt: "",
    schedule: { type: "manual" },
  })

  expect(result.warnings).toEqual(["Instructions are ignored."])
  expect(result.data).toMatchObject({ id: "r1", name: "Publish" })
})

test("the action catalogue is asked for under /harness/actions", async () => {
  const seen: string[] = []
  setEngineTransport({
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      seen.push(new URL(request.url).pathname)
      return new Response(JSON.stringify({ data: { profiles: [], rejected: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    socket: () => {
      throw new Error("not used")
    },
  })

  await createHarnessClient("http://harness").actions.list()

  expect(seen).toEqual(["/harness/actions"])
})
