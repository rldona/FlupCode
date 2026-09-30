import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "../api"
import type { HarnessHandlerOptions } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import { resolveAdaptiveConfig } from "./config"
import { createContextManager } from "./context-manager"
import { createDecisionService } from "./decision-service"
import { createAdaptiveEgressGuard } from "./egress"
import { planID } from "./compaction-plan"

const NOW = 1_700_000_000_000

const open = (options: HarnessHandlerOptions = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return { repository, handler: createHarnessHandler(repository, scheduler, options) }
}

const contextFor = (repository: SqliteRoutineRepository) => {
  const config = resolveAdaptiveConfig({ block: {}, env: {} })
  const service = createDecisionService({
    repository,
    config: () => config,
    egress: createAdaptiveEgressGuard({ config: () => config }),
    now: () => NOW,
  })
  return createContextManager({ repository, service, config: () => config, opaqueKey: () => Buffer.alloc(32, 7), now: () => NOW })
}

describe("the context plan routes (FH-022)", () => {
  const seeded = (options: HarnessHandlerOptions = {}) => {
    const repository = new SqliteRoutineRepository(":memory:")
    const context = contextFor(repository)
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const handler = createHarnessHandler(repository, scheduler, { ...options, context })
    return { repository, context, handler }
  }

  const planOne = async (context: ReturnType<typeof contextFor>) =>
    context.plan({
      parts: [
        { id: "obj", kind: "objective", text: "fix the bug" },
        { id: "art", kind: "artifact", text: "unrelated lunch note" },
      ],
      objective: "fix the bug",
      runID: "run-1",
      taskID: "task-1",
      now: NOW,
    })

  test("lists and explains under the bearer, and refuses without it", async () => {
    const { repository, context, handler } = seeded({ token: "secret" })
    await planOne(context)

    const forbidden = await handler(new Request("http://x/harness/adaptive/plans"))
    expect(forbidden.status).toBe(403)
    expect((await forbidden.json()).code).toBe("invalid_token")

    const list = await handler(
      new Request("http://x/harness/adaptive/plans?runID=run-1", {
        headers: { authorization: "Bearer secret" },
      }),
    )
    expect(list.status).toBe(200)
    const body = await list.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].runID).toBe("run-1")
    expect(body.data[0].scoreSource).toBe("deterministic")
    expect(body.data[0].entries.map((entry: { id: string }) => entry.id)).toEqual(["obj", "art"])

    const explain = await handler(
      new Request(`http://x/harness/adaptive/plans/${planID("run-1:task-1")}`, {
        headers: { authorization: "Bearer secret" },
      }),
    )
    expect(explain.status).toBe(200)
    const explained = await explain.json()
    expect(explained.data.id).toBe(planID("run-1:task-1"))
    expect(explained.data.evidenceRefs).toEqual([])
    expect(explained.data.objectiveHash).toMatch(/^[0-9a-f]{64}$/)
    repository.close()
  })

  test("explains an id the client encoded, as the cockpit sends it", async () => {
    const { repository, context, handler } = seeded()
    await planOne(context)

    const explain = await handler(
      new Request(`http://x/harness/adaptive/plans/${encodeURIComponent(planID("run-1:task-1"))}`),
    )
    expect(explain.status).toBe(200)
    expect((await explain.json()).data.id).toBe(planID("run-1:task-1"))
    repository.close()
  })

  test("answers without a token, and an unknown id is a 404", async () => {
    const { repository, context, handler } = seeded()
    await planOne(context)
    expect((await handler(new Request("http://x/harness/adaptive/plans"))).status).toBe(200)

    const missing = await handler(new Request("http://x/harness/adaptive/plans/plan:nope"))
    expect(missing.status).toBe(404)
    expect((await missing.json()).code).toBe("not_found")
    repository.close()
  })

  test("is an ordinary 404 without a context manager", async () => {
    const { repository, handler } = open()
    expect((await handler(new Request("http://x/harness/adaptive/plans"))).status).toBe(404)
    repository.close()
  })

  test("health announces adaptive-context only when the manager exists", async () => {
    const { repository, handler } = seeded()
    const announced = await (await handler(new Request("http://x/harness/health"))).json()
    expect(announced.capabilities).toContain("adaptive-context")
    repository.close()
  })
})
