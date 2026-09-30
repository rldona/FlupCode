import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHarnessServer } from "./index"
import { SqliteRoutineRepository } from "./repository"
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
  const keys = [
    "FLUPCODE_BROWSER_DISABLED",
    "FLUPCODE_ADAPTIVE_PROBE_TTL_MS",
    "FLUPCODE_CONFIG_DIR",
    "FLUPCODE_HARNESS_HOST",
  ] as const
  let directory = ""
  let previous: Array<string | undefined> = []
  let running: ReturnType<typeof createHarnessServer> | undefined

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fc-harness-runtime-"))
    previous = keys.map((key) => process.env[key])
    process.env.FLUPCODE_BROWSER_DISABLED = "1"
    process.env.FLUPCODE_CONFIG_DIR = directory
    delete process.env.FLUPCODE_ADAPTIVE_PROBE_TTL_MS
    delete process.env.FLUPCODE_HARNESS_HOST
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

  /** A real loopback server, so the acting route's wiring is exercised end to end. */
  const startAt = (overrides: { hostname?: string } = {}) => {
    const app = createHarnessServer({
      port: 0,
      databasePath: ":memory:",
      intervalMs: 3_600_000,
      browserToken: "t",
      vaultKeyFile: path.join(directory, "vault-key"),
      runtimeProbe: probe(async () => unknownState()),
      ...overrides,
    })
    running = app
    return app
  }

  const health = async (app: ReturnType<typeof createHarnessServer>): Promise<string[]> => {
    const body: unknown = await (await fetch(`http://127.0.0.1:${app.server.port}/harness/health`)).json()
    if (body && typeof body === "object" && "capabilities" in body && Array.isArray(body.capabilities))
      return body.capabilities
    return []
  }

  const postRelevance = (app: ReturnType<typeof createHarnessServer>) =>
    fetch(`http://127.0.0.1:${app.server.port}/harness/adaptive/relevance`, { method: "POST" })

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

  test("a server that cannot bind starts no background work", async () => {
    process.env.FLUPCODE_ADAPTIVE_PROBE_TTL_MS = "5"
    const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("taken") })
    const seen = { calls: 0 }
    try {
      expect(() =>
        createHarnessServer({
          port: taken.port,
          hostname: "127.0.0.1",
          databasePath: ":memory:",
          intervalMs: 3_600_000,
          browserToken: "t",
          vaultKeyFile: path.join(directory, "vault-key"),
          runtimeProbe: probe(async () => {
            seen.calls += 1
            return unknownState()
          }),
        }),
      ).toThrow()
      // The probe's refresh and its 5 ms interval come after the bind, so neither ever ran.
      await Bun.sleep(30)
      expect(seen.calls).toBe(0)
    } finally {
      await taken.stop(true)
    }
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

  test("on the loopback, the dedicated token opens the acting route and announces it", async () => {
    await writeFile(path.join(directory, "adaptive-token"), "adaptive-secret")
    const app = startAt()

    expect(await health(app)).toContain("adaptive-relevance")
    // The route exists and enforces its bearer: a call without one is refused, not served.
    expect((await postRelevance(app)).status).toBe(403)
  })

  test("on the loopback without a token, the route is absent (fail-closed)", async () => {
    const app = startAt()

    expect(await health(app)).not.toContain("adaptive-relevance")
    expect((await postRelevance(app)).status).toBe(404)
  })

  test("off the loopback a present token is inert: no route, no capability", async () => {
    await writeFile(path.join(directory, "adaptive-token"), "adaptive-secret")
    const app = startAt({ hostname: "0.0.0.0" })

    expect(await health(app)).not.toContain("adaptive-relevance")
    expect((await postRelevance(app)).status).toBe(404)
  })

  test("announces the adaptive settings surface whenever the service is built", async () => {
    const app = startAt()
    expect(await health(app)).toContain("adaptive-config")
  })
})

/**
 * Retention (FH-082, ADR-0022 §2) runs at startup on the real server, through the real config file
 * the global block is read from. The rows are seeded before the server opens the database, so the
 * drill observes exactly what the startup purge did: nothing when off, the out-of-window row when on.
 */
describe("adaptive retention at startup (FH-082, ADR-0022 §2)", () => {
  const keys = [
    "FLUPCODE_BROWSER_DISABLED",
    "FLUPCODE_CONFIG_DIR",
    "FLUPCODE_HARNESS_HOST",
    "XDG_CONFIG_HOME",
    "OPENCODE_CONFIG_DIR",
  ] as const
  let directory = ""
  let previous: Array<string | undefined> = []
  let running: ReturnType<typeof createHarnessServer> | undefined

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fc-harness-retention-"))
    previous = keys.map((key) => process.env[key])
    process.env.FLUPCODE_BROWSER_DISABLED = "1"
    process.env.FLUPCODE_CONFIG_DIR = directory
    process.env.XDG_CONFIG_HOME = directory
    delete process.env.FLUPCODE_HARNESS_HOST
    delete process.env.OPENCODE_CONFIG_DIR
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

  /** The global block the server reads: `<XDG>/opencode/opencode.json`. */
  const writeAdaptive = async (block: unknown) => {
    const config = path.join(directory, "opencode")
    await mkdir(config, { recursive: true })
    await writeFile(path.join(config, "opencode.json"), JSON.stringify({ flupcode: { adaptive: block } }))
  }

  /** One old shadow decision and one old proposed proposal, before the server opens the database. */
  const seed = (databasePath: string) => {
    const repository = new SqliteRoutineRepository(databasePath)
    repository.db
      .query(
        `INSERT INTO adaptive_decision
           (id, kind, inputs_hash, answer_json, baseline_answer_json, baseline_rule, provider, source, shadow, created_at, updated_at)
         VALUES ('retention:decision', 'completion', 'h', '{}', '{}', 'rule', 'deterministic', 'deterministic', 1, 1000, 1000)`,
      )
      .run()
    repository.db
      .query(
        `INSERT INTO skill_proposals (id, episode_id, project_id, intent, status, created_at, updated_at)
         VALUES ('retention:proposal', 'episode:r', '/p', 'add', 'proposed', 1000, 1000)`,
      )
      .run()
    repository.close()
  }

  const start = (databasePath: string) => {
    const app = createHarnessServer({
      port: 0,
      databasePath,
      intervalMs: 3_600_000,
      browserToken: "t",
      vaultKeyFile: path.join(directory, "vault-key"),
    })
    running = app
    return app
  }

  test("with retention off nothing expires; on, only the out-of-window row goes and the server lives", async () => {
    const databasePath = path.join(directory, "harness.sqlite")
    seed(databasePath)

    // Off by default: startup runs no purge, so both rows survive.
    const off = start(databasePath)
    expect(off.repository.listDecisions()).toHaveLength(1)
    expect(off.repository.listProposals()).toHaveLength(1)
    await off.stop()
    running = undefined

    // On with a one-day window: the old shadow decision is purged; the proposed proposal is exempt.
    await writeAdaptive({ retention: { enabled: true, decisionsDays: 1 } })
    const on = start(databasePath)
    expect(on.repository.listDecisions()).toHaveLength(0)
    expect(on.repository.listProposals()).toHaveLength(1)
    // The purge is fail-safe: the server answers after it, so it never took the process down.
    const health = await fetch(`http://127.0.0.1:${on.server.port}/harness/health`)
    expect(health.status).toBe(200)
  })

  test("a purge that throws is contained and rolls back: the server still answers", async () => {
    const databasePath = path.join(directory, "harness-throwing.sqlite")
    seed(databasePath)

    // A real failure on the purge's DELETE: the fail-safe must log it and carry on, and the failed
    // transaction must leave the out-of-window row it targeted untouched.
    const inject = new SqliteRoutineRepository(databasePath)
    inject.db.exec(
      "CREATE TRIGGER block_purge BEFORE DELETE ON adaptive_decision BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
    )
    inject.close()

    await writeAdaptive({ retention: { enabled: true, decisionsDays: 1 } })
    const app = start(databasePath)
    const health = await fetch(`http://127.0.0.1:${app.server.port}/harness/health`)
    expect(health.status).toBe(200)
    expect(app.repository.getDecision("retention:decision")).toBeDefined()
  })
})
