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
