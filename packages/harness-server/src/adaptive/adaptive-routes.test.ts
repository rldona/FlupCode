import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "../api"
import type { HarnessHandlerOptions } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import { createRuntimeProbe } from "./runtime"

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
