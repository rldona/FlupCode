import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

// A staged revert, so the session menu offers to confirm it without the test having to stage one.
const session = {
  id: "ses_r",
  projectID: "p",
  title: "Revert",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
  revert: { messageID: "msg_r" },
}

const messages = {
  data: [{ id: "msg_r", type: "user", text: "Change the API", time: { created: now } }],
  cursor: {},
}

type Harness = {
  /** POSTs the app made, in order. */
  calls: Array<{ path: string; method: string }>
}

async function openSession(page: Page): Promise<Harness> {
  const calls: Harness["calls"] = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_r"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const record = () => calls.push({ path: url.pathname, method: request.method() })
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (url.pathname === "/api/session/ses_r/message" && request.method() === "GET")
      return route.fulfill({ json: messages })
    if (url.pathname === "/session/ses_r/revert") {
      record()
      return route.fulfill({ json: { ...session, revert: { messageID: "msg_r" } } })
    }
    if (url.pathname === "/session/ses_r/revert/commit") {
      record()
      return route.fulfill({ json: true })
    }
    if (url.pathname.startsWith("/api/session/ses_r/revert")) {
      record()
      return route.fulfill({ json: {} })
    }
    if (url.pathname === "/session/ses_r" && request.method() === "PATCH") return route.fulfill({ json: session })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/event") {
      const body = `data: ${JSON.stringify({ type: "server.heartbeat", properties: {} })}\n\n`
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body })
    }
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return { calls }
}

test("editing a prompt rewinds through the legacy runtime that wrote the message", async ({ page }) => {
  const harness = await openSession(page)

  await page.getByRole("button", { name: /^Edit$|^Editar$/ }).click()

  // The message lives in the legacy store, so a v2 revert would answer "Message not found" instead.
  await expect.poll(() => harness.calls.some((call) => call.path === "/session/ses_r/revert")).toBe(true)
  expect(harness.calls.some((call) => call.path.startsWith("/api/session/ses_r/revert"))).toBe(false)
})

test("confirming a revert commits it on the legacy runtime", async ({ page }) => {
  const harness = await openSession(page)

  await page.getByRole("button", { name: /^Menu$|^Menú$/ }).click()
  // The menu is a menu since H-24: its rows are menuitems, not generic buttons.
  await page.getByRole("menuitem", { name: /Confirm revert|Confirmar reversión/ }).click()

  // The v2 commit looks the boundary up in the v2 message table and dies for a legacy one.
  await expect.poll(() => harness.calls.some((call) => call.path === "/session/ses_r/revert/commit")).toBe(true)
  expect(harness.calls.some((call) => call.path.startsWith("/api/session/ses_r/revert"))).toBe(false)
})
