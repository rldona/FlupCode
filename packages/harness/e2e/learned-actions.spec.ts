import { expect, test, type Page } from "@playwright/test"

/**
 * AH-E04: the whole learning cycle from the Skills screen, without touching a file. The harness server
 * is a small stateful mock, so each action changes what the next read answers, the way the real
 * routes do.
 */

const now = Date.now()

const session = {
  id: "ses_la",
  projectID: "p",
  title: "Learned",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const proposal = (name: string) => ({
  id: `proposal:${name}`,
  episodeID: `ep-${name}`,
  projectID: "/work/demo",
  intent: "add",
  name,
  description: `Use when ${name} applies`,
  body: `## Steps\nThe steps of ${name}.`,
  evidenceRefs: [`ep-${name}`],
  status: "proposed",
  createdAt: now,
  updatedAt: now,
})

type Learned = { name: string; description: string; body: string; disabled: boolean }

async function openApp(page: Page, options: { desktop?: boolean } = {}) {
  const posts: Array<{ path: string; body: unknown }> = []
  const proposals = [proposal("parser-fix"), proposal("noise-skill")]
  const learned: Learned[] = []
  const pathOf = (skill: Learned) =>
    skill.disabled
      ? `/work/demo/.opencode/flupcode-learned-disabled/${skill.name}/SKILL.md`
      : `/work/demo/.opencode/skills/flupcode-learned/${skill.name}/SKILL.md`
  const view = (skill: Learned) => ({
    name: skill.name,
    description: skill.description,
    learned: true,
    state: "probation",
    usage: { load: 0, view: 0, patch: 0, opportunities: 0 },
    disabled: skill.disabled,
    path: pathOf(skill),
  })

  await page.addInitScript((desktop) => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_la"))
    if (desktop) {
      const opened: Array<{ path: string; app?: string }> = []
      Object.assign(window, { __opened: opened })
      window.flupcode = {
        openPath: async (path: string, app?: string) => {
          opened.push({ path, ...(app ? { app } : {}) })
        },
      }
    }
  }, options.desktop === true)

  await page.route("http://127.0.0.1:9097/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/harness/health")
      return route.fulfill({
        json: {
          data: {
            healthy: true,
            capabilities: [
              "adaptive-skills",
              "adaptive-proposals",
              "adaptive-proposals-review",
              "adaptive-skills-manage",
            ],
          },
        },
      })
    if (url.pathname === "/harness/context")
      return route.fulfill({
        json: { data: { directory: "/work/demo", projectDirectory: "/work/demo", instructions: [] } },
      })
    if (url.pathname === "/harness/adaptive/proposals") return route.fulfill({ json: { data: proposals } })
    const review = url.pathname.match(/^\/harness\/adaptive\/proposals\/([^/]+)\/(approve|reject)$/)
    if (review && request.method() === "POST") {
      posts.push({ path: url.pathname, body: request.postDataJSON() })
      const entry = proposals.find((candidate) => candidate.id === decodeURIComponent(review[1]!))
      if (!entry) return route.fulfill({ status: 404, json: { error: "Not found", code: "not_found" } })
      if (review[2] === "approve") {
        entry.status = "promoted"
        learned.push({ name: entry.name, description: entry.description, body: entry.body, disabled: false })
      }
      if (review[2] === "reject") Object.assign(entry, { status: "rejected", reason: "human-rejected" })
      return route.fulfill({ json: { data: entry, changed: true } })
    }
    if (url.pathname === "/harness/adaptive/learned-skills") return route.fulfill({ json: { data: learned.map(view) } })
    const action = url.pathname.match(/^\/harness\/adaptive\/learned-skills\/([^/]+)\/(disable|enable|archive)$/)
    if (action && request.method() === "POST") {
      posts.push({ path: url.pathname, body: request.postDataJSON() })
      const index = learned.findIndex((skill) => skill.name === decodeURIComponent(action[1]!))
      if (index < 0) return route.fulfill({ status: 404, json: { error: "Not found", code: "not_found" } })
      if (action[2] === "archive") learned.splice(index, 1)
      if (action[2] !== "archive") learned[index]!.disabled = action[2] === "disable"
      return route.fulfill({ json: { data: { name: action[1], status: action[2] }, changed: true } })
    }
    const detail = url.pathname.match(/^\/harness\/adaptive\/learned-skills\/([^/]+)$/)
    if (detail) {
      const skill = learned.find((candidate) => candidate.name === decodeURIComponent(detail[1]!))
      if (!skill) return route.fulfill({ status: 404, json: { error: "Not found", code: "not_found" } })
      return route.fulfill({ json: { data: { ...view(skill), body: skill.body } } })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/skill") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/mcp" || url.pathname === "/config") return route.fulfill({ json: {} })
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  return posts
}

test("a proposal is approved, installed, disabled, re-enabled and archived from the UI (AH-E04)", async ({ page }) => {
  const posts = await openApp(page)
  await page.goto("/skills")

  const section = page.locator(".fc-skill-learned")
  const proposalRow = section.locator(".fc-skill-row", { hasText: "parser-fix" }).last()
  await expect(proposalRow).toContainText("Proposed")

  // Approve: the dialog shows the body, and installing it lists the skill.
  await proposalRow.getByRole("button", { name: "Approve" }).click()
  await page.getByRole("dialog", { name: "Review a learned skill" }).getByRole("button", { name: "Install" }).click()
  await expect(proposalRow).toContainText("Promoted")
  const skillRow = section.locator(".fc-routine-cards").first().locator(".fc-skill-row", { hasText: "parser-fix" })
  await expect(skillRow).toContainText("Probation")

  // Open file: a browser has no local bridge, so the text is read in place.
  await skillRow.getByRole("button", { name: "Open file" }).click()
  await expect(skillRow.locator("pre")).toContainText("The steps of parser-fix.")

  // Disable: the confirmation names the consequence, and cancelling sends nothing.
  await skillRow.getByRole("button", { name: "Disable" }).click()
  const disable = page.getByRole("dialog", { name: "Disable learned skill" })
  await expect(disable).toContainText("The skill will no longer be offered in new sessions of this project.")
  await expect(disable).toContainText("parser-fix")
  await disable.getByRole("button", { name: "Cancel" }).click()
  await expect(disable).toHaveCount(0)
  expect(posts.filter((post) => post.path.includes("/learned-skills/"))).toEqual([])

  await skillRow.getByRole("button", { name: "Disable" }).click()
  await page.getByRole("dialog", { name: "Disable learned skill" }).getByRole("button", { name: "Disable" }).click()
  await expect(skillRow).toContainText("Disabled")
  await expect(skillRow.getByRole("button", { name: "Enable" })).toBeVisible()

  await skillRow.getByRole("button", { name: "Enable" }).click()
  const enable = page.getByRole("dialog", { name: "Enable learned skill" })
  await expect(enable).toContainText("The skill will be offered again in new sessions of this project.")
  await enable.getByRole("button", { name: "Enable" }).click()
  await expect(skillRow.getByRole("button", { name: "Disable" })).toBeVisible()

  // Archive: it leaves the list, and nothing is deleted.
  await skillRow.getByRole("button", { name: "Archive" }).click()
  const archive = page.getByRole("dialog", { name: "Archive learned skill" })
  await expect(archive).toContainText("nothing is deleted")
  await archive.getByRole("button", { name: "Archive" }).click()
  await expect(section).toContainText("None yet.")

  expect(posts).toEqual([
    { path: "/harness/adaptive/proposals/proposal%3Aparser-fix/approve", body: { confirm: true } },
    { path: "/harness/adaptive/learned-skills/parser-fix/disable", body: { projectID: "/work/demo", confirm: true } },
    { path: "/harness/adaptive/learned-skills/parser-fix/enable", body: { projectID: "/work/demo", confirm: true } },
    { path: "/harness/adaptive/learned-skills/parser-fix/archive", body: { projectID: "/work/demo", confirm: true } },
  ])
})

test("rejecting a proposal asks first, and installs nothing (AH-E04)", async ({ page }) => {
  const posts = await openApp(page)
  await page.goto("/skills")

  const section = page.locator(".fc-skill-learned")
  const row = section.locator(".fc-skill-row", { hasText: "noise-skill" })
  await row.getByRole("button", { name: "Reject" }).click()
  const dialog = page.getByRole("dialog", { name: "Reject proposal" })
  await expect(dialog).toContainText("The skill will not be installed and the agent will never see it.")
  await expect(dialog).toContainText("noise-skill")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  expect(posts).toEqual([])

  await row.getByRole("button", { name: "Reject" }).click()
  await page.getByRole("dialog", { name: "Reject proposal" }).getByRole("button", { name: "Reject" }).click()
  await expect(row).toContainText("Rejected")
  await expect(row.getByRole("button", { name: /Approve|Reject/ })).toHaveCount(0)
  await expect(section).toContainText("None yet.")
  expect(posts).toEqual([{ path: "/harness/adaptive/proposals/proposal%3Anoise-skill/reject", body: {} }])
})

test("on the desktop, Open file hands the skill's path to the editor (AH-E04)", async ({ page }) => {
  await openApp(page, { desktop: true })
  await page.goto("/skills")

  const section = page.locator(".fc-skill-learned")
  await section.getByRole("button", { name: "Approve" }).first().click()
  await page.getByRole("dialog", { name: "Review a learned skill" }).getByRole("button", { name: "Install" }).click()
  const skillRow = section.locator(".fc-routine-cards").first().locator(".fc-skill-row", { hasText: "parser-fix" })
  await skillRow.getByRole("button", { name: "Open file" }).click()

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened))
    .toEqual([{ path: "/work/demo/.opencode/skills/flupcode-learned/parser-fix/SKILL.md", app: "code" }])
  await expect(skillRow.locator("pre")).toHaveCount(0)
})
