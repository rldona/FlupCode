import { expect, test } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_x",
  projectID: "p",
  title: "Work",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const models = [
  { id: "claude-opus-5", providerID: "anthropic", name: "Claude Opus 5" },
  { id: "gpt-5", providerID: "openai", name: "GPT-5" },
  { id: "claude-sonnet-5", providerID: "anthropic", name: "Claude Sonnet 5" },
]

const routine = {
  id: "r1",
  name: "Nightly audit",
  description: "",
  prompt: "Check the dependencies",
  schedule: { type: "manual" },
  enabled: true,
  createdAt: now,
  updatedAt: now,
  runs: [] as unknown[],
}

const engine = (page: import("@playwright/test").Page) =>
  page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/model") return route.fulfill({ json: { data: models } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })

const boot = async (page: import("@playwright/test").Page, deleted: string[], path = "/") => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
  await engine(page)
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/routines" && route.request().method() === "GET")
      return route.fulfill({ json: { data: deleted.length > 0 ? [] : [routine] } })
    if (/^\/harness\/routines\/[^/]+$/.test(url.pathname) && route.request().method() === "DELETE") {
      deleted.push(url.pathname.split("/").pop()!)
      return route.fulfill({ json: { data: true } })
    }
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto(path)
  if (path === "/") await page.getByRole("button", { name: /Routines|Rutinas/ }).click()
  return page.locator(".fc-routines-screen")
}

// Someone reading the list has no way to tell two models of the same name apart, and no way to see
// which provider a name belongs to. The list is grouped so the provider is on screen next to it.
test("the model list is grouped by provider", async ({ page }) => {
  const screen = await boot(page, [])
  await screen.getByRole("button", { name: /New routine|Nueva rutina/ }).click()
  const select = screen.locator("select").filter({ has: page.locator('option[value="anthropic/claude-opus-5"]') })
  await expect(select.locator("optgroup")).toHaveCount(2)
  await expect(select.locator("optgroup").first()).toHaveAttribute("label", "anthropic")
})

// Deleting asks first, and the question has to be where the eye already is: the confirmation used to
// render at the foot of a scrolling screen, so the button looked dead.
test("a routine can be deleted from the detail view", async ({ page }) => {
  const deleted: string[] = []
  const screen = await boot(page, deleted)
  await screen.getByRole("button", { name: "Nightly audit" }).click()
  await screen
    .getByRole("button", { name: /^(Delete|Borrar|Eliminar)$/ })
    .first()
    .click()
  const confirm = screen.getByText(/Delete this routine\?|¿Borrar esta rutina\?|¿Eliminar esta rutina\?/)
  await expect(confirm).toBeInViewport()
  await screen
    .getByRole("button", { name: /^(Delete|Borrar|Eliminar)$/ })
    .last()
    .click()
  await expect.poll(() => deleted).toEqual(["r1"])
  await expect(screen.getByRole("button", { name: "Nightly audit" })).toHaveCount(0)
})

// The Templates tab has nothing behind it and is not a defect: it says so, the way the sidebar does.
test("the Templates tab says it is not here yet", async ({ page }) => {
  const screen = await boot(page, [])
  const tab = screen.getByRole("button", { name: /Templates|Plantillas/ })
  await expect(tab).toBeDisabled()
  await expect(tab.locator(".fc-nav-soon")).toHaveText(/Soon|Pronto/)
})

// A screen you can reload is a screen you can link to and come back to. It lives in the hash, which
// survives a reload wherever this build is served from, including the desktop app's own bundle.
test("a screen is kept in the URL, through a reload and the Back button", async ({ page }) => {
  const screen = await boot(page, [])
  await expect(screen).toBeVisible()
  await expect(page).toHaveURL(/#routines$/)

  await page.reload()
  await expect(page.locator(".fc-routines-screen")).toBeVisible()

  // Back leaves the screen instead of leaving the app.
  await page.goBack()
  await expect(page.locator(".fc-routines-screen")).toHaveCount(0)
  await expect(page).not.toHaveURL(/#routines$/)
})

// And the link works cold: opened straight at the address, with no click to get there.
test("the Runs screen opens from its own address", async ({ page }) => {
  await boot(page, [], "/#runs")
  await expect(page.locator('section[aria-label="Runs"], section[aria-label="Ejecuciones"]')).toBeVisible()
})
