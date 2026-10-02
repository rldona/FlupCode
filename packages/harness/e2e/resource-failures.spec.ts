import { expect, test, type Page } from "@playwright/test"

// Changes and Cost read through the app's `createResource`, which never rejects: a failed read keeps
// the last answer and holds the failure in `failure()`. Both screens used to read `.error`, which
// that wrapper never sets, so a 500 or a refused token looked exactly like an empty, healthy answer
// (TI-14). Each test below fails a route and checks the screen says so, keeps what it had and asks
// again.

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

const patch = [
  "diff --git a/src/server.ts b/src/server.ts",
  "--- a/src/server.ts",
  "+++ b/src/server.ts",
  "@@ -1,1 +1,1 @@",
  "-const port = 4096",
  "+const port = 4097",
  "",
].join("\n")

const report = {
  totals: { runs: 2, tasks: 6, tokens: 14_000, cost: 1.5, ms: 60_000 },
  retries: { tasks: 0, tokens: 0, cost: 0 },
  byModel: [{ key: "openai/gpt-5.6", tasks: 6, tokens: 14_000, cost: 1.5 }],
  byAgent: [{ key: "build", tasks: 6, tokens: 14_000, cost: 1.5 }],
  byProject: [{ key: "/work/demo", tasks: 6, tokens: 14_000, cost: 1.5, runs: 2 }],
  byDay: [{ day: "2026-09-30", tokens: 14_000, cost: 1.5 }],
  slowest: [],
}

/**
 * What each failing route answers right now; `undefined` answers normally. Tests flip these.
 * `refused` is a harness started with a token this page does not have: every route but its health
 * answers `403 invalid_token`, as the real server does.
 */
type Failing = { diff?: number; usage?: number; refused?: boolean }

const refusal = { error: "Forbidden", code: "invalid_token" }

async function openApp(page: Page, failing: Failing, path: string) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_fail"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (failing.refused) return route.fulfill({ status: 403, json: refusal })
    if (url.pathname === "/harness/usage")
      return failing.usage === undefined
        ? route.fulfill({ json: { data: report } })
        : route.fulfill({
            status: failing.usage,
            json: failing.usage === 403 ? refusal : { error: "usage is away" },
          })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    const location = { directory: "/work/demo" }
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/vcs")
      return route.fulfill({ json: { location, data: { branch: { current: "feature", default: "main" } } } })
    if (url.pathname === "/api/vcs/status")
      return route.fulfill({
        json: { location, data: [{ file: "src/server.ts", additions: 1, deletions: 1, status: "modified" }] },
      })
    if (url.pathname === "/api/vcs/diff")
      return failing.diff === undefined
        ? route.fulfill({
            json: {
              location,
              data: [{ file: "src/server.ts", patch, additions: 1, deletions: 1, status: "modified" }],
            },
          })
        : route.fulfill({ status: failing.diff, json: { message: "the diff is away" } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto(path)
}

test("a 500 on the diff is said on Changes, and trying again draws it", async ({ page }) => {
  const failing: Failing = { diff: 500 }
  await openApp(page, failing, "/changes")

  const alert = page.getByRole("alert").filter({ hasText: "The changes could not be read" })
  await expect(alert).toBeVisible()
  await expect(page.getByRole("heading", { name: "Changes" })).toBeVisible()
  await expect(page.getByText("Nothing has changed here.")).toHaveCount(0)

  failing.diff = undefined
  await alert.getByRole("button", { name: "Try again" }).click()
  await expect(page.locator(".fc-diff-file").filter({ hasText: "server.ts" })).toBeVisible()
  await expect(alert).toHaveCount(0)
})

test("a failed refresh on Changes keeps the diff it had", async ({ page }) => {
  const failing: Failing = {}
  await openApp(page, failing, "/changes")
  const file = page.locator(".fc-diff-file").filter({ hasText: "server.ts" })
  await expect(file).toBeVisible()

  failing.diff = 500
  await page.getByRole("button", { name: "Refresh" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "The changes could not be read" })).toBeVisible()
  await expect(file).toBeVisible()
})

test("a 500 on Cost is said there, keeps the last report, and trying again recovers", async ({ page }) => {
  const failing: Failing = {}
  await openApp(page, failing, "/usage")
  const spent = page.locator(".fc-usage-tile").first()
  await expect(spent).toContainText("$1.50")

  failing.usage = 500
  await page.getByRole("button", { name: "7 days" }).click()
  const alert = page.getByRole("alert").filter({ hasText: "The cost report could not be read" })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText("usage is away")
  await expect(spent).toContainText("$1.50")

  failing.usage = undefined
  await alert.getByRole("button", { name: "Try again" }).click()
  await expect(alert).toHaveCount(0)
  await expect(spent).toContainText("$1.50")
})

test("a refused token on Cost says it needs the desktop app or pairing, not that the server is away", async ({
  page,
}) => {
  await openApp(page, { usage: 403 }, "/usage")

  const alert = page.getByRole("alert").filter({ hasText: "The cost report could not be read" })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText("needs the desktop app or a paired device")
  await expect(alert).not.toContainText("Forbidden")
  await expect(page.getByText("The harness server is not reachable")).toHaveCount(0)
})

test("a harness that refuses this page's token says so on Cost, and trying again recovers once it accepts", async ({
  page,
}) => {
  const failing: Failing = { refused: true }
  await openApp(page, failing, "/usage")

  const alert = page.getByRole("alert").filter({ hasText: "The cost report could not be read" })
  await expect(alert).toContainText("needs the desktop app or a paired device")
  await expect(page.getByText("The harness server is not reachable")).toHaveCount(0)
  // Nothing was read, so nothing is claimed about the window either.
  await expect(page.getByText("Nothing has run in this window.")).toHaveCount(0)

  failing.refused = false
  await alert.getByRole("button", { name: "Try again" }).click()
  await expect(alert).toHaveCount(0)
  await expect(page.locator(".fc-usage-tile").first()).toContainText("$1.50")
})

test("a harness that refuses this page's token says so on Changes, and the diff still shows", async ({ page }) => {
  await openApp(page, { refused: true }, "/changes")

  await expect(page.locator(".fc-diff-file").filter({ hasText: "server.ts" })).toBeVisible()
  const alert = page.getByRole("alert").filter({ hasText: "Commits and checkpoints are not available here" })
  await expect(alert).toContainText("needs the desktop app or a paired device")
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible()
})
