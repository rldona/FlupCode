import { describe, expect, test } from "bun:test"
import type { MemoryInfo } from "@opencode-ai/sdk/v2/client"
import { filterMemories, formatMemoryTime, memoryConfidenceLabel, memoryScopeLabel, pendingCandidates } from "./memory"

const memory = (overrides: Partial<MemoryInfo>): MemoryInfo => ({
  id: "mem_test",
  scope: "project",
  scopeID: "prj_test",
  kind: "fact",
  title: "Deploy",
  content: "Production deploy uses ./scripts/release.sh",
  tags: ["deploy"],
  source: "agent_discovery",
  status: "active",
  confidence: 0.8,
  importance: 3,
  createdBy: "extractor",
  timeCreated: 1_717_171_717_000,
  timeUpdated: 1_717_171_717_000,
  useCount: 0,
  ...overrides,
})

describe("memory helpers", () => {
  test("labels the global scope as the user", () => {
    expect(memoryScopeLabel("global")).toBe("user")
    expect(memoryScopeLabel("project")).toBe("project")
  })

  test("formats confidence and timestamps", () => {
    expect(memoryConfidenceLabel(0.834)).toBe("83%")
    expect(formatMemoryTime(undefined)).toBe("-")
    expect(formatMemoryTime(1_717_171_717_000)).not.toBe("-")
  })

  test("filters by text, scope, and status", () => {
    const items = [
      memory({ id: "a", title: "Use pnpm", tags: ["pnpm"], content: "Use pnpm", scope: "project" }),
      memory({ id: "b", title: "Release", tags: ["release"], content: "release step", scope: "global" }),
      memory({ id: "c", title: "Candidate", tags: [], content: "maybe", status: "candidate" }),
    ]

    expect(filterMemories(items, {}).map((item) => item.id)).toEqual(["a", "b", "c"])
    expect(filterMemories(items, { text: "pnpm" }).map((item) => item.id)).toEqual(["a"])
    expect(filterMemories(items, { scope: "global" }).map((item) => item.id)).toEqual(["b"])
    expect(filterMemories(items, { status: "candidate" }).map((item) => item.id)).toEqual(["c"])
    expect(pendingCandidates(items)).toBe(1)
  })
})
