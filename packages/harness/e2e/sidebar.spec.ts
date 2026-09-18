import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const sessionAt = (id: string, title: string, directory: string) => ({
  id,
  projectID: "p",
  title,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory },
})

const sessions = [
  sessionAt("ses_a", "Fix the parser", "/work/alpha"),
  sessionAt("ses_b", "Write the docs", "/work/beta"),
]

const routines = [
  {
    id: "rt_1",
    name: "Nightly audit",
    description: "Look for regressions",
    prompt: "audit",
    enabled: true,
    schedule: { type: "daily", hour: 3, minute: 0 },
    createdAt: now,
    runs: [],
  },
  {
    id: "rt_2",
    name: "Weekly deps",
    description: "",
    prompt: "deps",
    enabled: false,
    schedule: { type: "weekly", day: 1, hour: 9, minute: 0 },
    createdAt: now,
    runs: [],
  },
]

async function open(page: Page, options: { routines?: unknown[]; sessions?: unknown[]; selected?: string } = {}) {
  await page.addInitScript((selected?: string) => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    if (selected) window.localStorage.setItem("flupcode.selectedSession", JSON.stringify(selected))
  }, options.selected)
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: options.routines ?? [] } })
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/artifacts") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/workflows") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session")
      return route.fulfill({ json: { data: options.sessions ?? sessions, cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/find/file" || url.pathname === "/api/find/file") return route.fulfill({ json: { data: [] } })
    if (/\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await expect(page.locator(".fc-sidebar")).toBeVisible()
}

test("routines get a section of their own at the top, and only when there are any", async ({ page }) => {
  await open(page)
  // No routines, no section — an empty heading is furniture.
  await expect(page.locator(".fc-sidebar-routine")).toHaveCount(0)

  await page.goto("about:blank")
  await open(page, { routines })

  const items = page.locator(".fc-sidebar-routine")
  await expect(items).toHaveCount(2)
  // Above the projects, because a routine runs whether or not this window is open.
  const routineBox = await items.first().boundingBox()
  const projectBox = await page.locator(".fc-project-group").first().boundingBox()
  expect(routineBox!.y).toBeLessThan(projectBox!.y)
  // A paused one is marked as paused rather than looking the same as a running one.
  await expect(page.locator(".fc-sidebar-routine-off")).toHaveCount(1)
})

test("a routine in the sidebar opens the routines screen on that routine", async ({ page }) => {
  await open(page, { routines })

  await page.locator(".fc-sidebar-routine").filter({ hasText: "Nightly audit" }).click()

  await expect(page).toHaveURL(/\/routines$/)
  // Not just the screen: the one that was clicked, already selected.
  await expect(page.locator(".fc-routines-detail")).toContainText("Nightly audit")
})

test("sections are separated, rather than running into one another", async ({ page }) => {
  await open(page, { routines })

  // Every row used to sit 2px from its neighbour, so a heading was as close to the section above it
  // as to its own rows and the column read as one block of text.
  const gap = await page.locator(".fc-scroll").evaluate((node) => parseFloat(getComputedStyle(node).rowGap))
  const inside = await page
    .locator(".fc-sidebar-section")
    .first()
    .evaluate((node) => parseFloat(getComputedStyle(node).rowGap))
  expect(gap).toBeGreaterThanOrEqual(inside * 4)
})

test("the filter box is gone; the magnifier opens a search that reaches further", async ({ page }) => {
  await open(page, { routines })

  await expect(page.locator(".fc-filter-input")).toHaveCount(0)
  await page.locator(".fc-sidebar-search").click()

  const palette = page.locator(".fc-palette")
  await expect(palette).toBeVisible()
  // Sessions and routines both, which a box over the session list could never have found.
  await expect(palette).toContainText("Fix the parser")
  await expect(palette).toContainText("Nightly audit")
})

test("the list scrolls under + New, and + New does not move", async ({ page }) => {
  const many = Array.from({ length: 40 }, (_, index) => sessionAt(`ses_${index}`, `Session ${index}`, "/work/demo"))
  await open(page, { sessions: many })
  await page.setViewportSize({ width: 900, height: 420 })

  const newBefore = (await page.locator(".fc-new").boundingBox())!.y
  const navBefore = (await page.locator(".fc-nav-item").first().boundingBox())!.y

  await page.locator(".fc-scroll").evaluate((node) => node.scrollTo(0, 400))

  // The nav and the projects go under; the button that starts a session stays where it is.
  await expect.poll(() => page.locator(".fc-nav-item").first().boundingBox().then((box) => box!.y)).toBeLessThan(navBefore)
  expect((await page.locator(".fc-new").boundingBox())!.y).toBe(newBefore)
})

test("opening a session below does not collapse the project above it", async ({ page }) => {
  const many = [
    ...Array.from({ length: 6 }, (_, index) => sessionAt(`ses_a${index}`, `Alpha ${index}`, "/work/alpha")),
    ...Array.from({ length: 6 }, (_, index) => sessionAt(`ses_b${index}`, `Beta ${index}`, "/work/beta")),
  ]
  // The selected session makes its project open, which used to be the only reason it was.
  await open(page, { sessions: many, selected: "ses_a0" })

  const alpha = page.locator(".fc-session-row").filter({ hasText: /^Alpha / })
  await expect(alpha).toHaveCount(6)

  await page.locator(".fc-project-group").filter({ hasText: "beta" }).locator(".fc-project-toggle").click()
  await page.locator(".fc-session-row").filter({ hasText: "Beta 0" }).click()

  // Opening something below must not remove the rows above it: that shrank the list and jumped the
  // scroll to the top.
  await expect(alpha).toHaveCount(6)
})

test("the tabs are the kinds that matched, and picking one narrows to it", async ({ page }) => {
  await open(page, { routines })
  await page.locator(".fc-sidebar-search").click()

  const tabs = page.locator(".fc-palette-tab")
  const names = await tabs.allInnerTexts()
  expect(names).toContain("All")
  expect(names).toContain("Routines")
  // Nothing has run and nothing was kept, so neither gets a tab.
  expect(names).not.toContain("Runs")
  expect(names).not.toContain("Artifacts")

  await tabs.filter({ hasText: /^Routines$/ }).click()
  await expect(page.locator(".fc-palette-item")).toHaveCount(2)
  await expect(page.locator(".fc-palette")).not.toContainText("Fix the parser")
})

test("walking the palette with the arrows keeps the active row in view", async ({ page }) => {
  const many = Array.from({ length: 30 }, (_, index) => sessionAt(`ses_${index}`, `Session ${index}`, "/work/demo"))
  await open(page, { sessions: many })
  await page.locator(".fc-sidebar-search").click()

  // The Sessions tab lists them all; "All" would cap them at a handful.
  await page.locator(".fc-palette-tab").filter({ hasText: /^Sessions$/ }).click()
  const list = page.locator(".fc-palette-list")
  await expect(list.locator(".fc-palette-item").first()).toBeVisible()
  const listBox = (await list.boundingBox())!

  for (let index = 0; index < 20; index++) await page.keyboard.press("ArrowDown")

  // The active row must have been scrolled into view, not left below the fold.
  const active = page.locator(".fc-palette-item-active")
  await expect(active).toBeVisible()
  const activeBox = (await active.boundingBox())!
  expect(await list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  expect(activeBox.y).toBeGreaterThanOrEqual(listBox.y - 1)
  expect(activeBox.y + activeBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1)
})

test("typing narrows across kinds at once", async ({ page }) => {
  await open(page, { routines })
  await page.locator(".fc-sidebar-search").click()

  await page.locator(".fc-palette-input").fill("night")

  const items = page.locator(".fc-palette-item")
  await expect(items).toHaveCount(1)
  await expect(items.first()).toContainText("Nightly audit")
})

test("a search result opens the thing it names", async ({ page }) => {
  await open(page, { routines })
  await page.locator(".fc-sidebar-search").click()
  await page.locator(".fc-palette-input").fill("parser")

  await page.locator(".fc-palette-item").first().click()

  await expect(page.locator(".fc-palette")).toHaveCount(0)
  await expect(page.locator(".fc-topbar-title, .fc-session-title").first()).toContainText("Fix the parser")
})

// H-18: pins and tags are kept by the harness server, not the browser, so they travel to the phone.
test("a session is pinned and tagged on the server, and a tag filters the list", async ({ page }) => {
  const calls: Array<{ sessionID: string; body: unknown }> = []
  const prefs: Record<string, { sessionID: string; pinned: boolean; tags: string[]; updatedAt: number }> = {}

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_a"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/artifacts") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/workflows") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/stash") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/session-prefs" && route.request().method() === "GET")
      return route.fulfill({ json: { data: Object.values(prefs) } })
    if (url.pathname.startsWith("/harness/session-prefs/") && route.request().method() === "PATCH") {
      const sessionID = url.pathname.split("/").pop()!
      const body = route.request().postDataJSON() as { pinned?: boolean; tags?: string[] }
      calls.push({ sessionID, body })
      const current = prefs[sessionID] ?? { sessionID, pinned: false, tags: [], updatedAt: 0 }
      const next = { ...current, ...body, sessionID, updatedAt: Date.now() }
      prefs[sessionID] = next
      return route.fulfill({ json: { data: next } })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: sessions, cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (/\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await expect(page.locator(".fc-sidebar")).toBeVisible()

  const row = page.locator(".fc-session-row", { hasText: "Fix the parser" }).first()

  // Pinning asks the server; it is not written to the browser.
  await row.locator(".fc-session-action").click()
  await page.locator(".fc-menu-item", { hasText: "Pin" }).click()
  await expect.poll(() => calls.at(-1)?.body).toEqual({ pinned: true })
  await expect(page.locator(".fc-sidebar-section", { hasText: /Pinned|Fijado/ })).toContainText("Fix the parser")

  // Tagging asks the server too, and the tag becomes a filter chip.
  await row.locator(".fc-session-action").click()
  await page.locator(".fc-menu-item", { hasText: "Edit tags" }).click()
  await page.locator('.fc-modal input[aria-label="Tags"]').fill("work, home")
  await page.getByRole("button", { name: "Save" }).click()
  await expect.poll(() => calls.at(-1)?.body).toEqual({ tags: ["work", "home"] })
  await expect(page.getByRole("dialog", { name: /Tags/ })).toHaveCount(0)

  const filter = page.locator(".fc-sidebar .fc-tag-filter")
  await expect(filter).toContainText("work")
  await filter.locator(".fc-session-tag", { hasText: "work" }).click()
  await expect(filter.locator(".fc-session-tag", { hasText: "work" })).toHaveClass(/fc-session-tag-active/)
})
