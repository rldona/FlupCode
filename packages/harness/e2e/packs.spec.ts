import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_pack",
  projectID: "p",
  title: "Packs",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const pack = {
  id: "pack_1",
  name: "review",
  refs: ["@src/a.ts", "@artifact:report"],
  directory: "/work/demo",
  createdAt: now,
}

async function openApp(page: Page) {
  const saves: Array<Record<string, unknown>> = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_pack"))
    window.localStorage.setItem("flupcode.selectedModel", JSON.stringify({ providerID: "openai", id: "gpt" }))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, capabilities: ["session-prefs", "stash", "packs"] } } })
    if (url.pathname === "/harness/packs" && request.method() === "GET")
      return route.fulfill({ json: { data: [pack] } })
    if (url.pathname === "/harness/packs" && request.method() === "POST") {
      saves.push(request.postDataJSON() as Record<string, unknown>)
      return route.fulfill({ json: { data: { ...pack, ...(request.postDataJSON() as object) } } })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_pack/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/vcs") return route.fulfill({ json: { branch: "main", default_branch: "main" } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return saves
}

test("a context pack is offered in the @ menu and drops its refs in as chips", async ({ page }) => {
  await openApp(page)
  const composer = page.getByPlaceholder(/Type \/ for commands/i)
  await composer.fill("@")

  const row = page.locator(".fc-command-item").filter({ hasText: "review" })
  await expect(row).toBeVisible()
  await expect(row).toContainText("pack")
  await row.click()

  // Each ref is a chip of its own (UX-05), resolved when the message goes, and the draft is left empty.
  const chips = page.locator(".fc-composer .fc-composer-chip")
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(0)).toContainText("src/a.ts")
  await expect(chips.nth(1)).toContainText("report")
  await expect(composer).toHaveValue("")
})

test("the chips a pack dropped can be saved as a pack again", async ({ page }) => {
  const saves = await openApp(page)
  const composer = page.getByPlaceholder(/Type \/ for commands/i)
  await composer.fill("@")
  await page.locator(".fc-command-item").filter({ hasText: "review" }).click()

  await composer.fill("@")
  await page.locator(".fc-command-save").click()
  const dialog = page.getByRole("dialog", { name: "Name this pack" })
  await dialog.getByLabel("New title").fill("again")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect.poll(() => saves).toEqual([{ name: "again", refs: ["@src/a.ts", "@artifact:report"], directory: "/work/demo" }])
})

test("the refs in a draft can be saved as a pack", async ({ page }) => {
  const saves = await openApp(page)
  const composer = page.getByPlaceholder(/Type \/ for commands/i)
  await composer.fill("@src/a.ts @artifact:report")

  await page.locator(".fc-command-save").click()
  const dialog = page.getByRole("dialog", { name: "Name this pack" })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("New title").fill("my-pack")
  await dialog.getByRole("button", { name: "Save" }).click()

  await expect.poll(() => saves).toEqual([
    { name: "my-pack", refs: ["@src/a.ts", "@artifact:report"], directory: "/work/demo" },
  ])
  await expect(dialog).toHaveCount(0)
})
