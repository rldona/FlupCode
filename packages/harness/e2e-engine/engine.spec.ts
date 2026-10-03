import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * The app against a real OpenCode 2 engine (V2-43): no mocked routes, every answer is the engine's.
 * `fixture.ts` serves it on port 4187, through FlupCode's engine proxy, with the stub model, whose
 * next replies each spec scripts.
 */
const ENGINE = "http://127.0.0.1:4187"
/** The harness's usage ledger, filled from the engine's transcripts (UL-06). */
const LEDGER = "http://127.0.0.1:4188"
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

  await page.locator(".fc-profile-button").click()
  await page.locator(".fc-menu").getByText(/^(Settings|Configuración)$/).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })
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

  // The badge shows at once, while the prompt is still on its way: only once the engine lists it in the
  // session inbox is it the engine's to hold, and a reload before then would cancel the send.
  await expect
    .poll(
      async () =>
        ((await (await request.get(`${ENGINE}/api/session/${sessionID}/inbox`)).json()) as { data: [] }).data.length,
    )
    .toBe(1)
  // The engine holds it, not the page: a reload reads it back from the session inbox.
  await page.reload()
  await expect(queued.locator(".fc-message-queue-badge")).toHaveText(/Queued|En cola/, { timeout: 15_000 })

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

// UL-06: the meter's session figure is the usage ledger's, the same number the Cost screen and the
// run card read. The ledger is filled from what the engine recorded for each step, so it is checked
// against the harness's own answer for the session; the title the engine also bills is not a step
// and is not in it (see "Hallazgos", UL-02/UL-03), so the engine's `SessionInfo.cost` can be higher.
test("the context meter's session cost is the usage ledger's", async ({ page, request }) => {
  await script(request, { type: "text", text: "First answer" }, { type: "text", text: "Second answer" })
  await page.addInitScript((ledger) => {
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify(ledger))
  }, LEDGER)
  const sessionID = await openSession(page, request, { mode: "auto" })

  await send(page, "One")
  await expect(page.locator(".fc-message-assistant").filter({ hasText: "First answer" })).toBeVisible()
  await expect(page.locator(".fc-message-pending")).toHaveCount(0)
  await send(page, "Two")
  await expect(page.locator(".fc-message-assistant").filter({ hasText: "Second answer" })).toBeVisible()
  await expect(page.locator(".fc-message-pending")).toHaveCount(0)

  // Both steps reach the ledger once the session is idle and the reconciler has read it.
  type Bucket = { events: number; money: Array<{ billing: string; usd: number }> }
  const report = async () =>
    ((await (await request.get(`${LEDGER}/harness/usage/sessions/${sessionID}`)).json()) as {
      data: { total: Bucket }
    }).data.total
  await expect.poll(async () => (await report()).events, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  const total = await report()
  const usd = total.money.filter((line) => line.billing !== "subscription").reduce((sum, line) => sum + line.usd, 0)
  expect(usd).toBeGreaterThan(0)
  const engineCost = ((await (await request.get(`${ENGINE}/api/session/${sessionID}`)).json()) as {
    data: { cost: number }
  }).data.cost
  // Never more than the engine billed: the ledger has every step and nothing twice.
  expect(usd).toBeLessThanOrEqual(engineCost + 1e-9)

  await page.locator(".fc-context-button").click()
  const session = page.locator(".fc-context-spend .fc-context-row").filter({ hasText: /^(Session|Sesión)/ })
  const figure = usd < 0.01 ? `~$${usd.toFixed(4)}` : `~$${usd.toFixed(2)}`
  await expect(session.locator(".fc-cost-figure")).toHaveText(figure)
})

// TI-04: the terminal on OpenCode 2's own PTY. What a reader does with it: type a command, read
// what it printed. On the 1.x routes this panel printed a JSON parse error and never connected.
test("the terminal runs a command typed into it and shows what it printed", async ({ page, request }) => {
  await openSession(page, request, { mode: "auto" })
  await page.getByRole("button", { name: "Terminal" }).click()
  const terminal = page.locator(".fc-terminal")
  await expect(terminal.locator(".xterm")).toBeVisible()
  await expect(terminal).not.toContainText("terminal error")

  await terminal.click()
  // Arithmetic, so what is checked is the shell's answer and not the echo of the line typed.
  await page.keyboard.type("echo flup-$((6 * 7))")
  await page.keyboard.press("Enter")
  await expect(terminal.locator(".xterm-rows")).toContainText("flup-42", { timeout: 15_000 })

  // The panel's size reaches the shell, and a new size does too.
  const size = async () => {
    await page.keyboard.type('echo "size=$(stty size | tr " " x)"')
    await page.keyboard.press("Enter")
    const rows = terminal.locator(".xterm-rows")
    await expect(rows).toContainText(/size=\d+x\d+/)
    return ((await rows.textContent()) ?? "").match(/size=(\d+x\d+)/g)!.at(-1)!
  }
  const before = await size()
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: viewport.width - 200, height: viewport.height - 150 })
  await expect.poll(size).not.toBe(before)
  await page.setViewportSize(viewport)

  // Closing the panel removes the PTY from the engine.
  const project = ((await (await request.get(`${CONTROL}/__fixture`)).json()) as { project: string }).project
  const ptys = async () =>
    ((await (await request.get(`${ENGINE}/api/pty`, { headers: { "x-opencode-directory": encodeURIComponent(project) } })).json()) as {
      data: unknown[]
    }).data.length
  expect(await ptys()).toBe(1)
  await page.getByRole("button", { name: "Terminal" }).click()
  await expect.poll(ptys).toBe(0)
})

/** Everything the engine sent the model in its last chat request, as one string. */
const lastModelRequest = async (request: APIRequestContext) =>
  JSON.stringify(((await (await request.get(`${CONTROL}/__fixture/requests`)).json()) as unknown[]).at(-1))

// UX-05: what the reader points at reaches the model. A file chip goes as a file part the engine reads
// itself, an artifact chip as the artifact's content, both resolved on send by the harness. Before,
// `@file` and `@artifact:` were text the engine passed on as text.
test("a file chip and an artifact chip reach the model as their contents", async ({ page, request }) => {
  const project = ((await (await request.get(`${CONTROL}/__fixture`)).json()) as { project: string }).project
  writeFileSync(join(project, "chip-notes.txt"), "CHIP-FILE-7f3a: the port is 4096\n")
  const created = await request.post(`${LEDGER}/harness/artifacts`, {
    data: { kind: "report", title: "Live report", producer: "harness", content: "CHIP-ARTIFACT-91c2: all green", directory: project },
  })
  expect(created.ok()).toBe(true)
  await script(request, { type: "text", text: "Read both" })
  await page.addInitScript((ledger) => {
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify(ledger))
  }, LEDGER)
  await openSession(page, request, { mode: "auto" })

  const input = page.locator(".fc-composer textarea.fc-input")
  await input.fill("@chip-notes")
  await page.locator(".fc-command-item").filter({ hasText: "chip-notes.txt" }).click({ timeout: 20_000 })
  await input.fill("@Live")
  await page.locator(".fc-command-item").filter({ hasText: "Live report" }).click()
  const chips = page.locator(".fc-composer .fc-composer-chip")
  await expect(chips).toHaveCount(2)
  await expect(chips.filter({ hasText: /Missing|Falta/ })).toHaveCount(0)

  await send(page, "Use what I pointed at")
  await expect(page.locator(".fc-message-assistant").filter({ hasText: "Read both" })).toBeVisible()
  const sent = await lastModelRequest(request)
  expect(sent).toContain("Use what I pointed at")
  expect(sent).toContain("CHIP-FILE-7f3a: the port is 4096")
  expect(sent).toContain("CHIP-ARTIFACT-91c2: all green")
  // Not the refs: the contents.
  expect(sent).not.toContain("@chip-notes.txt")
  expect(sent).not.toContain("@artifact:")
})

// UX-05: a terminal selection, on the engine's own PTY, goes to the model as a quoted block.
test("a terminal selection becomes a chip the model receives", async ({ page, request }) => {
  await script(request, { type: "text", text: "Saw the output" })
  await openSession(page, request, { mode: "auto" })
  await page.getByRole("button", { name: "Terminal" }).click()
  const terminal = page.locator(".fc-terminal")
  await expect(terminal.locator(".xterm")).toBeVisible()
  await terminal.click()
  await page.keyboard.type("echo chipselect$((6 * 7))")
  await page.keyboard.press("Enter")
  const row = terminal.locator(".xterm-rows > div").filter({ hasText: /^chipselect42\s*$/ })
  await expect(row).toBeVisible({ timeout: 15_000 })
  // xterm takes the mouse on its screen layer, over the rows: dragging across the line selects it.
  const box = (await row.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 1, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, y, { steps: 8 })
  await page.mouse.move(box.x + box.width - 2, y, { steps: 8 })
  await page.mouse.up()

  await page.getByRole("button", { name: /Add to the message|Añadir al mensaje/ }).click()
  const chip = page.locator(".fc-composer .fc-composer-chip")
  await expect(chip).toContainText("Terminal")
  await expect(chip).toContainText("chipselect42")

  await send(page, "What did it print?")
  await expect(page.locator(".fc-message-assistant").filter({ hasText: "Saw the output" })).toBeVisible()
  expect(await lastModelRequest(request)).toContain("[Terminal selection]\\n```\\nchipselect42\\n```")
})
