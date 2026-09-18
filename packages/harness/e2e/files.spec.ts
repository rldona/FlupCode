import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_files",
  projectID: "p",
  title: "Files",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const rootEntries = [
  { path: "src", type: "directory" as const },
  { path: "README.md", type: "file" as const },
]
const srcEntries = [
  { path: "src/server.ts", type: "file" as const },
  { path: "src/client.ts", type: "file" as const },
]

async function openApp(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_files"))
    window.localStorage.setItem("flupcode.selectedModel", JSON.stringify({ providerID: "openai", id: "gpt" }))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, capabilities: ["packs", "files"] } } })
    if (url.pathname === "/harness/files/read") {
      const path = url.searchParams.get("path") ?? ""
      return route.fulfill({
        json: {
          data: {
            path,
            content: `// ${path}\nexport const server = true\n`,
            bytes: 40,
            truncated: false,
            binary: false,
          },
        },
      })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_files/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/vcs") return route.fulfill({ json: { branch: "main", default_branch: "main" } })
    if (url.pathname === "/api/fs/list") {
      const path = url.searchParams.get("path") ?? ""
      return route.fulfill({ json: { location: {}, data: path === "src" ? srcEntries : rootEntries } })
    }
    if (url.pathname === "/api/fs/find")
      return route.fulfill({ json: { location: {}, data: [{ path: "src/server.ts", type: "file" }] } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
}

test("the file tree opens a folder and reads a file", async ({ page }) => {
  await openApp(page)
  await page.goto("/files")

  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible()
  await page.locator(".fc-files-entry", { hasText: "src" }).click()
  await page.locator(".fc-files-entry", { hasText: "server.ts" }).click()

  await expect(page.locator(".fc-files-viewer-path")).toHaveText("src/server.ts")
  await expect(page.locator(".fc-files-code")).toContainText("export const server = true")
})

test("searching reaches files below the open folder", async ({ page }) => {
  await openApp(page)
  await page.goto("/files")

  await page.getByLabel("Search files").fill("server")

  const result = page.locator(".fc-files-entry", { hasText: "src/server.ts" })
  await expect(result).toBeVisible()
  await result.click()
  await expect(page.locator(".fc-files-viewer-path")).toHaveText("src/server.ts")
})
