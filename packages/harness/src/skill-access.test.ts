import { describe, expect, test } from "bun:test"
import { agentAllowsSkill, skillAccess } from "./skill-access"
import type { AgentFile } from "./types"

describe("whether a tools map allows a skill", () => {
  test("wildcard, skill key and prefixed key allow; nothing else does", () => {
    expect(agentAllowsSkill("review", { "*": true })).toBe(true)
    expect(agentAllowsSkill("review", { skill: true })).toBe(true)
    expect(agentAllowsSkill("review", { skill_review: true })).toBe(true)
    expect(agentAllowsSkill("review", { skill_other: true })).toBe(false)
    expect(agentAllowsSkill("review", { skill: false })).toBe(false)
    expect(agentAllowsSkill("review", { read: true })).toBe(false)
    expect(agentAllowsSkill("review", undefined)).toBe(false)
  })
})

describe("which agents see a skill", () => {
  const agent = (name: string, tools?: Record<string, unknown>) =>
    ({ name, fields: { tools } }) as unknown as AgentFile

  test("by name, in file order, skipping files without a tools map", () => {
    const agents = [
      agent("plan", { skill_review: true }),
      agent("build", { skill: true }),
      agent("title", { read: true }),
      agent("empty"),
    ]
    expect(skillAccess(["review"], agents)).toEqual([{ skill: "review", agents: ["plan", "build"] }])
    expect(skillAccess(["missing"], agents)).toEqual([{ skill: "missing", agents: ["build"] }])
  })
})
