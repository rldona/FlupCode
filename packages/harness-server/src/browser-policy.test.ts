import { afterEach, describe, expect, test } from "bun:test"
import { BROWSER_TIERS, blockedSite, createBrowserPolicy, profileTier, stepTier } from "./browser-policy"
import type { BrowserTier } from "./browser-policy"
import { SqliteRoutineRepository } from "./repository"
import type { BrowserAllowRule } from "./types"

const repositories: SqliteRoutineRepository[] = []
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()))

const subject = () => {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  return { repository, policy: createBrowserPolicy(repository) }
}

const site = "https://example.com"
const decisions = (policy: ReturnType<typeof createBrowserPolicy>, input: { sessionId?: string; rules?: BrowserAllowRule[]; action?: string; origin?: string } = {}) =>
  Object.fromEntries(BROWSER_TIERS.map((tier) => [tier, policy.decide({ origin: site, tier, ...input }).decision]))

describe("tiers", () => {
  test("a recipe step's tier", () => {
    expect([
      { goto: "/" },
      { waitFor: "#x" },
      { assert: { selector: "#x" } },
      { screenshot: "x" },
      { fill: { selector: "#x" } },
      { click: "#x" },
      { submit: { selector: "form" } },
      { upload: { selector: "#f", from: "{{image}}" } },
    ].map(stepTier)).toEqual(["navigate", "read", "read", "read", "interact", "interact", "sensitive", "sensitive"])
  })

  test("an action's tier is its highest step, raised by a credential, a marked step or a marked read", () => {
    expect(profileTier({ steps: [{ goto: "/" }], sensitive: false })).toBe("navigate")
    expect(profileTier({ steps: [{ goto: "/" }, { click: "#x" }], sensitive: true })).toBe("interact")
    expect(profileTier({ steps: [{ goto: "/" }, { submit: { selector: "f" } }], sensitive: true })).toBe("sensitive")
    expect(profileTier({ steps: [{ goto: "/" }, { fill: { selector: "#u" } }], credential: "site", sensitive: true })).toBe("sensitive")
    expect(profileTier({ steps: [{ goto: "/", sensitive: true }], sensitive: true })).toBe("sensitive")
    expect(profileTier({ steps: [{ goto: "/" }], sensitive: true })).toBe("sensitive")
  })
})

describe("the default-deny list", () => {
  test("names payment, banking and sign-in sites and their subdomains, nothing else", () => {
    expect(blockedSite("https://www.paypal.com")?.kind).toBe("financial")
    expect(blockedSite("https://accounts.google.com")?.kind).toBe("credential")
    expect(blockedSite("https://my.1password.com")?.kind).toBe("credential")
    expect(blockedSite("https://online.example.bank")?.kind).toBe("financial")
    expect(blockedSite("https://notpaypal.com")).toBeUndefined()
    expect(blockedSite("https://docs.stripe.com")).toBeUndefined()
    expect(blockedSite("https://google.com")).toBeUndefined()
  })

  test("denies every tier there, whatever a routine allows", () => {
    const { policy } = subject()
    const rules: BrowserAllowRule[] = [
      { permission: "browser", pattern: "https://www.paypal.com", action: "allow" },
      { permission: "browser_sensitive", pattern: "https://www.paypal.com:pay", action: "allow" },
    ]
    for (const tier of BROWSER_TIERS)
      expect(policy.decide({ origin: "https://www.paypal.com", tier, rules, action: "pay" }).decision).toBe("deny")
    expect(policy.answer({ origin: "https://www.paypal.com", tier: "read" }, "always")).toBeUndefined()
  })

  test("and what is not a web address is denied too", () => {
    const { policy } = subject()
    expect(policy.decide({ origin: "file:///etc/passwd", tier: "read" }).decision).toBe("deny")
    expect(policy.decide({ origin: "not a url", tier: "read" }).decision).toBe("deny")
  })
})

describe("decide", () => {
  test("with nothing granted, every tier asks", () => {
    const { policy } = subject()
    expect(decisions(policy)).toEqual({ read: "ask", navigate: "ask", interact: "ask", sensitive: "ask" })
  })

  test("an always grant covers its tier and the ones below, never sensitive", () => {
    for (const [tier, expected] of [
      ["read", { read: "allow", navigate: "ask", interact: "ask", sensitive: "ask" }],
      ["navigate", { read: "allow", navigate: "allow", interact: "ask", sensitive: "ask" }],
      ["interact", { read: "allow", navigate: "allow", interact: "allow", sensitive: "ask" }],
    ] as const) {
      const { policy } = subject()
      policy.answer({ origin: site, tier }, "always")
      expect([tier, decisions(policy)]).toEqual([tier, expected])
      expect(policy.decide({ origin: "https://other.example", tier: "read" }).decision).toBe("ask")
    }
  })

  test("a session grant answers in that session only", () => {
    const { policy } = subject()
    policy.answer({ origin: site, tier: "interact", sessionId: "ses_1" }, "session")
    expect(decisions(policy, { sessionId: "ses_1" })).toEqual({ read: "allow", navigate: "allow", interact: "allow", sensitive: "ask" })
    expect(decisions(policy, { sessionId: "ses_2" })).toEqual({ read: "ask", navigate: "ask", interact: "ask", sensitive: "ask" })
    expect(decisions(policy)).toEqual({ read: "ask", navigate: "ask", interact: "ask", sensitive: "ask" })
  })

  test("once stores nothing: the next action asks again", () => {
    const { policy, repository } = subject()
    expect(policy.answer({ origin: site, tier: "interact" }, "once")).toBeDefined()
    expect(repository.listBrowserGrants()).toEqual([])
    expect(policy.decide({ origin: site, tier: "interact" }).decision).toBe("ask")
  })

  test("a sensitive answer is never kept, whatever scope was picked", () => {
    const { policy, repository } = subject()
    expect(policy.answer({ origin: site, tier: "sensitive", sessionId: "ses_1" }, "always")).toBeDefined()
    expect(policy.answer({ origin: site, tier: "sensitive", sessionId: "ses_1" }, "session")).toBeDefined()
    expect(repository.listBrowserGrants()).toEqual([])
    expect(policy.decide({ origin: site, tier: "sensitive", sessionId: "ses_1" }).decision).toBe("ask")
  })

  test("deny and silence grant nothing", () => {
    const { policy, repository } = subject()
    expect(policy.answer({ origin: site, tier: "read" }, "deny")).toBeUndefined()
    expect(policy.answer({ origin: site, tier: "read" }, undefined)).toBeUndefined()
    expect(repository.listBrowserGrants()).toEqual([])
  })

  test("a routine's rule: browser opens and reads the origin, browser_sensitive allows its one action", () => {
    const { policy } = subject()
    const rules: BrowserAllowRule[] = [
      { permission: "browser", pattern: site, action: "allow" },
      { permission: "browser_sensitive", pattern: `${site}:publish`, action: "allow" },
    ]
    expect(decisions(policy, { rules })).toEqual({ read: "allow", navigate: "allow", interact: "ask", sensitive: "ask" })
    expect(decisions(policy, { rules, action: "publish" })).toEqual({ read: "allow", navigate: "allow", interact: "allow", sensitive: "allow" })
    expect(decisions(policy, { rules, action: "delete" })).toEqual({ read: "allow", navigate: "allow", interact: "ask", sensitive: "ask" })
  })

  test("a revoked grant asks again", () => {
    const { policy } = subject()
    policy.answer({ origin: site, tier: "navigate" }, "always")
    const [grant] = policy.grants()
    expect(policy.revoke(grant!.id)).toBe(true)
    expect(policy.revoke(grant!.id)).toBe(false)
    expect(policy.decide({ origin: site, tier: "read" }).decision).toBe("ask")
  })

  test("a grant is kept once, however often it is given", () => {
    const { policy } = subject()
    policy.answer({ origin: site, tier: "read" }, "always")
    policy.answer({ origin: `${site}/some/page`, tier: "read" }, "always")
    expect(policy.grants()).toMatchObject([{ origin: site, tier: "read", scope: "always" }])
  })
})

describe("permits", () => {
  test("are spent once, for the origin and a tier they cover", () => {
    const { policy } = subject()
    policy.answer({ origin: site, tier: "interact" }, "always")
    const permit = () => policy.decide({ origin: site, tier: "interact" }).permit
    const first = permit()
    expect(policy.spend(first, { origin: site, tier: "read" })).toBe(true)
    expect(policy.spend(first, { origin: site, tier: "read" })).toBe(false)
    expect(policy.spend(permit(), { origin: site, tier: "sensitive" })).toBe(false)
    expect(policy.spend(permit(), { origin: "https://other.example", tier: "read" })).toBe(false)
  })

  test("only the policy makes one: a look-alike, or none, drives nothing", () => {
    const { policy } = subject()
    const forged = Object.freeze({ origin: site, tier: "sensitive" as BrowserTier })
    expect(policy.spend(forged, { origin: site, tier: "read" })).toBe(false)
    expect(policy.spend(undefined, { origin: site, tier: "read" })).toBe(false)
    expect(policy.decide({ origin: site, tier: "read" }).permit).toBeUndefined()
  })
})

describe("the audit", () => {
  test("every decision, answer and action is kept and appended to the event log for its run", () => {
    const { policy, repository } = subject()
    const run = repository.startRun({ type: "manual" }, 1_000, "/work")
    const question = { origin: site, tier: "interact" as const, runId: run.id, taskId: "task_1", action: "post" }
    policy.decide(question)
    policy.answer(question, "once")
    policy.recordAction(question, { outcome: "success", artifactID: "art_1" })
    expect(
      repository
        .listBrowserAudit({ runID: run.id })
        .reverse()
        .map((entry) => [entry.kind, entry.decision ?? entry.outcome, entry.taskID, entry.artifactID]),
    ).toEqual([
      ["decision", "ask", "task_1", undefined],
      ["answer", "allow", "task_1", undefined],
      ["action", "success", "task_1", "art_1"],
    ])
    const logged = repository
      .listEvents(0, 100)
      .flatMap((stored) => (stored.event.type === "browser.audit" ? [stored.event.entry.kind] : []))
    expect(logged).toEqual(["decision", "answer", "action"])
  })
})
