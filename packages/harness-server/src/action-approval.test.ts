import { afterEach, expect, test } from "bun:test"
import { createActionApprover } from "./action-approval"
import type { ActionCatalogProfile } from "./action-runner"
import { createBrowserPolicy } from "./browser-policy"
import { SqliteRoutineRepository } from "./repository"

const repositories: SqliteRoutineRepository[] = []
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()))

const profile = (over: Partial<ActionCatalogProfile>) =>
  ({
    id: "search",
    tool: "flupcode_search",
    description: "Search the catalogue",
    kind: "browser",
    origin: "https://example.com",
    inputs: { query: "string" },
    steps: [{ goto: "/" }],
    guards: [],
    sensitive: false,
    availability: "host",
    evidence: "failure",
    scope: "global",
    ...over,
  }) as ActionCatalogProfile

type Asked = Parameters<Parameters<typeof createActionApprover>[0]["ask"]>[0]

function approver(profiles: ActionCatalogProfile[], answers: Array<string | undefined>) {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  const asked: Asked[] = []
  return {
    asked,
    repository,
    approver: createActionApprover({
      actions: { list: () => ({ profiles, rejected: [] }) },
      policy: createBrowserPolicy(repository),
      ask: async (request) => {
        asked.push(request)
        return answers.shift()
      },
    }),
  }
}

test("a read-only action asks for its site, and an always answer is not asked again", async () => {
  const subject = approver([profile({})], ["always"])
  expect(await subject.approver.approve({ action: "search", sessionID: "ses_1" })).toEqual({
    approved: true,
    remembered: false,
    approval: expect.any(String),
  })
  expect(subject.asked[0]!.title).toBe("Allow the agent to open and read pages on example.com?")
  expect(subject.asked[0]!.options.map((option) => option.label)).toEqual([
    "Allow once",
    "Allow for this session",
    "Always allow to open and read pages on example.com",
    "Deny",
  ])
  expect(subject.asked[0]!.metadata).toEqual({
    flupcode: "browser-approval",
    origin: "https://example.com",
    site: "example.com",
    tier: "navigate",
    action: "search",
  })
  expect(subject.repository.listBrowserGrants()).toMatchObject([
    { origin: "https://example.com", tier: "navigate", scope: "always" },
  ])
  expect(await subject.approver.approve({ action: "search", sessionID: "ses_2" })).toEqual({
    approved: true,
    remembered: true,
    approval: expect.any(String),
  })
  expect(subject.asked).toHaveLength(1)
})

test("an action that submits is sensitive: allowed once or denied, and asked every time", async () => {
  const subject = approver(
    [profile({ id: "post", steps: [{ goto: "/" }, { submit: { selector: "form" } }] as never, sensitive: true })],
    ["always", "deny", undefined],
  )
  expect((await subject.approver.approve({ action: "post", sessionID: "ses_1" })).approved).toBe(true)
  expect(subject.asked[0]!.title).toBe("Allow the agent to send forms, upload files or sign in on example.com?")
  expect(subject.asked[0]!.description).toBe("Search the catalogue. It will submit a form on the page.")
  expect(subject.asked[0]!.options.map((option) => option.value)).toEqual(["once", "deny"])
  // An "always" a sensitive action cannot hold is spent as once: nothing is stored.
  expect(subject.repository.listBrowserGrants()).toEqual([])
  expect(await subject.approver.approve({ action: "post", sessionID: "ses_1" })).toEqual({
    approved: false,
    reason: "denied",
  })
  expect(await subject.approver.approve({ action: "post", sessionID: "ses_1" })).toEqual({
    approved: false,
    reason: "unanswered",
  })
  expect(subject.asked).toHaveLength(3)
})

test("an interact action on an ungranted site waits for the answer, and nothing is approved before it", async () => {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  let answer: (value: string) => void = () => {}
  const asked: Asked[] = []
  const subject = createActionApprover({
    actions: {
      list: () => ({ profiles: [profile({ id: "like", steps: [{ goto: "/" }, { click: "#like" }] as never, sensitive: true })], rejected: [] }),
    },
    policy: createBrowserPolicy(repository),
    ask: (request) => {
      asked.push(request)
      return new Promise((resolve) => (answer = resolve))
    },
  })
  let settled = false
  const pending = subject.approve({ action: "like", sessionID: "ses_1" }).finally(() => (settled = true))
  await Bun.sleep(20)
  expect(asked.map((request) => request.metadata.tier)).toEqual(["interact"])
  expect(asked[0]!.title).toBe("Allow the agent to click and type on example.com?")
  expect(settled).toBe(false)
  answer("session")
  expect((await pending).approved).toBe(true)
  // The session grant answers the next action in that session, and only there.
  expect((await subject.approve({ action: "like", sessionID: "ses_1" })).approved).toBe(true)
  expect(asked).toHaveLength(1)
  void subject.approve({ action: "like", sessionID: "ses_2" })
  await Bun.sleep(20)
  expect(asked).toHaveLength(2)
})

test("a payment or sign-in site is refused without asking", async () => {
  const subject = approver([profile({ id: "pay", origin: "https://www.paypal.com" })], ["always"])
  expect(await subject.approver.approve({ action: "pay", sessionID: "ses_1" })).toEqual({
    approved: false,
    reason: "blocked",
    message: "www.paypal.com is a payment or banking site, which the agent never acts on",
  })
  expect(subject.asked).toHaveLength(0)
})

test("an action this server does not know is never approved, and nobody is asked", async () => {
  const subject = approver([profile({})], ["once"])
  expect(await subject.approver.approve({ action: "made-up", sessionID: "ses_1" })).toEqual({
    approved: false,
    reason: "unknown_action",
  })
  expect(subject.asked).toHaveLength(0)
})

test("every decision and answer is in the audit, with the session it was for", async () => {
  const subject = approver([profile({})], ["once"])
  await subject.approver.approve({ action: "search", sessionID: "ses_1" })
  expect(
    subject.repository
      .listBrowserAudit({ sessionID: "ses_1" })
      .map((entry) => [entry.kind, entry.decision, entry.scope, entry.action])
      .reverse(),
  ).toEqual([
    ["decision", "ask", undefined, "search"],
    ["answer", "allow", "once", "search"],
  ])
})
