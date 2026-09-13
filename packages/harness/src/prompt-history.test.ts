import { describe, expect, test } from "bun:test"
import { appendPrompt, stepHistory } from "./prompt-history"

describe("appendPrompt", () => {
  test("adds trimmed prompts at the end", () => {
    expect(appendPrompt(["a"], "  b \n")).toEqual(["a", "b"])
  })

  test("ignores blank prompts", () => {
    const history = ["a"]
    expect(appendPrompt(history, "   ")).toBe(history)
  })

  test("moves a repeated prompt to the end", () => {
    expect(appendPrompt(["a", "b", "c"], "a")).toEqual(["b", "c", "a"])
  })

  test("keeps only the newest prompts", () => {
    expect(appendPrompt(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"])
  })
})

describe("stepHistory", () => {
  test("up starts at the newest prompt and stops at the oldest", () => {
    expect(stepHistory(3, undefined, "up")).toBe(2)
    expect(stepHistory(3, 1, "up")).toBe(0)
    expect(stepHistory(3, 0, "up")).toBe(0)
  })

  test("down walks back to the draft", () => {
    expect(stepHistory(3, 0, "down")).toBe(1)
    expect(stepHistory(3, 2, "down")).toBeUndefined()
    expect(stepHistory(3, undefined, "down")).toBeUndefined()
  })

  test("an empty history stays on the draft", () => {
    expect(stepHistory(0, undefined, "up")).toBeUndefined()
  })
})
