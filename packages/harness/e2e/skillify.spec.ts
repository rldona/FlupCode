import { expect, test, type Page } from "@playwright/test"

const session = {
  id: "ses_skill",
  projectID: "p",
  title: "Auth refactor",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  location: { directory: "/work/demo" },
}

/**
 * H-43: the open session can be turned into a skill. The ask goes to that session — the one that
 * did the work — and it is a request to write the file with its own tools, so what this test holds
 * is the prompt reaching the engine with the path and the file name the Skills screen reads.
 */
async function open(page: Page) {
  const prompts: Array<Record<string, unknown>> = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_skill"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (url.pathname === "/api/session/ses_skill/message" && request.method() === "GET")
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/session/ses_skill/prompt_async") {
      prompts.push(request.postDataJSON() as Record<string, unknown>)
      return route.fulfill({ json: {} })
    }
    if (url.pathname === "/session/ses_skill" && request.method() === "PATCH") return route.fulfill({ json: session })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event" || url.pathname === "/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return prompts
}

test("the open session can be saved as a skill", async ({ page }) => {
  const prompts = await open(page)

  await page.locator(".fc-sidebar-search").click()
  await page.locator(".fc-palette-input").fill("skillify")
  await page.keyboard.press("Enter")

  await expect.poll(() => prompts.length).toBe(1)
  const parts = (prompts[0] as { parts?: Array<{ text?: string }> }).parts ?? []
  expect(parts[0]?.text).toContain(".opencode/skills/<short-name>/SKILL.md")
  expect(parts[0]?.text).toContain("name: <short-name>")
})
