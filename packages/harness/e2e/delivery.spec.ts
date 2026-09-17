import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_q2",
  projectID: "p",
  title: "Delivery",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

// One user message with no answer yet, and the engine lists the session as running: that is when
// delivery means anything at all.
const messages = {
  data: [{ id: "msg_u", type: "user", text: "Refactor it", time: { created: now } }],
  cursor: {},
}

type Harness = {
  /** Bodies POSTed to the legacy prompt endpoint, which is where a prompt goes now. */
  prompts: Array<Record<string, unknown>>
  /** Session IDs whose abort endpoint the app called. */
  aborts: string[]
  /** Lets the session's folder stream report that the turn finished. */
  finish: () => void
}

async function openRunningSession(page: Page): Promise<Harness> {
  const prompts: Array<Record<string, unknown>> = []
  const aborts: string[] = []
  const state = { idle: false, announced: false }

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_q2"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active")
      return route.fulfill({ json: { data: state.idle ? {} : { ses_q2: { type: "running" } } } })
    if (url.pathname === "/session/status")
      return route.fulfill({ json: state.idle ? {} : { ses_q2: { type: "busy" } } })
    if (url.pathname === "/api/session/ses_q2/message" && request.method() === "GET")
      return route.fulfill({ json: messages })
    if (url.pathname === "/session/ses_q2/abort") {
      aborts.push("ses_q2")
      return route.fulfill({ json: true })
    }
    if (url.pathname === "/session/ses_q2/prompt_async") {
      prompts.push(request.postDataJSON() as Record<string, unknown>)
      return route.fulfill({ json: {} })
    }
    if (url.pathname === "/session/ses_q2" && request.method() === "PATCH") return route.fulfill({ json: session })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/event") {
      // A heartbeat on every connection keeps the reconnect backoff at its floor, so the test does
      // not wait on it; the idle event goes out once, when the test asks for it.
      const events: unknown[] = [{ type: "server.heartbeat", properties: {} }]
      if (state.idle && !state.announced) {
        state.announced = true
        events.push({ type: "session.idle", properties: { sessionID: "ses_q2" } })
      }
      return route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      })
    }
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return { prompts, aborts, finish: () => (state.idle = true) }
}

test("a prompt sent while the agent works interrupts it, then reaches the engine", async ({ page }) => {
  const { prompts, aborts } = await openRunningSession(page)
  const composer = page.getByPlaceholder(/Type \/ for commands/i)

  await composer.fill("Use the other API")
  await composer.press("Enter")

  // Sending while the agent is working aborts the turn in flight — the tool it is waiting on
  // included — so the agent answers this line now instead of after that work finishes.
  await expect.poll(() => aborts.length).toBe(1)
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]).toMatchObject({ parts: [{ type: "text", text: "Use the other API" }] })
  expect(prompts[0]?.agent).toBeTruthy()
  await expect(page.locator(".fc-message-queue-badge")).toContainText(/Steering|Redirigiendo/i)
})

test("a queued prompt is held back until the turn is over", async ({ page }) => {
  const harness = await openRunningSession(page)
  const composer = page.getByPlaceholder(/Type \/ for commands/i)

  await page.locator(".fc-delivery .fc-mode-button").click()
  await page.locator('.fc-mode-item[data-delivery="queue"]').click()
  await composer.fill("And then write the tests")
  await composer.press("Enter")

  // Nothing reaches the engine: sent now it would be swallowed by the turn in flight, because the
  // legacy runtime has no queue of its own.
  await expect(page.locator(".fc-message-queue-badge")).toContainText(/Queued|En cola/i)
  await page.waitForTimeout(1500)
  expect(harness.prompts).toEqual([])
  // Queue means wait, so nothing is interrupted either.
  expect(harness.aborts).toEqual([])

  harness.finish()
  await expect.poll(() => harness.prompts.length, { timeout: 15_000 }).toBe(1)
  expect(harness.prompts[0]).toMatchObject({ parts: [{ type: "text", text: "And then write the tests" }] })
})

test("a queued prompt can be sent early or dropped", async ({ page }) => {
  const harness = await openRunningSession(page)
  const composer = page.getByPlaceholder(/Type \/ for commands/i)

  await page.locator(".fc-delivery .fc-mode-button").click()
  await page.locator('.fc-mode-item[data-delivery="queue"]').click()

  await composer.fill("Drop me")
  await composer.press("Enter")
  await expect(page.locator(".fc-message-send-now")).toHaveCount(2)
  await page.getByRole("button", { name: /^Cancel$|^Cancelar$/ }).click()
  await expect(page.locator(".fc-message-queue-badge")).toHaveCount(0)
  expect(harness.prompts).toEqual([])

  await composer.fill("Send me early")
  await composer.press("Enter")
  await page.getByRole("button", { name: /Send now|Enviar ahora/i }).click()
  await expect.poll(() => harness.prompts.length).toBe(1)
  expect(harness.prompts[0]).toMatchObject({ parts: [{ type: "text", text: "Send me early" }] })
})

test("the delivery choice is remembered", async ({ page }) => {
  await openRunningSession(page)
  await page.locator(".fc-delivery .fc-mode-button").click()
  await page.locator('.fc-mode-item[data-delivery="queue"]').click()
  await expect(page.locator(".fc-delivery .fc-mode-button")).toContainText(/Queue|Encolar/i)

  await page.reload()
  await expect(page.locator(".fc-delivery .fc-mode-button")).toContainText(/Queue|Encolar/i)
})

test("the delivery control is there before the agent starts working", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  // A control that only appears once the agent is already working is a control nobody finds.
  await expect(page.locator(".fc-delivery .fc-mode-button")).toBeVisible()
})
