import { expect, test } from "@playwright/test"

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

// OpenCode 2's model shape, which the app reads its own from.
const model = (providerID: string, id: string, name: string) => ({
  id,
  modelID: id,
  providerID,
  name,
  variants: [],
  time: { released: now },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 200_000, output: 8_000 },
})

const models = [
  model("anthropic", "claude-opus-5", "Claude Opus 5"),
  model("openai", "gpt-5", "GPT-5"),
  model("anthropic", "claude-sonnet-5", "Claude Sonnet 5"),
]

const routine = {
  id: "r1",
  name: "Nightly audit",
  description: "",
  prompt: "Check the dependencies",
  schedule: { type: "manual" },
  enabled: true,
  createdAt: now,
  updatedAt: now,
  runs: [] as unknown[],
}

const engine = (page: import("@playwright/test").Page) =>
  page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/model") return route.fulfill({ json: { data: models } })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|form)$/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })

type Route = import("@playwright/test").Route

const boot = async (
  page: import("@playwright/test").Page,
  deleted: string[],
  path = "/",
  /** Answers a harness request before the defaults do, or leaves it to them by returning nothing. */
  harness?: (route: Route, url: URL) => Promise<void> | undefined,
) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
  await engine(page)
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    const answered = harness?.(route, url)
    if (answered) return answered
    if (url.pathname === "/harness/routines" && route.request().method() === "GET")
      return route.fulfill({ json: { data: deleted.length > 0 ? [] : [routine] } })
    if (/^\/harness\/routines\/[^/]+$/.test(url.pathname) && route.request().method() === "DELETE") {
      deleted.push(url.pathname.split("/").pop()!)
      return route.fulfill({ json: { data: true } })
    }
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto(path)
  if (path === "/") await page.getByRole("button", { name: /Routines|Rutinas/ }).click()
  return page.locator(".fc-routines-screen")
}

// Someone reading the list has no way to tell two models of the same name apart, and no way to see
// which provider a name belongs to. The list is grouped so the provider is on screen next to it.
test("the model list is grouped by provider", async ({ page }) => {
  const screen = await boot(page, [])
  await screen.getByRole("button", { name: /New routine|Nueva rutina/ }).click()
  const select = screen.locator("select").filter({ has: page.locator('option[value="anthropic/claude-opus-5"]') })
  await expect(select.locator("optgroup")).toHaveCount(2)
  await expect(select.locator("optgroup").first()).toHaveAttribute("label", "anthropic")
})

// Deleting asks first, and the question has to be where the eye already is: the confirmation used to
// render at the foot of a scrolling screen, so the button looked dead.
test("a routine can be deleted from the detail view", async ({ page }) => {
  const deleted: string[] = []
  const screen = await boot(page, deleted)
  await screen.getByRole("button", { name: "Nightly audit" }).click()
  await screen
    .getByRole("button", { name: /^(Delete|Borrar|Eliminar)$/ })
    .first()
    .click()
  const confirm = screen.getByText(/Delete this routine\?|¿Borrar esta rutina\?|¿Eliminar esta rutina\?/)
  await expect(confirm).toBeInViewport()
  await screen
    .getByRole("button", { name: /^(Delete|Borrar|Eliminar)$/ })
    .last()
    .click()
  await expect.poll(() => deleted).toEqual(["r1"])
  await expect(screen.getByRole("button", { name: "Nightly audit" })).toHaveCount(0)
})

// The detail is a dialog over the list now, not a second column beside it, and its actions live in
// the same right-aligned footer the other dialogs use.
test("the routine detail is a dialog with its actions in a right-aligned footer", async ({ page }) => {
  const screen = await boot(page, [])
  await screen.getByRole("button", { name: "Nightly audit" }).click()

  const dialog = screen.locator('[role="dialog"].fc-routines-detail')
  await expect(dialog).toBeVisible()

  const actions = dialog.locator(".fc-dialog-actions")
  await expect(actions.getByRole("button", { name: /^(Edit|Editar)$/ })).toBeVisible()
  expect(await actions.evaluate((node) => getComputedStyle(node).justifyContent)).toBe("flex-end")
})

// Escape backs out of the dialog on top and stays on the screen. The detail and the edit form can
// both be open; the first Escape closes the form, the second the detail, and the screen remains.
test("Escape closes the topmost dialog without leaving the screen", async ({ page }) => {
  const screen = await boot(page, [])
  await screen.getByRole("button", { name: "Nightly audit" }).click()
  const detail = screen.locator('[role="dialog"].fc-routines-detail')
  await expect(detail).toBeVisible()

  await detail.getByRole("button", { name: /^(Edit|Editar)$/ }).click()
  const edit = screen.locator('div[role="dialog"].fc-form-modal')
  await expect(edit).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(edit).toHaveCount(0)
  await expect(detail).toBeVisible()
  await expect(screen).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(detail).toHaveCount(0)
  await expect(screen).toBeVisible()
})

// RP-07: a tab with nothing behind it is gone until there is something to put there.
test("there is no Templates tab", async ({ page }) => {
  const screen = await boot(page, [])
  await expect(screen.getByRole("button", { name: "Nightly audit" })).toBeVisible()
  await expect(screen.getByRole("button", { name: /Templates|Plantillas/ })).toHaveCount(0)
})

// RP-07: the row says how the routine is doing — when it runs next in its own zone, how its last run
// ended and how many failed in a row — from what the server says, with no schedule logic of its own.
test("a routine's row shows its next run in its zone, its last verdict and its failures in a row", async ({ page }) => {
  const failing = {
    ...routine,
    schedule: { type: "daily", time: "08:15", timezone: "Asia/Tokyo" },
    // 08:15 in Tokyo is 23:15 UTC the day before.
    nextRunAt: Date.UTC(2030, 0, 6, 23, 15),
    failedInARow: 3,
    failing: true,
    runs: [
      {
        id: "run_3",
        status: "success",
        startedAt: now - 1000,
        finishedAt: now,
        verdict: { value: "failed", reason: "I stop here", source: "rule", taskID: "t" },
      },
    ],
  }
  const screen = await boot(page, [], "/", (route, url) =>
    url.pathname === "/harness/routines" && route.request().method() === "GET"
      ? route.fulfill({ json: { data: [failing] } })
      : undefined,
  )
  const row = screen.getByRole("button", { name: /Nightly audit/ })
  await expect(row).toContainText(/Asia\/Tokyo/)
  await expect(row).toContainText(/08:15/)
  await expect(row.locator(".fc-verdict")).toHaveAttribute("data-verdict", "failed")
  await expect(row).toContainText(/3 failed in a row|3 fallidas seguidas/)
  await expect(row.locator(".fc-attention")).toHaveAttribute("data-attention", "failed")
})

// RP-07: the inputs a workflow declares are fields of the form, and what is typed there is what the
// server is asked to keep — with the zone, the missed-run policy and the retries.
test("the form fills a workflow's inputs and the schedule's zone, missed runs and retries", async ({ page }) => {
  const posted: unknown[] = []
  const workflows = [
    { name: "triage", description: "", inputs: ["label", "limit"], inputDefaults: { limit: "10" }, tasks: [] },
  ]
  const screen = await boot(page, [], "/", (route, url) => {
    if (url.pathname === "/harness/workflows") return route.fulfill({ json: { data: workflows } })
    if (url.pathname === "/harness/routines" && route.request().method() === "POST") {
      posted.push(route.request().postDataJSON())
      return route.fulfill({ status: 201, json: { data: { ...routine, id: "r2", name: "Triage" } } })
    }
    return undefined
  })
  await screen.getByRole("button", { name: /New routine|Nueva rutina/ }).click()
  const form = screen.locator('div[role="dialog"].fc-form-modal')
  await form.getByLabel(/^(Name|Nombre)/).fill("Triage")
  await form.getByLabel(/^(Instructions|Instrucciones)/).fill("Triage the issues")
  await form.getByLabel(/^(Workflow|Flujo de trabajo)/).selectOption("triage")
  await form.getByLabel(/^label/).fill("bug")
  await expect(form.getByLabel(/^limit/)).toHaveAttribute("placeholder", "10")
  await form.getByLabel(/^(Schedule|Programación)/).selectOption("daily")
  await form.getByLabel(/^(Time|Hora)$/).fill("08:15")
  await form.getByLabel(/^(Time zone|Zona horaria)/).fill("Europe/Madrid")
  await form.getByLabel(/^(Time zone|Zona horaria)/).blur()
  await form.getByLabel(/^(Missed runs|Ejecuciones perdidas)/).selectOption("skip")
  await form.getByLabel(/^(Retries|Reintentos)/).fill("2")
  await form.getByLabel(/^(Minutes before the first retry|Minutos antes del primer reintento)/).fill("10")
  await form.getByRole("button", { name: /^(Save|Guardar)$/ }).click()

  await expect.poll(() => posted.length).toBe(1)
  expect(posted[0]).toMatchObject({
    name: "Triage",
    workflow: { name: "triage", inputs: { label: "bug" } },
    schedule: { type: "daily", time: "08:15", timezone: "Europe/Madrid" },
    missed: "skip",
    retry: { count: 2, backoffMinutes: 10 },
  })
  // An empty field takes the file's default, so nothing is sent for it.
  expect((posted[0] as { workflow: { inputs: Record<string, string> } }).workflow.inputs).not.toHaveProperty("limit")
})

// A screen you can reload is a screen you can link to and come back to. It is a path, which means
// whatever serves this build has to answer it with index.html; the preview server here does, as
// vercel.json and the desktop's renderer protocol do in the two places this actually ships.
test("a screen is kept in the URL, through a reload and the Back button", async ({ page }) => {
  const screen = await boot(page, [])
  await expect(screen).toBeVisible()
  await expect(page).toHaveURL(/\/routines$/)

  await page.reload()
  await expect(page.locator(".fc-routines-screen")).toBeVisible()

  // Back leaves the screen instead of leaving the app.
  await page.goBack()
  await expect(page.locator(".fc-routines-screen")).toHaveCount(0)
  await expect(page).not.toHaveURL(/\/routines$/)
})

// And the link works cold: opened straight at the address, with no click to get there.
test("the Runs screen opens from its own address", async ({ page }) => {
  await boot(page, [], "/runs")
  await expect(page.locator('section[aria-label="Runs"], section[aria-label="Ejecuciones"]')).toBeVisible()
})
