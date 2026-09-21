import { expect, test, type Page } from "@playwright/test"

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

/** The engine: one session, and whatever messages a test needs. */
async function engine(page: Page, messages: unknown[]) {
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: messages, cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [] } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
}

/** The harness server: the documents and files a test wants shown. */
async function harness(page: Page, artifacts: unknown[]) {
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/workflows") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/artifacts") return route.fulfill({ json: { data: artifacts } })
    if (/^\/harness\/artifacts\/[^/]+\/raw$/.test(url.pathname))
      return route.fulfill({ status: 200, contentType: "image/png", body: "png" })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
}

const onboard = async (page: Page) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
}

test("a document is drawn by what it is, and the arrow comes back to the list", async ({ page }) => {
  await onboard(page)
  await engine(page, [])
  await harness(page, [
    { id: "d1", kind: "document", title: "Page", producer: "agent", mime: "text/html", createdAt: now, content: "<h1>Hello</h1>" },
    { id: "d2", kind: "document", title: "Readme", producer: "agent", mime: "text/markdown", createdAt: now, content: "# Title\n\nbody" },
    { id: "d3", kind: "document", title: "Shot", producer: "agent", mime: "image/png", createdAt: now, path: ".flupcode/artifacts/shot.png", directory: "/work/demo" },
  ])
  await page.goto("/artifacts")

  await expect(page.locator(".fc-artifact-card")).toHaveCount(3)

  // HTML runs in a sandbox, from the text the server kept.
  await page.locator(".fc-artifact-card", { hasText: "Page" }).locator(".fc-artifact-card-main").click()
  await expect(page.locator(".fc-artifact-frame")).toHaveAttribute("srcdoc", /<h1>Hello<\/h1>/)
  await page.locator(".fc-artifact-viewer-bar").getByRole("button", { name: /Back|Atrás/ }).click()

  // Markdown is rendered, not shown as source.
  await page.locator(".fc-artifact-card", { hasText: "Readme" }).locator(".fc-artifact-card-main").click()
  await expect(page.locator(".fc-artifact-markdown")).toContainText("Title")
  await page.locator(".fc-artifact-viewer-bar").getByRole("button", { name: /Back|Atrás/ }).click()

  // An image is drawn from the raw route.
  await page.locator(".fc-artifact-card", { hasText: "Shot" }).locator(".fc-artifact-card-main").click()
  await expect(page.locator(".fc-artifact-image img")).toHaveAttribute("src", /\/harness\/artifacts\/d3\/raw/)
})

test("a file the session wrote opens in VS Code, in the system, or is copied", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
    // The desktop bridge, stubbed: it records what it was asked to open, and with which app.
    ;(window as unknown as { __opened: unknown[] }).__opened = []
    ;(window as unknown as { flupcode: unknown }).flupcode = {
      platform: "darwin",
      openPath: (path: string, app?: string) => {
        ;(window as unknown as { __opened: unknown[] }).__opened.push([path, app])
        return Promise.resolve(true)
      },
    }
  })
  // One assistant message with a write tool part: that is what "files this session wrote" reads.
  await engine(page, [
    {
      id: "m1",
      type: "assistant",
      time: { created: now, completed: now },
      content: [
        { type: "tool", id: "p1", name: "write", state: { status: "completed", input: { filePath: "/work/demo/out.html" } } },
      ],
    },
  ])
  await harness(page, [])
  await page.goto("/artifacts")

  await page.getByRole("button", { name: /Files this session wrote/ }).click()
  const file = page.locator(".fc-artifact-file")
  await expect(file).toHaveCount(1)
  await expect(file).toContainText("out.html")

  // VS Code is the default; Open uses the system's app; both go through the bridge.
  await file.getByRole("button", { name: /^VS Code$/ }).click()
  await file.getByRole("button", { name: /^(Open|Abrir)$/ }).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened))
    .toEqual([
      ["/work/demo/out.html", "Visual Studio Code"],
      ["/work/demo/out.html", undefined],
    ])
  await expect(file.getByRole("button", { name: /^(Copy|Copiar)$/ })).toBeVisible()
})

test("an artifact's path reaches the bridge absolute, joined to its directory", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
    // The desktop bridge, stubbed: it records what it was asked to open, and with which app.
    ;(window as unknown as { __opened: unknown[] }).__opened = []
    ;(window as unknown as { __copied: string[] }).__copied = []
    ;(window as unknown as { flupcode: unknown }).flupcode = {
      platform: "darwin",
      openPath: (path: string, app?: string) => {
        ;(window as unknown as { __opened: unknown[] }).__opened.push([path, app])
        return Promise.resolve(true)
      },
    }
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          ;(window as unknown as { __copied: string[] }).__copied.push(text)
          return Promise.resolve()
        },
      },
    })
  })
  await engine(page, [])
  // A document stores a path relative to its directory, the same convention plans use.
  await harness(page, [
    {
      id: "doc1",
      kind: "document",
      title: "Report",
      producer: "agent",
      mime: "text/markdown",
      createdAt: now,
      content: "# Report",
      path: ".flupcode/artifacts/report.md",
      directory: "/work/demo",
    },
  ])
  await page.goto("/artifacts")

  await page.locator(".fc-artifact-card", { hasText: "Report" }).locator(".fc-artifact-card-main").click()
  await page.locator(".fc-artifact-viewer-bar").getByRole("button", { name: /^VS Code$/ }).click()
  await page.locator(".fc-artifact-viewer-bar").getByRole("button", { name: /^(Open|Abrir)$/ }).click()
  await page.locator(".fc-artifact-viewer-bar").getByRole("button", { name: /^(Copy path|Copiar ruta)$/ }).click()

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened))
    .toEqual([
      ["/work/demo/.flupcode/artifacts/report.md", "Visual Studio Code"],
      ["/work/demo/.flupcode/artifacts/report.md", undefined],
    ])
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied))
    .toEqual(["/work/demo/.flupcode/artifacts/report.md"])
})
