import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_s",
  projectID: "p",
  title: "Work",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const loaded = {
  name: "effect",
  path: "/work/demo/.opencode/skills/effect/SKILL.md",
  scope: "project",
  root: "/work/demo/.opencode/skills",
  description: "Work with Effect v4 in this repo",
  bytes: 2697,
  loaded: true,
}

const unnamed = {
  path: "/work/demo/.opencode/skills/reviewing/SKILL.md",
  scope: "project",
  root: "/work/demo/.opencode/skills",
  bytes: 400,
  loaded: false,
  reason: "It has no `name` in its frontmatter, so the engine skips it",
}

type Options = { files?: unknown[]; skills?: unknown[]; sourcePaths?: string[]; sourceUrls?: string[] }

async function open(page: Page, options: Options = {}) {
  const saved: Array<Record<string, unknown>> = []
  const deleted: string[] = []
  const patches: Array<Record<string, unknown>> = []
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_s"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/skills/file")
      return route.fulfill({ json: { data: { content: "---\nname: effect\n---\n\nUse Effect v4.\n" } } })
    if (url.pathname === "/harness/skills" && route.request().method() === "POST") {
      saved.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>)
      return route.fulfill({ json: { data: { path: "/work/demo/.opencode/skills/new/SKILL.md" } } })
    }
    if (url.pathname === "/harness/skills" && route.request().method() === "DELETE") {
      deleted.push(url.searchParams.get("path") ?? "")
      return route.fulfill({ json: { data: { removed: true } } })
    }
    if (url.pathname === "/harness/skills")
      return route.fulfill({ json: { data: options.files ?? [loaded, unnamed] } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/skill")
      return route.fulfill({
        json: {
          data: options.skills ?? [
            { name: "effect", description: "Work with Effect v4 in this repo" },
            { name: "customize-opencode", description: "The built-in one" },
          ],
        },
      })
    if (url.pathname === "/config" && route.request().method() === "GET")
      return route.fulfill({
        json: { skills: { paths: options.sourcePaths ?? ["/opt/skills"], urls: options.sourceUrls ?? [] } },
      })
    if (url.pathname === "/config" && route.request().method() === "PATCH") {
      patches.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>)
      return route.fulfill({ json: {} })
    }
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/skills")
  await expect(page.getByRole("heading", { name: /^Skills$/ })).toBeVisible()
  return { saved: () => saved, deleted: () => deleted, patches: () => patches }
}

test("a skill the engine drops is named first, with what it wants", async ({ page }) => {
  // This is the whole ticket. A dropped skill looks exactly like one nobody wrote.
  await open(page)

  const block = page.locator(".fc-skill-ignored")
  await expect(block).toContainText(/no `name`|frontmatter/)
  await expect(block).toContainText("reviewing")
  // And it is above the loaded ones on the page.
  const positions = await page.locator(".fc-usage-block h2").allTextContents()
  expect(positions[0]).toMatch(/not loaded|sin cargar/)
})

test("the loaded ones say where they come from", async ({ page }) => {
  await open(page)

  const row = page.locator(".fc-skill-row").filter({ hasText: "effect" })
  await expect(row).toContainText("project")
  await expect(row).toContainText("Work with Effect v4")
})

test("nothing is read from disk until a skill is opened", async ({ page }) => {
  await open(page)
  await expect(page.locator(".fc-pr-log")).toHaveCount(0)

  await page.locator(".fc-skill-row").filter({ hasText: "effect" }).click()

  await expect(page.locator(".fc-pr-log")).toContainText("Use Effect v4.")
})

test("a new one is written with a name, because that is what it is dropped for missing", async ({ page }) => {
  const { saved } = await open(page)
  await page.getByRole("button", { name: /New skill|Nuevo skill/ }).click()
  const form = page.locator(".fc-agent-form")
  await form.locator("input").first().fill("reviewing")
  await form.locator("textarea").fill("Read the diff first.")
  await page.getByRole("button", { name: /^Save$|^Guardar$/ }).click()

  await expect.poll(() => saved().length).toBe(1)
  expect(saved()[0]).toMatchObject({ name: "reviewing", scope: "project", body: "Read the diff first." })
  await expect(page.locator(".fc-agent-saved")).toContainText(/opened again|vuelva a abrir/)
})

test("a new one with no name is refused before anything is sent", async ({ page }) => {
  const { saved } = await open(page)
  await page.getByRole("button", { name: /New skill|Nuevo skill/ }).click()
  await page.getByRole("button", { name: /^Save$|^Guardar$/ }).click()

  await expect(page.locator(".fc-run-error")).toContainText(/needs a name|necesita un nombre/)
  expect(saved()).toHaveLength(0)
})

test("a skill written after the folder was opened is told apart from a broken one", async ({ page }) => {
  // Measured against a real engine: it reads a folder's skills when it opens the folder, and one
  // written afterwards simply is not there. Nothing is wrong with the file, and saying "not loaded"
  // would send the reader looking for a mistake that does not exist.
  await open(page, {
    files: [loaded, { ...loaded, name: "added-later", path: "/work/demo/.opencode/skills/added-later/SKILL.md" }],
    skills: [{ name: "effect", description: "Work with Effect v4 in this repo" }],
  })

  const block = page.locator(".fc-skill-waiting")
  await expect(block).toContainText("added-later")
  await expect(block).not.toContainText("effect")
  await expect(page.locator(".fc-skill-ignored")).toHaveCount(0)
})

test("says which skills no file here explains", async ({ page }) => {
  await open(page)

  const block = page.locator(".fc-usage-block").filter({ hasText: /Not from a file here|No vienen de un fichero/ })
  await expect(block).toContainText("customize-opencode")
  await expect(block).not.toContainText("Work with Effect")
})

test("a file that exists but is not loaded does not explain away a missing skill", async ({ page }) => {
  // Otherwise the broken file would hide that the engine does not have that skill at all.
  await open(page, {
    files: [{ ...unnamed, name: "reviewing" }],
    skills: [{ name: "reviewing", description: "Not really there" }],
  })

  const block = page.locator(".fc-usage-block").filter({ hasText: /Not from a file here|No vienen de un fichero/ })
  await expect(block).toContainText("reviewing")
})

test("deleting asks first", async ({ page }) => {
  const { deleted } = await open(page)
  await page.locator(".fc-skill-row").filter({ hasText: "effect" }).click()
  await page.getByRole("button", { name: /^Delete$|^Borrar$/ }).click()

  await expect(page.locator(".fc-confirm-inline")).toContainText("effect")
  expect(deleted()).toHaveLength(0)

  await page.locator(".fc-confirm-inline").getByRole("button", { name: /^Delete$|^Borrar$/ }).click()
  await expect.poll(() => deleted()).toEqual(["/work/demo/.opencode/skills/effect/SKILL.md"])
})

test("a folder or a URL can be added as an extra skill source, and removed", async ({ page }) => {
  const api = await open(page)
  await expect(page.getByText("/opt/skills")).toBeVisible()

  await page.getByPlaceholder("/home/me/my-skills").fill("/home/me/skills")
  await page.getByRole("button", { name: "Add folder" }).click()
  await expect
    .poll(() => api.patches())
    .toEqual([{ skills: { paths: ["/opt/skills", "/home/me/skills"], urls: [] } }])

  await page.getByPlaceholder("https://example.com/.well-known/skills/").fill("https://example.com/skills")
  await page.getByRole("button", { name: "Add URL" }).click()
  await expect
    .poll(() => api.patches().at(-1))
    .toEqual({ skills: { paths: ["/opt/skills", "/home/me/skills"], urls: ["https://example.com/skills"] } })

  // Removing the original folder writes the list without it, and the URL stays.
  await page.locator(".fc-skill-row", { hasText: "/opt/skills" }).getByRole("button", { name: "Remove" }).click()
  await expect
    .poll(() => api.patches().at(-1))
    .toEqual({ skills: { paths: ["/home/me/skills"], urls: ["https://example.com/skills"] } })
})
