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
  // The turn is over: a completed assistant reply follows the prompt, so the app reads the
  // session as idle and Edit is enabled. A bare user message alone reads as "still generating",
  // which correctly disables Edit but makes the test wait forever. Newest first, as 2.x pages them.
  data: [
    {
      id: "msg_a",
      type: "assistant",
      agent: "build",
      model: { providerID: "p", id: "m" },
      time: { created: now, completed: now + 1 },
      content: [{ type: "text", text: "Done." }],
    },
    { id: "msg_r", type: "user", text: "Change the API", time: { created: now } },
  ],
  cursor: {},
}

type Harness = {
  /** Revert calls the app made, in order, with what they sent. */
  calls: Array<{ path: string; method: string; body: unknown }>
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
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_r/message" && request.method() === "GET")
      return route.fulfill({ json: messages })
    if (url.pathname.startsWith("/api/session/ses_r/revert")) {
      calls.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() })
      // Staging answers with the session; committing and clearing answer with nothing.
      if (url.pathname.endsWith("/stage")) return route.fulfill({ json: { data: session } })
      return route.fulfill({ status: 204 })
    }
    if (/^\/api\/session\/[^/]+\/(permission|form|inbox)/.test(url.pathname))
      return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return { calls }
}

test("editing a prompt stages a revert at that message", async ({ page }) => {
  const harness = await openSession(page)

  await page.getByRole("button", { name: /^Edit$|^Editar$/ }).click()

  await expect.poll(() => harness.calls.map((call) => call.path)).toEqual(["/api/session/ses_r/revert/stage"])
  expect(harness.calls[0]).toMatchObject({ method: "POST", body: { messageID: "msg_r" } })
})

test("confirming a staged revert commits it", async ({ page }) => {
  const harness = await openSession(page)

  await page.getByRole("button", { name: /^Menu$|^Menú$/ }).click()
  // The menu is a menu since H-24: its rows are menuitems, not generic buttons.
  await page.getByRole("menuitem", { name: /Confirm revert|Confirmar reversión/ }).click()

  await expect.poll(() => harness.calls.map((call) => call.path)).toEqual(["/api/session/ses_r/revert/commit"])
  expect(harness.calls[0]?.method).toBe("POST")
})
