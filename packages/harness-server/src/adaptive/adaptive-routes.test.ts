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
import type { StoredDecisionInput } from "../types"

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

describe("the runtime alert acknowledgement (AH-D05)", () => {
  const changing = () => {
    let canary: unknown = { pid: 1, loadedAt: 100, token: "1:100", hookAt: 200 }
    let clock = 1_000
    const probe = createRuntimeProbe({
      engineURL: "http://127.0.0.1:4096",
      now: () => clock,
      engineHealth: async () => ({ reachable: true, version: "1.2.3" }),
      readFile: async () => JSON.stringify(canary),
    })
    return {
      probe,
      switchToV2: async () => {
        canary = { pid: 2, loadedAt: 100, token: "2:100", v2At: 200, event: "session.next.prompted" }
        clock = 2_000
        await probe.refresh(true)
      },
    }
  }
  const acknowledge = (token?: string) =>
    new Request("http://x/harness/adaptive/runtime/acknowledge", {
      method: "POST",
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    })

  test("clears the alerts with the writer bearer and is announced with it", async () => {
    const runtime = changing()
    await runtime.probe.refresh(true)
    await runtime.switchToV2()
    expect(runtime.probe.alerts()).toHaveLength(1)
    const { repository, handler } = open({ runtimeProbe: runtime.probe, token: "writer" })
    const health = await (await handler(new Request("http://x/harness/health"))).json()
    expect(health.capabilities).toContain("adaptive-runtime-alerts")

    expect((await handler(acknowledge("wrong"))).status).toBe(403)
    expect(runtime.probe.alerts()).toHaveLength(1)

    const response = await handler(acknowledge("writer"))
    expect(response.status).toBe(200)
    expect((await response.json()).data.alerts).toEqual([])
    expect(runtime.probe.alerts()).toEqual([])
    repository.close()
  })

  test("does not exist without the writer bearer", async () => {
    const runtime = changing()
    const { repository, handler } = open({ runtimeProbe: runtime.probe })
    const health = await (await handler(new Request("http://x/harness/health"))).json()
    expect(health.capabilities).not.toContain("adaptive-runtime-alerts")
    expect((await handler(acknowledge())).status).toBe(404)
    repository.close()
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

  describe("a page of the audit (AH-E05)", () => {
    const row = (index: number, overrides: Partial<StoredDecisionInput> = {}): StoredDecisionInput => ({
      id: `d:${String(index).padStart(3, "0")}`,
      kind: index % 2 === 0 ? "completion" : "skillRelevance",
      sessionID: "ses_1",
      inputsHash: "a".repeat(64),
      stateSummary: {},
      answer: true,
      baselineAnswer: true,
      baselineRule: "default",
      provider: "baseline",
      source: "baseline",
      degraded: false,
      latencyMs: 1,
      policy: DEFAULT_DECISION_POLICY,
      // Every third row acted; one of the acting ones sat in the holdout control arm.
      shadow: index % 3 !== 0,
      ...(index === 3 ? { arm: "control" as const } : {}),
      ...overrides,
    })
    const page = async (handler: (request: Request) => Promise<Response>, query: string) => {
      const response = await handler(new Request(`http://x/harness/adaptive/decisions?${query}`))
      expect(response.status).toBe(200)
      return (await response.json()) as { data: Array<{ id: string; kind: string; shadow: boolean; arm?: string }>; nextCursor?: string }
    }
    const seed = (repository: SqliteRoutineRepository) =>
      // Pairs share a timestamp, so the cursor has to break ties by id to neither repeat nor skip.
      Array.from({ length: 25 }, (_, index) => repository.createDecision(row(index), 1_000 + Math.floor(index / 2)))

    test("pages newest first with a stable cursor until every row was read exactly once", async () => {
      const { repository, handler } = seeded()
      seed(repository)
      const first = await page(handler, "limit=10")
      expect(first.data.map((entry) => entry.id)).toEqual(
        Array.from({ length: 10 }, (_, index) => `d:${String(24 - index).padStart(3, "0")}`),
      )
      expect(first.nextCursor).toBe("1007,d:015")
      // A row written between two pages is newer than the cursor, so it cannot shift the next page.
      repository.createDecision(row(99), 5_000)
      const second = await page(handler, `limit=10&before=${encodeURIComponent(first.nextCursor!)}`)
      const third = await page(handler, `limit=10&before=${encodeURIComponent(second.nextCursor!)}`)
      expect(third.data).toHaveLength(5)
      expect(third.nextCursor).toBeUndefined()
      const ids = [...first.data, ...second.data, ...third.data].map((entry) => entry.id)
      expect(new Set(ids).size).toBe(25)
      expect(ids).not.toContain("d:099")
      repository.close()
    })

    test("a page exactly full says there is nothing after it, and no limit keeps the old whole list", async () => {
      const { repository, handler } = seeded()
      seed(repository)
      expect((await page(handler, "limit=25")).nextCursor).toBeUndefined()
      const all = await page(handler, "")
      expect(all.data).toHaveLength(25)
      expect(all.nextCursor).toBeUndefined()
      repository.close()
    })

    test("filters by kind and by whether the harness acted, and pages inside the filter", async () => {
      const { repository, handler } = seeded()
      seed(repository)
      const kind = await page(handler, "kind=completion&limit=5")
      expect(kind.data.every((entry) => entry.kind === "completion")).toBe(true)
      expect(kind.data).toHaveLength(5)
      const rest = await page(handler, `kind=completion&limit=10&before=${encodeURIComponent(kind.nextCursor!)}`)
      expect(rest.nextCursor).toBeUndefined()
      expect(new Set([...kind.data, ...rest.data].map((entry) => entry.id)).size).toBe(13)

      const acted = await page(handler, "acted=true")
      expect(acted.data.map((entry) => entry.id).sort()).toEqual(
        ["d:000", "d:006", "d:009", "d:012", "d:015", "d:018", "d:021", "d:024"],
      )
      const recorded = await page(handler, "acted=false")
      expect(recorded.data).toHaveLength(17)
      // The held-out row was not applied, so it is only recorded even though it is not shadow.
      expect(recorded.data.map((entry) => entry.id)).toContain("d:003")
      expect((await page(handler, "acted=maybe")).data).toHaveLength(25)
      repository.close()
    })

    test("reads one decision by id, and a cursor that does not parse is ignored", async () => {
      const { repository, handler } = seeded()
      seed(repository)
      expect((await page(handler, "id=d:007")).data.map((entry) => entry.id)).toEqual(["d:007"])
      expect((await page(handler, "id=d:nope")).data).toEqual([])
      expect((await page(handler, "limit=3&before=garbage")).data.map((entry) => entry.id)).toEqual([
        "d:024",
        "d:023",
        "d:022",
      ])
      repository.close()
    })
  })
})
