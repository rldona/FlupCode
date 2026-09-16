import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_w",
  projectID: "p",
  title: "Wiring",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

type Calls = { posts: Array<{ path: string; body: unknown }>; patches: Array<{ path: string; body: unknown }> }

async function openApp(page: Page, options: { mcp?: Record<string, unknown> } = {}) {
  const calls: Calls = { posts: [], patches: [] }
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_w"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const record = () => {
      const body = request.postDataJSON() as unknown
      if (request.method() === "POST") calls.posts.push({ path: url.pathname, body })
      if (request.method() === "PATCH") calls.patches.push({ path: url.pathname, body })
    }
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_w/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/mcp" && request.method() === "GET")
      return route.fulfill({ json: options.mcp ?? { docs: { status: "connected" } } })
    if (url.pathname === "/config" && request.method() === "GET")
      return route.fulfill({ json: { mcp: { docs: { type: "remote", url: "https://docs.example" } } } })
    if (url.pathname === "/config" && request.method() === "PATCH") {
      record()
      return route.fulfill({ json: {} })
    }
    if (url.pathname === "/mcp" && request.method() === "POST") {
      record()
      return route.fulfill({ json: { status: {} } })
    }
    if (/^\/mcp\/[^/]+\/(connect|disconnect)$/.test(url.pathname)) {
      record()
      return route.fulfill({ json: {} })
    }
    if (url.pathname === "/session/ses_w/share" && request.method() === "POST") {
      record()
      return route.fulfill({ json: { ...session, share: { url: "https://share.example/ses_w" } } })
    }
    if (url.pathname === "/experimental/control-plane/move-session") {
      record()
      return route.fulfill({ json: {} })
    }
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return calls
}

test("the MCP manager shows the engine's real servers", async ({ page }) => {
  await openApp(page, { mcp: { docs: { status: "connected" }, linear: { status: "failed" } } })
  await page.getByRole("button", { name: "Command palette" }).first().click()
  await page.locator(".fc-palette-input").fill("mcp")
  await page.keyboard.press("Enter")

  // Every call in the MCP client used to be a no-op, so this list was always empty.
  const rows = page.locator(".fc-mcp-row")
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText("docs")
  await expect(rows.first()).toContainText("connected")
})

test("adding an MCP server reaches the engine and its configuration", async ({ page }) => {
  const calls = await openApp(page)
  await page.getByRole("button", { name: "Command palette" }).first().click()
  await page.locator(".fc-palette-input").fill("mcp")
  await page.keyboard.press("Enter")

  await page.getByPlaceholder("Name").fill("linear")
  await page.locator(".fc-mcp-form select").selectOption("remote")
  await page.getByPlaceholder("https://…").fill("https://mcp.linear.app")
  await page.locator(".fc-mcp-form .fc-button-primary").click()

  // The engine's own add is in-memory only, so the configuration has to learn about it too or the
  // server is gone the next time the engine starts.
  await expect.poll(() => calls.posts.some((call) => call.path === "/mcp")).toBe(true)
  await expect
    .poll(() => calls.patches.find((call) => call.path === "/config")?.body)
    .toMatchObject({
      mcp: { linear: { type: "remote", url: "https://mcp.linear.app" } },
    })
})

test("sharing a session asks the engine for a link", async ({ page }) => {
  const calls = await openApp(page)
  await page.getByRole("button", { name: "Menu", exact: true }).first().click()
  await page.getByText("Share", { exact: true }).click()

  // The roadmap called this impossible; the endpoint was there all along.
  await expect.poll(() => calls.posts.some((call) => call.path === "/session/ses_w/share")).toBe(true)
  await expect(page.locator(".fc-toast")).toContainText(/Share link copied|Enlace copiado/i)
})

test("Settings names the engine it is talking to", async ({ page }) => {
  // The version only ever comes from `/global/health`; the v2 route answers `{ healthy: true }` and
  // nothing else, so everything that compared versions was reading a field that never arrived.
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/global/health") return route.fulfill({ json: { healthy: true, version: "1.18.30" } })
    if (url.pathname === "/api/health") return route.fulfill({ json: { healthy: true } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await page
    .getByRole("button", { name: /Customize|Personalizar/ })
    .first()
    .click()
  const engine = page.locator(".fc-settings-row").filter({ hasText: /^Engine|^Motor/ })
  await expect(engine).toContainText("1.18.30")
})
