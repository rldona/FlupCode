import { describe, expect, test } from "bun:test"
import type { Model } from "../../policy"
import { redactText } from "../redaction"
import {
  DRAFT_INSTRUCTION,
  DRAFT_LIMITS,
  createEngineSkillDrafter,
  learningModel,
  parseSkillDraft,
} from "./draft"
import type { DraftEngine, SkillDraftRequest } from "./draft"

const body = `## Steps\n${"Do the thing carefully. ".repeat(20)}`.trim()

const validJson = JSON.stringify({
  name: "fix-failing-test",
  description: "Use when a test fails and the failing assertion is not obvious",
  body,
})

const request = (overrides: Partial<SkillDraftRequest> = {}): SkillDraftRequest => ({
  directory: "/work/project",
  objective: "fix the failing test",
  signals: ["verify:test fail", "file:src/a.ts"],
  evidence: ["the check is red"],
  ...overrides,
})

/** A fake engine; it counts what was asked and never starts a session. */
const fakeEngine = (options: { answer?: string; failAt?: "session" | "prompt" | "wait" } = {}) => {
  const prompts: string[] = []
  const models: Array<Model | undefined> = []
  const sessions: Array<{ directory?: string; permission?: Array<{ permission: string; pattern: string; action: string }> }> = []
  const interrupted: string[] = []
  const deleted: string[] = []
  const engine: DraftEngine = {
    async createSession(input) {
      sessions.push(input)
      if (options.failAt === "session") throw new Error("no session")
      return { id: "draft-session" }
    },
    async prompt(input) {
      prompts.push(input.text)
      models.push(input.model)
      if (options.failAt === "prompt") throw new Error("no prompt")
    },
    async waitForIdle() {
      if (options.failAt === "wait") throw new Error("timed out")
    },
    async lastAnswer() {
      return options.answer !== undefined ? { text: options.answer } : undefined
    },
    async interrupt(sessionID) {
      interrupted.push(sessionID)
    },
    async deleteSession(sessionID) {
      deleted.push(sessionID)
    },
  }
  return { engine, prompts, models, sessions, interrupted, deleted }
}

const model: Model = { providerID: "prov", id: "small" }

describe("parseSkillDraft (FH-032)", () => {
  test("reads a valid fenced json block", () => {
    expect(parseSkillDraft(`Here it is:\n\`\`\`json\n${validJson}\n\`\`\``)).toEqual({
      name: "fix-failing-test",
      description: "Use when a test fails and the failing assertion is not obvious",
      body,
    })
  })

  test("rejects a name that is missing or is not a slug", () => {
    expect(parseSkillDraft(JSON.stringify({ description: "Use when x", body }))).toBeUndefined()
    expect(parseSkillDraft(JSON.stringify({ name: "Bad Name", description: "Use when x", body }))).toBeUndefined()
    expect(
      parseSkillDraft(JSON.stringify({ name: "a".repeat(DRAFT_LIMITS.maxNameChars + 1), description: "Use when x", body })),
    ).toBeUndefined()
  })

  test("rejects a body over the altitude cap", () => {
    const long = JSON.stringify({ name: "n", description: "Use when x", body: "x".repeat(DRAFT_LIMITS.maxBodyChars + 1) })
    expect(parseSkillDraft(long)).toBeUndefined()
    const short = JSON.stringify({ name: "n", description: "Use when x", body: "too short" })
    expect(parseSkillDraft(short)).toBeUndefined()
  })

  test("rejects a transcript-shaped body", () => {
    const transcript = JSON.stringify({
      name: "n",
      description: "Use when x",
      body: `User: do it\nAssistant: ok\n${"a".repeat(100)}`,
    })
    expect(parseSkillDraft(transcript)).toBeUndefined()
  })

  test("rejects a description over the cap and a body over the line cap", () => {
    const longDescription = JSON.stringify({
      name: "n",
      description: `Use when ${"x".repeat(DRAFT_LIMITS.maxDescriptionChars)}`,
      body,
    })
    expect(parseSkillDraft(longDescription)).toBeUndefined()

    const manyLines = JSON.stringify({
      name: "n",
      description: "Use when x",
      body: `${"a line of context\n".repeat(DRAFT_LIMITS.maxBodyLines + 1)}tail`,
    })
    expect(parseSkillDraft(manyLines)).toBeUndefined()
  })

  test("no answer, or nothing parseable, is undefined rather than a guess", () => {
    expect(parseSkillDraft(undefined)).toBeUndefined()
    expect(parseSkillDraft("no block here")).toBeUndefined()
  })
})

describe("createEngineSkillDrafter (FH-032)", () => {
  test("drafts through a throwaway session with the resolved model", async () => {
    const { engine, prompts, models } = fakeEngine({ answer: validJson })
    const drafter = createEngineSkillDrafter({ engine, model, timeoutMs: 1_000 })

    const draft = await drafter.draft(request())

    expect(draft?.name).toBe("fix-failing-test")
    expect(models).toEqual([model])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("Objective: fix the failing test")
  })

  test("confines the throwaway session to the project directory and denies every tool", async () => {
    const { engine, sessions } = fakeEngine({ answer: validJson })
    const drafter = createEngineSkillDrafter({ engine, model, timeoutMs: 1_000 })

    const draft = await drafter.draft(request({ directory: "/work/project" }))

    expect(draft).toBeDefined()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.directory).toBe("/work/project")
    expect(sessions[0]!.permission).toEqual([{ permission: "*", pattern: "*", action: "deny" }])
  })

  test("without a directory it opens no session at all", async () => {
    const { engine, sessions } = fakeEngine({ answer: validJson })
    const drafter = createEngineSkillDrafter({ engine, model, timeoutMs: 1_000 })

    expect(await drafter.draft(request({ directory: "" }))).toBeUndefined()
    expect(sessions).toHaveLength(0)
  })

  test("a relative directory is refused before opening a session", async () => {
    const { engine, sessions } = fakeEngine({ answer: validJson })
    const drafter = createEngineSkillDrafter({ engine, model, timeoutMs: 1_000 })

    // A local project has the relative `projectID: "local"`; it must never run a session elsewhere.
    expect(await drafter.draft(request({ directory: "local" }))).toBeUndefined()
    expect(sessions).toHaveLength(0)
  })

  test("redacts before bounding, so a secret straddling the cap does not survive the cut", async () => {
    const canary = `sk-ant-${"A".repeat(24)}`
    const { engine, prompts } = fakeEngine({ answer: validJson })
    const drafter = createEngineSkillDrafter({
      engine,
      model,
      timeoutMs: 1_000,
      redact: (value) => redactText(String(value)),
      maxInputChars: 40,
    })

    await drafter.draft(request({ objective: `${"x".repeat(15)} ${canary}`, signals: [], evidence: [] }))

    // The secret starts before the 40-char cap and would have been cut in half by a bound-first order.
    expect(prompts[0]).not.toContain(canary)
    expect(prompts[0]).not.toContain(canary.slice(0, 10))
    expect(prompts[0]).toContain(redactText(canary))
  })

  test("redacts the transcript before it leaves, so a known secret is absent", async () => {
    const canary = `sk-ant-${"A".repeat(24)}`
    const { engine, prompts } = fakeEngine({ answer: validJson })
    const drafter = createEngineSkillDrafter({
      engine,
      model,
      timeoutMs: 1_000,
      redact: (value) => redactText(String(value)),
    })

    const draft = await drafter.draft(request({ objective: `fix ${canary}` }))

    expect(draft).toBeDefined()
    expect(prompts[0]).not.toContain(canary)
    expect(prompts[0]).toContain(redactText(canary))
  })

  test("a failure or a timeout resolves undefined, never throws", async () => {
    const promptFailure = createEngineSkillDrafter({ engine: fakeEngine({ failAt: "prompt" }).engine, model, timeoutMs: 1 })
    expect(await promptFailure.draft(request())).toBeUndefined()

    const timeout = createEngineSkillDrafter({ engine: fakeEngine({ failAt: "wait" }).engine, model, timeoutMs: 1 })
    expect(await timeout.draft(request())).toBeUndefined()

    const noAnswer = createEngineSkillDrafter({ engine: fakeEngine().engine, model, timeoutMs: 1 })
    expect(await noAnswer.draft(request())).toBeUndefined()
  })

  test("a timed-out draft is interrupted and its throwaway session deleted; a good one is deleted too", async () => {
    const timedOut = fakeEngine({ failAt: "wait" })
    expect(await createEngineSkillDrafter({ engine: timedOut.engine, model, timeoutMs: 1 }).draft(request())).toBeUndefined()
    expect(timedOut.interrupted).toEqual(["draft-session"])
    expect(timedOut.deleted).toEqual(["draft-session"])

    const drafted = fakeEngine({ answer: validJson })
    expect(await createEngineSkillDrafter({ engine: drafted.engine, model, timeoutMs: 1 }).draft(request())).toBeDefined()
    expect(drafted.interrupted).toEqual([])
    expect(drafted.deleted).toEqual(["draft-session"])
  })

  test("bounds the observed transcript, keeping the instruction whole", async () => {
    const { engine, prompts } = fakeEngine({ answer: validJson })
    const drafter = createEngineSkillDrafter({ engine, model, timeoutMs: 1_000, maxInputChars: 40 })

    await drafter.draft(request({ objective: "x".repeat(500), evidence: ["y".repeat(500)] }))

    expect(prompts).toHaveLength(1)
    const [instruction, transcript] = prompts[0]!.split("\n\n")
    // The answer format is never the part that gets cut; only the untrusted transcript is bounded.
    expect(instruction).toBe(DRAFT_INSTRUCTION)
    expect(transcript).toHaveLength(40)
  })
})

describe("learningModel (FH-032)", () => {
  test("adaptive.learning.model wins over the global small_model", () => {
    expect(learningModel({ model: "prov/learning" }, () => "prov/small")).toEqual({ providerID: "prov", id: "learning" })
  })

  test("falls back to the global small_model", () => {
    expect(learningModel({}, () => "prov/small")).toEqual({ providerID: "prov", id: "small" })
  })

  test("no model at all is undefined, the honest no-model", () => {
    expect(learningModel({})).toBeUndefined()
    expect(learningModel({}, () => "not-a-model-key")).toBeUndefined()
  })
})
