import { describe, expect, test } from "bun:test"
import { sessionTasks } from "./session-tasks"
import type { SessionMessageInfo } from "./engine-types"

const todo = (todos: unknown) =>
  ({
    id: "msg_a",
    type: "assistant",
    content: [
      { type: "text", text: "Working" },
      { type: "tool", name: "todowrite", state: { input: { todos } } },
    ],
  }) as unknown as SessionMessageInfo

describe("the session's tasks", () => {
  test("come from the last list the model wrote", () => {
    const first = todo([{ content: "Read the router", status: "completed" }])
    const last = todo([
      { content: "Read the router", status: "completed" },
      { content: "Draw the panel", status: "in_progress" },
    ])
    expect(sessionTasks([first, last])).toEqual([
      { content: "Read the router", status: "completed" },
      { content: "Draw the panel", status: "in_progress" },
    ])
  })

  test("a session that never wrote one has none", () => {
    expect(sessionTasks([{ id: "m", type: "user", text: "hola" } as unknown as SessionMessageInfo])).toEqual([])
    expect(sessionTasks(undefined)).toEqual([])
  })

  test("a malformed list drops the items it cannot read, not the list", () => {
    expect(sessionTasks([todo([{ content: "Keep" }, { status: "pending" }, "junk"])])).toEqual([
      { content: "Keep", status: "pending" },
    ])
  })

  test("a plain todo tool counts too, so a plugin tool brings its list", () => {
    const message = {
      id: "msg_b",
      type: "assistant",
      content: [
        { type: "tool", name: "todo", state: { input: { todos: [{ content: "Ship it", status: "completed" }] } } },
      ],
    } as unknown as SessionMessageInfo
    expect(sessionTasks([message])).toEqual([{ content: "Ship it", status: "completed" }])
  })
})
