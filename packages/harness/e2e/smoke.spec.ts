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
  const composer = page.getByPlaceholder(/Describe a task or ask a question/i)
  await composer.fill("Reply with exactly: ok")
  await composer.press("Enter")
  await expect(page.locator(".fc-message-assistant").filter({ hasText: "ok" }).first()).toBeVisible({
    timeout: 90_000,
  })
})
