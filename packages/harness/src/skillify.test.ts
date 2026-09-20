import { describe, expect, test } from "bun:test"
import { SKILLS_DIRECTORY, skillifyPrompt } from "./skillify"

describe("turning a session into a skill (H-43)", () => {
  test("asks for the path and the shape the engine reads", () => {
    const prompt = skillifyPrompt()
    // The folder and file name the Skill Manager reads (H-27): anything else is ignored silently.
    expect(SKILLS_DIRECTORY).toBe(".opencode/skills")
    expect(prompt).toContain(`${SKILLS_DIRECTORY}/<short-name>/SKILL.md`)
    expect(prompt).toContain("name: <short-name>")
    expect(prompt).toContain("description:")
    // The agent writes it, so it needs to be told to use the tool that does it.
    expect(prompt).toContain("write tool")
  })
})
