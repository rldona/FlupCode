import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * The app against a real OpenCode 2 engine (V2-43): no mocked routes, every answer is the engine's.
 * `fixture.ts` serves it on port 4187, through FlupCode's engine proxy, with the stub model, whose
 * next replies each spec scripts.
 */
const ENGINE = "http://127.0.0.1:4187"
/** The fixture's side door: the project's folder and the stub model's next replies. */
const CONTROL = "http://127.0.0.1:4189"

type Reply = { type: "text"; text: string } | { type: "tool"; name: string; input: unknown } | { type: "hang" }

/** The replies the stub model gives next, in order; whatever an earlier spec left unused is dropped. */
const script = (request: APIRequestContext, ...replies: Reply[]) =>
  request.post(`${CONTROL}/__fixture/model`, { data: replies })

/**
 * A new session in the engine's project, opened in the app with the build agent: what a reader has
 * after picking the folder and sending a first prompt, without the clicks that are not under test.
 */
async function openSession(
  page: Page,
  request: APIRequestContext,
  options: { mode: "auto" | "manual"; delivery?: "steer" | "queue" },
) {
  const project = ((await (await request.get(`${CONTROL}/__fixture`)).json()) as { project: string }).project
  const created = await request.post(`${ENGINE}/api/session`, {
    data: { location: { directory: project }, agent: "build" },
  })
  const sessionID = ((await created.json()) as { data: { id: string } }).data.id
  await page.addInitScript(
    (values) => {
      window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
      window.localStorage.setItem("flupcode.serverUrl", JSON.stringify(values.engine))
      window.localStorage.setItem("flupcode.selectedSession", JSON.stringify(values.sessionID))
      window.localStorage.setItem("flupcode.agent", JSON.stringify("build"))
      // The stub model, named: the replies each spec scripts come from it and nowhere else.
      window.localStorage.setItem("flupcode.selectedModel", JSON.stringify({ providerID: "stub", id: "stub-model" }))
      window.localStorage.setItem("flupcode.permissionMode", JSON.stringify(values.mode))
      window.localStorage.setItem("flupcode.delivery", JSON.stringify(values.delivery))
    },
    { engine: ENGINE, sessionID, mode: options.mode, delivery: options.delivery ?? "steer" },
  )
  await page.goto("/")
  return sessionID
}

async function send(page: Page, text: string) {
  const input = page.locator(".fc-composer textarea.fc-input")
  await input.fill(text)
  await input.press("Enter")
}

test("a prompt is sent and the answer streams into the transcript", async ({ page, request }) => {
  await script(request, { type: "text", text: "Hello from OpenCode 2" })
  await openSession(page, request, { mode: "auto" })

  await send(page, "Say hello")
  await expect(page.locator(".fc-message-user").filter({ hasText: "Say hello" })).toBeVisible()
  await expect(page.locator(".fc-message-assistant").filter({ hasText: "Hello from OpenCode 2" })).toBeVisible()
  await expect(page.locator(".fc-message-pending")).toHaveCount(0)
})

test("a command waits for the reader's permission, and runs once allowed", async ({ page, request }) => {
  await script(
    request,
    { type: "tool", name: "shell", input: { command: "echo live-engine", description: "Say it" } },
    { type: "text", text: "The command said live-engine" },
  )
  await openSession(page, request, { mode: "manual" })

  await send(page, "Run the echo")
  const dock = page.locator(".fc-dock-permission")
  await expect(dock).toBeVisible()
  await expect(dock).toContainText("echo live-engine")
  await dock.getByRole("button", { name: /^Allow once|^Permitir una vez/ }).click()
  await expect(dock).toHaveCount(0)
  await expect(page.getByText("The command said live-engine")).toBeVisible()
})

test("a question from the agent is a form the reader answers, and the turn goes on", async ({ page, request }) => {
  const questions = [
    {
      question: "Which colour?",
      header: "Colour",
      options: [
        { label: "Blue", description: "Cold" },
        { label: "Red", description: "Warm" },
      ],
    },
  ]
  await script(request, { type: "tool", name: "question", input: { questions } }, { type: "text", text: "Blue it is" })
  await openSession(page, request, { mode: "auto" })

  await send(page, "Ask me a colour")
  const dock = page.locator(".fc-dock-question")
  await expect(dock).toContainText("Which colour?")
  await dock.getByRole("button", { name: /Blue/ }).click()
  await dock.getByRole("button", { name: /Respond|Responder/ }).click()
  await expect(dock).toHaveCount(0)
  await expect(page.getByText("Blue it is")).toBeVisible()
})

test("the MCP servers the engine runs are listed with their state", async ({ page, request }) => {
  await openSession(page, request, { mode: "auto" })

  await page
    .getByRole("button", { name: /Customize|Personalizar/ })
    .first()
    .click()
  const dialog = page.getByRole("dialog", { name: "Customize" })
  await dialog.getByRole("tab", { name: "MCP servers" }).click()
  const row = dialog.locator(".fc-mcp-row").filter({ hasText: "contract" })
  await expect(row).toBeVisible()
  await expect(row.locator(".fc-chip").first()).toHaveText("connected")
})

test("a prompt queued behind a running turn waits in the engine, outlives a reload and is cancelled there", async ({
  page,
  request,
}) => {
  await script(request, { type: "hang" })
  const sessionID = await openSession(page, request, { mode: "auto", delivery: "queue" })

  await send(page, "Take your time")
  await expect(page.locator(".fc-message-pending")).toBeVisible()
  await send(page, "Then this")
  const queued = page.locator(".fc-message-optimistic").filter({ hasText: "Then this" })
  await expect(queued.locator(".fc-message-queue-badge")).toHaveText(/Queued|En cola/)

  // The engine holds it, not the page: a reload reads it back from the session inbox.
  await page.reload()
  await expect(queued.locator(".fc-message-queue-badge")).toHaveText(/Queued|En cola/)

  await queued.getByRole("button", { name: /Cancel|Cancelar/ }).click()
  await expect(queued).toHaveCount(0)
  await expect
    .poll(
      async () => ((await (await request.get(`${ENGINE}/api/session/${sessionID}/inbox`)).json()) as { data: [] }).data,
    )
    .toEqual([])
  await request.post(`${ENGINE}/api/session/${sessionID}/interrupt`)
})

test("what OpenCode 2 removed is not offered", async ({ page, request }) => {
  await openSession(page, request, { mode: "auto" })
  await expect(page.locator(".fc-composer textarea.fc-input")).toBeVisible()

  await page
    .getByRole("button", { name: /^(Menu|Menú)$/ })
    .first()
    .click()
  const menu = page.getByRole("menu")
  await expect(menu.getByRole("menuitem", { name: /Fork|Bifurcar/ })).toBeVisible()
  await expect(menu.getByRole("menuitem", { name: /Share|Compartir|Stop sharing|Dejar de compartir/ })).toHaveCount(0)
})
