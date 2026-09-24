import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_cfg",
  projectID: "p",
  title: "Config",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const files = [
  { name: "hello.js", path: "/c/tool/hello.js", scope: "global", kind: "tool", bytes: 2048, mtimeMs: 1 },
  { name: "guards/safety.js", path: "/c/guards/safety.js", scope: "global", kind: "guard", bytes: 100, mtimeMs: 2 },
  { name: "guards/gone.js", path: "/c/guards/gone.js", scope: "global", kind: "guard", bytes: 0, mtimeMs: 0, missing: true },
  { name: "config.json", path: "/c/config.json", scope: "global", kind: "config", bytes: 50, mtimeMs: 3 },
]

type Options = { config?: unknown }
type Calls = { exports: Array<Record<string, unknown>>; patches: Array<Record<string, unknown>> }

async function open(page: Page, options: Options = {}) {
  const calls: Calls = { exports: [], patches: [] }
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_cfg"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, capabilities: ["config-files"] } } })
    if (url.pathname === "/harness/config-files/export" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>
      calls.exports.push(body)
      return route.fulfill({
        json: {
          data: {
            repo: "/repo",
            dryRun: body.confirm !== true,
            written: ["/c/tool/hello.js"],
            unchanged: [],
            conflicts: [],
            skipped: ["/c/guards/gone.js"],
            outside: [],
            entries: [
              { path: "/c/tool/hello.js", target: "/repo/tool/hello.js", classification: "written" },
              { path: "/c/guards/gone.js", target: "", classification: "skipped", reason: "the file is not there" },
            ],
          },
        },
      })
    }
    if (url.pathname === "/harness/config-files") return route.fulfill({ json: { data: files } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/config" && request.method() === "GET")
      return route.fulfill({ json: options.config ?? { flupcode: { configRepo: "/repo" } } })
    if (url.pathname === "/global/config" && request.method() === "PATCH") {
      calls.patches.push(request.postDataJSON() as Record<string, unknown>)
      return route.fulfill({ json: {} })
    }
    if (url.pathname === "/mcp") return route.fulfill({ json: {} })
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await page
    .getByRole("button", { name: /Customize|Personalizar/ })
    .first()
    .click()
  const settings = page.getByRole("dialog", { name: "Customize" })
  await settings.getByRole("tab", { name: "Advanced" }).click()
  await settings.getByRole("button", { name: /^Config files$|^Archivos de configuración$/ }).click()
  const dialog = page.getByRole("dialog", { name: /^Config files$|^Archivos de configuración$/ })
  await expect(dialog).toBeVisible()
  return { dialog, calls }
}

test("lists the config files grouped by kind, with scope, size and a missing guard", async ({ page }) => {
  const { dialog } = await open(page)

  await expect(dialog.locator(".fc-usage-block").filter({ hasText: "Tools" })).toContainText("hello.js")
  await expect(dialog.locator(".fc-artifact-file", { hasText: "guards/safety.js" })).toHaveCount(1)
  await expect(dialog.locator(".fc-artifact-file", { hasText: "config.json" })).toHaveCount(1)
  // The size is in a unit a reader scans, and the scope is named.
  await expect(dialog.locator(".fc-artifact-file", { hasText: "hello.js" })).toContainText("2 kB")
  await expect(dialog.locator(".fc-artifact-file", { hasText: "hello.js" })).toContainText(/global/)
  // A guard the config names but which is not there says so instead of disappearing.
  await expect(dialog.locator(".fc-artifact-file", { hasText: "guards/gone.js" })).toContainText(/Missing|Falta/)
  // A browser cannot hand a path to the OS, and says so rather than offering a dead button.
  await expect(dialog).toContainText(/desktop app is required|app de escritorio/)
})

test("the export is previewed first, then confirmed", async ({ page }) => {
  const { dialog, calls } = await open(page)

  await dialog.getByRole("button", { name: /^Select all$|^Seleccionar todo$/ }).click()
  await dialog.getByRole("button", { name: /^Plan export$|^Planificar exportación$/ }).click()

  // The plan names what it would do and writes nothing.
  await expect(dialog).toContainText(/plan; nothing|plan; todavía no/)
  await expect.poll(() => calls.exports.length).toBe(1)
  expect(calls.exports[0]!.confirm).toBeUndefined()
  expect((calls.exports[0]!.paths as string[]).length).toBe(4)

  await dialog.getByRole("button", { name: /^Confirm export$|^Confirmar exportación$/ }).click()
  await expect.poll(() => calls.exports.length).toBe(2)
  expect(calls.exports[1]!.confirm).toBe(true)
})

test("changing the selection retires the previewed plan", async ({ page }) => {
  const { dialog } = await open(page)

  await dialog.getByRole("button", { name: /^Select all$|^Seleccionar todo$/ }).click()
  await dialog.getByRole("button", { name: /^Plan export$|^Planificar exportación$/ }).click()
  await expect(dialog).toContainText(/plan; nothing|plan; todavía no/)

  // The plan named the whole selection; unchecking a file must clear it so the write cannot differ.
  await dialog.getByRole("checkbox", { name: /hello\.js/ }).click()
  await expect(dialog).not.toContainText(/plan; nothing|plan; todavía no/)
  await expect(dialog.getByRole("button", { name: /^Confirm export$|^Confirmar exportación$/ })).toHaveCount(0)
})

test("with no repository set, the field saves one into the global config", async ({ page }) => {
  const { dialog, calls } = await open(page, { config: { flupcode: {} } })

  await expect(dialog).toContainText(/No config repository|No hay ningún repositorio/)
  await dialog.getByLabel(/^Config repository$|^Repositorio de configuración$/).fill("/repo")
  await dialog.getByRole("button", { name: /^Save$|^Guardar$/ }).click()

  await expect.poll(() => calls.patches[0]).toMatchObject({ flupcode: { configRepo: "/repo" } })
})
