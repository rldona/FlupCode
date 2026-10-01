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
  /** Bodies POSTed to the session's prompt endpoint. */
  prompts: Array<Record<string, unknown>>
  /** Session IDs whose interrupt endpoint the app called. */
  interrupts: string[]
  /** Inbox calls, in order: `PATCH <id> <delivery>` or `DELETE <id>`. */
  inbox: string[]
}

async function openRunningSession(page: Page): Promise<Harness> {
  const prompts: Harness["prompts"] = []
  const interrupts: string[] = []
  const inbox: string[] = []
  // What the session inbox holds: every prompt admitted as `queue` and not sent early or cancelled.
  const held = new Map<string, { id: string; type: "user"; payload: { text: string }; delivery: string }>()

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_q2"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active")
      return route.fulfill({ json: { data: { ses_q2: { type: "running" } } } })
    if (url.pathname === "/api/session/ses_q2" && request.method() === "PATCH") return route.fulfill({ status: 204 })
    if (url.pathname === "/api/session/ses_q2" && request.method() === "GET")
      return route.fulfill({ json: { data: session } })
    if (url.pathname === "/api/session/ses_q2/agent") return route.fulfill({ status: 204 })
    if (url.pathname === "/api/session/ses_q2/message" && request.method() === "GET")
      return route.fulfill({ json: messages })
    if (url.pathname === "/api/session/ses_q2/interrupt") {
      interrupts.push("ses_q2")
      return route.fulfill({ json: {} })
    }
    if (url.pathname === "/api/session/ses_q2/prompt") {
      const body = request.postDataJSON() as { id: string; text: string; delivery?: string }
      prompts.push(body)
      if (body.delivery === "queue")
        held.set(body.id, { id: body.id, type: "user", payload: { text: body.text }, delivery: "queue" })
      return route.fulfill({
        json: {
          data: {
            id: body.id,
            sessionID: "ses_q2",
            payload: { text: body.text },
            delivery: body.delivery ?? "steer",
            time: { created: now },
          },
        },
      })
    }
    if (url.pathname === "/api/session/ses_q2/inbox") return route.fulfill({ json: { data: [...held.values()] } })
    const item = url.pathname.match(/^\/api\/session\/ses_q2\/inbox\/([^/]+)$/)?.[1]
    if (item && request.method() === "PATCH") {
      inbox.push(`PATCH ${item} ${(request.postDataJSON() as { delivery: string }).delivery}`)
      held.delete(item)
      return route.fulfill({ status: 204 })
    }
    if (item && request.method() === "DELETE") {
      inbox.push(`DELETE ${item}`)
      held.delete(item)
      return route.fulfill({ status: 204 })
    }
    if (/^\/api\/session\/[^/]+\/(permission|form)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return { prompts, interrupts, inbox }
}

test("a prompt sent while the agent works steers the running turn through the engine", async ({ page }) => {
  const harness = await openRunningSession(page)
  const composer = page.getByPlaceholder(/Type \/ for commands/i)

  await composer.fill("Use the other API")
  await composer.press("Enter")

  // The engine joins a steer to the running execution at its next safe boundary, so the app sends it
  // as it is and stops nothing first.
  await expect.poll(() => harness.prompts.length).toBe(1)
  expect(harness.prompts[0]).toMatchObject({ text: "Use the other API", delivery: "steer" })
  await expect(page.locator(".fc-message-queue-badge")).toContainText(/Steering|Redirigiendo/i)
  expect(harness.interrupts).toEqual([])
})

test("a queued prompt waits in the session inbox, even across a reload", async ({ page }) => {
  const harness = await openRunningSession(page)
  const composer = page.getByPlaceholder(/Type \/ for commands/i)

  await page.locator(".fc-delivery .fc-mode-button").click()
  await page.locator('.fc-mode-item[data-delivery="queue"]').click()
  await composer.fill("And then write the tests")
  await composer.press("Enter")

  // The engine holds a queued prompt until the session would go idle; the app hands it over at once.
  await expect.poll(() => harness.prompts.length).toBe(1)
  expect(harness.prompts[0]).toMatchObject({ text: "And then write the tests", delivery: "queue" })
  await expect(page.locator(".fc-message-queue-badge")).toContainText(/Queued|En cola/i)
  // Queue means wait, so nothing is interrupted either.
  expect(harness.interrupts).toEqual([])

  // The inbox is the engine's, so the queued prompt is still there after a reload.
  await page.reload()
  await expect(page.locator(".fc-message-queue-badge")).toContainText(/Queued|En cola/i)
  expect(harness.prompts).toHaveLength(1)
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
  const dropped = harness.prompts[0]?.id
  await expect.poll(() => harness.inbox).toEqual([`DELETE ${dropped}`])

  await composer.fill("Send me early")
  await composer.press("Enter")
  await page.getByRole("button", { name: /Send now|Enviar ahora/i }).click()
  await expect.poll(() => harness.prompts.length).toBe(2)
  expect(harness.prompts[1]).toMatchObject({ text: "Send me early", delivery: "queue" })
  // Sending early asks the engine to steer the prompt it holds, not to admit it again.
  await expect.poll(() => harness.inbox).toEqual([`DELETE ${dropped}`, `PATCH ${harness.prompts[1]?.id} steer`])
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
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  // A control that only appears once the agent is already working is a control nobody finds.
  await expect(page.locator(".fc-delivery .fc-mode-button")).toBeVisible()
})
