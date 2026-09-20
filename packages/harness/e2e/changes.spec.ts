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

type Seen = {
  modes: string[]
  contexts: (string | null)[]
  commits: Array<{ message: string; paths: string[] }>
  branches: string[]
  pullRequests: string[]
  logs: string[]
  restored: string[]
  planned: string[]
  resolved: Array<{ id: string; resolved: boolean }>
}

/** What `GET /harness/git/pr` answers, which is the whole of what the chip can know. */
type BranchFixture = Record<string, unknown>

async function openSession(
  page: Page,
  panels: string[] = [],
  options: {
    long?: boolean
    branch?: BranchFixture
    checkpoints?: unknown[]
    findings?: unknown[]
    /** A working tree with nothing in it, which is when the bar has room for the PR's counts. */
    clean?: boolean
  } = {},
) {
  const seen: Seen = { modes: [], contexts: [], commits: [], branches: [], pullRequests: [], logs: [], restored: [], planned: [], resolved: [] }
  await page.addInitScript((panels) => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_diff"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    if (panels.length > 0) window.localStorage.setItem("flupcode.workspacePanels", JSON.stringify(panels))
  }, panels)
  // The harness server: the only part that can run git, so committing needs it up.
  await page.route("http://127.0.0.1:9097/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/artifacts") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/workflows") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    if (url.pathname === "/harness/git/commit") {
      const body = route.request().postDataJSON() as { message: string; paths: string[] }
      seen.commits.push({ message: body.message, paths: body.paths })
      return route.fulfill({ json: { data: { sha: "abc1234", subject: body.message, branch: "feature" } } })
    }
    if (url.pathname === "/harness/findings") {
      return route.fulfill({ json: { data: options.findings ?? [] } })
    }
    if (/^\/harness\/findings\/[^/]+\/resolved$/.test(url.pathname)) {
      const body = route.request().postDataJSON() as { resolved: boolean }
      seen.resolved.push({ id: url.pathname.split("/")[3]!, resolved: body.resolved })
      return route.fulfill({ json: { data: { id: url.pathname.split("/")[3], resolved: body.resolved } } })
    }
    if (url.pathname === "/harness/checkpoints" && route.request().method() === "GET") {
      return route.fulfill({ json: { data: options.checkpoints ?? [] } })
    }
    if (/^\/harness\/checkpoints\/[^/]+\/plan$/.test(url.pathname)) {
      seen.planned.push(url.pathname.split("/")[3]!)
      return route.fulfill({
        json: { data: { write: ["src/work.ts", "src/other.ts"], remove: ["src/oops.ts"] } },
      })
    }
    if (/^\/harness\/checkpoints\/[^/]+\/restore$/.test(url.pathname)) {
      seen.restored.push(url.pathname.split("/")[3]!)
      return route.fulfill({
        json: {
          data: {
            plan: { write: ["src/work.ts", "src/other.ts"], remove: ["src/oops.ts"] },
            safety: { id: "cp_safe", directory: "/work/demo", sha: "b".repeat(40), title: "Before restoring", createdAt: 3 },
          },
        },
      })
    }
    if (url.pathname === "/harness/git/pr/log") {
      const job = url.searchParams.get("job") ?? ""
      seen.logs.push(job)
      return route.fulfill({
        json: {
          data: {
            job,
            step: "Test remote control",
            text: " 37 pass\n 0 fail\n 1 error\nerror: script \"test\" exited with code 1",
            truncated: true,
          },
        },
      })
    }
    if (url.pathname === "/harness/git/pr" && route.request().method() === "GET") {
      return route.fulfill({
        json: {
          data: options.branch ?? { available: false, branch: "feature", pushed: false, problem: "gh is not installed" },
        },
      })
    }
    if (url.pathname === "/harness/git/pr" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { title: string }
      seen.pullRequests.push(body.title)
      return route.fulfill({
        json: {
          data: {
            number: 42,
            title: body.title,
            url: "https://github.com/rldona/FlupCode/pull/42",
            state: "open",
            draft: false,
            additions: 3,
            deletions: 1,
            checks: { total: 0, passed: 0, failed: 0, running: 0 },
          },
        },
      })
    }
    if (url.pathname === "/harness/git/branch") {
      const body = route.request().postDataJSON() as { name: string }
      seen.branches.push(body.name)
      return route.fulfill({ json: { data: { branch: body.name } } })
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/vcs") return route.fulfill({ json: { branch: "feature", default_branch: "main" } })
    if (url.pathname === "/vcs/status") return route.fulfill({ json: options.clean ? [] : status })
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

test("committing is the server running git, not a turn spent asking a model to", async ({ page }) => {
  const seen = await openSession(page)
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()

  // Everything is picked to begin with; unticking is the deliberate act.
  await expect(page.getByText(/All 2 files|Los 2 archivos/)).toBeVisible()
  await page.locator(".fc-diff-file").filter({ hasText: "added.ts" }).locator(".fc-diff-pick input").uncheck()
  await expect(page.getByText(/1 of 2|1 de 2/)).toBeVisible()

  await page.getByRole("textbox", { name: /Commit message|Mensaje del commit/ }).fill("only the server")
  await page.getByRole("button", { name: /^(Commit|Confirmar)$/ }).click()

  await expect.poll(() => seen.commits).toEqual([{ message: "only the server", paths: ["src/server.ts"] }])
  // The composer stayed empty: nothing was sent to the engine to make this happen.
  await expect(page.getByRole("textbox", { name: /Type \/ for commands/ })).toHaveValue("")
})

test("a commit needs a message and at least one file", async ({ page }) => {
  await openSession(page)
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()

  const commit = page.getByRole("button", { name: /^(Commit|Confirmar)$/ })
  await expect(commit).toBeDisabled()

  await page.getByRole("textbox", { name: /Commit message|Mensaje del commit/ }).fill("a message")
  await expect(commit).toBeEnabled()

  for (const pick of await page.locator(".fc-diff-pick input").all()) await pick.uncheck()
  await expect(commit).toBeDisabled()
})

test("a branch is started by name, and the uncommitted work comes with it", async ({ page }) => {
  const seen = await openSession(page)
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()

  await page.getByRole("button", { name: /New branch|Nueva rama/ }).click()
  await page.getByRole("textbox", { name: /Branch name|Nombre de la rama/ }).fill("feature/from-the-ui")
  await page.getByRole("button", { name: /^(Create|Crear)$/ }).click()

  await expect.poll(() => seen.branches).toEqual(["feature/from-the-ui"])
})

test("the branch view has no commit box, because there is nothing there to commit", async ({ page }) => {
  await openSession(page)
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()
  await expect(page.locator(".fc-commit")).toBeVisible()

  await page.getByRole("button", { name: /^(Branch|Rama)$/ }).click()

  await expect(page.locator(".fc-commit")).toHaveCount(0)
})

test("the repo bar's commit button opens the diff instead of sending a prompt", async ({ page }) => {
  await openSession(page)

  // It used to write "Commit the current changes with a clear message." into the composer and send
  // it: a model turn, charged for, to run two commands — and no sight of what was being committed.
  await page.getByRole("button", { name: /Commit changes|Confirmar cambios/ }).click()

  await expect(page).toHaveURL(/\/changes$/)
  await expect(page.locator(".fc-commit")).toBeVisible()
  await expect(page.getByRole("textbox", { name: /Type \/ for commands/ })).toHaveValue("")
})

const withPullRequest = (over: Record<string, unknown>) => ({
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
    additions: 835,
    deletions: 25,
    checks: { total: 5, passed: 5, failed: 0, running: 0 },
    failures: [],
    ...over,
  },
})

const failing = {
  checks: { total: 5, passed: 3, failed: 2, running: 0 },
  failures: [
    {
      name: "build",
      workflow: "harness",
      url: "https://github.com/rldona/FlupCode/actions/runs/1/job/9001",
      job: "9001",
    },
    { name: "ci/external", url: "https://ci.example.com/7" },
  ],
}

test("a branch with no pull request offers to open one, and says when it must push first", async ({ page }) => {
  const seen = await openSession(page, [], {
    branch: { available: true, branch: "feature/thing", repository: "rldona/FlupCode", pushed: false, subject: "feat: the thing" },
  })

  // One bar, not two: the branch, the repository and the button to open a pull request are the
  // same fact about where you are, and they are on the same row as the folder.
  const bar = page.locator(".fc-repo-bar")
  await expect(page.locator(".fc-repo-bar")).toHaveCount(1)
  await expect(bar).toContainText("feature/thing")
  await expect(bar).toContainText("rldona/FlupCode")
  // Pushing is part of it, so the button says so rather than doing it quietly.
  await bar.getByRole("button", { name: /Push and create PR|Subir y crear PR/ }).click()

  // The title starts as the branch's last commit subject, and stays editable.
  const title = bar.getByRole("textbox", { name: /Pull request title|Título del PR/ })
  await expect(title).toHaveValue("feat: the thing")
  await title.fill("feat: something better")
  await bar.getByRole("button", { name: /^(Open|Abrir)$/ }).click()

  await expect.poll(() => seen.pullRequests).toEqual(["feat: something better"])
})

test("an open pull request shows its number, its size and what CI says", async ({ page }) => {
  await openSession(page, [], { branch: withPullRequest({}) })

  const bar = page.locator(".fc-repo-bar")
  await expect(bar.getByRole("button", { name: "#121" })).toBeVisible()
  await expect(bar.locator(".fc-pr-checks")).toHaveAttribute("data-verdict", "passed")
  // One pair of counts at a time. This folder has uncommitted changes, so those are the ones on
  // the bar — two `+N −N` pairs side by side is a bar nobody can read. The pull request's size is
  // on its number.
  await expect(bar.locator(".fc-repo-counts")).toContainText("+3")
  await expect(bar).not.toContainText("+835")
  await expect(bar.getByRole("button", { name: "#121" })).toHaveAttribute("title", /835/)
})

test("with nothing uncommitted, the counts on the bar are the pull request's", async ({ page }) => {
  await openSession(page, [], { branch: withPullRequest({}), clean: true })

  const bar = page.locator(".fc-repo-bar")
  await expect(bar).toContainText("+835")
  await expect(bar).toContainText("−25")
})

test("checks still running are not reported as a verdict", async ({ page }) => {
  await openSession(page, [], {
    branch: withPullRequest({ checks: { total: 5, passed: 2, failed: 1, running: 2 } }),
  })

  const checks = page.locator(".fc-pr-checks")
  // One has already failed, but two are still going: the answer is not in yet.
  await expect(checks).toHaveAttribute("data-verdict", "running")
  await expect(checks).toContainText("3/5")
})

test("a failed check says how many, in the colour that means it", async ({ page }) => {
  await openSession(page, [], {
    branch: withPullRequest({ checks: { total: 5, passed: 3, failed: 2, running: 0 } }),
  })

  const checks = page.locator(".fc-pr-checks")
  await expect(checks).toHaveAttribute("data-verdict", "failed")
  await expect(checks).toContainText(/2 failed|2 han fallado/)
})

test("a merged pull request gets a row of its own, and stops talking about CI", async ({ page }) => {
  await openSession(page, [], { branch: withPullRequest({ state: "merged" }) })

  // A pull request that is over is a different fact from where you are, so it is drawn as one —
  // under the bar, in the state's colour, with its number, its repository and its branch.
  const done = page.locator(".fc-pr-done")
  await expect(done).toHaveAttribute("data-state", "merged")
  await expect(done).toContainText(/Merged|Mergeado/)
  await expect(done.getByRole("button", { name: "#121" })).toBeVisible()
  await expect(done).toContainText("FlupCode")
  await expect(done).toContainText("feature/thing")
  await expect(page.locator(".fc-pr-checks")).toHaveCount(0)
})

test("the bar behind a merged pull request still offers to open the next one", async ({ page }) => {
  await openSession(page, [], { branch: withPullRequest({ state: "merged" }) })

  // This is why it is two rows and not one: the branch is still a branch you can open a PR from.
  await expect(page.locator(".fc-repo-bar")).toBeVisible()
  await expect(page.locator(".fc-pr-done")).toBeVisible()
})

test("a merged row can be waved away on its own", async ({ page }) => {
  await openSession(page, [], { branch: withPullRequest({ state: "merged" }) })

  await page.locator(".fc-pr-done").getByRole("button", { name: /Hide this|^Ocultar$/ }).click()

  await expect(page.locator(".fc-pr-done")).toHaveCount(0)
  // The bar is about the branch, not about the pull request that ended: it stays.
  await expect(page.locator(".fc-repo-bar")).toBeVisible()
})

test("a closed pull request is drawn as closed, not as merged", async ({ page }) => {
  await openSession(page, [], { branch: withPullRequest({ state: "closed" }) })

  const done = page.locator(".fc-pr-done")
  await expect(done).toHaveAttribute("data-state", "closed")
  await expect(done).toContainText(/Closed|Cerrado/)
})

test("without gh there is no chip at all, rather than a chip that cannot say", async ({ page }) => {
  await openSession(page)
  await expect(page.locator(".fc-repo-bar")).toBeVisible()
  await expect(page.locator(".fc-pr-chip")).toHaveCount(0)
})

test("the branch and its pull request are one bar, not two", async ({ page }) => {
  // The complaint this came from: two stacked bubbles above the composer for one fact about where
  // you are, which left the reader joining them up and cost a line of the screen.
  await openSession(page, [], { branch: withPullRequest({}) })

  await expect(page.locator(".fc-repo-bar")).toHaveCount(1)
  const bar = page.locator(".fc-repo-bar")
  await expect(bar).toContainText("demo")
  await expect(bar).toContainText("feature/thing")
  await expect(bar.getByRole("button", { name: "#121" })).toBeVisible()
  // The chip is inside it, not stacked above it.
  await expect(bar.locator(".fc-pr-chip")).toHaveCount(1)
})

test("the finished row is the same alert as the bar above it, down to the ×", async ({ page }) => {
  await openSession(page, [], { branch: withPullRequest({ state: "merged" }) })

  const bar = page.locator(".fc-repo-bar")
  const done = page.locator(".fc-pr-done")
  const barBox = (await bar.boundingBox())!
  const doneBox = (await done.boundingBox())!

  // Two notices in one column: the same size, so neither reads as an afterthought.
  expect(doneBox.height).toBe(barBox.height)
  expect(doneBox.width).toBe(barBox.width)

  // And the × closes whichever one it sits on, so it must not move between them: same column on
  // the right, and the same place within its own row.
  const barClose = (await bar.locator(".fc-repo-clear").boundingBox())!
  const doneClose = (await done.locator(".fc-repo-clear").boundingBox())!
  expect(Math.abs(doneClose.x - barClose.x)).toBeLessThan(1)
  expect(Math.abs(doneClose.y - doneBox.y - (barClose.y - barBox.y))).toBeLessThan(1)
})

test("the composer's pieces are all one gap apart, the prompt dock included", async ({ page }) => {
  await openSession(page, [], { branch: withPullRequest({ state: "merged" }) })

  const bar = (await page.locator(".fc-repo-bar").boundingBox())!
  const done = (await page.locator(".fc-pr-done").boundingBox())!
  const dock = (await page.locator(".fc-input-wrap").boundingBox())!
  const toolbar = (await page.locator(".fc-composer-bottom").boundingBox())!

  // One gap for every stacked piece: between the alerts, before the dock, and under it. The branch
  // block used to add its own margin to the flex gap, so the dock sat further down than the rest.
  const alerts = done.y - (bar.y + bar.height)
  const beforeDock = dock.y - (done.y + done.height)
  const afterDock = toolbar.y - (dock.y + dock.height)
  expect(Math.abs(beforeDock - alerts)).toBeLessThan(1)
  expect(Math.abs(afterDock - beforeDock)).toBeLessThan(1)
})

test("the failing checks do get a bubble of their own, under the bar", async ({ page }) => {
  await openSession(page, [], { branch: withPullRequest(failing) })
  await expect(page.locator(".fc-pr-failures")).toHaveCount(0)

  await page.locator(".fc-pr-checks-open").click()

  // Opened on purpose and long: this one is a different thing from the bar.
  const failures = page.locator(".fc-pr-failures")
  await expect(failures).toBeVisible()
  await expect(page.locator(".fc-repo-bar .fc-pr-failures")).toHaveCount(0)
})

test("the bar can be closed, and closing it leaves the session behind", async ({ page }) => {
  await openSession(page, [], { branch: withPullRequest({}) })
  await expect(page.locator(".fc-repo-bar")).toBeVisible()

  // With a session open the bar's exit is "Close session" (the old "Hide this" belonged to a picked
  // folder with no session, and that bar was removed with it). Closing deselects, so the bar — which
  // only ever stands for an open session or a picked folder — goes with it.
  await page.getByRole("button", { name: /Close session|Cerrar sesión/ }).click()
  await expect(page.locator(".fc-repo-bar")).toHaveCount(0)
  await expect(page.locator(".fc-canvas")).toBeVisible()
})

test("the repository is named when it is not the folder's name again", async ({ page }) => {
  // The folder here is `demo` and the repository is `rldona/FlupCode`, so it is worth saying.
  await openSession(page, [], { branch: withPullRequest({}) })
  await expect(page.getByRole("button", { name: "#121" })).toBeVisible()
  await expect(page.locator(".fc-pr-repo")).toContainText("rldona/FlupCode")
})

test("the repository is not named when it is just the folder's name", async ({ page }) => {
  // Printing `demo demo` would be noise on a row that is already full. The repository is the
  // branch's, not the pull request's, so it is set beside the branch.
  await openSession(page, [], { branch: { ...withPullRequest({}), repository: "rldona/demo" } })
  await expect(page.getByRole("button", { name: "#121" })).toBeVisible()
  await expect(page.locator(".fc-pr-repo")).toHaveCount(0)
})

test("a failed check can be asked why, without leaving for a browser", async ({ page }) => {
  const seen = await openSession(page, [], { branch: withPullRequest(failing) })

  // "2 failed" used to be the end of the road: the answer was a tab away.
  await page.locator(".fc-pr-checks-open").click()

  const failures = page.locator(".fc-pr-failure")
  await expect(failures).toHaveCount(2)
  await expect(failures.first()).toContainText("build")
  await expect(failures.first()).toContainText("harness")

  // The log is fetched only when asked for: it is a network call per job, and the chip polls.
  expect(seen.logs).toEqual([])
  await failures.first().getByRole("button", { name: /Why|Por qué/ }).click()

  await expect.poll(() => seen.logs).toEqual(["9001"])
  await expect(page.locator(".fc-pr-log")).toContainText('error: script "test" exited with code 1')
  // The step that failed, which is what the log is of.
  await expect(failures.first()).toContainText("Test remote control")
  await expect(failures.first()).toContainText(/Only the end|Sólo se muestra el final/)
})

test("a check with no Actions job offers the page instead of a log it cannot read", async ({ page }) => {
  await openSession(page, [], { branch: withPullRequest(failing) })
  await page.locator(".fc-pr-checks-open").click()

  const external = page.locator(".fc-pr-failure").filter({ hasText: "ci/external" })
  await expect(external.getByRole("button", { name: /On GitHub|En GitHub/ })).toBeVisible()
  await expect(external.getByRole("button", { name: /^(Why|Por qué)$/ })).toHaveCount(0)
})

test("checks that all passed have nothing to expand", async ({ page }) => {
  await openSession(page, [], { branch: withPullRequest({}) })

  await expect(page.locator(".fc-pr-checks")).toBeVisible()
  // Not a button: there is nothing behind it.
  await expect(page.locator(".fc-pr-checks-open")).toHaveCount(0)
})

const checkpoint = (id: string, title: string, createdAt: number) => ({
  id,
  directory: "/work/demo",
  sha: `${id}${"0".repeat(40 - id.length)}`,
  title,
  createdAt,
})

test("restoring names every file it would delete, before it deletes any", async ({ page }) => {
  const seen = await openSession(page, [], {
    checkpoints: [checkpoint("cp1", "after the plan step", 2), checkpoint("cp2", "before the run", 1)],
  })
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()

  const first = page.locator(".fc-checkpoint").filter({ hasText: "after the plan step" })
  await first.getByRole("button", { name: /^(Restore|Restaurar)$/ }).click()

  const plan = first.locator(".fc-checkpoint-plan")
  await expect(plan).toBeVisible()
  // Nothing has been restored yet: the click asked what would happen, and that is all.
  await expect.poll(() => seen.planned).toEqual(["cp1"])
  expect(seen.restored).toEqual([])

  // The deletions by name and in full — a file nobody added to git is gone from everywhere.
  await expect(plan).toContainText(/Deleted \(1\)|Se borran \(1\)/)
  await expect(plan).toContainText("src/oops.ts")
  await expect(plan).toContainText(/Rewritten \(2\)|Se reescriben \(2\)/)
  await expect(plan).toContainText(/can be undone|se puede deshacer/)
})

test("cancelling a restore restores nothing", async ({ page }) => {
  const seen = await openSession(page, [], { checkpoints: [checkpoint("cp1", "after the plan step", 2)] })
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()

  await page.locator(".fc-checkpoint").getByRole("button", { name: /^(Restore|Restaurar)$/ }).click()
  await expect(page.locator(".fc-checkpoint-plan")).toBeVisible()
  await page.getByRole("button", { name: /^(Cancel|Cancelar)$/ }).click()

  await expect(page.locator(".fc-checkpoint-plan")).toHaveCount(0)
  await expect.poll(() => seen.restored).toEqual([])
})

test("confirming restores, and nothing else", async ({ page }) => {
  const seen = await openSession(page, [], { checkpoints: [checkpoint("cp1", "after the plan step", 2)] })
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()

  const card = page.locator(".fc-checkpoint")
  await card.getByRole("button", { name: /^(Restore|Restaurar)$/ }).click()
  await expect(card.locator(".fc-checkpoint-plan")).toBeVisible()
  await card.locator(".fc-checkpoint-plan").getByRole("button", { name: /^(Restore|Restaurar)$/ }).click()

  await expect.poll(() => seen.restored).toEqual(["cp1"])
})

test("the branch view has no checkpoints, because they are about the folder", async ({ page }) => {
  await openSession(page, [], { checkpoints: [checkpoint("cp1", "one", 1)] })
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()
  await expect(page.locator(".fc-checkpoints")).toBeVisible()

  await page.getByRole("button", { name: /^(Branch|Rama)$/ }).click()

  await expect(page.locator(".fc-checkpoints")).toHaveCount(0)
})

const finding = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  directory: "/work/demo",
  file: "src/server.ts",
  line: 11,
  severity: "high",
  title: "This can be undefined",
  detail: "When the list is empty, `at(-1)` gives undefined and the next line reads a property of it.",
  createdAt: 1,
  ...over,
})

test("a finding sits on the line it is about", async ({ page }) => {
  await openSession(page, [], { findings: [finding()] })
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()

  const file = page.locator(".fc-diff-file").filter({ hasText: "server.ts" })
  // The count is on the header before the file is even opened.
  await expect(file.locator(".fc-diff-finding-count")).toHaveText("1")
  await file.locator(".fc-diff-file-head").click()

  const comment = file.locator(".fc-diff-finding")
  await expect(comment).toContainText("This can be undefined")
  await expect(comment).toHaveAttribute("data-severity", "high")
  // Under line 11, which is where the review anchored it.
  const rows = await file.locator(".fc-diff-line, .fc-diff-finding").evaluateAll((nodes) =>
    nodes.map((node) => node.className + "|" + (node.textContent ?? "").slice(0, 24)),
  )
  const index = rows.findIndex((row) => row.startsWith("fc-diff-finding"))
  expect(rows[index - 1]).toContain("11")
})

test("a failed check does not read like a model's opinion", async ({ page }) => {
  // H-22. Both are drawn on the diff, and they are not the same claim: a review can be wrong, a
  // command that exited non-zero cannot. The reader has to be able to tell at a glance.
  await openSession(page, [], {
    findings: [
      finding(),
      finding({
        id: "f2",
        line: 12,
        source: "check",
        title: "Type 'number' is not assignable to type 'string'.",
        detail: "typecheck · TS2322",
      }),
    ],
  })
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()
  const file = page.locator(".fc-diff-file").filter({ hasText: "server.ts" })
  await file.locator(".fc-diff-file-head").click()

  const fromCheck = file.locator('.fc-diff-finding[data-source="check"]')
  await expect(fromCheck).toHaveCount(1)
  await expect(fromCheck.locator(".fc-diff-finding-severity")).toHaveText("check")
  await expect(fromCheck).toContainText("TS2322")
  // The review's point keeps its severity, so the two are told apart by what they say.
  const fromReview = file.locator('.fc-diff-finding[data-source="review"]')
  await expect(fromReview.locator(".fc-diff-finding-severity")).toHaveText(/high|alto/)
})

test("a finding about the file rather than a line still appears", async ({ page }) => {
  // Dropping it because it has no line would make the review claim to be complete when it is not.
  await openSession(page, [], { findings: [finding({ line: undefined, title: "This file does too much" })] })
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()
  const file = page.locator(".fc-diff-file").filter({ hasText: "server.ts" })
  await file.locator(".fc-diff-file-head").click()

  await expect(file.locator(".fc-diff-finding")).toContainText("This file does too much")
})

test("marking one done sets it aside without deleting it", async ({ page }) => {
  const seen = await openSession(page, [], { findings: [finding()] })
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()
  const file = page.locator(".fc-diff-file").filter({ hasText: "server.ts" })
  await file.locator(".fc-diff-file-head").click()

  await file.getByRole("button", { name: /^(Done|Hecho)$/ }).click()

  await expect.poll(() => seen.resolved).toEqual([{ id: "f1", resolved: true }])
})

test("one already done is still readable, and offers to be reopened", async ({ page }) => {
  await openSession(page, [], { findings: [finding({ resolved: true })] })
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()
  const file = page.locator(".fc-diff-file").filter({ hasText: "server.ts" })

  // It no longer counts against the file, but it has not disappeared.
  await expect(file.locator(".fc-diff-finding-count")).toHaveCount(0)
  await file.locator(".fc-diff-file-head").click()
  await expect(file.locator(".fc-diff-finding-done")).toContainText("This can be undefined")
  await expect(file.getByRole("button", { name: /Reopen|Reabrir/ })).toBeVisible()
})

test("a diff with no review on it looks exactly as it did", async ({ page }) => {
  await openSession(page)
  await page.getByRole("button", { name: /\+3.*-1|\+3.*−1/ }).click()

  await expect(page.locator(".fc-diff-finding")).toHaveCount(0)
  await expect(page.locator(".fc-diff-finding-count")).toHaveCount(0)
  await expect(page.locator(".fc-changes-findings")).toHaveCount(0)
})
