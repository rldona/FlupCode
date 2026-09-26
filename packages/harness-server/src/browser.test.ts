import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "./api"
import { createBrowserRuntime, resolveBrowserExecutable } from "./browser"
import type { BrowserRuntime } from "./browser"
import { createEgressGuard, NavigationBlockedError } from "./browser-egress"
import { redactSecrets } from "./redact"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import type { ServerEvent } from "./types"

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

// `caret-color: transparent` keeps a focused field from blinking into the byte comparison: Playwright's
// own `caret: "hide"` is applied too late to be reliable for a persistent profile.
const PAGE = `<!doctype html><html><head><title>Fixture</title><style>body { margin: 0 } input { outline: none; caret-color: transparent }</style></head><body>
  <h1 id="head">hello</h1>
  <button id="go" type="button">go</button>
  <input id="pw" type="password" />
  <input id="user" />
  <p id="mirror"></p>
  <script>
    document.getElementById("go").addEventListener("click", () => { document.getElementById("head").textContent = "clicked" })
    document.getElementById("user").addEventListener("input", (event) => { document.getElementById("mirror").textContent = event.target.value })
  </script>
</body></html>`

/** A local page, so the whole loop is exercised without a third party and without DNS. */
const fixture = () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/second")
        return new Response(
          '<!doctype html><html><head><title>Second</title></head><body><p id="out">second page</p></body></html>',
          { headers: { "content-type": "text/html" } },
        )
      if (path === "/set")
        return new Response(PAGE, {
          headers: { "content-type": "text/html", "set-cookie": "flup=yes; Path=/; Max-Age=3600" },
        })
      if (path === "/cookie")
        return new Response(
          `<!doctype html><html><head><title>Cookie</title></head><body><p id="cookie">${request.headers.get("cookie") ?? ""}</p></body></html>`,
          { headers: { "content-type": "text/html" } },
        )
      if (path === "/reflect") {
        const value = new URL(request.url).searchParams.get("value") ?? ""
        return new Response(
          `<!doctype html><html><head><title>Reflect</title></head><body><p id="raw"></p><script>
             const value = ${JSON.stringify(value)}
             document.title = value
             document.getElementById("raw").textContent = value
           </script></body></html>`,
          { headers: { "content-type": "text/html" } },
        )
      }
      if (path === "/mask") {
        const field = new URL(request.url).searchParams.get("field") === "pw" ? "pw" : "secret"
        return new Response(
          `<!doctype html><html><head><title>Mask</title><style>
             html, body { margin: 0; height: 100% }
             input { position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0; outline: none; caret-color: transparent; font-size: 40px }
           </style></head><body><input id="${field}" type="${field === "pw" ? "password" : "text"}" /></body></html>`,
          { headers: { "content-type": "text/html" } },
        )
      }
      if (path === "/pick")
        return new Response(
          `<!doctype html><html><head><title>Pick</title><style>
             body { margin: 0 }
             .target { position: fixed; left: 20px; top: 30px; width: 120px; height: 40px }
             iframe { position: fixed; left: 0; top: 200px; width: 200px; height: 100px; border: 0 }
           </style></head><body>
             <div><button class="target" id="save" name="save" data-testid="save-btn">Save it</button></div>
             <iframe></iframe>
           </body></html>`,
          { headers: { "content-type": "text/html" } },
        )
      if (path === "/manual")
        return new Response(
          `<!doctype html><html><head><title>Manual</title></head><body>
             <input id="pw" type="password" />
             <div id="out"></div>
             <script>
               document.getElementById("pw").addEventListener("input", (event) => {
                 document.getElementById("out").textContent = event.target.value
               })
             </script>
           </body></html>`,
          { headers: { "content-type": "text/html" } },
        )
      return new Response(PAGE, { headers: { "content-type": "text/html" } })
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

type Handler = ReturnType<typeof createHarnessHandler>

const browserRequest = (
  handler: Handler,
  path: string,
  id: string,
  init?: { method?: string; body?: unknown; query?: string },
) =>
  handler(
    new Request(`http://x/harness/browser/${path}${init?.query ?? ""}`, {
      method: init?.method ?? "POST",
      headers: headers(id),
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )

/** The bytes behind a screenshot artifact, read back through the route the UI would use. */
const screenshotBytes = async (handler: Handler, id: string, label: string) => {
  const response = await browserRequest(handler, "screenshot", id, { body: { label } })
  const artifactId = (await response.json()).data.artifactId
  const raw = await handler(
    new Request(`http://x/harness/artifacts/${artifactId}/raw`, { headers: { authorization: `Bearer ${TOKEN}` } }),
  )
  return Buffer.from(await raw.arrayBuffer())
}

describe("which browser is launched (WA-9)", () => {
  test("an explicit path beats the environment, then the managed Chromium, then the system browser", () => {
    expect(
      resolveBrowserExecutable({ option: "/opt/chrome", env: "/env/chrome", managed: "/managed/chromium" }),
    ).toBe("/opt/chrome")
    expect(resolveBrowserExecutable({ env: "/env/chrome", managed: "/managed/chromium" })).toBe("/env/chrome")
    expect(resolveBrowserExecutable({ managed: "/managed/chromium" })).toBe("/managed/chromium")
    // Nothing named: the system's Chrome is the fallback, chosen at launch.
    expect(resolveBrowserExecutable({})).toBeUndefined()
  })
})

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

  test("clear forgets a stored profile and requires a project", async () => {
    const { directory, handler } = open()
    const profile = join(directory, "profiles", createHash("sha256").update("proj").digest("hex").slice(0, 16))
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, "cookie"), "x")

    const cleared = await browserRequest(handler, "clear", "admin", { body: { project: "proj" } })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ data: { cleared: true } })
    expect(existsSync(profile)).toBe(false)

    const missing = await browserRequest(handler, "clear", "admin", { body: {} })
    expect(missing.status).toBe(400)
    expect((await missing.json()).code).toBe("project_required")
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

  test("redaction covers the raw, HTML-escaped and encoded shapes of a secret", () => {
    const secret = "P&SS<1 2"
    const shapes = [
      secret,
      "P&amp;SS&lt;1 2",
      encodeURIComponent(secret),
      encodeURIComponent(secret).replace(/%20/g, "+"),
    ]
    for (const shape of shapes) expect(redactSecrets(`before ${shape} after`, [secret])).toBe("before [redacted] after")
    // Quotes are escaped too, and a value that is not there is left alone.
    expect(redactSecrets("x &quot;y&quot;", ['"y"'])).toBe("x [redacted]")
    expect(redactSecrets("nothing here", [secret])).toBe("nothing here")
  })

  test("redaction covers the form encoding and the attribute serialization of a secret", () => {
    // `URLSearchParams` escapes `~ ! ' ( )` that `encodeURIComponent` leaves alone.
    const formSecret = "A~B!C(D)E'F G"
    const form = new URLSearchParams({ v: formSecret }).toString().slice(2)
    expect(redactSecrets(`before ${form} after`, [formSecret])).toBe("before [redacted] after")

    // A browser writes control characters back as numeric entities inside an attribute.
    const attributeSecret = "line\nbreak\ttab\rreturn\u00a0nbsp"
    const serialized = "line&#10;break&#9;tab&#13;return&nbsp;nbsp"
    expect(redactSecrets(`before ${serialized} after`, [attributeSecret])).toBe("before [redacted] after")
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

      const raw = await handler(
        new Request(`http://x/harness/artifacts/${artifactID}/raw`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      )
      expect(raw.status).toBe(200)
      expect(Buffer.from(await raw.arrayBuffer()).equals(bytes)).toBe(true)
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "pick reads the element under a point and ranks selectors",
    async () => {
      const server = fixture()
      const { handler } = open(server)
      await browserRequest(handler, "start", "s1", { body: { project: "proj" } })
      await browserRequest(handler, "navigate", "s1", { body: { url: `http://127.0.0.1:${server.port}/pick` } })

      const session = (await (await browserRequest(handler, "session", "s1", { method: "GET" })).json()).data
      const viewport = session.viewport as { width: number; height: number }
      expect(viewport.width).toBeGreaterThan(0)
      expect(viewport.height).toBeGreaterThan(0)
      // The editor sends a 0..1 fraction of the frame, and the server turns it back into the CSS
      // pixels `elementFromPoint` measures in; these are the points the old pixel form named.
      const at = (x: number, y: number) => ({ x: x / viewport.width, y: y / viewport.height })

      const picked = (await (await browserRequest(handler, "capture", "s1", { body: at(40, 45) })).json()).data
      expect(picked).toMatchObject({ found: true, tag: "button" })
      expect(picked.box).toMatchObject({ x: 20, y: 30, width: 120, height: 40 })
      expect(picked.candidates?.[0]).toBe('[data-testid="save-btn"]')
      expect(picked.candidates).toContain("#save")
      expect(picked.text).toBe("Save it")

      const frame = (await (await browserRequest(handler, "capture", "s1", { body: at(50, 250) })).json()).data
      expect(frame).toMatchObject({ found: true, reason: "iframe" })
      expect(frame.candidates).toBeUndefined()

      const none = (await (await browserRequest(handler, "capture", "s1", { body: at(-5, -5) })).json()).data
      expect(none).toMatchObject({ found: false, reason: "none" })

      const missing = await browserRequest(handler, "capture", "s1", { body: {} })
      expect(missing.status).toBe(400)
      expect((await missing.json()).code).toBe("point_required")
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

  test.skipIf(!existsSync(chromiumPath))(
    "protect blacks out a field so its value and its length never show",
    async () => {
      const server = fixture()
      const { handler, runtime } = open(server)
      const maskURL = (field: string) => `http://127.0.0.1:${server.port}/mask?field=${field}`

      /** Types two different-length values into a full-viewport field and returns both captures. */
      const pair = async (id: string, project: string, field: string, protectSelector?: string) => {
        await browserRequest(handler, "start", id, { body: { project } })
        await browserRequest(handler, "navigate", id, { body: { url: maskURL(field) } })
        if (protectSelector) runtime.protect(id, { selector: protectSelector, value: "site-password" })
        await browserRequest(handler, "type", id, { body: { selector: `#${field}`, text: "ab" } })
        const short = await screenshotBytes(handler, id, "short")
        await browserRequest(handler, "type", id, { body: { selector: `#${field}`, text: "abcdefghijklmnop" } })
        const long = await screenshotBytes(handler, id, "long")
        return { short, long }
      }

      // The password-shaped field: `protect` names it, and the base mask would cover it anyway.
      const password = await pair("s1", "proj", "pw", "#pw")
      expect(password.short.equals(password.long)).toBe(true)

      // A text field BASE_MASK would never cover, so this identity is `protect`'s own doing.
      const masked = await pair("s2", "proj2", "secret", "#secret")
      expect(masked.short.equals(masked.long)).toBe(true)

      // Control: the same experiment without `protect` differs, so the identity above is the mask.
      const bare = await pair("s3", "proj3", "secret")
      expect(bare.short.equals(bare.long)).toBe(false)
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "a protected value is stripped from snapshots and reads",
    async () => {
      const server = fixture()
      const { handler, runtime } = open(server)
      const base = `http://127.0.0.1:${server.port}/`
      await browserRequest(handler, "start", "s1", { body: { project: "proj" } })
      await browserRequest(handler, "navigate", "s1", { body: { url: base } })
      runtime.protect("s1", { value: "S3CRET" })
      await browserRequest(handler, "type", "s1", { body: { selector: "#user", text: "S3CRET" } })

      const text = (await (await browserRequest(handler, "snapshot", "s1", { method: "GET" })).json()).data
      expect(text.text).not.toContain("S3CRET")
      expect(text.text).toContain("[redacted]")

      const html = (await (await browserRequest(handler, "snapshot", "s1", { method: "GET", query: "?html=1" })).json())
        .data
      expect(html.html).not.toContain("S3CRET")

      const read = (await (await browserRequest(handler, "text", "s1", { body: { selector: "#mirror" } })).json()).data
      expect(read.value).not.toContain("S3CRET")
      expect(read.value).toBe("[redacted]")
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "a secret is stripped however the page writes it back",
    async () => {
      const server = fixture()
      const { handler, runtime } = open(server)
      const secret = "P&SS<1 2"
      const escaped = "P&amp;SS&lt;1 2"
      const base = `http://127.0.0.1:${server.port}/`
      await browserRequest(handler, "start", "s1", { body: { project: "proj" } })
      runtime.protect("s1", { value: secret })

      // The mirror renders what is typed as text, so the page carries the HTML-escaped shape.
      await browserRequest(handler, "navigate", "s1", { body: { url: base } })
      await browserRequest(handler, "type", "s1", { body: { selector: "#user", text: secret } })

      const snapshot = (
        await (await browserRequest(handler, "snapshot", "s1", { method: "GET", query: "?html=1" })).json()
      ).data
      expect(snapshot.text).not.toContain(secret)
      expect(snapshot.html).not.toContain(secret)
      expect(snapshot.html).not.toContain(escaped)

      const read = (
        await (await browserRequest(handler, "text", "s1", { body: { selector: "#mirror", as: "html" } })).json()
      ).data
      expect(read.value).not.toContain(secret)
      expect(read.value).not.toContain(escaped)

      // The page names the secret in its title and carries it percent-encoded in the URL.
      await browserRequest(handler, "navigate", "s1", {
        body: { url: `${base}reflect?value=${encodeURIComponent(secret)}` },
      })
      const session = (await (await browserRequest(handler, "session", "s1", { method: "GET" })).json()).data
      expect(session.title).toBe("[redacted]")
      expect(session.title).not.toContain(secret)
      expect(session.url).not.toContain(secret)
      expect(session.url).not.toContain(encodeURIComponent(secret))
      expect(session.url).toContain("[redacted]")

      const reflected = (await (await browserRequest(handler, "snapshot", "s1", { method: "GET" })).json()).data
      expect(reflected.title).not.toContain(secret)
      expect(reflected.url).not.toContain(secret)
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "a form-encoded secret is stripped from the URL the page reflects it in",
    async () => {
      const server = fixture()
      const { handler, runtime } = open(server)
      // The characters `URLSearchParams` escapes and `encodeURIComponent` does not.
      const secret = "A~B!C(D)E'F G"
      const form = new URLSearchParams({ v: secret }).toString().slice(2)
      const base = `http://127.0.0.1:${server.port}/`
      await browserRequest(handler, "start", "s1", { body: { project: "proj" } })
      runtime.protect("s1", { value: secret })
      await browserRequest(handler, "navigate", "s1", { body: { url: `${base}reflect?value=${form}` } })

      const session = (await (await browserRequest(handler, "session", "s1", { method: "GET" })).json()).data
      expect(session.url).not.toContain(secret)
      expect(session.url).not.toContain(form)
      expect(session.url).toContain("[redacted]")

      const snapshot = (await (await browserRequest(handler, "snapshot", "s1", { method: "GET" })).json()).data
      expect(snapshot.url).not.toContain(secret)
      expect(snapshot.url).not.toContain(form)
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "an artifact title never carries a secret held by the page",
    async () => {
      const server = fixture()
      const { handler, repository, runtime } = open(server)
      const secret = "TITLE-S3CRET"
      const base = `http://127.0.0.1:${server.port}/`
      await browserRequest(handler, "start", "s1", { body: { project: "proj" } })
      runtime.protect("s1", { value: secret })
      // The fixture copies the query value into `document.title`.
      await browserRequest(handler, "navigate", "s1", {
        body: { url: `${base}reflect?value=${encodeURIComponent(secret)}` },
      })

      const shot = await browserRequest(handler, "screenshot", "s1", { body: {} })
      const artifactId = (await shot.json()).data.artifactId
      const artifact = repository.getArtifact(artifactId)
      expect(artifact?.title).not.toContain(secret)
      expect(artifact?.title).toBe("[redacted]")
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "a password a person types by hand is not read back through a snapshot",
    async () => {
      const server = fixture()
      const { handler } = open(server)
      const secret = "manual-pass-123"
      const base = `http://127.0.0.1:${server.port}/`
      // No `protect`: this is the login the runtime knows nothing about.
      await browserRequest(handler, "login", "s1", { body: { project: "proj", headed: false } })
      await browserRequest(handler, "navigate", "s1", { body: { url: `${base}manual` } })
      await browserRequest(handler, "type", "s1", { body: { selector: "#pw", text: secret } })

      const snapshot = (await (await browserRequest(handler, "snapshot", "s1", { method: "GET" })).json()).data
      expect(snapshot.text).not.toContain(secret)
      expect(snapshot.text).toContain("[redacted]")

      const read = (await (await browserRequest(handler, "text", "s1", { body: { selector: "#out" } })).json()).data
      expect(read.value).not.toContain(secret)
      expect(read.value).toBe("[redacted]")
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "a login profile keeps its cookie across sessions",
    async () => {
      const server = fixture()
      const { handler } = open(server)
      const base = `http://127.0.0.1:${server.port}/`

      const first = await browserRequest(handler, "login", "s1", { body: { project: "proj", headed: false } })
      expect(first.status).toBe(201)
      await browserRequest(handler, "navigate", "s1", { body: { url: `${base}set` } })
      await browserRequest(handler, "close", "s1", { body: {} })

      const second = await browserRequest(handler, "login", "s2", { body: { project: "proj", headed: false } })
      expect(second.status).toBe(201)
      await browserRequest(handler, "navigate", "s2", { body: { url: `${base}cookie` } })
      const snapshot = (await (await browserRequest(handler, "snapshot", "s2", { method: "GET" })).json()).data
      expect(snapshot.text).toContain("flup=yes")
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "clearData removes the profile a login stored",
    async () => {
      const server = fixture()
      const { directory, handler } = open(server)
      const profile = join(directory, "profiles", createHash("sha256").update("proj").digest("hex").slice(0, 16))
      await browserRequest(handler, "start", "s1", { body: { project: "proj" } })
      expect(existsSync(profile)).toBe(true)

      const busy = await browserRequest(handler, "clear", "admin", { body: { project: "proj" } })
      expect(busy.status).toBe(409)
      expect((await busy.json()).code).toBe("browser_busy")

      await browserRequest(handler, "close", "s1", { body: {} })
      const cleared = await browserRequest(handler, "clear", "admin", { body: { project: "proj" } })
      expect(cleared.status).toBe(200)
      expect((await cleared.json()).data.cleared).toBe(true)
      expect(existsSync(profile)).toBe(false)
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "a browser started for a run files its screenshots under that run and task (WA-7)",
    async () => {
      const server = fixture()
      const { runtime, repository } = open(server)

      await runtime.start({ id: "s-scope", project: "proj", runID: "run_1", taskID: "task_1" })
      await runtime.navigate("s-scope", `http://127.0.0.1:${server.port}/`)
      const { artifactId } = await runtime.screenshot("s-scope", "scoped")

      expect(repository.getArtifact(artifactId)).toMatchObject({ runID: "run_1", taskID: "task_1" })
    },
    30_000,
  )
})

describe("the live view's control (WA-6)", () => {
  test("a control request with no session says so", async () => {
    const { handler } = open()
    for (const route of ["pause", "resume", "takeover", "stop"]) {
      const response = await browserRequest(handler, route, "missing", { body: {} })
      expect(response.status).toBe(404)
      expect((await response.json()).code).toBe("no_session")
    }
  })

  test.skipIf(!existsSync(chromiumPath))(
    "pauses, resumes and stops a run, reveals a headless takeover on the boundary, and announces it",
    async () => {
      const server = fixture()
      const { handler, repository, runtime } = open(server)
      const events: ServerEvent[] = []
      const unsubscribe = repository.subscribe((entry) => events.push(entry.event))

      await browserRequest(handler, "start", "s1", { body: { project: "proj" } })

      const paused = await browserRequest(handler, "pause", "s1", { body: {} })
      expect((await paused.json()).data.paused).toBe(true)
      const resumed = await browserRequest(handler, "resume", "s1", { body: {} })
      expect((await resumed.json()).data.paused).toBe(false)

      // No window is open yet: the takeover holds the agent, and the runner's pause check opens
      // the headed window at the next step boundary, on the same persistent profile.
      const takeover = await browserRequest(handler, "takeover", "s1", { body: {} })
      expect(takeover.status).toBe(200)
      expect((await takeover.json()).data.paused).toBe(true)
      const waiting = runtime.waitIfPaused("s1")
      for (let i = 0; i < 100 && runtime.get("s1")?.headed !== true; i++) await Bun.sleep(100)
      expect(runtime.get("s1")?.headed).toBe(true)
      await runtime.resume("s1")
      await waiting

      const stopped = await browserRequest(handler, "stop", "s1", { body: {} })
      expect((await stopped.json()).data.stopped).toBe(true)
      unsubscribe()

      const statuses = events.filter((event) => event.type === "browser.status")
      expect(statuses.some((event) => event.type === "browser.status" && event.paused)).toBe(true)
      expect(
        statuses.some((event) => event.type === "browser.status" && event.closed === true),
      ).toBe(true)
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "stores a frame and announces it, but a polled frame is not announced",
    async () => {
      const server = fixture()
      const { handler, repository } = open(server)
      const frames: string[] = []
      const unsubscribe = repository.subscribe((entry) => {
        if (entry.event.type === "browser.frame") frames.push(entry.event.artifactId)
      })

      await browserRequest(handler, "start", "s1", { body: { project: "proj" } })
      await browserRequest(handler, "screenshot", "s1", { body: { label: "step" } })
      const polled = await browserRequest(handler, "frame", "s1", { method: "GET", query: "?store=0" })
      expect(polled.headers.get("content-type")).toBe("image/png")
      unsubscribe()

      expect(frames).toHaveLength(1)
    },
    30_000,
  )
})
