import { describe, expect, test } from "bun:test"
import { resumePrompt } from "./resume"

describe("the checkpoint a session writes about itself", () => {
  test("asks for what a reader picking the work up needs", () => {
    const prompt = resumePrompt()
    expect(prompt).toContain("checkpoint of this session")
    expect(prompt).toContain("pending")
    expect(prompt).toContain("next step")
  })

  test("is a report, so it must not change anything", () => {
    expect(resumePrompt()).toContain("do not change anything")
  })
})
