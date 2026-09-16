import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_sec",
  projectID: "p",
  title: "Security",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

/** The engine answers `/config/providers` with the configured API keys in the clear. */
const providerDirectory = {
  all: [
    {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      source: "api",
      key: "sk-ant-super-secret",
      models: { "claude-opus-5": { id: "claude-opus-5", name: "Opus 5" } },
    },
  ],
  connected: [],
}

type Recorded = { patches: unknown[]; connects: unknown[] }

async function openApp(page: Page) {
  const recorded: Recorded = { patches: [], connects: [] }
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_sec"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_sec/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/config/providers") return route.fulfill({ json: providerDirectory })
    if (url.pathname === "/api/integration") return route.fulfill({ json: { data: [] } })
    if (/^\/api\/integration\/[^/]+\/connect\/key/.test(url.pathname)) {
      recorded.connects.push(request.postDataJSON())
      return route.fulfill({ json: { data: {} } })
    }
    if (url.pathname === "/api/session/ses_sec/prompt") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/ses_sec" && request.method() === "PATCH") {
      recorded.patches.push(request.postDataJSON())
      return route.fulfill({ json: session })
    }
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return recorded
}

test("the default mode no longer grants the session every permission", async ({ page }) => {
  const recorded = await openApp(page)

  const composer = page.getByPlaceholder(/Type \/ for commands/i)
  await composer.fill("Do it")
  await composer.press("Enter")

  await expect.poll(() => recorded.patches.length).toBeGreaterThan(0)
  const rules = (recorded.patches[0] as { permission: Array<{ permission: string; action: string }> }).permission
  expect(rules.filter((rule) => rule.action === "allow")).toEqual([])
  expect(rules).toContainEqual({ permission: "external_directory", pattern: "*", action: "ask" })
})

test("bypassing permissions takes a second, deliberate click", async ({ page }) => {
  await openApp(page)

  await page.locator(".fc-mode-button").first().click()
  const bypass = page.locator('.fc-mode-item[data-mode="bypass"]')
  await bypass.click()
  // Still open, still not applied: the row asks for confirmation first.
  await expect(bypass).toHaveClass(/fc-mode-item-confirming/)
  await expect(page.locator(".fc-mode-button").first()).not.toContainText("Bypass")

  await bypass.click()
  await expect(page.locator(".fc-mode-button").first()).toContainText("Bypass")
})

test("a provider key in the engine's configuration is never copied on its own", async ({ page }) => {
  const recorded = await openApp(page)

  await page.locator(".fc-mode-button").first().click()
  await page.keyboard.press("Escape")
  await page.waitForTimeout(1200)

  expect(recorded.connects).toEqual([])
  // Nothing in the page ever holds the key, so it cannot reach a paired phone either.
  expect(await page.content()).not.toContain("sk-ant-super-secret")
})

test("the browser panel keeps untrusted pages inside a sandbox", async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => window.localStorage.setItem("flupcode.workspacePanels", JSON.stringify(["browser"])))
  await page.reload()

  const input = page.locator(".fc-browser-url")
  await input.fill("http://127.0.0.1:9/preview")
  await input.press("Enter")

  const frame = page.locator("iframe.fc-browser-frame")
  await expect(frame).toHaveAttribute("sandbox", /allow-scripts/)
  const sandbox = (await frame.getAttribute("sandbox")) ?? ""
  expect(sandbox).not.toContain("allow-top-navigation")
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer")
})

test("the engine started by the desktop app is reached with its password", async ({ page }) => {
  const seen: Array<string | undefined> = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    // What the desktop preload exposes once the main process gives the engine a password.
    window.flupcode = { engineAuth: "b3BlbmNvZGU6c2VjcmV0" }
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    seen.push(route.request().headers()["authorization"])
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect.poll(() => seen.length).toBeGreaterThan(0)
  expect(seen.every((value) => value === "Basic b3BlbmNvZGU6c2VjcmV0")).toBe(true)
})
