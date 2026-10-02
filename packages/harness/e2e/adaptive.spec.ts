import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_ad",
  projectID: "p",
  title: "Adaptive",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

/** The allowlist the server ships, so the panel draws exactly the switches it really has. */
const WRITABLE = [
  { path: "enabled", type: "boolean", confirmation: "none", guard: "env-disabled" },
  { path: "shadow", type: "boolean", confirmation: "none", guard: "none" },
  { path: "context.enabled", type: "boolean", confirmation: "none", guard: "none" },
  { path: "context.apply", type: "boolean", confirmation: "none", guard: "none", warning: "evaluation-gated" },
  {
    path: "learning.enabled",
    type: "boolean",
    confirmation: "required",
    guard: "none",
    warning: "learning-draft-egress",
  },
  { path: "relevance.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
  { path: "guardrails.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
  { path: "jev.enabled", type: "boolean", confirmation: "required", guard: "egress-allowlist" },
  { path: "models.*", type: "model", confirmation: "none", guard: "none", warning: "model-no-consent" },
  { path: "egress.providers.*.enabled", type: "boolean", confirmation: "required", guard: "egress-allowlist" },
  { path: "egress.providers.*.projects", type: "string-list", confirmation: "widening", guard: "none" },
  { path: "egress.providers.*.kinds", type: "kinds", confirmation: "widening", guard: "none" },
  { path: "retention.enabled", type: "boolean", confirmation: "required", guard: "none" },
  { path: "budget.monthlyTokens", type: "number", confirmation: "none", guard: "none" },
]

/** The registry the server serves (AH-C01), with the names the reader is shown. */
const MODELS = [
  {
    id: "jev",
    name: "Jev",
    locality: "remote",
    supports: ["completion", "skillRelevance", "contextItem", "skillReflection", "failure"],
    needsConsent: true,
    needsKey: true,
  },
  {
    id: "small-llm",
    name: "Small model (through the engine)",
    locality: "remote",
    supports: ["skillRelevance", "completion", "failure"],
    needsConsent: true,
    needsKey: false,
  },
]

/** What the legacy `jev.enabled` resolves to: every decision the server knows answered by Jev. */
const LEGACY_MODELS = {
  completion: "jev",
  skillRelevance: "jev",
  contextItem: "jev",
  skillReflection: "jev",
  failure: "jev",
}

type View = {
  effective: {
    enabled: boolean
    shadow: boolean
    context: { enabled: boolean; apply: boolean }
    learning: { enabled: boolean; maxInputChars: number }
    relevance: { enabled: boolean }
    guardrails: { enabled: boolean }
    jev: { enabled: boolean }
    models?: Record<string, string>
    egress: { providers: Record<string, { enabled: boolean; projects: string[]; kinds: Record<string, boolean> }> }
    retention: { enabled: boolean }
    budget: { monthlyTokens: number; hotReserveFraction: number }
  }
  source: Record<string, "env" | "block" | "default">
  env: { adaptiveDisabled: boolean; typesafeKeyPresent: boolean; typesafeKeySource?: "env" | "stored" | "none" }
  modelKeyStorable?: boolean
  runtime: { runtime: string; degraded: boolean; checkedAt: number; alerts?: unknown[] }
  capabilities: Record<string, unknown>
  canWrite: boolean
  writer: { path: string; exists: boolean }
  usage: { month: string; tokensSpent: number; calls: number; monthlyTokens: number; hotReserveFraction: number }
  writable: typeof WRITABLE
  egressProviders?: string[]
  models?: typeof MODELS
  learningDraft?: { model: string | null }
  learningClassifier?: { model: string | null; ready: boolean }
}

const view = (over: Partial<View> = {}): View => ({
  effective: {
    enabled: true,
    shadow: false,
    context: { enabled: true, apply: false },
    learning: { enabled: false, maxInputChars: 8000 },
    relevance: { enabled: false },
    guardrails: { enabled: false },
    jev: { enabled: false },
    models: {},
    egress: { providers: { jev: { enabled: false, projects: [], kinds: {} } } },
    retention: { enabled: false },
    budget: { monthlyTokens: 100_000, hotReserveFraction: 0.2 },
  },
  source: {},
  env: { adaptiveDisabled: false, typesafeKeyPresent: false },
  runtime: { runtime: "legacy", degraded: false, checkedAt: now },
  capabilities: {},
  canWrite: true,
  writer: { path: "/work/.config/opencode/opencode.jsonc", exists: true },
  usage: { month: "2026-09", tokensSpent: 0, calls: 0, monthlyTokens: 100_000, hotReserveFraction: 0.2 },
  writable: WRITABLE,
  models: MODELS,
  ...over,
})

type Calls = {
  asked: string[]
  patches: Array<{ path: string; body: unknown }>
  /** Every POST to a proposal review route (AH-A04), with its body. */
  reviews: Array<{ path: string; body: unknown }>
  /** The query of every read of the live guardrail advisory, to pin the session it names. */
  guardrailQueries: string[]
  /** The query of every guardrail read the mock has answered, so a slow one can be waited for. */
  guardrailAnswered: string[]
  /** Every engine POST, by path, to see a turn being stopped. */
  enginePosts: string[]
}

type Options = {
  capabilities?: string[]
  view?: View
  /** What the server answers a `PATCH` with; the default echoes the view with no warnings. */
  patchResponse?: (body: unknown) => {
    status?: number
    json: unknown
    /** The view the next `GET` should answer with, when the write changed something. */
    nextView?: View
  }
  decisions?: unknown[]
  /** The status the decision list answers with; read on every request, so a failure can recover. */
  decisionsStatus?: () => number
  explanation?: unknown
  /** Answers `GET /harness/adaptive/decisions/:id` per id, in place of `explanation`. */
  explain?: (id: string) => Promise<{ status?: number; json: unknown }> | { status?: number; json: unknown }
  plans?: unknown[]
  proposals?: unknown[]
  learnedSkills?: unknown[]
  /** What `GET /harness/adaptive/guardrails/status` answers per session; read on every tick, so a thunk. */
  guardrailsStatus?: (sessionID: string) => unknown
  /** How long the guardrail read of a session takes to answer, to race a session switch. */
  guardrailsDelay?: (sessionID: string) => number
  /** The sessions the engine reports as running; read on every poll, so a turn can end. */
  running?: () => string[]
  /** The session list; the default is the one "Adaptive" session. */
  sessions?: unknown[]
}

/**
 * Opens the harness against a mocked server and the engine, with no network at all. The harness
 * client only asks for the adaptive routes `/harness/health` announced, which is what the
 * "capability absent" tests lean on.
 */
async function openApp(page: Page, options: Options = {}) {
  const calls: Calls = { asked: [], patches: [], reviews: [], guardrailQueries: [], guardrailAnswered: [], enginePosts: [] }
  const capabilities = options.capabilities ?? []
  // The settings panel re-reads the view after every write, so the mock has to remember what the
  // last answer left behind; otherwise the panel would snap back to the pre-write state.
  let current = options.view ?? view()
  // A review changes the row the next list reads, so the mock keeps the proposals it was given.
  const proposals = (options.proposals ?? []).map((proposal) => ({ ...(proposal as Record<string, unknown>) }))
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_ad"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true, capabilities } } })
    if (url.pathname === "/harness/context")
      return route.fulfill({
        json: { data: { directory: "/work/demo", projectDirectory: "/work/demo", instructions: [] } },
      })
    if (url.pathname === "/harness/context/system-prompt") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/context/tool-uses") return route.fulfill({ json: { data: { tools: {} } } })
    if (url.pathname === "/harness/adaptive/config" && request.method() === "GET") {
      calls.asked.push("config")
      return route.fulfill({ json: { data: current } })
    }
    if (url.pathname === "/harness/adaptive/config" && request.method() === "PATCH") {
      const body: unknown = request.postDataJSON()
      calls.patches.push({ path: url.pathname, body })
      const reply = options.patchResponse?.(body) ?? { json: { data: current, warnings: [] } }
      const { nextView, ...response } = reply
      if (nextView) current = nextView
      return route.fulfill(response)
    }
    if (url.pathname === "/harness/adaptive/decisions") {
      calls.asked.push("decisions")
      const status = options.decisionsStatus?.() ?? 200
      if (status >= 400) return route.fulfill({ status, json: { error: `the audit is away (${status})` } })
      return route.fulfill({ json: { data: options.decisions ?? [] } })
    }
    if (url.pathname.startsWith("/harness/adaptive/decisions/")) {
      const id = decodeURIComponent(url.pathname.slice("/harness/adaptive/decisions/".length))
      if (options.explain) return Promise.resolve(options.explain(id)).then((reply) => route.fulfill(reply))
      return route.fulfill({ json: { data: options.explanation } })
    }
    if (url.pathname === "/harness/adaptive/plans") {
      calls.asked.push("plans")
      return route.fulfill({ json: { data: options.plans ?? [] } })
    }
    if (url.pathname === "/harness/adaptive/proposals") {
      calls.asked.push("proposals")
      return route.fulfill({ json: { data: proposals } })
    }
    const review = url.pathname.match(/^\/harness\/adaptive\/proposals\/([^/]+)\/(approve|reject)$/)
    if (review && request.method() === "POST") {
      calls.reviews.push({ path: url.pathname, body: request.postDataJSON() })
      const proposal = proposals.find((entry) => entry.id === decodeURIComponent(review[1]!))
      if (!proposal) return route.fulfill({ status: 404, json: { error: "Not found", code: "not_found" } })
      Object.assign(
        proposal,
        review[2] === "approve" ? { status: "promoted" } : { status: "rejected", reason: "human-rejected" },
      )
      return route.fulfill({ json: { data: proposal, changed: true } })
    }
    if (url.pathname === "/harness/adaptive/learned-skills") {
      calls.asked.push("learned")
      return route.fulfill({ json: { data: options.learnedSkills ?? [] } })
    }
    if (url.pathname === "/harness/adaptive/guardrails/status") {
      calls.asked.push("guardrails")
      calls.guardrailQueries.push(url.search)
      const sessionID = url.searchParams.get("sessionID") ?? ""
      return new Promise((resolve) => setTimeout(resolve, options.guardrailsDelay?.(sessionID) ?? 0))
        .then(() => route.fulfill({ json: { data: options.guardrailsStatus?.(sessionID) ?? null } }))
        .then(() => calls.guardrailAnswered.push(url.search))
        .catch(() => undefined)
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === "POST") calls.enginePosts.push(url.pathname)
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session")
      return route.fulfill({ json: { data: options.sessions ?? [session], cursor: {} } })
    if (url.pathname === "/api/session/active")
      return route.fulfill({
        json: { data: Object.fromEntries((options.running?.() ?? []).map((id) => [id, { type: "running" }])) },
      })
    if (/^\/api\/session\/[^/]+\/interrupt$/.test(url.pathname)) return route.fulfill({ json: {} })
    if (url.pathname === "/experimental/tool/ids") return route.fulfill({ json: ["bash", "read", "edit"] })
    if (url.pathname === "/api/skill")
      return route.fulfill({ json: { data: [{ name: "effect", description: "Work with Effect v4" }] } })
    if (url.pathname === "/mcp") return route.fulfill({ json: {} })
    if (url.pathname === "/config") return route.fulfill({ json: {} })
    if (/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/permission|question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  return calls
}

const openSettings = async (page: Page, section: string) => {
  await page
    .getByRole("button", { name: /Customize|Personalizar/ })
    .first()
    .click()
  const dialog = page.getByRole("dialog", { name: "Customize" })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("tab", { name: section }).click()
  return dialog
}

// ── FH-074 / AH-E01: the level is the kill switch ─────────────────────────────────────────────

/** The acting capabilities: a server that resolved the adaptive token announces them. */
const ACTING = ["adaptive-config", "adaptive-relevance", "adaptive-guardrails"]

const levels = (dialog: ReturnType<Page["getByRole"]>) => dialog.getByRole("radiogroup", { name: "Level" })

test("the level Off is the kill switch, and it never promises to stop loading learned skills", async ({ page }) => {
  const calls = await openApp(page, {
    capabilities: ["adaptive-config"],
    view: view({ source: { enabled: "block" }, effective: { ...view().effective, shadow: true } }),
    patchResponse: () => {
      const off = view({
        source: { enabled: "block" },
        effective: { ...view().effective, shadow: true, enabled: false },
      })
      return { json: { data: off, warnings: ["skills-still-load"] }, nextView: off }
    },
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  // The honest copy is there before anything is touched: learned skills keep loading.
  await expect(dialog.getByText(/skills already learned still load/)).toBeVisible()
  await expect(levels(dialog).getByRole("radio", { name: "Observe" })).toHaveAttribute("aria-checked", "true")
  await expect(dialog.getByText("Active · observing, nothing is changed")).toBeVisible()

  // Off writes only the master switch, as one plain patch: every child keeps its value.
  await levels(dialog).getByRole("radio", { name: "Off" }).click()
  await expect.poll(() => calls.patches.at(0)?.body).toEqual({ patch: { enabled: false }, confirm: false })

  // What the server answers is what is shown: the level, each card's reason, the learned skills note.
  await expect(levels(dialog).getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true")
  await expect(dialog.getByText("Inactive: the level is Off.")).toBeVisible()
  await expect(dialog.getByText("Learned skills still load from disk.")).toBeVisible()
  await dialog.locator("summary").filter({ hasText: "Advanced" }).click()
  await expect(dialog.getByRole("switch", { name: "Master switch" })).toHaveAttribute("aria-checked", "false")
  await expect(dialog.getByText(/Effective value:.*Off.*from the config file/)).toBeVisible()
  expect(calls.patches).toHaveLength(1)
})

test("switches that match no preset read as Custom, and each level travels as one nested patch", async ({ page }) => {
  const observe = view({ effective: { ...view().effective, shadow: true } })
  const calls = await openApp(page, {
    capabilities: ACTING,
    patchResponse: () => ({ json: { data: observe, warnings: [] }, nextView: observe }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  // Shadow off with context on is no preset: the level is derived as Custom.
  await expect(levels(dialog).getByRole("radio", { name: "Custom" })).toHaveAttribute("aria-checked", "true")
  await expect(dialog.getByText("Your own mix of the capabilities below.")).toBeVisible()

  await levels(dialog).getByRole("radio", { name: "Observe" }).click()
  await expect
    .poll(() => calls.patches.at(0)?.body)
    .toEqual({
      patch: {
        enabled: true,
        shadow: true,
        context: { enabled: true, apply: false },
        relevance: { enabled: false },
        guardrails: { enabled: false },
      },
      confirm: false,
    })
  await expect(levels(dialog).getByRole("radio", { name: "Observe" })).toHaveAttribute("aria-checked", "true")

  await levels(dialog).getByRole("radio", { name: "Assist" }).click()
  await expect
    .poll(() => calls.patches.at(1)?.body)
    .toEqual({
      patch: {
        enabled: true,
        shadow: true,
        context: { enabled: true, apply: false },
        relevance: { enabled: true },
        guardrails: { enabled: true },
      },
      confirm: false,
    })
  // A level never touches learning, the predictive model or retention, so no dialog ever opens.
  await expect(page.getByRole("dialog", { name: "Confirm change" })).toHaveCount(0)
})

test("without the acting token Assist and the acting cards are not offered, and say why", async ({ page }) => {
  const calls = await openApp(page, { capabilities: ["adaptive-config"] })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await expect(levels(dialog).getByRole("radio", { name: "Assist" })).toBeDisabled()
  await expect(
    dialog.getByText("Assist is not available: This server was started without permission to act on sessions."),
  ).toBeVisible()
  await expect(
    dialog.getByRole("radiogroup", { name: "Skill suggestion" }).getByRole("radio", { name: "Suggesting" }),
  ).toBeDisabled()
  await expect(
    dialog.getByRole("radiogroup", { name: "Loop warnings" }).getByRole("radio", { name: "Warning" }),
  ).toBeDisabled()
  expect(calls.patches).toHaveLength(0)
})

// ── AH-E01: the cards are drawn from the server's list ────────────────────────────────────────

test("loop warnings are a card from the server's list, and a choice travels as a patch", async ({ page }) => {
  const on = view({ effective: { ...view().effective, guardrails: { enabled: true } } })
  const calls = await openApp(page, {
    capabilities: ACTING,
    patchResponse: () => ({ json: { data: on, warnings: [] }, nextView: on }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await expect(
    dialog.getByText("Warns you when the agent repeats the same step. It never pauses the turn."),
  ).toBeVisible()
  const loops = dialog.getByRole("radiogroup", { name: "Loop warnings" })
  await expect(loops.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true")
  await loops.getByRole("radio", { name: "Warning" }).click()
  await expect
    .poll(() => calls.patches.at(0)?.body)
    .toEqual({ patch: { guardrails: { enabled: true } }, confirm: false })
  await expect(loops.getByRole("radio", { name: "Warning" })).toHaveAttribute("aria-checked", "true")
  await expect(dialog.getByText("Active · watching for repeated steps")).toBeVisible()
  expect(calls.patches).toHaveLength(1)
})

test("a leaf the server does not list is not drawn, and a newly listed switch reaches Advanced", async ({ page }) => {
  await openApp(page, {
    capabilities: ACTING,
    view: view({
      writable: [
        ...WRITABLE.filter((field) => field.path !== "guardrails.enabled" && field.path !== "retention.enabled"),
        { path: "toolTrim.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
      ],
    }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await expect(dialog.getByRole("radiogroup", { name: "Context" })).toBeVisible()
  await expect(dialog.getByRole("radiogroup", { name: "Loop warnings" })).toHaveCount(0)
  await dialog.locator("summary").filter({ hasText: "Data & budget" }).click()
  await expect(dialog.getByRole("switch", { name: "Clean up old history" })).toHaveCount(0)
  await dialog.locator("summary").filter({ hasText: "Advanced" }).click()
  await expect(dialog.getByRole("switch", { name: "Record decisions in the background" })).toBeVisible()
  await expect(dialog.getByRole("switch", { name: "Shorten long tool outputs (recoverable)" })).toBeVisible()
})

test("every inert card says why: the level, the runtime, missing permission, a missing key", async ({ page }) => {
  const base = view().effective
  await openApp(page, {
    capabilities: ACTING,
    view: view({
      runtime: { runtime: "v2", degraded: false, checkedAt: now },
      effective: {
        ...base,
        relevance: { enabled: true },
        learning: { enabled: true, maxInputChars: 8000 },
        jev: { enabled: true },
        models: LEGACY_MODELS,
      },
      learningDraft: { model: "openai/mini" },
      learningClassifier: { model: "jev", ready: false },
    }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await expect(dialog.getByText("Inactive: this engine's newer session runtime cannot run it yet.")).toBeVisible()
  // Learning is never inert for lack of permission: the built-in rules propose, and the card says so.
  await expect(
    dialog.getByText(
      "Active · proposing skills with built-in rules: the predictive model has no permission to review sessions",
    ),
  ).toBeVisible()
  // The predictive models' state is on its collapsed summary, so it is read without opening it: which
  // model answers each decision, by its name, and what it still waits for.
  await expect(dialog.getByText(/^Whether the task is finished: Jev \(needs permission\) · Which skills fit: Jev/)).toBeVisible()
  // No jargon at the first level: nothing the reader has to decode before opening a section.
  const firstLevel = (
    await dialog.locator(".fc-adaptive-level, .fc-adaptive-card, .fc-routines-notice").allInnerTexts()
  ).join("\n")
  expect(firstLevel).not.toMatch(/Jev|shadow|egress|token|FLUPCODE|[a-z]+\.[a-z]+\b/i)
})

// The probe has already answered for the engine running now, so the newest change says so instead of
// asking the reader to check by hand, and each change stands on its own line.
test("the engine changes since last looked are one per line, and the current one says the plugins answered", async ({
  page,
}) => {
  await openApp(page, {
    capabilities: ["adaptive-config", "adaptive-runtime-alerts"],
    view: view({
      runtime: {
        runtime: "legacy",
        degraded: false,
        checkedAt: now,
        alerts: [
          { kind: "engine-version-changed", from: "local", to: "1.18.33", at: now - 2 },
          { kind: "engine-version-changed", from: "1.18.33", to: "2.0.18", at: now - 1 },
        ],
      },
    }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")
  const notice = dialog.locator(".fc-routines-notice").filter({ hasText: "The engine changed since you last looked." })
  await notice.getByText("Details").click()
  const lines = notice.locator(".fc-adaptive-more .fc-settings-hint")
  await expect(lines).toHaveText([
    "The engine changed from version local to 1.18.33.",
    "The engine changed from version 1.18.33 to 2.0.18. FlupCode's plugins answered from it, so the adaptive features work there.",
  ])
  const [first, second] = await lines.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top))
  expect(second).toBeGreaterThan(first!)
})

test("the value gate's pause is shown as the predictive model's state", async ({ page }) => {
  await openApp(page, {
    capabilities: ["adaptive-config", "adaptive-voi"],
    view: view({
      env: { adaptiveDisabled: false, typesafeKeyPresent: true },
      effective: {
        ...view().effective,
        models: { completion: "jev" },
        egress: { providers: { jev: { enabled: true, projects: ["/work/demo"], kinds: { completion: true } } } },
      },
    }),
  })
  const gate = (kind: string) => ({
    kind,
    modelID: "jev",
    state: "paused",
    samples: 40,
    disagreements: 1,
    disagreementRate: 0.02,
    uplift: 0,
    valueUsd: 0,
    costUsd: 0.0021,
    latencySamples: 0,
  })
  await page.route("http://127.0.0.1:9097/harness/adaptive/voi", (route) =>
    route.fulfill({
      json: {
        data: {
          enabled: true,
          window: 100,
          minSamples: 20,
          epsilon: 0.01,
          explorationRate: 0.1,
          kinds: [gate("completion")],
        },
      },
    }),
  )
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await expect(dialog.getByText("Paused: it is not adding enough value").first()).toBeVisible()
  await dialog.locator("summary").filter({ hasText: "Predictive model" }).click()
  await expect(dialog.getByText("Paused: it does not help here")).toBeVisible()
  await dialog.locator("summary").filter({ hasText: "Data & budget" }).click()
  await expect(dialog.getByText("Predictive model cost over its recent decisions: $0.0021 (USD).")).toBeVisible()
})

test("retention asks for a confirmation before the write leaves; choosing a model does not, since it is not consent", async ({
  page,
}) => {
  const calls = await openApp(page, {
    capabilities: ["adaptive-config"],
    view: view({
      env: { adaptiveDisabled: false, typesafeKeyPresent: true },
      effective: {
        ...view().effective,
        egress: { providers: { jev: { enabled: true, projects: ["/work/demo"], kinds: { skillReflection: true } } } },
      },
    }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await dialog.locator("summary").filter({ hasText: "Data & budget" }).click()
  await dialog.getByRole("switch", { name: "Clean up old history" }).click()
  const confirm = page.getByRole("dialog", { name: "Confirm change" })
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText("Learned skills are never removed.")
  // Nothing is written until the dialog is confirmed.
  expect(calls.patches).toHaveLength(0)
  await confirm.getByRole("button", { name: "Write it" }).click()
  await expect.poll(() => calls.patches.at(0)?.body).toEqual({ patch: { retention: { enabled: true } }, confirm: true })

  // Choosing a model sends nothing by itself: what leaves the machine is the provider's consent, which
  // already asked. So the choice is written at once, without a dialog.
  await dialog.locator("summary").filter({ hasText: "Predictive model" }).click()
  await dialog.getByLabel("Whether a session is worth learning from", { exact: true }).selectOption({ label: "Jev" })
  await expect(page.getByRole("dialog", { name: "Confirm change" })).toHaveCount(0)
  await expect
    .poll(() => calls.patches.at(1)?.body)
    .toEqual({ patch: { models: { skillReflection: "jev" } }, confirm: false })
})

test("learning asks first, since its drafts leave the machine", async ({ page }) => {
  const calls = await openApp(page, {
    capabilities: ["adaptive-config"],
    view: view({
      effective: {
        ...view().effective,
        egress: { providers: { jev: { enabled: false, projects: ["/work/demo"], kinds: { skillReflection: true } } } },
      },
    }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await dialog.getByRole("radiogroup", { name: "Learning" }).getByRole("radio", { name: "Proposing" }).click()
  const confirm = page.getByRole("dialog", { name: "Confirm change" })
  await expect(confirm).toContainText("objective and evidence")
  expect(calls.patches).toHaveLength(0)
  await confirm.getByRole("button", { name: "Write it" }).click()
  await expect.poll(() => calls.patches.at(0)?.body).toEqual({ patch: { learning: { enabled: true } }, confirm: true })
})

test("without any permission Proposing can be chosen, and learning proposes with the built-in rules", async ({ page }) => {
  const off = view({ learningDraft: { model: "openai/mini" }, learningClassifier: { model: null, ready: false } })
  const on = { ...off, effective: { ...off.effective, learning: { enabled: true, maxInputChars: 8000 } } }
  const calls = await openApp(page, {
    capabilities: ["adaptive-config"],
    view: off,
    patchResponse: () => ({
      json: { data: on, warnings: ["learning-draft-egress", "classifier-no-consent"] },
      nextView: on,
    }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")
  const learning = dialog.getByRole("radiogroup", { name: "Learning" })

  await expect(learning.getByRole("radio", { name: "Proposing" })).toBeEnabled()
  await expect(dialog.getByText(/Proposing is not available/)).toHaveCount(0)
  await expect(dialog.getByText("Turning it on asks first. With the built-in rules, nothing leaves this machine.")).toBeVisible()
  await learning.getByRole("radio", { name: "Proposing" }).click()
  const confirm = page.getByRole("dialog", { name: "Confirm change" })
  await expect(confirm).toContainText("built-in rules on this machine, so nothing is sent")
  await confirm.getByRole("button", { name: "Write it" }).click()
  await expect.poll(() => calls.patches.at(0)?.body).toEqual({ patch: { learning: { enabled: true } }, confirm: true })

  await expect(
    dialog.getByText("Active · proposing skills with built-in rules: no predictive model is set to review sessions"),
  ).toBeVisible()
  await expect(
    dialog.getByText("The predictive model cannot review sessions, so skills are proposed with built-in rules on this machine."),
  ).toBeVisible()
})

// ── AH-E06: the selectors and the confirmation work from the keyboard ─────────────────────────

test("the level is one Tab stop, the arrows walk the levels that can be picked, and Space picks", async ({ page }) => {
  const observe = view({ effective: { ...view().effective, shadow: true } })
  const assist = view({
    effective: { ...observe.effective, relevance: { enabled: true }, guardrails: { enabled: true } },
  })
  const calls = await openApp(page, {
    capabilities: ACTING,
    view: observe,
    patchResponse: () => ({ json: { data: assist, warnings: [] }, nextView: assist }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")
  const group = levels(dialog)
  const radio = (name: string) => group.getByRole("radio", { name })

  // One Tab stop: only the picked level is in the tab order.
  await expect(radio("Observe")).toHaveAttribute("tabindex", "0")
  for (const other of ["Off", "Assist", "Custom"]) await expect(radio(other)).toHaveAttribute("tabindex", "-1")

  // The arrows move the focus without writing anything; Custom is only offered from a mix, so it is skipped.
  await radio("Observe").focus()
  await page.keyboard.press("ArrowRight")
  await expect(radio("Assist")).toBeFocused()
  await page.keyboard.press("ArrowRight")
  await expect(radio("Off")).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(radio("Assist")).toBeFocused()
  await page.keyboard.press("Home")
  await expect(radio("Off")).toBeFocused()
  await page.keyboard.press("End")
  await expect(radio("Assist")).toBeFocused()
  expect(calls.patches).toHaveLength(0)

  // Space picks the focused level, and the focus stays on it once the server answers.
  await page.keyboard.press("Space")
  await expect
    .poll(() => calls.patches.at(0)?.body)
    .toEqual({
      patch: {
        enabled: true,
        shadow: true,
        context: { enabled: true, apply: false },
        relevance: { enabled: true },
        guardrails: { enabled: true },
      },
      confirm: false,
    })
  await expect(radio("Assist")).toHaveAttribute("aria-checked", "true")
  await expect(radio("Assist")).toBeFocused()
  await expect(radio("Assist")).toHaveAttribute("tabindex", "0")
})

test("the confirmation takes the focus, Escape cancels it, and the focus goes back to the choice", async ({ page }) => {
  const calls = await openApp(page, {
    capabilities: ["adaptive-config"],
    view: view({
      effective: {
        ...view().effective,
        egress: { providers: { jev: { enabled: false, projects: ["/work/demo"], kinds: { skillReflection: true } } } },
      },
    }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")
  const learning = dialog.getByRole("radiogroup", { name: "Learning" })

  await learning.getByRole("radio", { name: "Off" }).focus()
  await page.keyboard.press("ArrowRight")
  await expect(learning.getByRole("radio", { name: "Proposing" })).toBeFocused()
  await page.keyboard.press("Enter")

  const confirm = page.getByRole("dialog", { name: "Confirm change" })
  await expect(confirm).toBeFocused()
  // The dialog is described by its consequence, which a screen reader reads with its name.
  await expect(confirm).toHaveAccessibleDescription(/objective and evidence/)
  // Tab stays inside the dialog.
  for (let step = 0; step < 4; step++) {
    await page.keyboard.press("Tab")
    expect(await confirm.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  }

  await page.keyboard.press("Escape")
  await expect(confirm).toHaveCount(0)
  await expect(learning.getByRole("radio", { name: "Proposing" })).toBeFocused()
  // Only the confirmation closed: the settings stay open, and nothing was written.
  await expect(dialog).toBeVisible()
  expect(calls.patches).toHaveLength(0)

  // Enter on Cancel cancels; it never confirms.
  await page.keyboard.press("Enter")
  await expect(confirm).toBeFocused()
  await confirm.getByRole("button", { name: "Cancel" }).focus()
  await page.keyboard.press("Enter")
  await expect(confirm).toHaveCount(0)
  expect(calls.patches).toHaveLength(0)
})

// ── AH-C03: consent per provider ─────────────────────────────────────────────────────────────

test("each remote provider has its own consent row, and a write names only that provider", async ({ page }) => {
  const calls = await openApp(page, {
    capabilities: ["adaptive-config"],
    view: view({
      egressProviders: ["jev", "small-llm"],
      effective: {
        ...view().effective,
        egress: {
          providers: {
            jev: { enabled: false, projects: ["/work/demo"], kinds: { completion: true } },
            "small-llm": { enabled: false, projects: [], kinds: {} },
          },
        },
      },
    }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")
  await dialog.locator("summary").filter({ hasText: "Predictive model" }).click()

  // Each provider is named as the server's registry names it; its id is only in the config file.
  await expect(dialog.getByText("Sharing with Jev")).toBeVisible()
  await expect(dialog.getByText("Sharing with Small model (through the engine)")).toBeVisible()
  await expect(dialog.getByText(/small-llm/)).toHaveCount(0)
  // The small model has no project and no decision yet, so its consent cannot be offered; Jev's can.
  await expect(dialog.getByRole("switch", { name: "Send data to Small model (through the engine)" })).toBeDisabled()
  // The older single switch is gone: models are chosen per decision.
  await expect(dialog.getByRole("switch", { name: "Use the predictive model" })).toHaveCount(0)

  // Consenting to Jev asks first, the dialog names Jev only, and the patch touches Jev only.
  await dialog.getByRole("switch", { name: "Send data to Jev" }).click()
  const confirm = page.getByRole("dialog", { name: "Confirm change" })
  await expect(confirm.getByText(/covers Jev only/)).toBeVisible()
  expect(calls.patches).toHaveLength(0)
  await confirm.getByRole("button", { name: "Write it" }).click()
  await expect
    .poll(() => calls.patches.at(0)?.body)
    .toEqual({ patch: { egress: { providers: { jev: { enabled: true } } } }, confirm: true })

  // A decision for the small model widens the small model's consent alone.
  await dialog.getByRole("switch", { name: "Which skills fit for Small model (through the engine)" }).click()
  await page.getByRole("dialog", { name: "Confirm change" }).getByRole("button", { name: "Write it" }).click()
  await expect
    .poll(() => calls.patches.at(1)?.body)
    .toEqual({ patch: { egress: { providers: { "small-llm": { kinds: { skillRelevance: true } } } } }, confirm: true })
})

test("FLUPCODE_ADAPTIVE_DISABLED=1 holds the level at Off and blocks every write that would turn it on", async ({
  page,
}) => {
  const calls = await openApp(page, {
    capabilities: ACTING,
    view: view({
      source: { enabled: "env" },
      env: { adaptiveDisabled: true, typesafeKeyPresent: false },
      effective: { ...view().effective, enabled: false },
    }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await expect(levels(dialog).getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true")
  await expect(levels(dialog).getByRole("radio", { name: "Observe" })).toBeDisabled()
  await expect(levels(dialog).getByRole("radio", { name: "Custom" })).toBeDisabled()
  await expect(dialog.getByText("Set by the environment: the level stays Off.")).toBeVisible()
  await expect(dialog.getByText("Inactive: set to Off by the environment.")).toBeVisible()
  await dialog.locator("summary").filter({ hasText: "Advanced" }).click()
  await expect(dialog.getByRole("switch", { name: "Master switch" })).toBeDisabled()
  await expect(dialog.getByText("Set by the environment (FLUPCODE_ADAPTIVE_DISABLED=1).")).toBeVisible()
  expect(calls.patches).toHaveLength(0)
})

// ── FH-071/072/073: read-only inspectors ──────────────────────────────────────────────────────

const decision = {
  id: "dec_1",
  kind: "completion",
  inputsHash: "h",
  stateSummary: {},
  answer: { complete: false },
  baselineAnswer: { complete: true },
  baselineRule: "default",
  provider: "typesafe",
  modelVersion: "m1",
  source: "model",
  degraded: true,
  degradedReason: "timeout",
  latencyMs: 1500,
  shadow: true,
  createdAt: now,
  updatedAt: now,
}

test("the decision audit paints the row and the explanation, and offers no action", async ({ page }) => {
  await openApp(page, {
    capabilities: ["adaptive-decisions"],
    decisions: [decision],
    explanation: {
      id: "dec_1",
      question: "Is this complete?",
      answer: { complete: false },
      baseline: { answer: { complete: true }, rule: "default" },
      why: "the provider timed out",
      source: "model",
      provider: "typesafe",
      modelVersion: "m1",
      providerID: "typesafe",
      costUsd: 0.0031,
      inputTokens: 812,
      latencyMs: 1500,
      degraded: true,
      degradedReason: "timeout",
      evidenceRefs: [],
      decidedAt: now,
    },
  })
  await page.goto("/decisions")

  await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeVisible()
  const row = page.locator(".fc-context-row", { hasText: "Is the task done" })
  await expect(row).toContainText("typesafe")
  await expect(row).toContainText("Built-in rules were used (the model took too long)")

  await row.click()
  const dialog = page.getByRole("dialog", { name: "Decision" })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("Is this complete?")
  await expect(dialog).toContainText("the provider timed out")
  await expect(dialog.getByText("Baseline")).toBeVisible()
  await expect(dialog).toContainText("$0.0031 · 812 input tokens")

  await expect(dialog).toContainText("Built-in rules were used (the model took too long)")

  // Reading only: there is no route that approves, merges or archives a decision.
  await expect(page.getByRole("button", { name: /Approve|Merge|Archive|Revive/i })).toHaveCount(0)

  // The dialog takes the focus as it opens, Escape closes it, and the focus returns to the row (AH-E06).
  await expect(dialog).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(row).toBeFocused()
})

const explanationOf = (id: string, question: string) => ({
  id,
  question,
  answer: { complete: false },
  baseline: { answer: { complete: true }, rule: "default" },
  why: "the provider timed out",
  source: "model",
  provider: "typesafe",
  latencyMs: 1500,
  degraded: false,
  evidenceRefs: [],
  decidedAt: now,
})

test("a 500 on the decision audit is said inline, and the app stays usable", async ({ page }) => {
  let status = 500
  await openApp(page, {
    capabilities: ["adaptive-decisions"],
    decisions: [decision],
    decisionsStatus: () => status,
  })
  await page.goto("/decisions")

  // The failure sits where the list would be, instead of the root boundary's startup screen.
  const alert = page.getByRole("alert").filter({ hasText: "The decision audit could not be read" })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText("the audit is away (500)")
  await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeVisible()
  await expect(page.getByText("No decisions recorded yet.")).toHaveCount(0)
  await expect(page.getByText("FlupCode couldn't start")).toHaveCount(0)

  // Still usable: asking again once the server is back paints the audit.
  status = 200
  await alert.getByRole("button", { name: "Try again" }).click()
  await expect(page.locator(".fc-context-row", { hasText: "Is the task done" })).toBeVisible()
  await expect(alert).toHaveCount(0)
  await expect(page.getByText("FlupCode couldn't start")).toHaveCount(0)
})

test("an explanation that fails is said inside the dialog, and another decision still opens", async ({ page }) => {
  await openApp(page, {
    capabilities: ["adaptive-decisions"],
    decisions: [decision, { ...decision, id: "dec_2", kind: "relevance" }],
    explain: (id) =>
      id === "dec_1"
        ? { status: 404, json: { error: "decision not found" } }
        : { json: { data: explanationOf(id, "Is this relevant?") } },
  })
  await page.goto("/decisions")

  await page.locator(".fc-context-row", { hasText: "Is the task done" }).click()
  const dialog = page.getByRole("dialog", { name: "Decision" })
  await expect(dialog.getByRole("alert")).toContainText("This decision could not be read")
  await expect(dialog).toContainText("decision not found")
  await dialog.getByRole("button", { name: "Close" }).click()

  await page.locator(".fc-context-row", { hasText: "relevance" }).click()
  await expect(dialog).toContainText("Is this relevant?")
  await expect(dialog.getByRole("alert")).toHaveCount(0)
})

test("the dialog reads the decision that is open, never the one before it", async ({ page }) => {
  let answerSecond: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    answerSecond = resolve
  })
  await openApp(page, {
    capabilities: ["adaptive-decisions"],
    decisions: [decision, { ...decision, id: "dec_2", kind: "relevance" }],
    explain: async (id) => {
      if (id === "dec_2") await held
      return { json: { data: explanationOf(id, id === "dec_1" ? "Is this complete?" : "Is this relevant?") } }
    },
  })
  await page.goto("/decisions")

  await page.locator(".fc-context-row", { hasText: "Is the task done" }).click()
  const dialog = page.getByRole("dialog", { name: "Decision" })
  await expect(dialog).toContainText("Is this complete?")
  await dialog.getByRole("button", { name: "Close" }).click()

  await page.locator(".fc-context-row", { hasText: "relevance" }).click()
  await expect(dialog).toContainText("dec_2")
  await expect(dialog).toContainText("Reading…")
  await expect(dialog).not.toContainText("Is this complete?")

  answerSecond()
  await expect(dialog).toContainText("Is this relevant?")
})

test("the context plan paints each disposition and reason, and offers no action", async ({ page }) => {
  await openApp(page, {
    capabilities: ["adaptive-context", "adaptive-config"],
    plans: [
      {
        id: "plan_1",
        objectiveHash: "h",
        entries: [
          {
            id: "file_1",
            kind: "file",
            score: 0.2,
            disposition: "archive",
            reason: "superseded",
            protected: false,
            tokens: 120,
          },
          {
            id: "obj_1",
            kind: "objective",
            score: 1,
            disposition: "keep",
            reason: "the objective",
            protected: true,
            tokens: 40,
          },
        ],
        scoreSource: "model",
        scoreProvider: "jev",
        degraded: false,
        applied: false,
        tokensBefore: 1200,
        tokensAfter: 1080,
        truncated: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
  })
  await page.goto("/context")

  const block = page.locator(".fc-context-plan")
  await expect(block.getByText("Context plan")).toBeVisible()
  await expect(block).toContainText("Observe only: nothing was filtered.")
  // The refinement names the model that made it, whichever it was (AH-C02), by its registry name.
  await expect(block).toContainText("Refined by Jev")
  await expect(block).toContainText("Archive · superseded")
  await expect(block).toContainText("Keep · the objective")
  await expect(page.getByRole("button", { name: /Approve|Merge|Archive|Revive/i })).toHaveCount(0)
})

test("the learned section paints the roster and the rejected proposal, read-only", async ({ page }) => {
  await openApp(page, {
    capabilities: ["adaptive-skills", "adaptive-proposals"],
    learnedSkills: [
      {
        name: "deploy-runbook",
        description: "How to deploy",
        learned: true,
        state: "probation",
        usage: { load: 2, view: 0, patch: 0, opportunities: 5 },
        sessionsSinceUse: 1,
        suggestArchive: false,
      },
      {
        name: "old-habit",
        description: "Something no session asks for",
        learned: true,
        state: "probation",
        usage: { load: 0, view: 0, patch: 0, opportunities: 20 },
        sessionsSinceUse: 20,
        suggestArchive: true,
      },
    ],
    proposals: [
      {
        id: "proposal:ep1",
        episodeID: "ep1",
        projectID: "/work/demo",
        intent: "add",
        name: "flaky-test-helper",
        evidenceRefs: [],
        status: "rejected",
        reason: "not reusable",
        createdAt: now,
        updatedAt: now,
      },
    ],
  })
  await page.goto("/skills")

  const learned = page.locator(".fc-skill-learned")
  await expect(learned.getByRole("heading", { name: "Learned", exact: true })).toBeVisible()
  await expect(learned).toContainText("deploy-runbook")
  await expect(learned).toContainText("Probation")
  // Real use, and the archive hint only on the skill that sat unused (AH-F02).
  await expect(learned).toContainText("Used in 2 of 5 sessions")
  await expect(learned.locator(".fc-skill-archive-hint")).toHaveCount(1)
  await expect(learned.locator(".fc-skill-archive-hint")).toHaveText("Unused in 20 sessions · Archive?")
  await expect(learned).toContainText("flaky-test-helper")
  await expect(learned).toContainText("Rejected")
  await expect(learned).toContainText("not reusable")

  // Without the review capability nothing is offered: no approve, edit, merge or archive control.
  await expect(page.getByRole("button", { name: /Approve|Merge|Archive|Revive|Edit skill/i })).toHaveCount(0)
})

test("a staged proposal is installed only after a person reads it and confirms (AH-A04)", async ({ page }) => {
  const calls = await openApp(page, {
    capabilities: ["adaptive-skills", "adaptive-proposals", "adaptive-proposals-review"],
    proposals: [
      {
        id: "proposal:ep2",
        episodeID: "ep2",
        projectID: "/work/demo",
        intent: "add",
        name: "parser-fix",
        description: "Use when a parser test fails",
        body: "## Steps\nRun the parser test alone first.",
        evidenceRefs: ["ep2"],
        status: "proposed",
        createdAt: now,
        updatedAt: now,
      },
    ],
  })
  await page.goto("/skills")

  const learned = page.locator(".fc-skill-learned")
  await expect(learned).toContainText("parser-fix")
  await expect(learned).toContainText("Proposed")
  await learned.getByRole("button", { name: "Approve" }).click()

  // The dialog shows exactly what the agent would load: name, description and the whole body.
  const dialog = page.getByRole("dialog", { name: "Review a learned skill" })
  await expect(dialog).toContainText("The agent will see it in every session of this project.")
  await expect(dialog).toContainText("parser-fix")
  await expect(dialog).toContainText("Use when a parser test fails")
  await expect(dialog).toContainText("Run the parser test alone first.")
  expect(calls.reviews).toEqual([])

  // Cancelling sends nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toHaveCount(0)
  expect(calls.reviews).toEqual([])

  await learned.getByRole("button", { name: "Approve" }).click()
  await page.getByRole("dialog", { name: "Review a learned skill" }).getByRole("button", { name: "Install" }).click()
  await expect(learned).toContainText("Promoted")
  expect(calls.reviews).toEqual([
    { path: "/harness/adaptive/proposals/proposal%3Aep2/approve", body: { confirm: true } },
  ])
  await expect(learned.getByRole("button", { name: /Approve|Reject/ })).toHaveCount(0)
})

// ── Capability absent: the surface is not offered, and no route is poked ──────────────────────

test("a server without adaptive-config shows no settings and is never asked for the route", async ({ page }) => {
  const calls = await openApp(page, { capabilities: [] })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await expect(dialog.getByText("This server does not have the adaptive settings.")).toBeVisible()
  expect(calls.asked).not.toContain("config")
})

test("a server without adaptive-decisions shows no audit and is never asked for it", async ({ page }) => {
  const calls = await openApp(page, { capabilities: [] })
  await page.goto("/decisions")

  await expect(page.getByText("This server does not have the decision audit.")).toBeVisible()
  expect(calls.asked).not.toContain("decisions")
})

// ── FH-062: the advisory guardrail banner ─────────────────────────────────────────────────────

const loopStatus = () => ({
  reason: "loop",
  repeatedCalls: 3,
  repeatedErrors: 0,
  tool: "bash",
  decisionID: "failure:ses_ad:bash:a",
  at: now,
})

const running = () => ["ses_ad"]

test("a server without adaptive-guardrails shows no banner and is never asked", async ({ page }) => {
  const calls = await openApp(page, { capabilities: [], running })
  await page.goto("/")

  await expect(page.locator(".fc-guardrail-banner")).toHaveCount(0)
  expect(calls.asked).not.toContain("guardrails")
})

test("a live loop paints the actionable banner, announced through a permanent live region", async ({ page }) => {
  const calls = await openApp(page, { capabilities: ["adaptive-guardrails"], guardrailsStatus: loopStatus, running })
  await page.goto("/")

  // The live region is there before any warning, so the screen reader hears it when text arrives.
  const live = page.locator('.fc-sr-only[role="status"]')
  await expect(live).toHaveCount(1)

  const banner = page.locator(".fc-guardrail-banner")
  await expect(banner).toBeVisible()
  await expect(banner).toContainText("Possible loop")
  await expect(banner).toContainText("3 identical calls to bash in a row")
  await expect(live).toHaveText("Possible loop: 3 identical calls to bash in a row")

  // The read names the session the panel has selected, not some other one.
  expect(calls.guardrailQueries[0]).toBe("?sessionID=ses_ad")

  // The close control meets the 32px hit target.
  const close = banner.getByRole("button", { name: "Dismiss" })
  const box = await close.boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(32)
  expect(box?.height).toBeGreaterThanOrEqual(32)

  await close.click()
  await expect(banner).toHaveCount(0)
  // The region stays mounted; only its text goes.
  await expect(live).toHaveCount(1)
  await expect(live).toHaveText("")
})

test("the surface with no live loop is read but paints no banner", async ({ page }) => {
  // With the feature off or the runtime off-legacy the server keeps the surface but projects null,
  // so the panel keeps asking while the turn runs and shows nothing.
  const calls = await openApp(page, { capabilities: ["adaptive-guardrails"], guardrailsStatus: () => null, running })
  await page.goto("/")

  await expect.poll(() => calls.asked).toContain("guardrails")
  await expect(page.locator(".fc-guardrail-banner")).toHaveCount(0)
})

test("a new loop with a new decisionID arms the banner again", async ({ page }) => {
  let current = loopStatus()
  await openApp(page, { capabilities: ["adaptive-guardrails"], guardrailsStatus: () => current, running })
  await page.goto("/")

  const banner = page.locator(".fc-guardrail-banner")
  await expect(banner).toBeVisible()
  await banner.getByRole("button", { name: "Dismiss" }).click()
  await expect(banner).toHaveCount(0)

  // The next read names a different loop, so the dismissal no longer applies.
  current = { ...loopStatus(), decisionID: "failure:ses_ad:bash:b" }
  await expect(banner).toBeVisible({ timeout: 10_000 })
})

// ── AH-E03: an actionable banner that only polls while it matters ────────────────────────────────

test("an idle session is never polled for guardrails", async ({ page }) => {
  const calls = await openApp(page, { capabilities: ["adaptive-guardrails"], guardrailsStatus: loopStatus })
  await page.goto("/")

  await expect(page.locator(".fc-session-row", { hasText: "Adaptive" }).first()).toBeVisible()
  // Longer than one polling interval: a single read would have landed by now.
  await page.waitForTimeout(6_000)
  expect(calls.guardrailQueries).toHaveLength(0)
  await expect(page.locator(".fc-guardrail-banner")).toHaveCount(0)
})

test("the polling stops when the turn ends and while the tab is hidden", async ({ page }) => {
  let busy = ["ses_ad"]
  const calls = await openApp(page, {
    capabilities: ["adaptive-guardrails"],
    guardrailsStatus: loopStatus,
    running: () => busy,
  })
  await page.goto("/")
  const banner = page.locator(".fc-guardrail-banner")
  await expect(banner).toBeVisible()

  // A hidden tab stops asking.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  const hidden = calls.guardrailQueries.length
  await page.waitForTimeout(6_000)
  expect(calls.guardrailQueries).toHaveLength(hidden)

  // Coming back asks again at once.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect.poll(() => calls.guardrailQueries.length).toBeGreaterThan(hidden)

  // The turn ends: the warning goes with it and nothing more is asked.
  busy = []
  await expect(banner).toHaveCount(0, { timeout: 10_000 })
  const ended = calls.guardrailQueries.length
  await page.waitForTimeout(6_000)
  expect(calls.guardrailQueries).toHaveLength(ended)
})

test("a slow answer for one session never paints its warning in the next one", async ({ page }) => {
  const other = { ...session, id: "ses_b", title: "Other" }
  const calls = await openApp(page, {
    capabilities: ["adaptive-guardrails"],
    sessions: [session, other],
    running: () => ["ses_ad", "ses_b"],
    // Only the first session has a loop, and its answer is slow enough to land after the switch.
    guardrailsStatus: (sessionID) => (sessionID === "ses_ad" ? loopStatus() : null),
    guardrailsDelay: (sessionID) => (sessionID === "ses_ad" ? 3_000 : 0),
  })
  await page.goto("/")

  await expect.poll(() => calls.guardrailQueries).toContain("?sessionID=ses_ad")
  await page.locator(".fc-session-row", { hasText: "Other" }).first().click()
  await expect(page.locator(".fc-session-row-active")).toContainText("Other")
  await expect.poll(() => calls.guardrailQueries).toContain("?sessionID=ses_b")

  // The slow answer for the first session lands while the second is open, and paints nothing.
  await expect.poll(() => calls.guardrailAnswered, { timeout: 10_000 }).toContain("?sessionID=ses_ad")
  // Checked once, not retried: a retrying assertion would pass once the next read for the second
  // session overwrote a wrongly painted warning.
  await page.waitForTimeout(500)
  expect(await page.locator(".fc-guardrail-banner").count()).toBe(0)
  expect(await page.locator('.fc-sr-only[role="status"]').textContent()).toBe("")

  // Back on the first session its own loop shows again.
  await page.locator(".fc-session-row", { hasText: "Adaptive" }).first().click()
  await expect(page.locator(".fc-guardrail-banner")).toBeVisible({ timeout: 10_000 })
})

test("View decision opens that decision, and Stop turn interrupts the running turn", async ({ page }) => {
  const calls = await openApp(page, {
    capabilities: ["adaptive-guardrails", "adaptive-decisions"],
    guardrailsStatus: loopStatus,
    running,
    decisions: [{ ...decision, id: "failure:ses_ad:bash:a", kind: "guardrails" }],
    explain: (id) => ({ json: { data: explanationOf(id, "Is this a loop?") } }),
  })
  await page.goto("/")

  const banner = page.locator(".fc-guardrail-banner")
  await banner.getByRole("button", { name: "Stop turn" }).click()
  await expect.poll(() => calls.enginePosts).toContain("/api/session/ses_ad/interrupt")

  await banner.getByRole("button", { name: "View decision" }).click()
  await expect(page).toHaveURL(/\/decisions\?decision=/)
  const dialog = page.getByRole("dialog", { name: "Decision" })
  await expect(dialog).toContainText("failure:ses_ad:bash:a")
  await expect(dialog).toContainText("Is this a loop?")
})

// ── The predictive model's setup, in order, and its write-only key ─────────────────────────────

/** Merges a nested patch into a view the way the server's writer would, arrays replaced whole. */
const applyPatch = (target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    [...new Set([...Object.keys(target), ...Object.keys(patch)])].map((key) => {
      const next = patch[key]
      const before = target[key]
      if (next === undefined) return [key, before]
      if (typeof next === "object" && next !== null && !Array.isArray(next))
        return [
          key,
          applyPatch(
            typeof before === "object" && before !== null ? (before as Record<string, unknown>) : {},
            next as Record<string, unknown>,
          ),
        ]
      return [key, next]
    }),
  )

/** A settings server that keeps what it was told: the config writes and the model key's status. */
async function keyServer(page: Page, start: View) {
  const state = { view: start, puts: [] as unknown[], deletes: [] as unknown[] }
  await page.route("http://127.0.0.1:9097/harness/adaptive/config", (route) => {
    const request = route.request()
    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as { patch: Record<string, unknown> }
      state.view = { ...state.view, effective: applyPatch(state.view.effective, body.patch) as View["effective"] }
    }
    return route.fulfill({ json: { data: state.view, warnings: [] } })
  })
  await page.route("http://127.0.0.1:9097/harness/adaptive/model-key", (route) => {
    const request = route.request()
    const body = request.postDataJSON() as unknown
    if (request.method() === "PUT") state.puts.push(body)
    if (request.method() === "DELETE") state.deletes.push(body)
    const source = request.method() === "PUT" ? "stored" : "none"
    state.view = {
      ...state.view,
      env: { adaptiveDisabled: false, typesafeKeyPresent: source === "stored", typesafeKeySource: source },
    }
    return route.fulfill({ json: { data: { source, storable: true } } })
  })
  return state
}

const confirmWrite = async (page: Page) => {
  const confirm = page.getByRole("dialog", { name: "Confirm change" })
  await confirm.getByRole("button", { name: "Write it" }).click()
  await expect(confirm).toBeHidden()
}

test("Jev is chosen for a decision, and its row says what it still needs until consent and the key are in place; the key never comes back", async ({
  page,
}) => {
  const KEY = "test-key-not-real-0001"
  await openApp(page, { capabilities: ["adaptive-config", "adaptive-model-key"] })
  const server = await keyServer(
    page,
    view({ egressProviders: ["jev"], modelKeyStorable: true, env: { adaptiveDisabled: false, typesafeKeyPresent: false, typesafeKeySource: "none" } }),
  )
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")
  await expect(dialog.locator("summary").filter({ hasText: "Predictive model" })).toContainText("Not configured")
  await dialog.locator("summary").filter({ hasText: "Predictive model" }).click()

  const choice = dialog.getByLabel("Whether the task is finished", { exact: true })
  const project = dialog.getByLabel("Project path for Jev")
  const decision = dialog.getByRole("switch", { name: "Whether the task is finished for Jev" })
  const send = dialog.getByRole("switch", { name: "Send data to Jev" })
  const keyField = dialog.getByLabel("Predictive model key")

  // The order the reader follows: what answers each decision, then Jev's own section — projects,
  // decisions, sending data and, only because Jev needs one, its key.
  const tops = await Promise.all([choice, project, decision, send, keyField].map(async (entry) => (await entry.boundingBox())!.y))
  expect(tops).toEqual([...tops].sort((a, b) => a - b))

  // Choosing Jev is written at once; its row then says everything it still waits for, by name.
  await expect(choice).toHaveValue("")
  await choice.selectOption({ label: "Jev" })
  await expect(choice).toHaveValue("jev")
  const missing = (text: string) => dialog.getByText(text, { exact: true })
  await expect(
    missing("Missing: a project, this decision allowed for Jev, sending data to Jev turned on, and the model key"),
  ).toBeVisible()
  await expect(dialog.locator("summary").filter({ hasText: "Predictive model" })).toContainText(
    "Whether the task is finished: Jev (needs permission)",
  )

  await project.fill("/work/demo")
  await dialog.getByRole("button", { name: "Add project" }).click()
  await confirmWrite(page)
  await decision.click()
  await confirmWrite(page)
  await expect(missing("Missing: sending data to Jev turned on and the model key")).toBeVisible()
  await expect(send).toBeEnabled()
  await send.click()
  await confirmWrite(page)
  await expect(missing("Missing: the model key")).toBeVisible()
  await expect(dialog.locator("summary").filter({ hasText: "Predictive model" })).toContainText(
    "Whether the task is finished: Jev (key missing)",
  )

  // The key: a password field, saved only after a confirmation that says what happens to it.
  await expect(keyField).toHaveAttribute("type", "password")
  await keyField.fill(KEY)
  await dialog.getByRole("button", { name: "Save key" }).click()
  const confirm = page.getByRole("dialog", { name: "Save the key?" })
  await expect(confirm).toContainText("stored encrypted on this machine")
  await expect(confirm).toContainText("used only for calls to the predictive model's provider")
  expect(server.puts).toHaveLength(0)
  await confirm.getByRole("button", { name: "Save key" }).click()
  await expect.poll(() => server.puts).toEqual([{ key: KEY, confirm: true }])

  await expect(dialog.getByText("Key saved")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Change" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Remove", exact: true }).last()).toBeVisible()
  await expect(keyField).toHaveCount(0)
  // Never echoed: not in the markup, and not in any field's value.
  expect(await page.content()).not.toContain(KEY)
  expect(await page.evaluate((key) => [...document.querySelectorAll("input")].some((input) => input.value.includes(key)), KEY)).toBe(
    false,
  )

  // Nothing is missing any more, and the summary says Jev answers that decision.
  await expect(dialog.getByText(/^Missing:/)).toHaveCount(0)
  await expect(dialog.locator("summary").filter({ hasText: "Predictive model" })).toContainText(
    "Whether the task is finished: Jev",
  )
  await expect(dialog.locator("summary").filter({ hasText: "Predictive model" })).not.toContainText("key missing")
})

test("the small model is chosen for a decision by its name, with no key field of its own", async ({ page }) => {
  await openApp(page, { capabilities: ["adaptive-config"] })
  const server = await keyServer(
    page,
    view({
      egressProviders: ["jev", "small-llm"],
      effective: {
        ...view().effective,
        egress: {
          providers: {
            jev: { enabled: false, projects: [], kinds: {} },
            "small-llm": { enabled: true, projects: ["/work/demo"], kinds: { skillRelevance: true } },
          },
        },
      },
    }),
  )
  const patches: unknown[] = []
  page.on("request", (request) => {
    if (request.url().endsWith("/harness/adaptive/config") && request.method() === "PATCH") patches.push(request.postDataJSON())
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")
  await dialog.locator("summary").filter({ hasText: "Predictive model" }).click()

  // Only the models that can answer a decision are offered for it: which context to keep is Jev's alone.
  const fits = dialog.getByLabel("Which skills fit", { exact: true })
  await expect(fits.locator("option")).toHaveText(["None (built-in rules)", "Jev", "Small model (through the engine)"])
  await expect(dialog.getByLabel("Which context to keep", { exact: true }).locator("option")).toHaveText([
    "None (built-in rules)",
    "Jev",
  ])
  // Every decision a registered model can answer has its selector, not only the first four.
  await expect(dialog.getByLabel("Why a step failed", { exact: true }).locator("option")).toHaveText([
    "None (built-in rules)",
    "Jev",
    "Small model (through the engine)",
  ])
  await expect(dialog.getByRole("switch", { name: "Why a step failed for Small model (through the engine)" })).toBeVisible()

  await fits.selectOption({ label: "Small model (through the engine)" })
  await expect.poll(() => patches).toEqual([{ patch: { models: { skillRelevance: "small-llm" } }, confirm: false }])
  await expect(fits).toHaveValue("small-llm")
  // Its consent covers this decision and it needs no key, so its row waits for nothing.
  await expect(dialog.locator(".fc-settings-row", { has: page.getByRole("combobox", { name: "Which skills fit", exact: true }) })).not.toContainText("Missing:")
  await expect(dialog.locator("summary").filter({ hasText: "Predictive model" })).toContainText(
    "Which skills fit: Small model (through the engine)",
  )
  // The key belongs to Jev's section alone: one key row, never one for the small model.
  await expect(dialog.getByText("Model key", { exact: true })).toHaveCount(1)

  // Back to none.
  await fits.selectOption({ label: "None (built-in rules)" })
  await expect.poll(() => patches.at(1)).toEqual({ patch: { models: { skillRelevance: null } }, confirm: false })
  expect(server.puts).toHaveLength(0)
})

test("a config on the older single switch shows Jev on every decision, and the first choice saves one per decision", async ({
  page,
}) => {
  await openApp(page, { capabilities: ["adaptive-config"] })
  await keyServer(
    page,
    view({
      env: { adaptiveDisabled: false, typesafeKeyPresent: true, typesafeKeySource: "env" },
      effective: {
        ...view().effective,
        jev: { enabled: true },
        models: LEGACY_MODELS,
        egress: { providers: { jev: { enabled: true, projects: ["/work/demo"], kinds: { completion: true, skillRelevance: true } } } },
      },
    }),
  )
  const patches: unknown[] = []
  page.on("request", (request) => {
    if (request.url().endsWith("/harness/adaptive/config") && request.method() === "PATCH") patches.push(request.postDataJSON())
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")
  await dialog.locator("summary").filter({ hasText: "Predictive model" }).click()

  for (const label of ["Whether the task is finished", "Which skills fit", "Which context to keep", "Whether a session is worth learning from"])
    await expect(dialog.getByLabel(label, { exact: true })).toHaveValue("jev")
  await expect(dialog.getByText(/come from the older single switch/)).toBeVisible()

  await dialog.getByLabel("Which skills fit", { exact: true }).selectOption({ label: "Small model (through the engine)" })
  // One patch: every decision written explicitly, the one chosen changed, and the older switch off.
  await expect
    .poll(() => patches)
    .toEqual([
      {
        patch: {
          models: { ...LEGACY_MODELS, skillRelevance: "small-llm" },
          jev: { enabled: false },
        },
        confirm: false,
      },
    ])
  await expect(dialog.getByText(/come from the older single switch/)).toHaveCount(0)
  await expect(dialog.getByLabel("Whether the task is finished", { exact: true })).toHaveValue("jev")
  await expect(dialog.getByLabel("Which skills fit", { exact: true })).toHaveValue("small-llm")
})

test("a key set by the environment is only reported, with no field to change it", async ({ page }) => {
  await openApp(page, {
    capabilities: ["adaptive-config", "adaptive-model-key"],
    view: view({ modelKeyStorable: true, env: { adaptiveDisabled: false, typesafeKeyPresent: true, typesafeKeySource: "env" } }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")
  await dialog.locator("summary").filter({ hasText: "Predictive model" }).click()
  await expect(dialog.getByText("Key set by the environment.")).toBeVisible()
  await expect(dialog.getByLabel("Predictive model key")).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Change" })).toHaveCount(0)
})

test("a saved key can be removed, after a confirmation that says what removing it means", async ({ page }) => {
  await openApp(page, { capabilities: ["adaptive-config", "adaptive-model-key"] })
  const server = await keyServer(
    page,
    view({ modelKeyStorable: true, env: { adaptiveDisabled: false, typesafeKeyPresent: true, typesafeKeySource: "stored" } }),
  )
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")
  await dialog.locator("summary").filter({ hasText: "Predictive model" }).click()
  await expect(dialog.getByText("Key saved")).toBeVisible()
  // Change opens an empty field: the saved value is never put back into it.
  await dialog.getByRole("button", { name: "Change" }).click()
  await expect(dialog.getByLabel("Predictive model key")).toHaveValue("")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await dialog.getByText("Key saved").locator("..").getByRole("button", { name: "Remove" }).click()
  const confirm = page.getByRole("dialog", { name: "Remove the key?" })
  await expect(confirm).toContainText("built-in rules decide")
  await confirm.getByRole("button", { name: "Remove" }).click()
  await expect.poll(() => server.deletes).toEqual([{ confirm: true }])
  await expect(dialog.getByLabel("Predictive model key")).toBeVisible()
})

test("without a vault the panel says the key cannot be stored here and points to the environment", async ({ page }) => {
  await openApp(page, {
    capabilities: ["adaptive-config", "adaptive-model-key"],
    view: view({ modelKeyStorable: false, env: { adaptiveDisabled: false, typesafeKeyPresent: false, typesafeKeySource: "none" } }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")
  await dialog.locator("summary").filter({ hasText: "Predictive model" }).click()
  await expect(dialog.getByText(/cannot store the key.*TYPESAFE_API_KEY/)).toBeVisible()
  await expect(dialog.getByLabel("Predictive model key")).toHaveCount(0)
})
