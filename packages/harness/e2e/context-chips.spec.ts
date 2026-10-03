import { expect, test, type Page } from "@playwright/test"

/**
 * One chip model for what the reader points at (UX-05): a file and an artifact from the `@` menu, a
 * diff hunk, a failing check's log and a preview annotation each become a removable chip that says
 * where it came from, and resolve only on send into what the engine receives: a file part or a
 * quoted block. The harness's answers are scripted here; `e2e-engine` sends them to a real engine.
 */

const now = Date.now()

const session = {
  id: "ses_chips",
  projectID: "p",
  title: "Chips",
  agent: "build",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const report = {
  id: "art_report",
  kind: "report",
  title: "Run report",
  producer: "harness",
  mime: "text/markdown",
  content: "All twelve checks passed.",
  createdAt: now,
  logicalID: "art_report",
  version: 1,
  directory: "/work/demo",
}

const patch = [
  "diff --git a/src/server.ts b/src/server.ts",
  "--- a/src/server.ts",
  "+++ b/src/server.ts",
  "@@ -10,3 +10,4 @@ export function handler() {",
  "   const port = 4096",
  "-  return listen(port)",
  "+  logger.info({ port })",
  "+  return listen(port)",
  "",
].join("\n")

const failingBranch = {
  available: true,
  branch: "feature/thing",
  repository: "rldona/FlupCode",
  pushed: true,
  subject: "feat: the thing",
  pullRequest: {
    number: 121,
    title: "feat: the thing",
    url: "https://github.com/rldona/FlupCode/pull/121",
    state: "open",
    draft: false,
    additions: 10,
    deletions: 2,
    checks: { total: 3, passed: 2, failed: 1, running: 0 },
    failures: [
      { name: "build", workflow: "harness", url: "https://github.com/rldona/FlupCode/actions/runs/1/job/9001", job: "9001" },
    ],
  },
}

type Prompt = { text?: string; files?: Array<{ uri: string; name?: string }> }

/** What the harness says about each ref, as `POST /harness/context/resolve` would. */
const RESOLVED: Record<string, unknown> = {
  "@src/server.ts": { uri: "file:///work/demo/src/server.ts", name: "src/server.ts" },
  "@artifact:art_report": { quote: "--- Run report (report) ---\n\nAll twelve checks passed.\n\n---", cut: false },
  "@src/gone.ts": { missing: true },
}

async function openApp(page: Page, options: { panels?: string[]; files?: string[]; desktopPreview?: boolean } = {}) {
  const prompts: Prompt[] = []
  const resolves: Array<{ directory?: string; refs: string[] }> = []
  await page.addInitScript((panels) => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_chips"))
    window.localStorage.setItem("flupcode.agent", JSON.stringify("build"))
    if (panels.length > 0) window.localStorage.setItem("flupcode.workspacePanels", JSON.stringify(panels))
  }, options.panels ?? [])
  if (options.desktopPreview) await page.addInitScript(stubPreview)
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, capabilities: ["packs", "context-chips", "preview"] } } })
    if (url.pathname === "/harness/context/resolve") {
      const body = request.postDataJSON() as { directory?: string; refs: string[] }
      resolves.push(body)
      return route.fulfill({
        json: { data: body.refs.map((ref) => ({ ref, ...((RESOLVED[ref] as object) ?? { missing: true }) })) },
      })
    }
    if (url.pathname === "/harness/artifacts" && request.method() === "GET")
      return route.fulfill({ json: { data: [report] } })
    if (url.pathname === "/harness/git/pr") return route.fulfill({ json: { data: failingBranch } })
    if (url.pathname === "/harness/git/pr/log")
      return route.fulfill({
        json: { data: { job: "9001", step: "Run tests", text: "error: expected 1 to be 2", truncated: false } },
      })
    if (url.pathname === "/harness/preview/annotation")
      return route.fulfill({ json: { data: { artifactID: "art_shot" } } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const location = { directory: "/work/demo" }
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/fs/find")
      return route.fulfill({
        json: { location, data: (options.files ?? ["src/server.ts"]).map((path) => ({ path, type: "file" })) },
      })
    if (url.pathname === "/api/vcs")
      return route.fulfill({ json: { location, data: { branch: { current: "feature/thing", default: "main" } } } })
    if (url.pathname === "/api/vcs/status")
      return route.fulfill({ json: { location, data: [{ file: "src/server.ts", additions: 2, deletions: 1, status: "modified" }] } })
    if (url.pathname === "/api/vcs/diff")
      return route.fulfill({
        json: { location, data: [{ file: "src/server.ts", patch, additions: 2, deletions: 1, status: "modified" }] },
      })
    if (url.pathname === "/api/session/ses_chips/prompt") {
      const body = request.postDataJSON() as Prompt & { id?: string }
      prompts.push(body)
      return route.fulfill({ json: { data: { id: body.id, sessionID: "ses_chips", payload: { text: body.text } } } })
    }
    if (url.pathname === "/api/session/ses_chips" && request.method() === "PATCH") return route.fulfill({ status: 204 })
    if (url.pathname === "/api/session/ses_chips") return route.fulfill({ json: { data: session } })
    if (/^\/api\/session\/ses_chips\/(agent|instructions|model)$/.test(url.pathname))
      return route.fulfill({ status: 204 })
    if (/^\/api\/session\/[^/]+\/(message|permission|question|inbox|children)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return { prompts, resolves }
}

const composer = (page: Page) => page.locator(".fc-composer textarea.fc-input")
const chips = (page: Page) => page.locator(".fc-composer .fc-composer-chip")

async function mention(page: Page, token: string, row: string) {
  await composer(page).fill(`@${token}`)
  await page.locator(".fc-command-item").filter({ hasText: row }).click()
}

async function send(page: Page, text: string) {
  await composer(page).fill(text)
  await composer(page).press("Enter")
}

test("a file picked from the @ menu is a chip, and goes to the engine as a file part", async ({ page }) => {
  const { prompts, resolves } = await openApp(page)
  await mention(page, "serv", "src/server.ts")

  const chip = chips(page)
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText(/File|Archivo/)
  await expect(chip).toContainText("src/server.ts")
  // The mention left the draft: the chip is the reference now, not the text.
  await expect(composer(page)).toHaveValue("")

  await send(page, "Review this file")
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]).toMatchObject({
    text: "Review this file",
    files: [{ uri: "file:///work/demo/src/server.ts", name: "src/server.ts" }],
  })
  // Resolved in the session's folder, the one the engine reads it from.
  expect(resolves.at(-1)).toEqual({ directory: "/work/demo", refs: ["@src/server.ts"] })
  await expect(chips(page)).toHaveCount(0)
})

test("an @artifact chip sends the artifact's content", async ({ page }) => {
  const { prompts } = await openApp(page)
  await mention(page, "Run", "Run report")

  await expect(chips(page)).toContainText(/Artifact|Artefacto/)
  await expect(chips(page)).toContainText("Run report")
  await send(page, "Summarise the report")

  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]?.text).toBe(
    "Summarise the report\n\n--- Run report (report) ---\n\nAll twelve checks passed.\n\n---",
  )
})

test("a chip can be removed before sending, and then sends nothing", async ({ page }) => {
  const { prompts } = await openApp(page)
  await mention(page, "serv", "src/server.ts")
  await chips(page).getByRole("button", { name: /Remove|Quitar/ }).click()
  await expect(chips(page)).toHaveCount(0)

  await send(page, "Just text")
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]?.text).toBe("Just text")
  expect(prompts[0]?.files ?? []).toEqual([])
})

test("a chip whose file is gone says so, and the message waits until it is removed", async ({ page }) => {
  const { prompts } = await openApp(page, { files: ["src/gone.ts"] })
  await mention(page, "gone", "src/gone.ts")

  // Checked as it arrives, so the reader sees it before sending (P4).
  const chip = chips(page)
  await expect(chip).toHaveClass(/fc-composer-chip-missing/)
  await expect(chip).toContainText(/Missing|Falta/)

  await send(page, "Read it")
  await expect(page.getByText(/can no longer be found|ya no se encuentra/).first()).toBeVisible()
  expect(prompts).toEqual([])
  await expect(composer(page)).toHaveValue("Read it")

  await chip.getByRole("button", { name: /Remove|Quitar/ }).click()
  await composer(page).press("Enter")
  await expect.poll(() => prompts.map((prompt) => prompt.text)).toEqual(["Read it"])
})

test("a selected diff hunk becomes a chip with its file and lines", async ({ page }) => {
  const { prompts } = await openApp(page, { panels: ["diff"] })
  const hunk = page.locator(".fc-workspace .fc-diff-hunk-head").first()
  await hunk.getByRole("button", { name: /Add to the message|Añadir al mensaje/ }).click()

  const chip = chips(page)
  await expect(chip).toContainText(/Changes|Cambios/)
  await expect(chip).toContainText("server.ts:10-12")
  await expect(chip).toHaveAttribute("title", /src\/server\.ts/)

  await send(page, "Why this change?")
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]?.text).toBe(
    [
      "Why this change?",
      "",
      "[Diff hunk of src/server.ts, lines 10-12]",
      "```diff",
      "@@ -10 +10 @@ export function handler() {",
      "   const port = 4096",
      "-  return listen(port)",
      "+  logger.info({ port })",
      "+  return listen(port)",
      "```",
    ].join("\n"),
  )
})

test("a failing check's log becomes a chip", async ({ page }) => {
  const { prompts } = await openApp(page)
  await page.locator(".fc-pr-checks-open").click()
  await page
    .locator(".fc-pr-failure")
    .getByRole("button", { name: /Add to the message|Añadir al mensaje/ })
    .click()

  const chip = chips(page)
  await expect(chip).toContainText("CI")
  await expect(chip).toContainText("build")
  await send(page, "Fix the build")

  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]?.text).toBe(
    ["Fix the build", "", "[Failing check build (harness · Run tests)]", "```", "error: expected 1 to be 2", "```"].join(
      "\n",
    ),
  )
})

test("a preview annotation is a chip with its picture", async ({ page }) => {
  const { prompts } = await openApp(page, { panels: ["preview"], desktopPreview: true })
  await page.locator(".fc-preview").getByRole("button", { name: /^(Annotate|Anotar)$/ }).click()
  await page.getByRole("button", { name: /Add to the message|Añadir al mensaje/ }).click()

  const chip = chips(page)
  await expect(chip).toContainText(/Preview|Vista previa/)
  await expect(chip.locator("img")).toHaveCount(1)
  await send(page, "Make it fit")

  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]?.text).toContain("Make it fit\n\n[Preview annotation of http://localhost:5173/settings, artifact art_shot]")
  expect(prompts[0]?.files?.[0]?.name).toBe("preview-art_shot.png")
})

test("the chips fit a phone-width composer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openApp(page)
  await mention(page, "serv", "src/server.ts")
  await expect(chips(page)).toBeVisible()
  const box = await chips(page).boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
})

/** The desktop's preview, as its preload hands it to the page: a page on a dev server, and its picture. */
function stubPreview() {
  // A 2×2 PNG, so the marked-up copy has something to draw on.
  const image =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8DwnwEJMBJQAAA8VQP9C3Kh0AAAAABJRU5ErkJggg=="
  const state = { url: "http://localhost:5173/settings", title: "Settings", canGoBack: false, canGoForward: false, loading: false }
  ;(window as unknown as { flupcode: unknown }).flupcode = {
    preview: {
      show: async () => true,
      hide: async () => undefined,
      state: async () => state,
      open: async (url: string) => ({ verdict: "allow", url }),
      history: async () => undefined,
      capture: async () => image,
      servers: async () => [],
      onChange: () => () => undefined,
      onBlocked: () => () => undefined,
    },
  }
}
