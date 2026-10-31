import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_chat",
  projectID: "p",
  title: "Hola",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

/** Opens the chat home with nothing selected: the screen a reader starts Cowork from. */
async function openChat(page: Page) {
  const created: Array<Record<string, unknown>> = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.view", JSON.stringify("chat"))
    window.localStorage.setItem("flupcode.chatMode", JSON.stringify("cowork"))
    window.localStorage.setItem("flupcode.selectedModel", JSON.stringify({ providerID: "openai", id: "gpt" }))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => route.fulfill({ json: { data: [] } }))
  await page.route("http://127.0.0.1:9/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === "POST" && url.pathname === "/api/session") {
      created.push(JSON.parse(request.postData() ?? "{}"))
      return route.fulfill({ json: { data: session } })
    }
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/\/message$/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/command") return route.fulfill({ json: { data: [] } })
    if (/^\/api\/session\/[^/]+\/(permission|question|form|inbox)/.test(url.pathname))
      return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await expect(page.locator(".fc-composer textarea").first()).toBeVisible()
  return created
}

/**
 * Cowork offered no way out without a folder: the send did nothing on this screen and the reason
 * only appeared in the code home. A turn is usually reading, searching or running a command, so a
 * folder is offered, not required.
 */
test("Cowork sends from the chat home with no folder, and says so when a send cannot go", async ({ page }) => {
  const created = await openChat(page)

  await page.locator(".fc-composer textarea").first().fill("Hola, ¿me ayudas con esto?")
  await page.locator(".fc-composer textarea").first().press("Enter")

  await expect.poll(() => created.length).toBe(1)
  // A session with no folder at all, not one pointing at the app's own directory.
  expect(created[0]).not.toHaveProperty("location")
  expect(created[0]).toMatchObject({ agent: "cowork" })
  // And whatever fails later is said where the reader tried it, not on another screen.
  await expect(page.locator(".fc-error")).toHaveCount(0)
})
