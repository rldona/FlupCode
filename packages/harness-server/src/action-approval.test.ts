import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createActionApprover } from "./action-approval"
import type { ActionCatalogProfile } from "./action-runner"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

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

function approver(profiles: ActionCatalogProfile[], answers: Array<"once" | "always" | "deny" | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "fc-approval-"))
  dirs.push(dir)
  const asked: Array<{ sessionID: string; title: string; description: string }> = []
  const file = join(dir, "action-approvals.json")
  return {
    asked,
    file,
    approver: createActionApprover({
      actions: { list: () => ({ profiles, rejected: [] }) },
      ask: async (request) => {
        asked.push(request)
        return answers.shift()
      },
      file,
    }),
  }
}

test("a read-only action is approved per origin, and an always answer is not asked again", async () => {
  const subject = approver([profile({})], ["always"])
  expect(await subject.approver.approve({ action: "search", sessionID: "ses_1" })).toEqual({
    approved: true,
    remembered: false,
  })
  expect(subject.asked[0]!.title).toBe("Allow web actions on https://example.com?")
  expect(JSON.parse(readFileSync(subject.file, "utf8"))).toEqual({ always: ["https://example.com"] })
  expect(await subject.approver.approve({ action: "search", sessionID: "ses_2" })).toEqual({
    approved: true,
    remembered: true,
  })
  expect(subject.asked).toHaveLength(1)
})

test("an action that submits is sensitive and named, whatever the plugin says", async () => {
  const subject = approver(
    [profile({ id: "post", steps: [{ goto: "/" }, { submit: { selector: "form" } }] as never })],
    ["once", "deny", undefined],
  )
  expect((await subject.approver.approve({ action: "post", sessionID: "ses_1" })).approved).toBe(true)
  expect(subject.asked[0]!.title).toBe('Allow the web action "post" on https://example.com?')
  expect(subject.asked[0]!.description).toContain("It will submit on the page.")
  expect(await subject.approver.approve({ action: "post", sessionID: "ses_1" })).toEqual({
    approved: false,
    reason: "denied",
  })
  expect(await subject.approver.approve({ action: "post", sessionID: "ses_1" })).toEqual({
    approved: false,
    reason: "unanswered",
  })
})

test("an action this server does not know is never approved, and nobody is asked", async () => {
  const subject = approver([profile({})], ["once"])
  expect(await subject.approver.approve({ action: "made-up", sessionID: "ses_1" })).toEqual({
    approved: false,
    reason: "unknown_action",
  })
  expect(subject.asked).toHaveLength(0)
})
