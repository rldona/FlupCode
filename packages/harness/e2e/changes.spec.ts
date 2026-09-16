import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_diff",
  projectID: "p",
  title: "Diff",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const status = [
  { file: "src/server.ts", additions: 2, deletions: 1, status: "modified" },
  { file: "src/added.ts", additions: 1, deletions: 0, status: "added" },
]

/**
 * A patch as git writes one: four rows of file identity before the first `@@`.
 *
 * They are what the old panel drew as if they were code, so a test that leaves them out cannot tell
 * whether they are still being drawn.
 */
const modified = [
  "diff --git a/src/server.ts b/src/server.ts",
  "index f384549..02b5054 100644",
  "--- a/src/server.ts",
  "+++ b/src/server.ts",
  "@@ -10,3 +10,4 @@ export function handler() {",
  "   const port = 4096",
  "-  return listen(port)",
  "+  logger.info({ port })",
  "+  return listen(port)",
  "",
].join("\n")

const added = [
  "diff --git a/src/added.ts b/src/added.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/added.ts",
  "@@ -0,0 +1 @@",
  "+export const added = true",
  "",
].join("\n")

const branchOnly = [
  "diff --git a/src/shipped.ts b/src/shipped.ts",
  "--- a/src/shipped.ts",
  "+++ b/src/shipped.ts",
  "@@ -1,1 +1,1 @@",
  "-const version = 1",
  "+const version = 2",
  "",
].join("\n")

/**
 * A patch far taller than any panel, so the layout has to cope with one.
 *
 * The short patches above cannot tell whether a long diff is reachable: they fit, and a box that
 * fits never has to shrink. This one is 200 rows in a panel that is about 700 pixels tall.
 */
const long = [
  "diff --git a/src/long.ts b/src/long.ts",
  "--- a/src/long.ts",
  "+++ b/src/long.ts",
  "@@ -1,100 +1,100 @@",
  ...Array.from({ length: 100 }, (_, index) => [
    `-const a${index} = ${index}`,
    `+const a${index} = ${index + 1}`,
  ]).flat(),
  "",
].join("\n")

type Seen = { modes: string[]; contexts: (string | null)[] }

async function openSession(page: Page, panels: string[] = [], options: { long?: boolean } = {}) {
  const seen: Seen = { modes: [], contexts: [] }
  await page.addInitScript((panels) => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_diff"))
    if (panels.length > 0) window.localStorage.setItem("flupcode.workspacePanels", JSON.stringify(panels))
  }, panels)
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/vcs") return route.fulfill({ json: { branch: "feature", default_branch: "main" } })
    if (url.pathname === "/vcs/status") return route.fulfill({ json: status })
    if (url.pathname === "/vcs/diff") {
      const mode = url.searchParams.get("mode") ?? "git"
      seen.modes.push(mode)
      seen.contexts.push(url.searchParams.get("context"))
      if (mode === "branch")
        return route.fulfill({
          json: [{ file: "src/shipped.ts", patch: branchOnly, additions: 1, deletions: 1, status: "modified" }],
        })
      if (options.long)
        return route.fulfill({
          json: [{ file: "src/long.ts", patch: long, additions: 100, deletions: 100, status: "modified" }],
        })
      return route.fulfill({
        json: [
          { file: "src/server.ts", patch: modified, additions: 2, deletions: 1, status: "modified" },
          { file: "src/added.ts", patch: added, additions: 1, deletions: 0, status: "added" },
        ],
      })
    }
    if (url.pathname === "/api/session/ses_diff/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  return seen
}

test("the repo bar's counts open a diff of what changed", async ({ page }) => {
  const seen = await openSession(page)

  // The counts were two numbers with nothing to click. That is where the reader stopped.
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()

  await expect(page).toHaveURL(/\/changes$/)
  await expect(page.getByRole("heading", { name: /Changes|Cambios/ })).toBeVisible()
  await expect(page.getByText("src/server.ts")).toBeVisible()
  await expect(page.getByText("src/added.ts")).toBeVisible()

  // Without `context`, the engine answers with the whole file as one hunk. The request has to say.
  expect(seen.contexts.filter((value) => value !== null)).not.toHaveLength(0)
  expect(seen.contexts).not.toContain(null)
})

test("a file's diff shows its hunks and not git's file header", async ({ page }) => {
  await openSession(page)
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()

  // The path is drawn as two spans — folder, then name — so the accessible name has a space in it.
  const file = page.locator(".fc-diff-file").filter({ hasText: "server.ts" })
  await file.locator(".fc-diff-file-head").click()
  await expect(file.locator(".fc-diff-line-add").first()).toContainText("logger.info({ port })")
  await expect(file.locator(".fc-diff-line-del").first()).toContainText("return listen(port)")
  // The hunk header says where in the file this is, and carries the heading git put after it.
  await expect(file.locator(".fc-diff-hunk-head")).toContainText("@@ -10 +10 @@ export function handler() {")
  // Both sides are numbered: a deletion's number is the old file's, which is what a line comment
  // would have to point at.
  await expect(file.locator(".fc-diff-line-del .fc-diff-no").first()).toHaveText("11")

  // The four rows of file identity are the header's job, not the body's.
  await expect(file).not.toContainText("index f384549")
  await expect(file).not.toContainText("diff --git")
})

test("the branch view answers once the working tree is clean again", async ({ page }) => {
  const seen = await openSession(page)
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()

  await page.getByRole("button", { name: /^(Branch|Rama)$/ }).click()

  await expect(page.getByText("src/shipped.ts")).toBeVisible()
  await expect(page.getByText("src/server.ts")).toHaveCount(0)
  expect(seen.modes).toContain("branch")
})

test("the screen survives a reload, because it is an address", async ({ page }) => {
  await openSession(page)
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()
  await expect(page.getByRole("heading", { name: /Changes|Cambios/ })).toBeVisible()

  await page.reload()

  await expect(page.getByRole("heading", { name: /Changes|Cambios/ })).toBeVisible()
  await expect(page.getByText("src/server.ts")).toBeVisible()
})

test("the side panel's list takes the scroll, so a long diff is reachable", async ({ page }) => {
  await openSession(page, ["diff"], { long: true })

  const list = page.locator(".fc-changes-list-panel")
  await expect(list).toBeVisible()
  const file = list.locator(".fc-diff-file").filter({ hasText: "long.ts" })
  await file.locator(".fc-diff-file-head").click()
  await expect(file.locator(".fc-diff-line")).toHaveCount(200)

  // A flex item shrinks by default, and `.fc-panel-body` is `overflow: hidden`: without
  // `flex-shrink: 0` the 200 rows are squeezed into the panel's own height and clipped there, and
  // the list has nothing left to scroll — which is what "it gets stuck" looks like from outside.
  const measured = await list.evaluate((node) => ({
    scroll: node.scrollHeight,
    client: node.clientHeight,
    file: (node.querySelector(".fc-diff-file") as HTMLElement).getBoundingClientRect().height,
  }))
  expect(measured.file).toBeGreaterThan(measured.client)
  expect(measured.scroll).toBeGreaterThan(measured.client)

  // And it really moves, both ways.
  await list.evaluate((node) => node.scrollTo({ top: 1000 }))
  expect(await list.evaluate((node) => node.scrollTop)).toBe(1000)
})
