import { expect, test } from "@playwright/test"

// TI-04: when the engine will not give the panel a terminal, the panel says so in a sentence and
// offers to try again, instead of printing a raw exception into the terminal. The working path runs
// against the real engine in e2e-engine.
test("a terminal the engine refused is said in a sentence, with a way to try again", async ({ page }) => {
  let creates = 0
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    if (url.pathname === "/api/pty" && route.request().method() === "POST") {
      creates++
      return route.fulfill({ status: 500, json: {} })
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Terminal" }).click()

  const failure = page.getByRole("alert").filter({ hasText: /The terminal could not connect|El terminal no pudo/ })
  await expect(failure).toBeVisible()
  await expect(page.locator(".fc-terminal")).not.toContainText("[terminal error]")
  expect(creates).toBe(1)

  await failure.getByRole("button", { name: /Try again|Reintentar/ }).click()
  await expect.poll(() => creates).toBe(2)
  await expect(failure).toBeVisible()
})
