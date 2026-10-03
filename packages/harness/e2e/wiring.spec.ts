import { expect, test, type Page, type Request } from "@playwright/test"

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

type Call = { method: string; path: string; body: unknown }

async function openApp(page: Page, options: { mcp?: Array<{ name: string; status: { status: string } }> } = {}) {
  const calls: Call[] = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_w"))
    window.localStorage.setItem("flupcode.selectedModel", JSON.stringify({ providerID: "openai", id: "gpt" }))
  })
  const record = (request: Request) =>
    calls.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON() })
  // OpenCode 2 writes no config files, so the harness server keeps them (V2-24).
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/harness/engine-config" && request.method() === "PATCH") {
      record(request)
      return route.fulfill({ json: { data: { path: "/home/opencode.json", changed: true } } })
    }
    if (url.pathname === "/harness/engine-config")
      return route.fulfill({
        json: {
          data: {
            path: "/home/opencode.json",
            config:
              url.searchParams.get("scope") === "global"
                ? { mcp: { docs: { type: "remote", url: "https://docs.example" } } }
                : {},
          },
        },
      })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_w/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/location") return route.fulfill({ json: { directory: "/work/demo" } })
    if (url.pathname === "/api/mcp")
      return route.fulfill({
        json: {
          location: { directory: "/work/demo" },
          data: options.mcp ?? [{ name: "docs", status: { status: "connected" } }],
        },
      })
    if (url.pathname === "/api/location/reload") {
      record(request)
      return route.fulfill({ status: 204 })
    }
    if (url.pathname === "/api/session/ses_w/compact") {
      record(request)
      return route.fulfill({ json: {} })
    }
    if (/^\/api\/session\/[^/]+\/(permission|form)/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return calls
}

test("the MCP manager shows the engine's real servers", async ({ page }) => {
  await openApp(page, {
    mcp: [
      { name: "docs", status: { status: "connected" } },
      { name: "linear", status: { status: "failed" } },
    ],
  })
  await page.locator(".fc-sidebar-search").click()
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
  await page.locator(".fc-sidebar-search").click()
  await page.locator(".fc-palette-input").fill("mcp")
  await page.keyboard.press("Enter")

  await page.getByRole("button", { name: "Add server" }).click()
  await page.getByPlaceholder("Name").fill("linear")
  await page.getByLabel(/Type/).selectOption("remote")
  await page.getByPlaceholder("https://…").fill("https://mcp.linear.app")
  await page.locator(".fc-mcp-form .fc-button-primary").click()

  // OpenCode 2's own add is in-memory only and it writes no config, so the server goes into the
  // global configuration through the harness server and the engine reloads to connect it.
  await expect
    .poll(() => calls.find((call) => call.path === "/harness/engine-config")?.body)
    .toMatchObject({ scope: "global", patch: { mcp: { linear: { type: "remote", url: "https://mcp.linear.app" } } } })
  await expect.poll(() => calls.some((call) => call.path === "/api/location/reload")).toBe(true)
})

test("/compact runs the engine's compaction", async ({ page }) => {
  const calls = await openApp(page)
  const input = page.locator(".fc-composer textarea.fc-input")
  await input.fill("/compact")
  await input.press("Enter")

  // OpenCode 2 compacts with the session's own model, so the request names only the session.
  await expect
    .poll(() => calls.some((call) => call.method === "POST" && call.path === "/api/session/ses_w/compact"))
    .toBe(true)
})

test("Settings names the engine it is talking to", async ({ page }) => {
  // The version comes from `/api/info`, the route OpenCode 2 names itself on.
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "2.0.18" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await page.locator(".fc-profile-button").click()
  await page.locator(".fc-menu").getByText(/^(Settings|Configuración)$/).click()
  await page.getByRole("tab", { name: /Server|Servidor/ }).click()
  const engine = page.locator(".fc-settings-row").filter({ hasText: /^Engine|^Motor/ })
  await expect(engine).toContainText("OpenCode 2.0.18")
})
