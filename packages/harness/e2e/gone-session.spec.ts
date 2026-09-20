import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const other = {
  id: "ses_other",
  projectID: "p",
  title: "Other",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

// The engine of a new install does not have the session the last one left open. Until this was
// handled, the app kept the id, the transcript failed to load, and the composer invited writing into
// a session every prompt would 404 on.
async function openGoneSession(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_gone"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [other], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_gone/message")
      return route.fulfill({
        status: 404,
        json: { _tag: "SessionNotFoundError", sessionID: "ses_gone", message: "no such session" },
      })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
}

test("a saved session the engine no longer has is let go and said out loud", async ({ page }) => {
  await openGoneSession(page)

  await expect(page.locator(".fc-toast-info")).toContainText(/no longer in the engine|ya no está en el motor/i)
  // Not reported as the engine being away, which would offer a retry that cannot work.
  await expect(page.locator(".fc-toast-error")).toHaveCount(0)
  // The reader is back on the home rather than in an empty conversation.
  await expect(page.getByRole("heading", { name: "What's next?" })).toBeVisible()
  const stored = await page.evaluate(() => window.localStorage.getItem("flupcode.selectedSession"))
  expect(stored === null || stored === "null" || stored === '""').toBe(true)
})
