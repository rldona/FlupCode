import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

const input = {
  name: "Check CI",
  description: "",
  prompt: "Inspect CI failures",
  schedule: { type: "manual" },
}

describe("harness routines API", () => {
  test("creates, updates, toggles, and removes routines", async () => {
    const repository = new SqliteRoutineRepository()
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const handler = createHarnessHandler(repository, scheduler)

    const created = await handler(
      new Request("http://localhost/harness/routines", { method: "POST", body: JSON.stringify(input) }),
    )
    expect(created.status).toBe(201)
    const routine = (await created.json()).data

    const updated = await handler(
      new Request(`http://localhost/harness/routines/${routine.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...input, name: "Updated CI" }),
      }),
    )
    expect((await updated.json()).data.name).toBe("Updated CI")

    const toggled = await handler(
      new Request(`http://localhost/harness/routines/${routine.id}/enabled`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
    )
    expect((await toggled.json()).data.enabled).toBe(false)

    const removed = await handler(new Request(`http://localhost/harness/routines/${routine.id}`, { method: "DELETE" }))
    expect(removed.status).toBe(200)
    repository.close()
  })
})
