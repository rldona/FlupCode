import { describe, expect, test } from "bun:test"
import { SqliteRoutineRepository } from "./repository"

const input = {
  name: "Dependency audit",
  description: "",
  prompt: "Check dependencies",
  schedule: { type: "interval" as const, intervalMinutes: 60 },
}

describe("SqliteRoutineRepository", () => {
  test("persists routines, runs, and session links", () => {
    const repository = new SqliteRoutineRepository()
    const routine = repository.create(input)
    expect(repository.get(routine.id)?.name).toBe("Dependency audit")

    const run = repository.startRun(routine.id, 1000)
    expect(run?.status).toBe("running")
    repository.attachSession(run!.id, "session_1")
    repository.finishRun(run!.id, "success", undefined, 2000)

    expect(repository.listRuns(routine.id)).toMatchObject([
      {
        id: run!.id,
        routineID: routine.id,
        sessionID: "session_1",
        status: "success",
        startedAt: 1000,
        finishedAt: 2000,
      },
    ])
    repository.close()
  })

  test("allows one owner to hold a lock and reclaims expired locks", () => {
    const repository = new SqliteRoutineRepository()
    const routine = repository.create(input)
    expect(repository.acquire(routine.id, "owner_a", 1000, 100)).toBe(true)
    expect(repository.acquire(routine.id, "owner_b", 1050, 100)).toBe(false)
    expect(repository.acquire(routine.id, "owner_b", 1101, 100)).toBe(true)
    repository.release(routine.id, "owner_b")
    expect(repository.acquire(routine.id, "owner_a", 1200, 100)).toBe(true)
    repository.close()
  })

  test("marks orphaned runs after a server restart", () => {
    const repository = new SqliteRoutineRepository()
    const routine = repository.create(input)
    const run = repository.startRun(routine.id, 1000)
    repository.recoverRunning(2000)
    expect(repository.getRun(run!.id)).toMatchObject({ status: "failed", finishedAt: 2000 })
    repository.close()
  })
})
