import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
  })
})

test("loads the harness shell", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveTitle(/FlupCode/)
  await expect(page.getByRole("button", { name: /New/ }).first()).toBeVisible()
  await expect(page.getByText("FlupCode").first()).toBeVisible()
})

test("installs as a FlupCode-branded app", async ({ page, request }) => {
  const manifest = await (await request.get("/site.webmanifest")).json()
  expect(manifest.icons.map((icon: { purpose: string }) => icon.purpose)).toEqual(["any", "any", "maskable"])
  for (const icon of manifest.icons as Array<{ src: string; sizes: string }>) {
    const response = await request.get(icon.src)
    expect(response.headers()["content-type"]).toBe("image/png")
  }
  await page.goto("/")
  const touchIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href")
  expect((await request.get(touchIcon!)).ok()).toBe(true)
})

test("completes onboarding", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.removeItem("flupcode.onboarded")
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
  })
  // "Get started" needs a healthy engine; CI has none, so answer the health check.
  await page.route(/\/(api|global)\/health/, (route) => route.fulfill({ json: { healthy: true, version: "e2e" } }))
  await page.goto("/")
  await expect(page.getByText(/Welcome to FlupCode/i)).toBeVisible()
  await page
    .locator(".fc-onboarding")
    .getByPlaceholder(/Your name/i)
    .fill("Raúl")
  await page.getByRole("button", { name: /Get started/i }).click()
  await expect(page.getByText(/Welcome to FlupCode/i)).toHaveCount(0)
})

test("serves the app shell offline after the service worker installs", async ({ page, context }) => {
  await page.goto("/")
  await page.evaluate(() => navigator.serviceWorker.ready)
  await context.setOffline(true)
  await page.reload()
  await expect(page.locator(".fc-app")).toBeVisible()
})

test("opens the command palette", async ({ page }) => {
  test.skip(process.env.FLUPCODE_E2E_SERVER !== "1", "set FLUPCODE_E2E_SERVER=1 with a running OpenCode server")
  await page.goto("/")
  await page.getByRole("button", { name: /Command palette/i }).click()
  await expect(page.getByPlaceholder(/Search commands/i)).toBeVisible()
  await page.keyboard.press("Escape")
})

test("sidebar loads projects", async ({ page }) => {
  test.skip(process.env.FLUPCODE_E2E_SERVER !== "1", "set FLUPCODE_E2E_SERVER=1 with a running OpenCode server")
  await page.goto("/")
  await expect(page.locator(".fc-skeleton")).toHaveCount(0)
})

test("sends a prompt and receives an answer", async ({ page }) => {
  test.skip(process.env.FLUPCODE_E2E_MODEL !== "1", "set FLUPCODE_E2E_MODEL=1 to run the live model test")
  test.setTimeout(120_000)
  await page.goto("/")
  await page.getByRole("button", { name: /New/ }).first().click()
  const composer = page.getByPlaceholder(/Type \/ for commands/i)
  await composer.fill("Reply with exactly: ok")
  await composer.press("Enter")
  await expect(page.locator(".fc-message-assistant").filter({ hasText: "ok" }).first()).toBeVisible({
    timeout: 90_000,
  })
})

test("shows the startup error instead of a blank page and resets without losing pairings", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.remoteHosts", JSON.stringify([{ hostId: "kept" }]))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("stale"))
  })
  await page.route(/\/assets\/index-[^/]+\.js$/, (route) => route.abort())
  await page.goto("/")
  const alert = page.getByRole("alert")
  await expect(alert).toContainText("FlupCode couldn't start")
  await expect(alert).toContainText(/Failed to load .*\/assets\/index-/)

  await page.unroute(/\/assets\/index-[^/]+\.js$/)
  await page.evaluate(() => window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("stale")))
  await alert.getByRole("button", { name: "Reset app data" }).click()
  await expect(page.getByRole("button", { name: /New/ }).first()).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  const stored = await page.evaluate(() => Object.keys(window.localStorage))
  expect(stored).toContain("flupcode.remoteHosts")
})

test("settings change the app and chat text size and remember them", async ({ page }) => {
  await page.goto("/")
  await page.locator(".fc-profile-button").click()
  await page.locator(".fc-menu").getByText("Settings", { exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Customize" })
  await dialog.getByLabel("App text size").selectOption("large")
  await dialog.getByLabel("Chat text size").selectOption("xlarge")
  const applied = () =>
    page.evaluate(() => ({
      zoom: document.documentElement.style.zoom,
      chat: document.documentElement.style.getPropertyValue("--fc-chat-zoom"),
    }))
  expect(await applied()).toEqual({ zoom: "1.1", chat: "1.25" })
  await page.reload()
  expect(await applied()).toEqual({ zoom: "1.1", chat: "1.25" })
})

test("settings reset the summary counters and can count everything again", async ({ page }) => {
  await page.goto("/")
  await page.locator(".fc-profile-button").click()
  await page.locator(".fc-menu").getByText("Settings", { exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Customize" })
  await expect(dialog.getByText("Counting every session")).toBeVisible()
  const reset = dialog.getByRole("button", { name: "Reset counters" })
  await reset.click()
  // The first click only asks for confirmation.
  expect(await page.evaluate(() => localStorage.getItem("flupcode.usageResetAt"))).toBeNull()
  await dialog.getByRole("button", { name: "Click again to reset" }).click()
  await expect(dialog.getByText(/Counting sessions since/)).toBeVisible()
  expect(Number(await page.evaluate(() => localStorage.getItem("flupcode.usageResetAt")))).toBeGreaterThan(0)
  await dialog.getByRole("button", { name: "Count all again" }).click()
  await expect(dialog.getByText("Counting every session")).toBeVisible()
})

test("arrow keys walk through sent prompts and return to the draft", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.promptHistory", JSON.stringify(["first prompt", "second\nprompt"]))
  })
  await page.goto("/")
  const input = page.locator(".fc-composer textarea.fc-input")
  await input.fill("my draft")
  await input.press("Home")
  await input.press("ArrowUp")
  await expect(input).toHaveValue("second\nprompt")
  await expect(page.locator(".fc-input-history")).toHaveText("History 2/2")
  await input.press("ArrowUp")
  await expect(input).toHaveValue("first prompt")
  await expect(page.locator(".fc-input-history")).toHaveText("History 1/2")
  await input.press("ArrowDown")
  await input.press("ArrowDown")
  await expect(input).toHaveValue("my draft")
  await expect(page.locator(".fc-input-history")).toHaveCount(0)

  // Editing a recalled prompt leaves the history and keeps the text.
  await input.press("ArrowUp")
  // The caret lands at the start, so ↑ keeps walking back.
  await input.pressSequentially("!")
  await expect(input).toHaveValue("!second\nprompt")
  await expect(page.locator(".fc-input-history")).toHaveCount(0)

  // Escape brings the draft back.
  await input.fill("")
  await input.press("ArrowUp")
  await input.press("Escape")
  await expect(input).toHaveValue("")
})

test("the Chat tab shows its own home, input and top bar, and is remembered", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.displayName", JSON.stringify("Raúl"))
  })
  await page.goto("/")
  const files = page.getByRole("button", { name: "Files changed" })
  await expect(files).toBeVisible()

  // The tabs sit next to the FlupCode name at the top of the sidebar, and move to the top bar while it is hidden.
  await expect(page.locator(".fc-sidebar-brand").getByRole("tab", { name: "Chat" })).toBeVisible()
  await expect(page.locator(".fc-topbar .fc-view-tabs")).toHaveCount(0)
  await page.getByRole("tab", { name: "Chat" }).click()
  await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true")
  await expect(page.locator(".fc-chat-greeting")).toContainText("Raúl")
  // Chats have no workspace panels, folder, agent or permission controls.
  await expect(files).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Terminal" })).toHaveCount(0)
  await expect(page.locator(".fc-composer .fc-folder-button")).toHaveCount(0)
  const input = page.locator(".fc-composer textarea.fc-input")
  await expect(input).toHaveAttribute("placeholder", "Write a message…")

  // A starter fills the input.
  await page.locator(".fc-chat-starter", { hasText: "Write" }).click()
  await expect(input).toHaveValue("Help me write ")

  await page.getByRole("button", { name: "Toggle sidebar" }).click()
  await expect(page.locator(".fc-topbar").getByRole("tab", { name: "Chat" })).toBeVisible()
  await page.getByRole("button", { name: "Toggle sidebar" }).click()

  await page.reload()
  await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true")
  await page.getByRole("tab", { name: "Code" }).click()
  await expect(page.getByRole("button", { name: "Files changed" })).toBeVisible()
  await expect(page.locator(".fc-chat-greeting")).toHaveCount(0)
})

test("split view opens a second session from the sidebar menu and closes back to one", async ({ page }) => {
  const now = Date.now()
  const session = (id: string, title: string) => ({
    id,
    projectID: "p",
    title,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now, updated: now },
    location: { directory: "/work/demo" },
  })
  const sessions = [session("ses_a", "First session"), session("ses_b", "Second session")]
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.expandedProjects", JSON.stringify({ "/work/demo": true }))
  })
  // A minimal engine: healthy, two sessions, empty transcripts and requests.
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: sessions, cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(message|permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await page.locator(".fc-session-row", { hasText: "First session" }).click()
  await page.locator(".fc-session-row", { hasText: "Second session" }).click({ button: "right" })
  await page.locator(".fc-menu").getByText("Split view", { exact: true }).click()

  const panes = page.locator(".fc-pane")
  await expect(panes).toHaveCount(2)
  await expect(page.locator(".fc-pane-title")).toHaveText(["First session", "Second session"])
  // Each pane has its own input, and the new one is focused.
  await expect(panes.locator("textarea.fc-input")).toHaveCount(2)
  await expect(panes.nth(1)).toHaveClass(/fc-pane-focused/)
  await panes.nth(0).locator(".fc-pane-header").click()
  await expect(panes.nth(0)).toHaveClass(/fc-pane-focused/)

  await panes.nth(1).getByRole("button", { name: "Close pane" }).click()
  await expect(panes).toHaveCount(0)
  await expect(page.locator(".fc-session-row-active")).toContainText("First session")
})

test("double-clicking a sidebar edge restores its original width", async ({ page }) => {
  await page.goto("/")
  const sidebar = page.locator(".fc-sidebar")
  const handle = page.locator(".fc-sidebar-resizer")
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + 140, box.y + 200, { steps: 5 })
  await page.mouse.up()
  expect(Math.round((await sidebar.boundingBox())!.width)).toBeGreaterThan(380)

  await handle.dblclick()
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(280)
  expect(await page.evaluate(() => localStorage.getItem("flupcode.sidebarWidth"))).toBe("280")
})

test("the slash command menu closes with Escape or a click outside, and opens again", async ({ page }) => {
  await page.goto("/")
  const input = page.locator(".fc-composer textarea.fc-input")
  const menu = page.locator(".fc-command-menu")
  await input.fill("/")
  await expect(menu).toBeVisible()
  // Closing drops the unfinished command.
  await input.press("Escape")
  await expect(menu).toHaveCount(0)
  await expect(input).toHaveValue("")

  await input.pressSequentially("/se")
  await expect(menu).toBeVisible()
  await page.locator(".fc-greeting").click()
  await expect(menu).toHaveCount(0)
  await expect(input).toHaveValue("")

  // Typing / again opens it, every time.
  await input.pressSequentially("/")
  await expect(menu).toBeVisible()
  await input.press("Escape")
  await input.pressSequentially("/")
  await expect(menu).toBeVisible()
  await input.pressSequentially("se")
  await menu.getByText("/settings").click()
  await expect(input).toHaveValue("/settings ")
})
