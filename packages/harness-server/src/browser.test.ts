import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "./api"
import { createBrowserRuntime } from "./browser"
import type { BrowserRuntime } from "./browser"
import { createEgressGuard, NavigationBlockedError } from "./browser-egress"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

// Deferred, and only here: `@playwright/test` is the harness's own browser runner and must not
// enter the server at all. This import exists to ask where the binary is, nothing more.
const { chromium } = await import("playwright")
const chromiumPath = chromium.executablePath()

// CI installs Chromium before this suite, so there it must not skip quietly: without a browser the
// whole point of WA-1 goes untested.
if (process.env.FLUPCODE_REQUIRE_BROWSER === "1" && !existsSync(chromiumPath))
  throw new Error(`FLUPCODE_REQUIRE_BROWSER=1 but Playwright has no Chromium at ${chromiumPath}`)

const TOKEN = "test-token"
const made: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []
const runtimes: BrowserRuntime[] = []
const repositories: SqliteRoutineRepository[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()))
  for (const repository of repositories.splice(0)) repository.close()
  for (const server of servers.splice(0)) server.stop(true)
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
}, 15_000)

const headers = (id: string, token = TOKEN) => ({ "x-flupcode-session": id, authorization: `Bearer ${token}` })

/** A local page, so the whole loop is exercised without a third party and without DNS. */
const fixture = () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      const html =
        path === "/second"
          ? '<!doctype html><html><head><title>Second</title></head><body><p id="out">second page</p></body></html>'
          : `<!doctype html><html><head><title>Fixture</title></head><body>
               <h1 id="head">hello</h1>
               <button id="go" type="button">go</button>
               <script>document.getElementById("go").addEventListener("click", () => { document.getElementById("head").textContent = "clicked" })</script>
             </body></html>`
      return new Response(html, { headers: { "content-type": "text/html" } })
    },
  })
  servers.push(server)
  return server
}

const open = (server?: ReturnType<typeof Bun.serve>) => {
  const directory = mkdtempSync(join(tmpdir(), "flupcode-browser-"))
  made.push(directory)
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  const runtime = createBrowserRuntime({
    repository,
    dataDir: directory,
    egress: createEgressGuard(server ? { allowLoopbackPorts: [server.port ?? 0] } : undefined),
  })
  runtimes.push(runtime)
  const handler = createHarnessHandler(
    repository,
    new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" }),
    { browser: runtime, token: TOKEN },
  )
  return { directory, handler, repository, runtime }
}

describe("the browser boundary", () => {
  test("a request without the right token is refused", async () => {
    const { handler } = open()
    const missing = await handler(
      new Request("http://x/harness/browser/start", {
        method: "POST",
        headers: { "x-flupcode-session": "s1" },
        body: JSON.stringify({ project: "proj" }),
      }),
    )
    expect(missing.status).toBe(403)
    expect((await missing.json()).code).toBe("invalid_token")

    const wrong = await handler(
      new Request("http://x/harness/browser/start", {
        method: "POST",
        headers: { "x-flupcode-session": "s1", authorization: "Bearer nope" },
        body: JSON.stringify({ project: "proj" }),
      }),
    )
    expect(wrong.status).toBe(403)
  })

  test("a browser request with no session header is refused", async () => {
    const { handler } = open()
    const refused = await handler(
      new Request("http://x/harness/browser/session", { headers: { authorization: `Bearer ${TOKEN}` } }),
    )
    expect(refused.status).toBe(400)
    expect((await refused.json()).code).toBe("session_required")
  })

  test("an operation with no session started says so", async () => {
    const { handler } = open()
    const missing = await handler(new Request("http://x/harness/browser/session", { headers: headers("s-missing") }))
    expect(missing.status).toBe(404)
    expect((await missing.json()).code).toBe("no_session")
  })

  test("the strict guard refuses file, loopback, link-local and private addresses", async () => {
    const guard = createEgressGuard()
    for (const url of [
      "file:///etc/passwd",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://169.254.169.254/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
    ]) {
      await expect(guard.assertNavigable(url)).rejects.toThrow(NavigationBlockedError)
    }
  })
})

describe("driving a real browser", () => {
  test.skipIf(!existsSync(chromiumPath))(
    "navigates, reads, clicks and keeps a screenshot artifact",
    async () => {
      const server = fixture()
      const { handler } = open(server)
      const base = `http://127.0.0.1:${server.port}/`

      const started = await handler(
        new Request("http://x/harness/browser/start", {
          method: "POST",
          headers: headers("s1"),
          body: JSON.stringify({ project: "proj" }),
        }),
      )
      expect(started.status).toBe(201)
      expect((await started.json()).data.id).toBe("s1")

      const navigated = await handler(
        new Request("http://x/harness/browser/navigate", {
          method: "POST",
          headers: headers("s1"),
          body: JSON.stringify({ url: base }),
        }),
      )
      expect(navigated.status).toBe(200)

      const before = await handler(new Request("http://x/harness/browser/snapshot", { headers: headers("s1") }))
      expect((await before.json()).data.text).toContain("hello")

      const clicked = await handler(
        new Request("http://x/harness/browser/click", {
          method: "POST",
          headers: headers("s1"),
          body: JSON.stringify({ selector: "#go" }),
        }),
      )
      expect(clicked.status).toBe(200)

      const after = await handler(new Request("http://x/harness/browser/snapshot", { headers: headers("s1") }))
      expect((await after.json()).data.text).toContain("clicked")

      const framed = await handler(new Request("http://x/harness/browser/frame", { headers: headers("s1") }))
      expect(framed.headers.get("content-type")).toBe("image/png")
      const artifactID = framed.headers.get("x-flupcode-artifact")
      expect(artifactID).toBeTruthy()
      const bytes = Buffer.from(await framed.arrayBuffer())
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")

      const raw = await handler(new Request(`http://x/harness/artifacts/${artifactID}/raw`))
      expect(raw.status).toBe(200)
      expect(Buffer.from(await raw.arrayBuffer()).equals(bytes)).toBe(true)
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "refuses a blocked navigation and a second browser for one project",
    async () => {
      const server = fixture()
      const { handler } = open(server)
      await handler(
        new Request("http://x/harness/browser/start", {
          method: "POST",
          headers: headers("s1"),
          body: JSON.stringify({ project: "proj" }),
        }),
      )

      const blocked = await handler(
        new Request("http://x/harness/browser/navigate", {
          method: "POST",
          headers: headers("s1"),
          body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }),
        }),
      )
      expect(blocked.status).toBe(403)
      const blockedBody = await blocked.json()
      expect(blockedBody.code).toBe("navigation_blocked")
      expect(blockedBody.reason).toBeTruthy()

      const busy = await handler(
        new Request("http://x/harness/browser/start", {
          method: "POST",
          headers: headers("s2"),
          body: JSON.stringify({ project: "proj" }),
        }),
      )
      expect(busy.status).toBe(409)
      expect((await busy.json()).code).toBe("browser_busy")

      const wrong = await handler(
        new Request("http://x/harness/browser/start", {
          method: "POST",
          headers: headers("s1"),
          body: JSON.stringify({ project: "other" }),
        }),
      )
      expect(wrong.status).toBe(409)
      expect((await wrong.json()).code).toBe("wrong_project")
    },
    30_000,
  )

  // The launch yields, so the project has to be reserved before that await; otherwise both starts
  // pass the check and one project ends up with two browsers.
  test.skipIf(!existsSync(chromiumPath))(
    "two concurrent starts for one project leave a single browser",
    async () => {
      const server = fixture()
      const { handler, runtime } = open(server)
      const start = (id: string) =>
        handler(
          new Request("http://x/harness/browser/start", {
            method: "POST",
            headers: headers(id),
            body: JSON.stringify({ project: "proj" }),
          }),
        )

      const [first, second] = await Promise.all([start("s1"), start("s2")])
      expect([first.status, second.status].sort((left, right) => left - right)).toEqual([201, 409])

      const winner = first.status === 201 ? first : second
      const loser = first.status === 201 ? second : first
      expect((await loser.json()).code).toBe("browser_busy")

      const winnerID = (await winner.json()).data.id
      expect(runtime.get(winnerID)?.id).toBe(winnerID)
      expect(runtime.get(winnerID === "s1" ? "s2" : "s1")).toBeUndefined()
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "the profile a project gets is readable only by its owner",
    async () => {
      const server = fixture()
      const { directory, handler } = open(server)
      const started = await handler(
        new Request("http://x/harness/browser/start", {
          method: "POST",
          headers: headers("s1"),
          body: JSON.stringify({ project: "proj" }),
        }),
      )
      expect(started.status).toBe(201)

      const profile = join(directory, "profiles", createHash("sha256").update("proj").digest("hex").slice(0, 16))
      expect(statSync(profile).mode & 0o777).toBe(0o700)
    },
    30_000,
  )
})
