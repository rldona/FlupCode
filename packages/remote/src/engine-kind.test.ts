import { afterAll, describe, expect, test } from "bun:test"
import { detectEngine, openCodeV2Locked, openCodeV2Version } from "./engine-kind"

const html = () => new Response("<!doctype html><title>OpenCode</title>", { headers: { "content-type": "text/html" } })

// A 1.x engine: `/global/health`, and its web UI for every other path, `/api/info` included.
const v1 = Bun.serve({
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/global/health" ? Response.json({ healthy: true, version: "1.18.32" }) : html(),
})
// A 2.x engine: no `/global/health`, and `/api/info` with its version.
const v2 = Bun.serve({
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/api/info"
      ? Response.json({ version: "2.0.20", pid: 1, urls: [], paths: { tmp: "/tmp" } })
      : Response.json({ _tag: "NotFound" }, { status: 404 }),
})
// A 1.x engine behind a password: plain text, for every path.
const v1Locked = Bun.serve({ port: 0, fetch: () => new Response("Unauthorized", { status: 401 }) })
// Something else listening on the port, answering HTML for everything.
const other = Bun.serve({ port: 0, fetch: html })
// A 2.x engine that wants credentials the caller does not have.
const locked = Bun.serve({
  port: 0,
  fetch: (request) =>
    request.headers.get("authorization") === "Basic secret"
      ? Response.json({ version: "2.0.20", pid: 1, urls: [], paths: { tmp: "/tmp" } })
      : Response.json({ _tag: "UnauthorizedError" }, { status: 401 }),
})

afterAll(() => [v1, v2, other, locked, v1Locked].forEach((server) => server.stop(true)))

describe("detectEngine", () => {
  test("reads OpenCode 1.x from its health route", async () => {
    expect(await detectEngine(v1.url.href)).toEqual({ kind: "v1", version: "1.18.32" })
  })

  test("names OpenCode 2.x by the version it reports", async () => {
    expect(await detectEngine(v2.url.href)).toEqual({ kind: "v2", version: "2.0.20" })
  })

  test("does not mistake an HTML answer for either engine", async () => {
    expect(await detectEngine(other.url.href)).toEqual({ kind: "none" })
  })

  test("sends the caller's credentials", async () => {
    expect(await detectEngine(locked.url.href)).toEqual({ kind: "none" })
    expect(await detectEngine(locked.url.href, fetch, { headers: { authorization: "Basic secret" } })).toEqual({
      kind: "v2",
      version: "2.0.20",
    })
  })

  test("reports nothing when no engine listens", async () => {
    expect(await detectEngine("http://127.0.0.1:9")).toEqual({ kind: "none" })
  })
})

describe("openCodeV2Version", () => {
  test("is empty for a 1.x engine, whose web UI answers the path", async () => {
    expect(await openCodeV2Version(v1.url.href)).toBeUndefined()
  })
})

describe("openCodeV2Locked", () => {
  test("names a 2.x engine behind a password the caller does not have", async () => {
    expect(await openCodeV2Locked(locked.url.href)).toBe(true)
    expect(await openCodeV2Locked(locked.url.href, fetch, { headers: { authorization: "Basic secret" } })).toBe(false)
  })

  test("is false for a 1.x engine behind a password, an open 2.x engine and nothing at all", async () => {
    expect(await openCodeV2Locked(v1Locked.url.href)).toBe(false)
    expect(await openCodeV2Locked(v2.url.href)).toBe(false)
    expect(await openCodeV2Locked("http://127.0.0.1:9")).toBe(false)
  })
})
