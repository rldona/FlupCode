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

// One user message with no answer yet: the session reads as running, which is when delivery matters.
const messages = {
  data: [{ id: "msg_u", type: "user", text: "Refactor it", time: { created: now } }],
  cursor: {},
}

async function openRunningSession(page: Page) {
  const prompts: Array<Record<string, unknown>> = []
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
      return route.fulfill({ json: { data: { ses_q2: { type: "running" } } } })
    if (url.pathname === "/api/session/ses_q2/message" && request.method() === "GET")
      return route.fulfill({ json: messages })
    if (url.pathname === "/api/session/ses_q2/prompt") {
      prompts.push(request.postDataJSON() as Record<string, unknown>)
      return route.fulfill({ json: { data: {} } })
    }
    if (url.pathname === "/session/ses_q2" && request.method() === "PATCH") return route.fulfill({ json: session })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return prompts
}

test("the composer chooses what happens to a prompt sent mid-turn", async ({ page }) => {
  const prompts = await openRunningSession(page)
  const composer = page.getByPlaceholder(/Type \/ for commands/i)

  // The default is the engine's own: the prompt redirects the turn in flight.
  await composer.fill("Use the other API")
  await composer.press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]?.delivery).toBe("steer")
  await expect(page.locator(".fc-message-queue-badge")).toContainText(/Steering|Redirigiendo/i)

  await page.locator(".fc-delivery .fc-mode-button").click()
  await page.locator('.fc-mode-item[data-delivery="queue"]').click()

  await composer.fill("And then write the tests")
  await composer.press("Enter")
  await expect.poll(() => prompts.length).toBe(2)
  expect(prompts[1]?.delivery).toBe("queue")
  await expect(page.locator(".fc-message-queue-badge").last()).toContainText(/Queued|En cola/i)
})

test("only a queued prompt offers to jump the running turn", async ({ page }) => {
  await openRunningSession(page)
  const composer = page.getByPlaceholder(/Type \/ for commands/i)

  await composer.fill("Steered")
  await composer.press("Enter")
  // A steered prompt is already promoted at the next boundary, so there is nothing to hurry along.
  await expect(page.locator(".fc-message-queue-badge")).toBeVisible()
  await expect(page.locator(".fc-message-send-now")).toHaveCount(0)

  await page.locator(".fc-delivery .fc-mode-button").click()
  await page.locator('.fc-mode-item[data-delivery="queue"]').click()
  await composer.fill("Queued")
  await composer.press("Enter")
  await expect(page.locator(".fc-message-send-now")).toHaveCount(1)
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
