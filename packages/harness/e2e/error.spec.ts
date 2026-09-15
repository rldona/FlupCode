import { expect, test } from "@playwright/test"

const now = Date.now()
const message = 'Provider request failed with HTTP 402: {"error":{"message":"Insufficient Balance"}}'

const session = {
  id: "ses_error",
  projectID: "p",
  title: "Failed session",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const messages = [
  { id: "msg_u", type: "user", text: "Sea el balance", time: { created: now } },
  {
    id: "msg_a",
    type: "assistant",
    agent: "plan",
    model: { providerID: "p", id: "m" },
    content: [],
    error: { type: "unknown", message },
    time: { created: now + 1, completed: now + 2 },
  },
]

test("shows the provider's failure reason instead of a generic error", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_error"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/ses_error/message") return route.fulfill({ json: { data: messages, cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  const error = page.locator(".fc-message-error")
  await expect(error).toBeVisible()
  // The reader sees the provider's sentence, not the JSON envelope; the raw text stays in the tooltip.
  const detail = error.locator(".fc-message-error-detail")
  await expect(detail).toHaveText("HTTP 402: Insufficient Balance")
  await expect(detail).toHaveAttribute("title", message)
})

test("Retry resends the failed turn's prompt with the same session", async ({ page }) => {
  const prompts: unknown[] = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_error"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/ses_error/message") return route.fulfill({ json: { data: messages, cursor: {} } })
    if (url.pathname === "/api/session/ses_error/prompt") {
      prompts.push(route.request().postDataJSON())
      return route.fulfill({ json: { data: { accepted: true } } })
    }
    if (url.pathname === "/session/ses_error") return route.fulfill({ json: session })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  const composer = page.locator("textarea").first()
  await composer.fill("draft in progress")
  await page.locator(".fc-message-retry").click()

  // The failed prompt goes out again as-is; the draft in the composer stays untouched.
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]).toMatchObject({ prompt: { text: "Sea el balance" } })
  await expect(composer).toHaveValue("draft in progress")
})
