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
    guard: "egress-allowlist",
    warning: "learning-draft-egress",
  },
  { path: "relevance.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
  { path: "guardrails.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
  { path: "jev.enabled", type: "boolean", confirmation: "required", guard: "egress-allowlist" },
  { path: "egress.providers.*.enabled", type: "boolean", confirmation: "required", guard: "egress-allowlist" },
  { path: "egress.providers.*.projects", type: "string-list", confirmation: "widening", guard: "none" },
  { path: "egress.providers.*.kinds", type: "kinds", confirmation: "widening", guard: "none" },
  { path: "retention.enabled", type: "boolean", confirmation: "required", guard: "none" },
  { path: "budget.monthlyTokens", type: "number", confirmation: "none", guard: "none" },
]

type View = {
  effective: {
    enabled: boolean
    shadow: boolean
    context: { enabled: boolean; apply: boolean }
    learning: { enabled: boolean; maxInputChars: number }
    relevance: { enabled: boolean }
    guardrails: { enabled: boolean }
    jev: { enabled: boolean }
    egress: { providers: Record<string, { enabled: boolean; projects: string[]; kinds: Record<string, boolean> }> }
    retention: { enabled: boolean }
    budget: { monthlyTokens: number; hotReserveFraction: number }
  }
  source: Record<string, "env" | "block" | "default">
  env: { adaptiveDisabled: boolean; typesafeKeyPresent: boolean }
  runtime: { runtime: string; degraded: boolean; checkedAt: number }
  capabilities: Record<string, unknown>
  canWrite: boolean
  writer: { path: string; exists: boolean }
  usage: { month: string; tokensSpent: number; calls: number; monthlyTokens: number; hotReserveFraction: number }
  writable: typeof WRITABLE
  egressProviders?: string[]
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
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session")
      return route.fulfill({ json: { data: options.sessions ?? [session], cursor: {} } })
    if (url.pathname === "/api/session/active")
      return route.fulfill({
        json: { data: Object.fromEntries((options.running?.() ?? []).map((id) => [id, { type: "running" }])) },
      })
    if (url.pathname === "/session/status")
      return route.fulfill({
        json: Object.fromEntries((options.running?.() ?? []).map((id) => [id, { type: "busy" }])),
      })
    if (/^\/session\/[^/]+\/abort$/.test(url.pathname)) return route.fulfill({ json: true })
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

// ── FH-074: the kill switch ────────────────────────────────────────────────────────────────────

test("the kill switch turns the harness off and never promises to stop loading learned skills", async ({ page }) => {
  const calls = await openApp(page, {
    capabilities: ["adaptive-config"],
    view: view({ source: { enabled: "block" } }),
    patchResponse: () => {
      const off = view({ effective: { ...view().effective, enabled: false } })
      return { json: { data: off, warnings: ["skills-still-load"] }, nextView: off }
    },
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  // The honest copy is there before anything is touched: learned skills keep loading.
  await expect(dialog.getByText("Learned skills still load from disk.").first()).toBeVisible()

  const master = dialog.getByRole("switch", { name: "Adaptive decisions" })
  await expect(master).toHaveAttribute("aria-checked", "true")
  await expect(dialog.getByText(/Effective value:.*On/)).toBeVisible()

  // Turning it off is the kill switch action, and it travels as a plain partial patch.
  await master.click()
  await expect.poll(() => calls.patches.at(0)?.body).toEqual({ patch: { enabled: false }, confirm: false })

  // What the server answers is what is shown, including the reminder about learned skills.
  await expect(master).toHaveAttribute("aria-checked", "false")
  await expect(dialog.getByText(/Effective value:.*Off/)).toBeVisible()
  await expect(dialog.getByText("Learned skills still load from disk.").first()).toBeVisible()
})

// ── FH-070: settings, provenance and warnings ─────────────────────────────────────────────────

test("the switches show the effective value and where it comes from, and a write travels as a patch", async ({
  page,
}) => {
  const calls = await openApp(page, {
    capabilities: ["adaptive-config"],
    view: view({ source: { enabled: "block", "context.enabled": "block", shadow: "default" } }),
    patchResponse: () => ({
      json: { data: view({ source: { enabled: "block" } }), warnings: ["evaluation-gated"] },
    }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  // Effective value and provenance, not the raw block.
  await expect(dialog.getByText(/Effective value:.*On.*from the config file/)).toBeVisible()
  await expect(dialog.getByRole("switch", { name: "Shadow" })).toHaveAttribute("aria-checked", "false")
  await expect(dialog.getByRole("switch", { name: "Context selection" })).toHaveAttribute("aria-checked", "true")

  // A switch without a guard or a confirmation writes the nested leaf it names.
  await dialog.getByRole("switch", { name: "Apply the context plan" }).click()
  await expect.poll(() => calls.patches.at(0)?.body).toEqual({ patch: { context: { apply: true } }, confirm: false })

  // The warning the server travels beside the write is shown, not swallowed.
  await expect(
    dialog.getByText("Applying is configured, but promotion waits for the offline evaluation."),
  ).toBeVisible()
})

// ── Guardas de egress, relevance y retención ──────────────────────────────────────────────────

test("relevance is not offered without the acting token, and says why", async ({ page }) => {
  const calls = await openApp(page, { capabilities: ["adaptive-config"] })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  const relevance = dialog.getByRole("switch", { name: "Relevance", exact: true })
  await expect(relevance).toBeDisabled()
  // Relevance and loop warnings share the guard, so each row carries the same reason.
  await expect(dialog.getByText("This switch needs the acting token, which this server does not have.")).toHaveCount(2)
  await expect(dialog.getByRole("switch", { name: "Loop warnings" })).toBeDisabled()
  expect(calls.patches).toHaveLength(0)
})

test("loop warnings are drawn from the server's list and toggle through a patch", async ({ page }) => {
  const on = view({ effective: { ...view().effective, guardrails: { enabled: true } } })
  const calls = await openApp(page, {
    capabilities: ["adaptive-config", "adaptive-guardrails"],
    patchResponse: () => ({ json: { data: on, warnings: [] }, nextView: on }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await expect(
    dialog.getByText("Warns when the agent repeats the same tool call; never pauses the turn."),
  ).toBeVisible()
  const guardrails = dialog.getByRole("switch", { name: "Loop warnings" })
  await expect(guardrails).toHaveAttribute("aria-checked", "false")
  await guardrails.click()
  await expect
    .poll(() => calls.patches.at(0)?.body)
    .toEqual({ patch: { guardrails: { enabled: true } }, confirm: false })
  await expect(guardrails).toHaveAttribute("aria-checked", "true")
  expect(calls.patches).toHaveLength(1)
})

test("a leaf the server does not list is not drawn", async ({ page }) => {
  await openApp(page, {
    capabilities: ["adaptive-config", "adaptive-guardrails"],
    view: view({
      writable: WRITABLE.filter((field) => field.path !== "guardrails.enabled" && field.path !== "retention.enabled"),
    }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await expect(dialog.getByRole("switch", { name: "Shadow" })).toBeVisible()
  await expect(dialog.getByRole("switch", { name: "Loop warnings" })).toHaveCount(0)
  await expect(dialog.getByRole("switch", { name: "Retention" })).toHaveCount(0)
})

test("with the master off, its children say they are inactive, and Jev says the key is missing", async ({ page }) => {
  await openApp(page, {
    capabilities: ["adaptive-config"],
    view: view({ effective: { ...view().effective, enabled: false, shadow: true } }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await expect(dialog.getByRole("switch", { name: "Shadow" })).toHaveAttribute("aria-checked", "true")
  await expect(dialog.getByText("Inactive: the master switch is off.").first()).toBeVisible()
  await expect(dialog.getByText("Key missing: decisions fall back to built-in rules.")).toBeVisible()
})

test("retention and Jev ask for a confirmation before the write leaves", async ({ page }) => {
  const calls = await openApp(page, {
    capabilities: ["adaptive-config"],
    view: view({
      effective: {
        ...view().effective,
        egress: { providers: { jev: { enabled: true, projects: ["/work/demo"], kinds: { skillReflection: true } } } },
      },
    }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await dialog.getByRole("switch", { name: "Retention" }).click()
  const confirm = page.getByRole("dialog", { name: "Confirm change" })
  await expect(confirm).toBeVisible()
  // Nothing is written until the dialog is confirmed.
  expect(calls.patches).toHaveLength(0)
  await confirm.getByRole("button", { name: "Write it" }).click()
  await expect
    .poll(() => calls.patches.at(0)?.body)
    .toEqual({
      patch: { retention: { enabled: true } },
      confirm: true,
    })

  // Jev carries the same confirmation, and its egress guard is met by Jev's consent already there.
  await dialog.getByRole("switch", { name: "Jev", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Confirm change" })).toBeVisible()
  await page.getByRole("dialog", { name: "Confirm change" }).getByRole("button", { name: "Write it" }).click()
  await expect.poll(() => calls.patches.at(1)?.body).toEqual({ patch: { jev: { enabled: true } }, confirm: true })
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

  await expect(dialog.getByText("Egress consent: jev")).toBeVisible()
  await expect(dialog.getByText("Egress consent: small-llm")).toBeVisible()
  // small-llm has no project and no kind yet, so its consent cannot be offered; Jev's can.
  await expect(dialog.getByRole("switch", { name: "Send data to small-llm" })).toBeDisabled()
  await expect(dialog.getByRole("switch", { name: "Jev", exact: true })).toBeDisabled()

  // Consenting to Jev asks first, the dialog names Jev only, and the patch touches Jev only.
  await dialog.getByRole("switch", { name: "Send data to jev" }).click()
  const confirm = page.getByRole("dialog", { name: "Confirm change" })
  await expect(confirm.getByText(/covers jev only/)).toBeVisible()
  expect(calls.patches).toHaveLength(0)
  await confirm.getByRole("button", { name: "Write it" }).click()
  await expect
    .poll(() => calls.patches.at(0)?.body)
    .toEqual({ patch: { egress: { providers: { jev: { enabled: true } } } }, confirm: true })

  // A kind for small-llm widens small-llm's consent alone.
  await dialog.getByRole("switch", { name: "skillRelevance for small-llm" }).click()
  await page.getByRole("dialog", { name: "Confirm change" }).getByRole("button", { name: "Write it" }).click()
  await expect
    .poll(() => calls.patches.at(1)?.body)
    .toEqual({ patch: { egress: { providers: { "small-llm": { kinds: { skillRelevance: true } } } } }, confirm: true })
})

test("FLUPCODE_ADAPTIVE_DISABLED=1 disables the master switch and blocks the write", async ({ page }) => {
  const calls = await openApp(page, {
    capabilities: ["adaptive-config"],
    view: view({
      source: { enabled: "env" },
      env: { adaptiveDisabled: true, typesafeKeyPresent: false },
      effective: { ...view().effective, enabled: false },
    }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await expect(dialog.getByRole("switch", { name: "Adaptive decisions" })).toBeDisabled()
  await expect(dialog.getByText("Disabled by FLUPCODE_ADAPTIVE_DISABLED=1")).toBeVisible()
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
  await expect(row).toContainText("Degraded")

  await row.click()
  const dialog = page.getByRole("dialog", { name: "Decision" })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("Is this complete?")
  await expect(dialog).toContainText("the provider timed out")
  await expect(dialog.getByText("Baseline")).toBeVisible()
  await expect(dialog).toContainText("$0.0031 · 812 input tokens")

  // Reading only: there is no route that approves, merges or archives a decision.
  await expect(page.getByRole("button", { name: /Approve|Merge|Archive|Revive/i })).toHaveCount(0)
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
    capabilities: ["adaptive-context"],
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
  await expect(block).toContainText("Shadow only: nothing was filtered.")
  // The refinement names the model that made it, whichever it was (AH-C02).
  await expect(block).toContainText("Refined by jev")
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
  risk: "ALLOW",
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

test("View decision opens that decision, and Stop turn aborts the running turn", async ({ page }) => {
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
  await expect.poll(() => calls.enginePosts).toContain("/session/ses_ad/abort")

  await banner.getByRole("button", { name: "View decision" }).click()
  await expect(page).toHaveURL(/\/decisions\?decision=/)
  const dialog = page.getByRole("dialog", { name: "Decision" })
  await expect(dialog).toContainText("failure:ses_ad:bash:a")
  await expect(dialog).toContainText("Is this a loop?")
})
