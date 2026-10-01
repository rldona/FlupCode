import { afterAll, describe, expect, test } from "bun:test"
import { setEngineTransport } from "../transport"
import { createV2Domains } from "./v2"

/**
 * An MCP sign-in that comes back as a code to paste (2.x's `code` attempt mode). 2.0.18 signs MCP
 * servers in through its own callback, so a real engine never offers it; this stand-in answers the
 * same routes the way the client contract describes, to prove the adapter takes the code to the engine.
 */
const now = Date.now()
const completed: Array<{ code?: string }> = []
let finished = false
const engine = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const path = new URL(request.url).pathname
    const location = { directory: "/work/demo" }
    if (path === "/api/mcp") return Response.json({ location, data: [{ name: "docs", integrationID: "int_docs" }] })
    if (path === "/api/integration/int_docs")
      return Response.json({
        location,
        data: { id: "int_docs", methods: [{ id: "oauth", type: "oauth" }], connections: [] },
      })
    if (path === "/api/integration/int_docs/connect/oauth")
      return Response.json({
        location,
        data: {
          attemptID: "con_1",
          url: "https://auth.example/authorize",
          instructions: "Copy the code shown after you sign in.",
          mode: "code",
          time: { created: now, expires: now + 60_000 },
        },
      })
    if (path === "/api/integration/int_docs/connect/oauth/con_1/complete") {
      completed.push((await request.json()) as { code?: string })
      finished = true
      return new Response(null, { status: 204 })
    }
    if (path === "/api/integration/int_docs/connect/oauth/con_1")
      return Response.json({
        location,
        data: { status: finished ? "complete" : "pending", time: { created: now, expires: now + 60_000 } },
      })
    return Response.json({ _tag: "NotFound" }, { status: 404 })
  },
})
setEngineTransport({
  fetch: (input, init) => fetch(input, init),
  socket: () => {
    throw new Error("not used")
  },
})

afterAll(() => {
  setEngineTransport(undefined)
  engine.stop(true)
})

describe("an MCP sign-in that needs a pasted code", () => {
  test("opens the page, says it wants a code, and hands the code the reader pastes to the engine", async () => {
    const opened: string[] = []
    const domains = createV2Domains(engine.url.href.replace(/\/$/, ""), { openUrl: (url) => void opened.push(url) })
    const started = await domains.mcp.authStart({ server: "docs" })
    expect(started).toMatchObject({
      authorizationUrl: "https://auth.example/authorize",
      code: true,
      instructions: "Copy the code shown after you sign in.",
    })
    expect(opened).toEqual(["https://auth.example/authorize"])

    await domains.mcp.authComplete({ server: "docs", code: "pasted-123" })
    expect(completed).toEqual([{ code: "pasted-123" }])
  })
})
