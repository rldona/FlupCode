import { expect, test, type Page } from "@playwright/test"

// The files and artifacts screens read the engine and the harness server on their own. A 500 there
// used to reach the root boundary and replace the app with the startup screen; now it is said where
// the answer would have been, with a way to ask again.

const now = Date.now()

const session = {
  id: "ses_fail",
  projectID: "p",
  title: "Failing reads",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const artifact = {
  id: "shot",
  kind: "document",
  title: "Shot",
  producer: "agent",
  mime: "image/png",
  createdAt: now,
  path: ".flupcode/artifacts/shot.png",
  directory: "/work/demo",
}

/** Which routes answer 500 right now. Tests flip these to show the retry recovering. */
type Failing = { list: boolean; find: boolean; raw: boolean }

async function openApp(page: Page, failing: Failing) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_fail"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, capabilities: ["packs", "files"] } } })
    if (url.pathname === "/harness/artifacts") return route.fulfill({ json: { data: [artifact] } })
    if (/^\/harness\/artifacts\/[^/]+\/raw$/.test(url.pathname))
      return failing.raw
        ? route.fulfill({ status: 500, json: { error: "artifact store is away" } })
        : route.fulfill({ status: 200, contentType: "image/png", body: "png" })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/vcs") return route.fulfill({ json: { branch: "main", default_branch: "main" } })
    if (url.pathname === "/api/fs/list")
      return failing.list
        ? route.fulfill({ status: 500, json: { error: "listing is away" } })
        : route.fulfill({ json: { location: {}, data: [{ path: "README.md", type: "file" }] } })
    if (url.pathname === "/api/fs/find")
      return failing.find
        ? route.fulfill({ status: 500, json: { error: "search is away" } })
        : route.fulfill({ json: { location: {}, data: [{ path: "src/server.ts", type: "file" }] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
}

const fatal = (page: Page) => page.getByText("FlupCode couldn't start")

test("a 500 on the folder listing is said inline, and trying again paints the tree", async ({ page }) => {
  const failing = { list: true, find: false, raw: false }
  await openApp(page, failing)
  await page.goto("/files")

  const alert = page.getByRole("alert").filter({ hasText: "The folder could not be read" })
  await expect(alert).toBeVisible()
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible()
  await expect(fatal(page)).toHaveCount(0)

  failing.list = false
  await alert.getByRole("button", { name: "Try again" }).click()
  await expect(page.locator(".fc-files-entry", { hasText: "README.md" })).toBeVisible()
  await expect(alert).toHaveCount(0)
})

test("a 500 on the file search is said inline, and the rest of the app stays usable", async ({ page }) => {
  const failing = { list: false, find: true, raw: false }
  await openApp(page, failing)
  await page.goto("/files")

  await page.getByLabel("Search files").fill("server")
  const alert = page.getByRole("alert").filter({ hasText: "The search could not be read" })
  await expect(alert).toBeVisible()
  await expect(fatal(page)).toHaveCount(0)

  // Leaving the screen works, and so does coming back to it.
  await page.getByRole("button", { name: "Back to sessions" }).click()
  await expect(page.getByRole("heading", { name: "Files" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /New/ }).first()).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible()

  failing.find = false
  await page.getByLabel("Search files").fill("serve")
  await expect(page.locator(".fc-files-entry", { hasText: "src/server.ts" })).toBeVisible()
  await expect(page.getByRole("alert").filter({ hasText: "The search could not be read" })).toHaveCount(0)
})

test("a 500 on an artifact's bytes is said in the viewer, and trying again draws it", async ({ page }) => {
  const failing = { list: false, find: false, raw: true }
  await openApp(page, failing)
  await page.goto("/artifacts")

  await page.locator(".fc-artifact-card", { hasText: "Shot" }).locator(".fc-artifact-card-main").click()
  const alert = page.getByRole("alert").filter({ hasText: "This artifact could not be read" })
  await expect(alert).toBeVisible()
  await expect(fatal(page)).toHaveCount(0)

  // The list is still one click away.
  await page.locator(".fc-artifact-viewer-bar").getByRole("button", { name: /Back|Atrás/ }).click()
  await expect(page.locator(".fc-artifact-card")).toHaveCount(1)
  await page.locator(".fc-artifact-card", { hasText: "Shot" }).locator(".fc-artifact-card-main").click()

  failing.raw = false
  await alert.getByRole("button", { name: "Try again" }).click()
  await expect(page.locator(".fc-artifact-image img")).toHaveAttribute("src", /^blob:/)
  await expect(alert).toHaveCount(0)
})
