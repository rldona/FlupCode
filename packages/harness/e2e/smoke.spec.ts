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
  // The favicon must be one of the manifest icons so it keeps the app's dark ground.
  const favicon = await page.locator('link[rel="icon"]').getAttribute("href")
  expect(manifest.icons.map((icon: { src: string }) => icon.src)).toContain(favicon)

  const cornerAlpha = (src: string) =>
    page.evaluate(async (url) => {
      const image = new Image()
      image.src = url
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")!
      context.drawImage(image, 0, 0)
      return context.getImageData(0, 0, 1, 1).data[3]
    }, src)

  // "any" icons carry the same rounded shape as the desktop app icon. The maskable icon and
  // the Apple touch icon stay full-bleed because iOS and Android apply their own mask.
  for (const icon of manifest.icons as Array<{ src: string; purpose: string }>) {
    expect(await cornerAlpha(icon.src)).toBe(icon.purpose === "maskable" ? 255 : 0)
  }
  expect(await cornerAlpha(touchIcon!)).toBe(255)
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

test("a long session shows its newest messages past the engine's first page", async ({ page }) => {
  const now = Date.now()
  const messages = Array.from({ length: 250 }, (_, index) => ({
    id: `msg_${String(index).padStart(3, "0")}`,
    type: "user",
    text: `Message ${index}`,
    time: { created: now + index },
  }))
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_long"))
  })
  // The engine pages messages: at most `limit`, then the rest through `cursor`.
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session")
      return route.fulfill({
        json: {
          data: [
            {
              id: "ses_long",
              projectID: "p",
              title: "Long session",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: now, updated: now },
              location: { directory: "/work/demo" },
            },
          ],
          cursor: {},
        },
      })
    if (url.pathname === "/api/session/ses_long/message") {
      const start = url.searchParams.has("cursor") ? Number(url.searchParams.get("cursor")) : 0
      const limit = Number(url.searchParams.get("limit") ?? 50)
      return route.fulfill({
        json: { data: messages.slice(start, start + limit), cursor: { next: String(start + limit) } },
      })
    }
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await expect(page.getByText("Message 249", { exact: true })).toBeVisible()
})

test("the stop button stays while a run goes on between its steps", async ({ page }) => {
  const now = Date.now()
  let active = true
  let streams = 0
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_run"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session")
      return route.fulfill({
        json: {
          data: [
            {
              id: "ses_run",
              projectID: "p",
              title: "Running session",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: now, updated: now },
              location: { directory: "/work/demo" },
            },
          ],
          cursor: {},
        },
      })
    if (url.pathname === "/api/session/active")
      return route.fulfill({ json: { data: active ? { ses_run: { type: "running" } } : {} } })
    // One step has ended and the next has not started: the transcript alone looks finished.
    if (url.pathname === "/api/session/ses_run/message")
      return route.fulfill({
        json: {
          data: [
            { id: "msg_1", type: "user", text: "Fix it", time: { created: now } },
            {
              id: "msg_2",
              type: "assistant",
              agent: "build",
              model: { providerID: "p", id: "m" },
              content: [{ type: "text", text: "Reading the files" }],
              finish: "tool-calls",
              time: { created: now + 1, completed: now + 2 },
            },
          ],
          cursor: {},
        },
      })
    if (url.pathname === "/api/event") {
      const events =
        streams++ === 0
          ? [
              { type: "session.next.step.started", data: { sessionID: "ses_run" } },
              { type: "session.next.step.ended", data: { sessionID: "ses_run", finish: "tool-calls" } },
            ]
          : []
      return route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      })
    }
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  const stop = page.getByRole("button", { name: "Stop" })
  await expect(page.getByText("Reading the files")).toBeVisible()
  await expect(stop).toBeVisible()
  await page.waitForTimeout(3500)
  await expect(stop).toBeVisible()

  // The engine finished the run.
  active = false
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 5000 })
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

test("the slash menu walks with the arrow keys and Enter runs the chosen command", async ({ page }) => {
  await page.goto("/")
  const input = page.locator(".fc-composer textarea.fc-input")
  const menu = page.locator(".fc-command-menu")
  const activeName = menu.locator(".fc-command-item-active .fc-command-name")

  await input.fill("/s")
  await expect(menu).toBeVisible()
  // The first match starts highlighted; the arrows move it around the list.
  await expect(activeName).toHaveText("/steps")
  await input.press("ArrowDown")
  await expect(activeName).toHaveText("/stash")
  await input.press("ArrowUp")
  await expect(activeName).toHaveText("/steps")

  // Enter runs the highlighted command instead of sending the half-typed text.
  await input.fill("/sett")
  await expect(activeName).toHaveText("/settings")
  await input.press("Enter")
  await expect(menu).toHaveCount(0)
  await expect(page.getByRole("dialog", { name: "Customize" })).toBeVisible()
})

test("a local preview linked from the transcript opens in the browser panel", async ({ page }) => {
  const now = Date.now()
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_preview"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session")
      return route.fulfill({
        json: {
          data: [
            {
              id: "ses_preview",
              projectID: "p",
              title: "Preview",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: now, updated: now },
              location: { directory: "/work/demo" },
            },
          ],
          cursor: {},
        },
      })
    if (/^\/(api\/)?session\/ses_preview\/message$/.test(url.pathname))
      return route.fulfill({
        json: {
          data: [
            {
              id: "msg_preview",
              type: "user",
              text: "Servidor levantado en http://localhost:4444",
              time: { created: now },
            },
          ],
          cursor: {},
        },
      })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/(api\/)?session\/[^/]+\/message/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  const link = page.getByRole("link", { name: "http://localhost:4444" })
  await expect(link).toBeVisible()
  await link.click()
  // The integrated browser opens on the linked URL instead of a new tab.
  await expect(page.locator(".fc-browser-url")).toHaveValue(/localhost:4444/)
})
