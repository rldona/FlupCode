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
  { path: "learning.enabled", type: "boolean", confirmation: "none", guard: "egress-allowlist" },
  { path: "relevance.enabled", type: "boolean", confirmation: "none", guard: "adaptive-token" },
  { path: "jev.enabled", type: "boolean", confirmation: "required", guard: "egress-allowlist" },
  { path: "egress.projects", type: "string-list", confirmation: "widening", guard: "none" },
  { path: "egress.kinds", type: "kinds", confirmation: "widening", guard: "none" },
  { path: "retention.enabled", type: "boolean", confirmation: "required", guard: "none" },
  { path: "budget.monthlyTokens", type: "number", confirmation: "none", guard: "none" },
]

type View = {
  effective: {
    enabled: boolean
    shadow: boolean
    context: { enabled: boolean; apply: boolean }
    learning: { enabled: boolean }
    relevance: { enabled: boolean }
    jev: { enabled: boolean }
    egress: { projects: string[]; kinds: Record<string, boolean> }
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
}

const view = (over: Partial<View> = {}): View => ({
  effective: {
    enabled: true,
    shadow: false,
    context: { enabled: true, apply: false },
    learning: { enabled: false },
    relevance: { enabled: false },
    jev: { enabled: false },
    egress: { projects: [], kinds: {} },
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
  explanation?: unknown
  plans?: unknown[]
  proposals?: unknown[]
  learnedSkills?: unknown[]
}

/**
 * Opens the harness against a mocked server and the engine, with no network at all. The harness
 * client only asks for the adaptive routes `/harness/health` announced, which is what the
 * "capability absent" tests lean on.
 */
async function openApp(page: Page, options: Options = {}) {
  const calls: Calls = { asked: [], patches: [] }
  const capabilities = options.capabilities ?? []
  // The settings panel re-reads the view after every write, so the mock has to remember what the
  // last answer left behind; otherwise the panel would snap back to the pre-write state.
  let current = options.view ?? view()
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_ad"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/harness/health")
      return route.fulfill({ json: { data: { healthy: true, capabilities } } })
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
      return route.fulfill({ json: { data: options.decisions ?? [] } })
    }
    if (url.pathname.startsWith("/harness/adaptive/decisions/"))
      return route.fulfill({ json: { data: options.explanation } })
    if (url.pathname === "/harness/adaptive/plans") {
      calls.asked.push("plans")
      return route.fulfill({ json: { data: options.plans ?? [] } })
    }
    if (url.pathname === "/harness/adaptive/proposals") {
      calls.asked.push("proposals")
      return route.fulfill({ json: { data: options.proposals ?? [] } })
    }
    if (url.pathname === "/harness/adaptive/learned-skills") {
      calls.asked.push("learned")
      return route.fulfill({ json: { data: options.learnedSkills ?? [] } })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
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
  await expect(dialog.getByText("Relevance needs the acting token, which this server does not have.")).toBeVisible()
  expect(calls.patches).toHaveLength(0)
})

test("retention and Jev ask for a confirmation before the write leaves", async ({ page }) => {
  const calls = await openApp(page, {
    capabilities: ["adaptive-config"],
    view: view({ effective: { ...view().effective, egress: { projects: ["/work/demo"], kinds: { skillReflection: true } } } }),
  })
  await page.goto("/")
  const dialog = await openSettings(page, "Adaptive")

  await dialog.getByRole("switch", { name: "Retention" }).click()
  const confirm = page.getByRole("dialog", { name: "Confirm change" })
  await expect(confirm).toBeVisible()
  // Nothing is written until the dialog is confirmed.
  expect(calls.patches).toHaveLength(0)
  await confirm.getByRole("button", { name: "Write it" }).click()
  await expect.poll(() => calls.patches.at(0)?.body).toEqual({
    patch: { retention: { enabled: true } },
    confirm: true,
  })

  // Jev carries the same confirmation, and its egress guard is met by the allowlist already there.
  await dialog.getByRole("switch", { name: "Jev" }).click()
  await expect(page.getByRole("dialog", { name: "Confirm change" })).toBeVisible()
  await page.getByRole("dialog", { name: "Confirm change" }).getByRole("button", { name: "Write it" }).click()
  await expect.poll(() => calls.patches.at(1)?.body).toEqual({ patch: { jev: { enabled: true } }, confirm: true })
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
  source: "jev",
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
      source: "jev",
      provider: "typesafe",
      modelVersion: "m1",
      latencyMs: 1500,
      degraded: true,
      degradedReason: "timeout",
      evidenceRefs: [],
      decidedAt: now,
    },
  })
  await page.goto("/decisions")

  await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeVisible()
  const row = page.locator(".fc-context-row", { hasText: "completion" })
  await expect(row).toContainText("typesafe")
  await expect(row).toContainText("Degraded")

  await row.click()
  const dialog = page.getByRole("dialog", { name: "Decision" })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("Is this complete?")
  await expect(dialog).toContainText("the provider timed out")
  await expect(dialog.getByText("Baseline")).toBeVisible()

  // Reading only: there is no route that approves, merges or archives a decision.
  await expect(page.getByRole("button", { name: /Approve|Merge|Archive|Revive/i })).toHaveCount(0)
})

test("the context plan paints each disposition and reason, and offers no action", async ({ page }) => {
  await openApp(page, {
    capabilities: ["adaptive-context"],
    plans: [
      {
        id: "plan_1",
        objectiveHash: "h",
        entries: [
          { id: "file_1", kind: "file", score: 0.2, disposition: "archive", reason: "superseded", protected: false, tokens: 120 },
          { id: "obj_1", kind: "objective", score: 1, disposition: "keep", reason: "the objective", protected: true, tokens: 40 },
        ],
        scoreSource: "deterministic",
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

  // Read-only by design: no approve, edit, merge or archive control exists here.
  await expect(page.getByRole("button", { name: /Approve|Merge|Archive|Revive|Edit skill/i })).toHaveCount(0)
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
