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
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: messages, cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|form)$/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event") return new Promise(() => {})
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

  // An image is drawn from the raw route, fetched as a blob so the request can carry the bearer (WA-9).
  await page.locator(".fc-artifact-card", { hasText: "Shot" }).locator(".fc-artifact-card-main").click()
  await expect(page.locator(".fc-artifact-image img")).toHaveAttribute("src", /^blob:/)
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
        {
          type: "tool",
          id: "p1",
          name: "write",
          state: { status: "completed", input: { filePath: "/work/demo/out.html" }, content: [] },
        },
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

test("the search and the open artifact are still there after leaving the screen", async ({ page }) => {
  await onboard(page)
  await engine(page, [])
  await harness(page, [
    { id: "d1", kind: "document", title: "Page", producer: "agent", mime: "text/html", createdAt: now, content: "<h1>Hello</h1>" },
    { id: "d2", kind: "document", title: "Readme", producer: "agent", mime: "text/markdown", createdAt: now, content: "# Title\n\nbody" },
  ])
  await page.goto("/artifacts")

  await page.getByLabel("Search artifacts").fill("Read")
  await expect(page.locator(".fc-artifact-card")).toHaveCount(1)
  await page.locator(".fc-nav-item", { hasText: "Workflows" }).click()
  await expect(page.getByRole("heading", { name: "Artifacts", exact: true })).toHaveCount(0)
  await page.locator(".fc-nav-item", { hasText: "Artifacts" }).click()
  await expect(page.getByLabel("Search artifacts")).toHaveValue("Read")
  await expect(page.locator(".fc-artifact-card")).toHaveCount(1)

  await page.locator(".fc-artifact-card", { hasText: "Readme" }).locator(".fc-artifact-card-main").click()
  await expect(page.locator(".fc-artifact-markdown")).toContainText("Title")
  await page.locator(".fc-nav-item", { hasText: "Workflows" }).click()
  await page.locator(".fc-nav-item", { hasText: "Artifacts" }).click()
  await expect(page.locator(".fc-artifact-markdown")).toContainText("Title")
})

test("a document is one row with its versions: the switcher shows each, compares it, and opens what wrote it (RP-03)", async ({ page }) => {
  await onboard(page)
  // The session the document came from, with the message whose turn wrote it among others.
  await engine(page, [
    { id: "msg_1", type: "user", time: { created: now }, text: "Write the report", content: [] },
    { id: "msg_2", type: "assistant", time: { created: now, completed: now }, content: [{ type: "text", text: "Kept the report." }] },
  ])
  const base = { kind: "document", producer: "agent", mime: "text/markdown", directory: "/work/demo", path: ".flupcode/artifacts/report.md", logicalID: "v1", sessionID: "ses_x" }
  const newest = { ...base, id: "v2", title: "Report", version: 2, versions: 2, createdAt: now, content: "# Report\n\nsecond take", messageID: "msg_2", runID: "run_1", taskID: "task_1" }
  const oldest = { ...base, id: "v1", title: "Report", version: 1, createdAt: now - 60_000, content: "# Report\n\nfirst take", messageID: "msg_2" }
  const other = { id: "o1", kind: "report", title: "Weekly notes", producer: "harness", mime: "text/markdown", createdAt: now - 120_000, content: "x", logicalID: "o1", version: 1, versions: 1 }
  const pages: string[] = []
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/artifacts") {
      pages.push(url.searchParams.get("offset") ?? "0")
      // Two pages: the document, then the rest.
      return route.fulfill({ json: url.searchParams.get("offset") === "1" ? { data: [other] } : { data: [newest], next: 1 } })
    }
    if (url.pathname === "/harness/artifacts/v2/versions")
      return route.fulfill({ json: { data: [newest, oldest].map(({ content: _content, ...version }) => version) } })
    if (url.pathname === "/harness/artifacts/v1") return route.fulfill({ json: { data: oldest } })
    if (url.pathname === "/harness/runs")
      return route.fulfill({
        json: {
          data: [
            {
              id: "run_1",
              source: { type: "manual" },
              status: "success",
              startedAt: now,
              finishedAt: now,
              directory: "/work/demo",
              tasks: [{ id: "task_1", runID: "run_1", name: "write", prompt: "Write", status: "success", position: 0, kind: "agent", attempt: 1 }],
            },
          ],
        },
      })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.goto("/artifacts")

  // One row for the document, saying how many versions it has; the rest are a page away.
  const card = page.locator(".fc-artifact-card").filter({ has: page.locator("strong", { hasText: /^Report$/ }) })
  await expect(page.locator(".fc-artifact-card")).toHaveCount(1)
  await expect(card).toContainText(/2 versions|2 versiones/)
  await page.getByRole("button", { name: /^(Load more|Cargar más)$/ }).click()
  await expect(page.locator(".fc-artifact-card")).toHaveCount(2)
  expect(pages.at(-1)).toBe("1")
  await expect(page.getByRole("button", { name: /^(Load more|Cargar más)$/ })).toHaveCount(0)

  // The newest version opens; the switcher reaches the older one, by its own id.
  await card.locator(".fc-artifact-card-main").click()
  await expect(page.locator(".fc-artifact-markdown")).toContainText("second take")
  const switcher = page.getByRole("combobox", { name: /^(Version|Versión)$/ })
  await expect(switcher.locator("option")).toHaveText([/(Version|Versión) 2/, /(Version|Versión) 1/])
  await switcher.selectOption("v1")
  await expect(page.locator(".fc-artifact-markdown")).toContainText("first take")
  await expect(page.getByRole("button", { name: /Compare with version|Comparar con la versión/ })).toHaveCount(0)

  // Back on the newest, the comparison with the one before is a diff of their text.
  await switcher.selectOption("v2")
  await page.getByRole("button", { name: /^(Compare with version 1|Comparar con la versión 1)$/ }).click()
  await expect(page.locator(".fc-artifact-diff .fc-diff-del")).toHaveText("-first take")
  await expect(page.locator(".fc-artifact-diff .fc-diff-add")).toHaveText("+second take")

  // What produced it: the run, at its task, and the message whose turn wrote it.
  await page.locator(".fc-artifact-lineage").getByRole("button", { name: /^(Open run|Abrir ejecución)$/ }).click()
  await expect(page.locator('.fc-run-card[data-run-id="run_1"]')).toBeVisible()
  await page.goto("/artifacts")
  await card.locator(".fc-artifact-card-main").click()
  await page.locator(".fc-artifact-lineage").getByRole("button", { name: /^(Open message|Abrir mensaje)$/ }).click()
  await expect(page.locator('[data-message-id="msg_2"]')).toBeInViewport()
})
