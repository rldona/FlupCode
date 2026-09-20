import { describe, expect, test } from "bun:test"
import { clearsPanel } from "./RightAside"
import type { TodoItem } from "./TodoDock"

const todo = (content: string, status = "pending") => ({ content, status }) as TodoItem

describe("closing the panel when clearing empties it", () => {
  test("last task gone and no subagents closes", () => {
    expect(clearsPanel([todo("a", "completed")], ["a"], 0)).toBe(true)
    expect(clearsPanel([todo("a"), todo("b")], ["a", "b"], 0)).toBe(true)
  })

  test("tasks left or subagents showing keeps it open", () => {
    expect(clearsPanel([todo("a", "completed"), todo("b")], ["a"], 0)).toBe(false)
    expect(clearsPanel([todo("a", "completed")], ["a"], 2)).toBe(false)
    expect(clearsPanel([], [], 1)).toBe(false)
  })

  test("nothing to clear on an empty panel with no subagents closes", () => {
    expect(clearsPanel([], [], 0)).toBe(true)
  })
})
