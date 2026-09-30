import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "../api"
import type { HarnessHandlerOptions } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import { createRuntimeProbe } from "./runtime"
import { resolveAdaptiveConfig } from "./config"
import { createDecisionService } from "./decision-service"
import { createAdaptiveEgressGuard } from "./egress"
import { DEFAULT_DECISION_POLICY } from "./decision"
import type { DecisionRequest } from "./decision"

const open = (options: HarnessHandlerOptions = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return { repository, handler: createHarnessHandler(repository, scheduler, options) }
}

const probeWith = (canary: unknown) =>
  createRuntimeProbe({
    engineURL: "http://127.0.0.1:4096",
    now: () => 1_000,
    engineHealth: async () => ({ reachable: true, version: "1.2.3" }),
    readFile: async () => JSON.stringify(canary),
  })

describe("the adaptive capabilities route", () => {
  test("answers the runtime the probe classified, with its capabilities", async () => {
    const { repository, handler } = open({
      runtimeProbe: probeWith({
        pid: 1,
        loadedAt: 100,
        token: "1:100",
        hookAt: 200,
        hook: "experimental.chat.system.transform",
      }),
    })
    const response = await handler(new Request("http://x/harness/adaptive/capabilities"))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.runtime).toBe("legacy")
    expect(body.data.evidence.reason).toBe("legacy-hook-fired")
    expect(body.data.capabilities.canUseLegacyHooks).toBe(true)
    repository.close()
  })

  test("is an ordinary 404 without a probe", async () => {
    const { repository, handler } = open()
    expect((await handler(new Request("http://x/harness/adaptive/capabilities"))).status).toBe(404)
    repository.close()
  })

  test("health announces adaptive only when the probe was built", async () => {
    const without = open()
    const plain = await (await without.handler(new Request("http://x/harness/health"))).json()
    expect(plain.capabilities).not.toContain("adaptive")
    without.repository.close()

    const withProbe = open({ runtimeProbe: probeWith({ pid: 1, loadedAt: 100, token: "1:100" }) })
    const announced = await (await withProbe.handler(new Request("http://x/harness/health"))).json()
    expect(announced.capabilities).toContain("adaptive")
    withProbe.repository.close()
  })
})

describe("the decision audit routes (FH-015)", () => {
  const serviceFor = (repository: SqliteRoutineRepository) => {
    const config = resolveAdaptiveConfig({ block: {}, env: {} })
    return createDecisionService({
      repository,
      config: () => config,
      egress: createAdaptiveEgressGuard({ config: () => config }),
      now: () => 1_000,
    })
  }

  const seeded = (options: HarnessHandlerOptions = {}) => {
    const repository = new SqliteRoutineRepository(":memory:")
    const service = serviceFor(repository)
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const handler = createHarnessHandler(repository, scheduler, { ...options, decisions: service })
    return { repository, service, handler }
  }

  const completion = (): DecisionRequest<"completion"> => ({
    kind: "completion",
    episodeID: "episode:run:1",
    projectID: "/work/project",
    policy: DEFAULT_DECISION_POLICY,
    state: {
      episodeID: "episode:run:1",
      objective: "fix the test",
      outcome: "success",
      toolCalls: 1,
      verifications: [{ step: "test", ok: true }],
      failures: 0,
      projectID: "/work/project",
    },
  })

  test("lists and explains under the bearer, and refuses without it", async () => {
    const { repository, service, handler } = seeded({ token: "secret" })
    await service.predict(completion())

    const forbidden = await handler(new Request("http://x/harness/adaptive/decisions"))
    expect(forbidden.status).toBe(403)
    expect((await forbidden.json()).code).toBe("invalid_token")

    const list = await handler(
      new Request("http://x/harness/adaptive/decisions?episodeID=episode:run:1", {
        headers: { authorization: "Bearer secret" },
      }),
    )
    expect(list.status).toBe(200)
    const body = await list.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].kind).toBe("completion")

    const explain = await handler(
      new Request("http://x/harness/adaptive/decisions/completion:episode:run:1", {
        headers: { authorization: "Bearer secret" },
      }),
    )
    expect(explain.status).toBe(200)
    const explained = await explain.json()
    expect(explained.data.id).toBe("completion:episode:run:1")
    expect(explained.data.question).toBe("Should this episode be marked complete?")
    repository.close()
  })

  test("explains an id the client encoded, as the cockpit sends it", async () => {
    const { repository, service, handler } = seeded()
    await service.predict(completion())

    const explain = await handler(
      new Request(`http://x/harness/adaptive/decisions/${encodeURIComponent("completion:episode:run:1")}`),
    )
    expect(explain.status).toBe(200)
    expect((await explain.json()).data.id).toBe("completion:episode:run:1")
    repository.close()
  })

  test("answers without a token, and an unknown id is a 404", async () => {
    const { repository, service, handler } = seeded()
    await service.predict(completion())
    expect((await handler(new Request("http://x/harness/adaptive/decisions"))).status).toBe(200)

    const missing = await handler(new Request("http://x/harness/adaptive/decisions/completion:nope"))
    expect(missing.status).toBe(404)
    expect((await missing.json()).code).toBe("not_found")
    repository.close()
  })

  test("is an ordinary 404 without a decision service", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const handler = createHarnessHandler(repository, scheduler)
    expect((await handler(new Request("http://x/harness/adaptive/decisions"))).status).toBe(404)
    repository.close()
  })

  test("health announces adaptive-decisions only when the service exists", async () => {
    const { repository, handler } = seeded()
    const announced = await (await handler(new Request("http://x/harness/health"))).json()
    expect(announced.capabilities).toContain("adaptive-decisions")
    repository.close()
  })
})
