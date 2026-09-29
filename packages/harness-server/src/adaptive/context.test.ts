import { describe, expect, test } from "bun:test"
import { PROTECTED_CONTEXT_KINDS } from "./decision"
import { classifyEpisode, classifyRunPrompt, contextItemKindOf, estimateTokens, words } from "./context"
import type { ContextPart } from "./context"
import { opaqueItemID } from "./opaque-id"
import type { SessionEpisode } from "../types"

/** A fixed key so ids are stable and no install state is read. */
const KEY = Buffer.alloc(32, 7)

const episode = (overrides: Partial<SessionEpisode> = {}): SessionEpisode => ({
  id: "episode:run:1",
  sessionID: "session-1",
  projectID: "/work/project",
  objective: "fix src/math.ts bug",
  toolCalls: 2,
  files: [],
  commands: [],
  failures: [],
  verifications: [],
  outcome: "success",
  startedAt: 1,
  endedAt: 2,
  evidenceRefs: [],
  timeCreated: 1,
  timeUpdated: 2,
  ...overrides,
})

describe("classifyRunPrompt (FH-020)", () => {
  const parts: ContextPart[] = [
    { id: "obj", kind: "objective", text: "fix src/math.ts bug" },
    { id: "hand", kind: "handoff", text: "previous step fixed the bug" },
    { id: "mem", kind: "memory", text: "- remember the build command" },
    { id: "art", kind: "artifact", text: "unrelated note about lunch" },
    { id: "file", kind: "file", file: { path: "src/math.ts" } },
  ]

  test("maps every part to exactly one item, in order, and keeps the objective", () => {
    const items = classifyRunPrompt({ parts, objective: "fix src/math.ts bug" })
    expect(items.map((item) => item.id)).toEqual(parts.map((part) => part.id))
    expect(items.map((item) => item.kind)).toEqual(["objective", "handoff", "memory", "artifact", "file"])
    expect(items[0]).toMatchObject({ referenced: true, anchors: 0, archived: false })
    expect(items[0]!.kind).toBe("objective")
    expect(PROTECTED_CONTEXT_KINDS).toContain(items[0]!.kind)
  })

  test("computes reference and anchors lexically and estimates tokens from the visible text", () => {
    const items = classifyRunPrompt({ parts, objective: "fix src/math.ts bug" })
    const byID = Object.fromEntries(items.map((item) => [item.id, item]))
    expect(byID.hand!.referenced).toBe(true) // "bug" is in the objective
    expect(byID.mem!.referenced).toBe(false)
    expect(byID.art!.referenced).toBe(false)
    expect(byID.file!.referenced).toBe(true) // "src"/"math" are in the objective
    expect(byID.file!.anchors).toBe(1)
    expect(byID.art!.anchors).toBe(0)
    expect(byID.file!.tokens).toBe(estimateTokens("src/math.ts"))
  })

  test("the kind mapping is total: an unknown value becomes the protected other", () => {
    expect(contextItemKindOf("mystery")).toBe("other")
    expect(contextItemKindOf(7)).toBe("other")
    expect(contextItemKindOf(undefined)).toBe("other")
    expect(contextItemKindOf("file")).toBe("file")
    expect(PROTECTED_CONTEXT_KINDS).toContain("other")
  })

  test("never emits skill: the kind is reserved to 3b/4", () => {
    const items = [
      ...classifyRunPrompt({ parts, objective: "fix src/math.ts bug" }),
      ...classifyEpisode({ episode: episode({ files: ["a.ts"], commands: ["bun test"], failures: [{ summary: "boom" }] }), key: KEY }),
    ]
    expect(items.some((item) => item.kind === "skill")).toBe(false)
  })

  test("a part kind outside the vocabulary becomes the protected other, never an invented item", () => {
    // The typed parts cannot produce this today; the classifier stays total when a future source
    // does. `other` is protected, so the scorer can never drop it.
    const rogue = [{ id: "rogue", kind: "mystery", text: "something unrelated" }] as unknown as ContextPart[]
    const [item] = classifyRunPrompt({ parts: rogue, objective: "fix the bug" })
    expect(item!.kind).toBe("other")
    expect(PROTECTED_CONTEXT_KINDS).toContain(item!.kind)
  })
})

describe("classifyEpisode (FH-020)", () => {
  test("maps files, commands and failures to file/command/error with Phase 2 ids", () => {
    const items = classifyEpisode({
      episode: episode({ files: ["src/math.ts"], commands: ["bun test"], failures: [{ summary: "the check is red" }] }),
      key: KEY,
    })
    expect(items.map((item) => item.kind)).toEqual(["file", "command", "error"])
    expect(items.map((item) => item.id)).toEqual([
      opaqueItemID("file", "src/math.ts", KEY),
      opaqueItemID("command", "bun test", KEY),
      opaqueItemID("failure", "the check is red", KEY),
    ])
    // The literals `file`/`command`/`failure` are Phase 2's, so a re-capture converges.
    expect(items.every((item) => /^(?:file|command|failure):[0-9a-f]{16}$/.test(item.id))).toBe(true)
    expect(items.every((item) => item.anchors === 1 && !item.archived)).toBe(true)
  })

  test("does not leak raw paths or commands into the ids", () => {
    const items = classifyEpisode({ episode: episode({ commands: ["bun test --filter secret"] }), key: KEY })
    const serialized = JSON.stringify(items)
    expect(serialized).not.toContain("secret")
    expect(serialized).not.toContain("bun test")
  })

  test("pins the Phase 2 opaque ids for file, command and failure", () => {
    // Golden, computed from the Phase 2 formula (HMAC-SHA256 under the key, 16 hex chars). It fixes
    // the literal discriminants and the truncation length so a re-capture keeps converging on the
    // rows Phase 2 already wrote.
    const items = classifyEpisode({
      episode: episode({
        files: ["src/math.ts"],
        commands: ["bun test"],
        failures: [{ summary: "the check is red" }],
      }),
      key: KEY,
    })
    expect(items.map((item) => item.id)).toEqual([
      "file:fbbe9f755fddf656",
      "command:a789a340c4a4feed",
      "failure:7e32fbedd64ac694",
    ])
  })

  test("the same episode re-captured yields the same ids", () => {
    const first = classifyEpisode({ episode: episode({ files: ["a.ts"] }), key: KEY })
    const second = classifyEpisode({ episode: episode({ files: ["a.ts"] }), key: KEY })
    expect(first).toEqual(second)
  })
})

describe("the lexical helpers", () => {
  test("words drops tokens shorter than three characters", () => {
    expect(words("A bug in src/math.ts")).toEqual(["bug", "src", "math"])
  })
})
