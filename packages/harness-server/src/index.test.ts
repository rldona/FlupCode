import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHarnessServer } from "./index"
import type { RuntimeCapabilities, RuntimeProbe, RuntimeState } from "./adaptive/runtime"

const unknownState = (): RuntimeState => ({
  runtime: "unknown",
  degraded: true,
  evidence: { reason: "no-evidence", engine: { url: "", reachable: false }, checkedAt: 0 },
  checkedAt: 0,
})

const capabilities: RuntimeCapabilities = {
  runtime: "unknown",
  degraded: true,
  canUseLegacyHooks: false,
  canInjectSystemPrompt: false,
  canObserveToolCalls: false,
  canObserveCompaction: false,
  canTransformMessages: false,
  canUseSdkPath: true,
  checkedAt: 0,
}

const probe = (refresh: RuntimeProbe["refresh"]): RuntimeProbe => ({
  state: unknownState,
  refresh,
  capabilities: () => capabilities,
})

/**
 * The server is built for real (a port, a repository, the scheduler) but with the probe injected, so
 * the test touches no engine and no network. The browser is killed off and the config directory is a
 * throwaway, so no reader's real files are read or written.
 */
describe("createHarnessServer runtime probe wiring", () => {
  const keys = ["FLUPCODE_BROWSER_DISABLED", "FLUPCODE_ADAPTIVE_PROBE_TTL_MS", "FLUPCODE_CONFIG_DIR"] as const
  let directory = ""
  let previous: Array<string | undefined> = []
  let running: ReturnType<typeof createHarnessServer> | undefined

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fc-harness-runtime-"))
    previous = keys.map((key) => process.env[key])
    process.env.FLUPCODE_BROWSER_DISABLED = "1"
    process.env.FLUPCODE_CONFIG_DIR = directory
    delete process.env.FLUPCODE_ADAPTIVE_PROBE_TTL_MS
  })

  afterEach(async () => {
    await running?.stop()
    running = undefined
    for (const [index, key] of keys.entries()) {
      const value = previous[index]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  })

  const start = (runtimeProbe: RuntimeProbe) => {
    const app = createHarnessServer({
      port: 0,
      databasePath: ":memory:",
      intervalMs: 3_600_000,
      browserToken: "t",
      vaultKeyFile: path.join(directory, "vault-key"),
      runtimeProbe,
    })
    running = app
    return app
  }

  test("starting the server does not wait for the probe's first refresh", () => {
    let calls = 0
    const app = start(
      probe(() => {
        calls += 1
        return new Promise<RuntimeState>(() => {})
      }),
    )

    // The probe's refresh never resolves; the server still comes back and keeps the injected probe.
    expect(calls).toBe(1)
    expect(app.runtimeProbe).toBeDefined()
  })

  test("stop clears the probe interval so it stops refreshing", async () => {
    process.env.FLUPCODE_ADAPTIVE_PROBE_TTL_MS = "5"
    const seen = { calls: 0 }
    const app = start(
      probe(async () => {
        seen.calls += 1
        return unknownState()
      }),
    )

    const deadline = Date.now() + 2_000
    while (seen.calls < 2 && Date.now() < deadline) await Bun.sleep(5)
    expect(seen.calls).toBeGreaterThanOrEqual(2)

    await app.stop()
    running = undefined
    const afterStop = seen.calls
    await Bun.sleep(50)
    expect(seen.calls).toBe(afterStop)
  })
})
