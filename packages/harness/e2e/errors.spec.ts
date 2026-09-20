import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_err",
  projectID: "p",
  title: "Errors",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const messages = {
  data: [
    { id: "msg_u", type: "user", text: "Hello", time: { created: now } },
    {
      id: "msg_a",
      type: "assistant",
      agent: "build",
      model: { providerID: "p", id: "m" },
      content: [{ type: "text", id: "p1", text: "Answering" }],
      time: { created: now + 1, completed: now + 2 },
    },
  ],
  cursor: {},
}

type Options = {
  /** Answers after this many successful message fetches fail; the transcript goes stale. */
  failMessagesAfter?: number
  /** Events the first `/api/event` connection delivers, which is what triggers a refetch. */
  events?: unknown[]
  /** The working-tree diff the side panel reads; a non-array makes it throw while rendering. */
  diff?: unknown
  panels?: string[]
}

async function openSession(page: Page, options: Options = {}) {
  let served = 0
  let streams = 0
  await page.addInitScript((panels) => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_err"))
    if (panels.length > 0) window.localStorage.setItem("flupcode.workspacePanels", JSON.stringify(panels))
  }, options.panels ?? [])
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/vcs/diff") return route.fulfill({ json: options.diff ?? [] })
    if (url.pathname === "/api/session/ses_err/message") {
      if (options.failMessagesAfter !== undefined && served++ >= options.failMessagesAfter)
        return route.fulfill({ status: 500, json: { message: "engine gone" } })
      return route.fulfill({ json: messages })
    }
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event") {
      const batch = streams++ === 0 ? (options.events ?? []) : []
      return route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body: batch.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      })
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
}

test("a toast reaches the reader instead of being built and thrown away", async ({ page }) => {
  await openSession(page)
  await expect(page.getByText("Answering")).toBeVisible()

  await page.getByRole("button", { name: "Menu", exact: true }).first().click()
  await page.getByText("Export MD").click()

  // The toaster was never mounted, so every message this app raised — sent, exported, failed —
  // went nowhere.
  await expect(page.locator(".fc-toast")).toContainText(/Transcript exported|Transcripción exportada/i)
})

test("a transcript that stopped following the engine says so and offers to try again", async ({ page }) => {
  await openSession(page, {
    failMessagesAfter: 1,
    events: [{ type: "message.updated", data: { sessionID: "ses_err" } }],
  })
  await expect(page.getByText("Answering")).toBeVisible()

  const toast = page.locator(".fc-toast-error")
  await expect(toast).toContainText(/not following the engine|no está siguiendo/i)
  // The last good transcript stays on screen rather than being blanked out.
  await expect(page.getByText("Answering")).toBeVisible()

  // An error toast with something to do about it waits for the reader instead of vanishing.
  await page.waitForTimeout(4500)
  await expect(toast).toBeVisible()
  await expect(toast.getByRole("button", { name: /Try again|Reintentar/i })).toBeVisible()
})

test("a side panel that throws while rendering does not take the app down", async ({ page }) => {
  await openSession(page, { panels: ["diff"], diff: { notAnArray: true } })

  // Without a boundary around the panels, this reaches the root and shows the startup error screen.
  await expect(page.getByText(/could not be shown|no se pudo mostrar/i)).toBeVisible()
  await expect(page.getByText("FlupCode couldn't start")).toHaveCount(0)
  await expect(page.getByText("Answering")).toBeVisible()
  await expect(page.getByRole("button", { name: /New/ }).first()).toBeVisible()
})
