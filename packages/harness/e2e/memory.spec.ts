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
  const sent: Array<Record<string, unknown>> = []
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
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_mem/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (/\/session\/[^/]+\/message$/.test(url.pathname)) {
      if (request.method() === "POST") {
        sent.push(request.postDataJSON() as Record<string, unknown>)
        return route.fulfill({ json: { data: {} } })
      }
      return route.fulfill({ json: [] })
    }
    if (/\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: {} } })
    if (/\/session\/[^/]+$/.test(url.pathname) && request.method() === "PATCH")
      return route.fulfill({ json: { data: {} } })
    if (/\/session\/[^/]+\/prompt(_async)?$/.test(url.pathname) && request.method() === "POST") {
      sent.push(request.postDataJSON() as Record<string, unknown>)
      return route.fulfill({ json: { data: {} } })
    }
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await expect(page.locator(".fc-transcript-body")).toBeVisible()
  return { added, sent }
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

  await dialog.getByRole("button", { name: "Close" }).click()

  // And the next turn carries them.
  await composer.fill("hello")
  await page.locator(".fc-input-send").click()
  await expect.poll(() => api.sent.length).toBeGreaterThan(0)
  expect(String(api.sent[0]!.system ?? "")).toContain("Project memory:")
  expect(String(api.sent[0]!.system ?? "")).toContain("Conventional commits")
})
