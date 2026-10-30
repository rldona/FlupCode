import { describe, expect, test } from "bun:test"
import { sessionTasksFrom } from "./session-tasks"

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

describe("the stored list", () => {
  test("survives a restart of the repository, and one session does not see another's", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { SqliteRoutineRepository } = await import("./repository")
    const folder = mkdtempSync(join(tmpdir(), "flupcode-tasks-"))
    const file = join(folder, "tasks.db")
    try {
      const first = new SqliteRoutineRepository(file)
      first.setSessionTasks("ses_a", [{ content: "Read the router", status: "completed" }])
      first.close()
      const again = new SqliteRoutineRepository(file)
      expect(again.getSessionTasks("ses_a")).toEqual([{ content: "Read the router", status: "completed" }])
      expect(again.getSessionTasks("ses_b")).toBeUndefined()
      // A second write replaces the row: the list the reader watches is always the last one.
      again.setSessionTasks("ses_a", [{ content: "Draw the panel", status: "in_progress" }])
      expect(again.getSessionTasks("ses_a")).toEqual([{ content: "Draw the panel", status: "in_progress" }])
      again.close()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
