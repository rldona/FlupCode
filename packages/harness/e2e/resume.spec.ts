import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

/** A Cowork session: a project session marked by the reserved agent (ADR-0013). */
const session = {
  id: "ses_cw",
  projectID: "p",
  title: "Cowork",
  agent: "cowork",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

type Harness = {
  /** Bodies POSTed to the session's prompt endpoint: what reached the model as a message. */
  prompts: Array<Record<string, unknown>>
  /** Session IDs whose compact endpoint the app called, which is the engine's compaction. */
  summarized: string[]
}

/**
 * Commands in a conversation. `/compact` used to be typed straight to the model in Chat and Cowork,
 * which answered with a status summary instead of folding the session; the summary is worth having,
 * so it is `/resume` now, and `/compact` reaches the engine like it does in Code.
 */
async function openCowork(page: Page): Promise<Harness> {
  const prompts: Array<Record<string, unknown>> = []
  const summarized: string[] = []

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_cw"))
    window.localStorage.setItem("flupcode.view", JSON.stringify("chat"))
    window.localStorage.setItem("flupcode.selectedModel", JSON.stringify({ providerID: "anthropic", id: "sonnet" }))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_cw/message" && request.method() === "GET")
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/ses_cw/compact") {
      summarized.push("ses_cw")
      return route.fulfill({ json: { data: {} } })
    }
    if (url.pathname === "/api/session/ses_cw/prompt") {
      prompts.push(request.postDataJSON() as Record<string, unknown>)
      const id = (request.postDataJSON() as { id?: string }).id ?? "msg_p"
      return route.fulfill({
        json: { data: { id, sessionID: "ses_cw", payload: { text: "" }, delivery: "steer", time: { created: now } } },
      })
    }
    if (url.pathname === "/api/session/ses_cw" && request.method() === "PATCH") return route.fulfill({ status: 204 })
    if (url.pathname === "/api/session/ses_cw" && request.method() === "GET")
      return route.fulfill({ json: { data: session } })
    if (/^\/api\/session\/ses_cw\/(agent|model)$/.test(url.pathname)) return route.fulfill({ status: 204 })
    if (/^\/api\/session\/[^/]+\/(permission|form|inbox)/.test(url.pathname))
      return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return { prompts, summarized }
}

const type = async (page: Page, text: string) => {
  const composer = page.locator(".fc-composer textarea").first()
  await composer.fill(text)
  await composer.press("Enter")
}

test("/compact folds the conversation through the engine instead of asking the model", async ({ page }) => {
  const { prompts, summarized } = await openCowork(page)

  await type(page, "/compact")

  await expect.poll(() => summarized).toEqual(["ses_cw"])
  expect(prompts).toEqual([])
})

test("/resume asks the conversation itself for a checkpoint of the work", async ({ page }) => {
  const { prompts } = await openCowork(page)

  await type(page, "/resume")

  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]?.text).toContain("checkpoint of this session")
})
