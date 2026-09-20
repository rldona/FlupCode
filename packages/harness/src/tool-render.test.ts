import { describe, expect, test } from "bun:test"
import { outputLines, parseTodos, taskSessionID } from "./tool-render"

describe("parseTodos", () => {
  test("reads the todo list the tool was given, keeping its order and statuses", () => {
    expect(
      parseTodos({
        todos: [
          { content: "write the test", status: "completed" },
          { content: "make it pass", status: "in_progress" },
          { content: "ship it" },
        ],
      }),
    ).toEqual([
      { content: "write the test", status: "completed" },
      { content: "make it pass", status: "in_progress" },
      { content: "ship it", status: "pending" },
    ])
  })

  test("drops entries that are not a todo, and a call with none renders nothing", () => {
    expect(parseTodos({ todos: [{ status: "pending" }, { content: "kept" }, "nope", null] })).toEqual([
      { content: "kept", status: "pending" },
    ])
    expect(parseTodos({})).toEqual([])
    expect(parseTodos({ todos: "not a list" })).toEqual([])
  })
})

describe("taskSessionID", () => {
  test("reads the child session out of the task tool's own output", () => {
    expect(taskSessionID('<task id="ses_child" state="completed">done</task>')).toBe("ses_child")
  })

  test("nothing to open is undefined, not a broken link", () => {
    expect(taskSessionID(undefined)).toBeUndefined()
    expect(taskSessionID("In progress")).toBeUndefined()
    expect(taskSessionID("<task state='completed'>no id</task>")).toBeUndefined()
  })
})

describe("outputLines", () => {
  test("one non-empty line per hit, trimmed", () => {
    expect(outputLines("src/a.ts\n\n  src/b.ts  \n")).toEqual(["src/a.ts", "src/b.ts"])
    expect(outputLines("")).toEqual([])
  })
})
