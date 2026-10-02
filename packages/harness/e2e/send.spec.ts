import { expect, test } from "@playwright/test"

/**
 * A split pane sends through the same path as the composer (UX-00): the session's permission mode is
 * set first, then the prompt goes to the pane's own session with its id, and the pane's draft clears.
 */
test("a split pane sends its prompt to its own session, after setting its permission mode", async ({ page }) => {
  const now = Date.now()
  const session = (id: string, title: string) => ({
    id,
    projectID: "p",
    title,
    agent: "build",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now, updated: now },
    location: { directory: "/work/demo" },
  })
  const sessions = [session("ses_a", "First session"), session("ses_b", "Second session")]
  const calls: string[] = []
  const prompts: Array<{ id?: string; text?: string }> = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.expandedProjects", JSON.stringify({ "/work/demo": true }))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: sessions, cursor: {} } })
    const match = url.pathname.match(/^\/api\/session\/(ses_[ab])(\/.*)?$/)
    if (match && request.method() !== "GET") calls.push(`${request.method()} ${match[1]}${match[2] ?? ""}`)
    if (match && !match[2] && request.method() === "PATCH") return route.fulfill({ status: 204 })
    if (match && !match[2]) return route.fulfill({ json: { data: sessions.find((entry) => entry.id === match[1]) } })
    if (match?.[2] === "/prompt") {
      const body = request.postDataJSON() as { id?: string; text?: string }
      prompts.push(body)
      return route.fulfill({ json: { data: { id: body.id, sessionID: match[1], payload: { text: body.text } } } })
    }
    if (match?.[2] === "/agent" || match?.[2] === "/instructions") return route.fulfill({ status: 204 })
    if (/^\/api\/session\/[^/]+\/(message|permission|question|inbox|children)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await page.locator(".fc-session-row", { hasText: "First session" }).click()
  await page.locator(".fc-session-row", { hasText: "Second session" }).click({ button: "right" })
  await page.locator(".fc-menu").getByText("Split view", { exact: true }).click()

  const pane = page.locator(".fc-pane").nth(1)
  await expect(pane.locator(".fc-pane-title")).toHaveText("Second session")
  const input = pane.locator("textarea.fc-input")
  await input.fill("Hello from the pane")
  await input.press("Enter")

  await expect.poll(() => prompts.map((prompt) => prompt.text)).toEqual(["Hello from the pane"])
  expect(prompts[0]?.id).toBeTruthy()
  expect(calls.filter((call) => call.includes("ses_a"))).toEqual([])
  expect(calls.indexOf("PATCH ses_b")).toBeGreaterThanOrEqual(0)
  expect(calls.indexOf("PATCH ses_b")).toBeLessThan(calls.indexOf("POST ses_b/prompt"))
  await expect(input).toHaveValue("")
})
