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
    if (url.pathname === "/api/session/ses_error/message")
      return route.fulfill({ json: { data: messages, cursor: {} } })
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
    if (url.pathname === "/api/session/ses_error/message")
      return route.fulfill({ json: { data: messages, cursor: {} } })
    if (url.pathname === "/session/ses_error/prompt_async") {
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
  expect(prompts[0]).toMatchObject({ parts: [{ type: "text", text: "Sea el balance" }] })
  await expect(composer).toHaveValue("draft in progress")
})

test("a turn waiting on a spent quota says so, instead of thinking on forever", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_error"))
  })
  // The engine reports why it is waiting through the session status, once per attempt, while the
  // transcript stays as it was: without it the run reads as "Thinking…" until the retries run out.
  const retry = {
    id: "evt_retry",
    type: "session.status",
    properties: {
      sessionID: "ses_error",
      status: { type: "retry", attempt: 2, message: "Go usage limit exceeded", next: Date.now() + 8000 },
    },
  }
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/ses_error/message")
      return route.fulfill({ json: { data: [messages[0]], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body: `data: ${JSON.stringify(retry)}\n\n`,
      })
    if (url.pathname === "/session/ses_error") return route.fulfill({ json: session })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.locator(".fc-loader-text")).toHaveText(/Go usage limit exceeded/)
})

test("a turn that has spent no tokens does not say 0 tokens", async ({ page }) => {
  const zero = [
    {
      info: {
        id: "msg_zero",
        sessionID: "ses_error",
        role: "assistant",
        agent: "build",
        modelID: "m",
        providerID: "p",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
        time: { created: now },
      },
      parts: [{ id: "p_zero", type: "text", text: "", time: { start: now } }],
    },
  ]
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_error"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/ses_error/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/session/ses_error/message") return route.fulfill({ json: zero })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  // The turn is still open, so the status line is there; what is not is a "0 tokens" chip.
  await expect(page.locator(".fc-loader")).toBeVisible()
  await expect(page.locator(".fc-loader-meta")).toHaveCount(0)
})
