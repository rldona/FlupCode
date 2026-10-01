import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_mem",
  projectID: "p",
  title: "Memory",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

async function open(page: Page) {
  const added: Array<Record<string, unknown>> = []
  const instructions: Array<{ key: string; value: unknown }> = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_mem"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, capabilities: ["memory"] } } })
    if (url.pathname === "/harness/memory" && request.method() === "GET")
      return route.fulfill({
        json: { data: [{ id: "m1", directory: "/work/demo", text: "Conventional commits", createdAt: 1 }] },
      })
    if (url.pathname === "/harness/memory" && request.method() === "POST") {
      added.push(request.postDataJSON() as Record<string, unknown>)
      return route.fulfill({
        json: { data: { id: "m2", directory: "/work/demo", text: "Use the server", createdAt: 2 } },
      })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_mem/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/ses_mem" && request.method() === "PATCH") return route.fulfill({ status: 204 })
    if (url.pathname === "/api/session/ses_mem") return route.fulfill({ json: { data: session } })
    if (url.pathname === "/api/session/ses_mem/agent") return route.fulfill({ status: 204 })
    if (url.pathname === "/api/session/ses_mem/prompt")
      return route.fulfill({ json: { data: { id: "msg_1", sessionID: "ses_mem", type: "user", delivery: "steer" } } })
    if (url.pathname === "/api/experimental/session/ses_mem/instructions/entries")
      return route.fulfill({ json: { data: [] } })
    const entry = url.pathname.match(/^\/api\/experimental\/session\/ses_mem\/instructions\/entries\/(.+)$/)?.[1]
    if (entry && request.method() === "PUT") {
      instructions.push({ key: decodeURIComponent(entry), value: (request.postDataJSON() as { value: unknown }).value })
      return route.fulfill({ status: 204 })
    }
    if (/^\/api\/session\/[^/]+\/(permission|form|inbox)/.test(url.pathname))
      return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await expect(page.locator(".fc-transcript-body")).toBeVisible()
  return { added, instructions }
}

test("the project's notes are kept here and handed to the next turn", async ({ page }) => {
  const api = await open(page)

  // The panel opens from the `/memory` command, and shows the harness's notes first.
  const composer = page.getByPlaceholder(/Type \/ for commands/i)
  await composer.fill("/memory")
  await composer.press("Enter")
  const dialog = page.getByRole("dialog", { name: "Memory" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "Project notes" })).toBeVisible()
  await expect(dialog.getByText("Conventional commits")).toBeVisible()

  await dialog.getByPlaceholder("Use the server, not the browser, for anything durable").fill("Use the server")
  await dialog.getByRole("button", { name: "Add note" }).click()
  await expect.poll(() => api.added).toEqual([{ directory: "/work/demo", text: "Use the server" }])
  await expect(dialog.getByText("Use the server")).toBeVisible()

  // The next turn carries every note, as the session instruction the engine puts in the system prompt.
  await page.keyboard.press("Escape")
  await composer.fill("What should I do next?")
  await composer.press("Enter")
  await expect
    .poll(() => api.instructions.find((entry) => entry.key === "flupcode.notes")?.value)
    .toBe("Project memory:\n- Conventional commits\n- Use the server")
})
