import { describe, expect, test } from "bun:test"
import { createSessionTaskStore, sessionTasksFrom } from "./session-tasks"

describe("the session task store", () => {
  test("a write replaces the list, and the last write wins", () => {
    const store = createSessionTaskStore()
    store.write("ses_a", [{ content: "Read the router", status: "in_progress" }])
    store.write("ses_a", [{ content: "Read the router", status: "completed" }])
    expect(store.read("ses_a")).toEqual([{ content: "Read the router", status: "completed" }])
  })

  test("sessions do not see each other's tasks", () => {
    const store = createSessionTaskStore()
    store.write("ses_a", [{ content: "A", status: "pending" }])
    expect(store.read("ses_b")).toEqual([])
    store.forget("ses_a")
    expect(store.read("ses_a")).toEqual([])
  })

  test("a body that is not a list writes nothing at all", () => {
    const store = createSessionTaskStore()
    store.write("ses_a", [{ content: "Keep", status: "pending" }])
    expect(store.write("ses_a", { todos: [] })).toBeUndefined()
    expect(store.read("ses_a")).toEqual([{ content: "Keep", status: "pending" }])
  })
})

describe("a written list", () => {
  test("drops the items it cannot read and defaults the state", () => {
    expect(sessionTasksFrom([{ content: " Keep " }, { status: "done" }, "junk", null])).toEqual([
      { content: "Keep", status: "pending" },
    ])
  })

  test("caps what one session can hold", () => {
    const many = Array.from({ length: 500 }, (_, index) => ({ content: `t${index}`, status: "pending" }))
    expect(sessionTasksFrom(many)?.length).toBe(200)
  })
})
