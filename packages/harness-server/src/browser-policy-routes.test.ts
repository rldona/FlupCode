import { afterEach, describe, expect, test } from "bun:test"
import { createActionApprover } from "./action-approval"
import { createActionRunner } from "./action-runner"
import { createHarnessHandler } from "./api"
import { BrowserError } from "./browser"
import type { BrowserRuntime } from "./browser"
import { createBrowserPolicy } from "./browser-policy"
import { unavailableActionCredentialResolver } from "./action-credentials"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

/**
 * No route drives a page without `BrowserPolicy.decide` (BU-01).
 *
 * The browser here is a recording stand-in: every call is written down and refused, so a route that
 * reached it is visible whatever it then answered. The runner, the approver and the policy are the
 * real ones.
 */

const UI = "ui-token"
const PLUGIN = "plugin-token"

/**
 * What acts on a page. Opening a blank window on the project's profile (`start`, `login`) and the
 * person's own controls of a window an action opened (its frame, picking an element, pause, take
 * over, stop) are the app's, behind its token, and act on no page by themselves.
 */
const ACTING = new Set(["navigate", "click", "type", "submit", "upload", "text", "snapshot", "waitFor", "screenshot"])

const PROFILES = {
  post: {
    tool: "post_message",
    kind: "browser",
    origin: "https://example.com",
    inputs: { text: "string" },
    steps: [{ goto: "{{origin}}/" }, { fill: { selector: "#message", text: "{{text}}" } }, { click: "#send" }],
  },
  pay: {
    tool: "pay_invoice",
    kind: "browser",
    origin: "https://www.paypal.com",
    steps: [{ goto: "{{origin}}/" }],
    sensitive: false,
  },
}

const repositories: SqliteRoutineRepository[] = []
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()))

function subject(answer: () => Promise<string | undefined> = async () => undefined) {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  const calls: string[] = []
  const browser = new Proxy({} as BrowserRuntime, {
    get: (_target, name) => (...args: unknown[]) => {
      calls.push(String(name))
      if (name === "get") return undefined
      if (name === "close" || name === "endRun" || name === "stop") return Promise.resolve(false)
      if (name === "beginRun" || name === "protect") return undefined
      throw new BrowserError("no_session", 404, `stand-in browser: ${String(name)}(${args.length})`)
    },
  })
  const policy = createBrowserPolicy(repository)
  const actions = createActionRunner({
    browser,
    policy,
    repository,
    credentials: unavailableActionCredentialResolver,
    loadProfiles: () => ({ configDir: "/nonexistent", profiles: PROFILES, scopes: {}, guardDirs: {} }),
  })
  const asked: string[] = []
  const handler = createHarnessHandler(repository, new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" }), {
    token: UI,
    pluginToken: PLUGIN,
    browser,
    actions,
    browserPolicy: policy,
    actionApprover: createActionApprover({
      actions,
      policy,
      ask: (request) => {
        asked.push(request.title)
        return answer()
      },
    }),
  })
  const call = (token: string, method: string, path: string, body?: unknown) =>
    handler(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-flupcode-session": "ses_1" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const acted = () => calls.filter((name) => ACTING.has(name))
  const drives = () => calls.filter((name) => name === "start")
  return { repository, policy, calls, acted, drives, asked, call }
}

const run = { action: "post", sessionID: "ses_1", project: "/work/demo", inputs: { text: "hello" } }

describe("no route drives a page without the policy (BU-01)", () => {
  test("every browser and action route, with either token and any body, leaves the page alone", async () => {
    const { call, acted } = subject()
    const browserRoutes = [
      "start", "login", "clear", "session", "viewport", "waitFor", "screenshot", "capture", "frame", "close",
      "pause", "resume", "takeover", "stop", "navigate", "click", "type", "submit", "text", "snapshot", "upload",
    ]
    const bodies = [
      {},
      { project: "/work/demo", selector: "#x", url: "https://example.com", text: "hi", x: 0.5, y: 0.5, width: 800, height: 600 },
    ]
    for (const token of [UI, PLUGIN])
      for (const route of browserRoutes)
        for (const method of ["GET", "POST"])
          for (const body of bodies) {
            const response = await call(token, method, `/harness/browser/${route}`, method === "POST" ? body : undefined)
            if (token === PLUGIN) expect([route, response.status]).toEqual([route, 403])
          }
    const runs = [
      run,
      { ...run, approval: "made-up" },
      { ...run, approval: "" },
      { ...run, permit: { origin: "https://example.com", tier: "sensitive" } },
      { ...run, action: "pay", inputs: {} },
      { ...run, action: undefined, profile: PROFILES.post },
      // The editor's preview is the person's: on a blocked site the policy refuses it too.
      { ...run, action: "pay", inputs: {}, preview: true },
      { ...run, action: undefined, inputs: {}, profile: PROFILES.pay, preview: true },
      { ...run, dryRun: true },
    ]
    for (const token of [UI, PLUGIN]) {
      for (const body of runs) await call(token, "POST", "/harness/actions/run", body)
      await call(token, "POST", "/harness/actions/approve", { ...run, action: "pay" })
      await call(token, "POST", "/harness/actions/validate", { id: "post", profile: PROFILES.post })
      await call(token, "GET", "/harness/actions")
    }
    expect(acted()).toEqual([])
  })

  test("the plugins' token cannot read or revoke the grants, nor read the audit", async () => {
    const { call, policy } = subject()
    policy.answer({ origin: "https://example.com", tier: "read" }, "always")
    const [grant] = policy.grants()
    expect((await call(PLUGIN, "GET", "/harness/browser-policy/grants")).status).toBe(403)
    expect((await call(PLUGIN, "DELETE", `/harness/browser-policy/grants/${grant!.id}`)).status).toBe(403)
    expect((await call(PLUGIN, "GET", "/harness/browser-policy/audit")).status).toBe(403)
    expect(policy.grants()).toHaveLength(1)
    expect((await (await call(UI, "GET", "/harness/browser-policy/grants")).json()).data).toMatchObject([
      { origin: "https://example.com", tier: "read", scope: "always" },
    ])
    expect((await call(UI, "DELETE", `/harness/browser-policy/grants/${grant!.id}`)).status).toBe(200)
    expect(policy.grants()).toEqual([])
  })
})

describe("the acceptance criteria (BU-01)", () => {
  test("an interact action on an ungranted site asks, and does nothing until it is answered", async () => {
    let answer: (value: string) => void = () => {}
    const { call, acted, drives, asked, repository } = subject(() => new Promise((resolve) => (answer = resolve)))
    const pending = call(PLUGIN, "POST", "/harness/actions/approve", run)
    await Bun.sleep(20)
    expect(asked).toEqual(["Allow the agent to click and type on example.com?"])
    // While the question is open, nothing the plugin can send drives the page.
    expect((await call(PLUGIN, "POST", "/harness/actions/run", run)).status).toBe(403)
    expect([...acted(), ...drives()]).toEqual([])
    answer("once")
    const verdict = (await (await pending).json()).data
    expect([verdict.approved, typeof verdict.approval]).toEqual([true, "string"])
    await call(PLUGIN, "POST", "/harness/actions/run", { ...run, approval: verdict.approval })
    // The drive began only now, with the permit the answer gave; the stand-in browser then refused it.
    expect(drives()).toEqual(["start"])
    expect(
      repository
        .listBrowserAudit({ sessionID: "ses_1" })
        .reverse()
        .map((entry) => [entry.kind, entry.decision ?? entry.outcome, entry.tier]),
    ).toEqual([
      ["decision", "ask", "interact"],
      ["answer", "allow", "interact"],
      ["action", "failed", "interact"],
    ])
  })

  test("the editor's preview is decided by the policy before the browser opens", async () => {
    const { call, drives, repository } = subject()
    const blocked = await call(UI, "POST", "/harness/actions/run", { ...run, action: "pay", inputs: {}, preview: true })
    expect(blocked.status).toBe(403)
    expect((await blocked.json()).code).toBe("blocked")
    expect(drives()).toEqual([])
    await call(UI, "POST", "/harness/actions/run", { ...run, preview: true })
    expect(drives()).toEqual(["start"])
    expect(
      repository
        .listBrowserAudit({ sessionID: "ses_1" })
        .reverse()
        .map((entry) => [entry.kind, entry.decision ?? entry.outcome, entry.origin, entry.reason]),
    ).toEqual([
      ["decision", "deny", "https://www.paypal.com", "www.paypal.com is a payment or banking site, which the agent never acts on"],
      ["decision", "ask", "https://example.com", "Nothing allows this on this site yet"],
      ["answer", "allow", "https://example.com", "asked for in the app"],
      ["action", "failed", "https://example.com", "stand-in browser: start(1)"],
    ])
  })
})
