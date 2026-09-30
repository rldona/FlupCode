import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptMessage } from "../engine"
import {
  exportSession,
  fixtureDirectory,
  loadFixtures,
  parseFixture,
  redactReplayText,
  REPLAY_FIXTURES_DIR,
} from "./fixture"

const ANTHROPIC_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"
const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"

const transcript: TranscriptMessage[] = [
  {
    info: { role: "user", agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } },
    parts: [
      {
        type: "text",
        text: `Fix the login in ${join(homedir(), "work", "app")}/src/auth.ts, my key is ${ANTHROPIC_KEY}`,
      },
      { type: "text", text: "Called the Read tool with the file contents", synthetic: true },
    ],
  },
  {
    info: { role: "assistant", cost: 0.02, tokens: { input: 10, output: 5 } },
    parts: [
      { type: "text", text: "ASSISTANT-ANSWER-NEVER-EXPORTED" },
      { type: "tool", text: "TOOL-OUTPUT-NEVER-EXPORTED" },
    ],
  },
  {
    info: { role: "user", agent: "build" },
    parts: [{ type: "text", text: `Push it with token=${GITHUB_TOKEN} from /home/jane/app and /Users/jane.doe/app` }],
  },
  { info: { role: "user" }, parts: [{ type: "compaction" }] },
]

const engine = (directory: string) => ({
  describeSession: async () => ({ directory, title: "t", createdAt: 0 }),
  messages: async () => transcript,
})

describe("replay export", () => {
  test("keeps the prompts in order and nothing the assistant or a tool produced", async () => {
    const directory = join(homedir(), "work", "app")
    const fixture = await exportSession({ engine: engine(directory), sessionID: "ses_abc", verify: "bun test", now: 1 })
    expect(fixture.prompts).toHaveLength(2)
    expect(fixture.prompts[0]).toStartWith("Fix the login")
    expect(fixture.prompts[1]).toStartWith("Push it")
    expect(fixture.agent).toBe("build")
    expect(fixture.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" })
    expect(fixture.verify).toBe("bun test")
    expect(fixture.source).toEqual({ sessionID: "ses_abc", exportedAt: 1 })
    const written = JSON.stringify(fixture)
    expect(written).not.toContain("ASSISTANT-ANSWER")
    expect(written).not.toContain("TOOL-OUTPUT")
    expect(written).not.toContain("Called the Read tool")
  })

  test("removes secrets and absolute home paths", async () => {
    const directory = join(homedir(), "work", "app")
    const fixture = await exportSession({
      engine: engine(directory),
      sessionID: "ses_abc",
      secrets: ["hunter2-literal"],
    })
    const written = JSON.stringify(fixture)
    expect(written).not.toContain(ANTHROPIC_KEY)
    expect(written).not.toContain(GITHUB_TOKEN)
    expect(written).not.toContain(homedir())
    expect(written).not.toContain("/home/jane")
    expect(written).not.toContain("/Users/jane.doe")
    expect(written).toContain("[REDACTED]")
    expect(fixture.directory).toBe("~/work/app")
    expect(fixture.prompts[0]).toContain("~/work/app/src/auth.ts")
    expect(fixtureDirectory(fixture)).toBe(directory)
  })

  test("redacts a named secret and a Windows home path", () => {
    expect(redactReplayText("pw hunter2-literal at C:\\Users\\jane\\repo", ["hunter2-literal"])).toBe(
      "pw [REDACTED] at ~\\repo",
    )
  })

  test("a session with no typed prompt is refused", async () => {
    const empty = {
      describeSession: async () => ({ directory: "/tmp", title: "t", createdAt: 0 }),
      messages: async () => [],
    }
    await expect(exportSession({ engine: empty, sessionID: "s" })).rejects.toThrow("no user prompt")
  })
})

describe("replay corpus", () => {
  test("loads a corpus of 30 sessions, sorted by id", async () => {
    const directory = mkdtempSync(join(tmpdir(), "replay-corpus-"))
    Array.from({ length: 30 }, (_, index) =>
      writeFileSync(
        join(directory, `s${String(index).padStart(2, "0")}.json`),
        JSON.stringify({ version: 1, id: `s${String(index).padStart(2, "0")}`, directory: "~/p", prompts: ["go"] }),
      ),
    )
    const fixtures = await loadFixtures(directory)
    expect(fixtures).toHaveLength(30)
    expect(fixtures[0]!.id).toBe("s00")
    expect(fixtures[29]!.id).toBe("s29")
  })

  test("the shipped synthetic example is a valid fixture", async () => {
    const fixtures = await loadFixtures(join(REPLAY_FIXTURES_DIR, "example-synthetic.json"))
    expect(fixtures[0]!.prompts.length).toBeGreaterThan(0)
  })

  test("a malformed fixture fails by reason", () => {
    expect(parseFixture({ version: 1, id: "x", directory: "~", prompts: [] })).toBe("no prompts")
    expect(parseFixture({ version: 1, id: "x", directory: "~", prompts: ["a"], model: { providerID: "p" } })).toBe(
      "model needs providerID and modelID",
    )
  })
})
