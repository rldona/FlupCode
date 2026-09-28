import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { classifyRuntime, createRuntimeProbe, runtimeProbeFilePath } from "./runtime"
import type { EngineHealth } from "./runtime"
import type { RuntimeProbeConfig } from "./runtime-config"

const config: RuntimeProbeConfig = { enabled: true, ttlMs: 60_000, override: "auto", versionMap: {} }

const reachable: EngineHealth = { reachable: true, version: "1.2.3" }

const token = "12345:1000"

describe("classifyRuntime", () => {
  test("a live hook inside the current process is the proof of legacy", () => {
    const state = classifyRuntime({
      config,
      engine: reachable,
      canary: { pid: 12345, loadedAt: 1000, token, hookAt: 1001, hook: "experimental.chat.system.transform" },
      now: 2000,
    })
    expect(state.runtime).toBe("legacy")
    expect(state.degraded).toBe(false)
    expect(state.evidence.reason).toBe("legacy-hook-fired")
  })

  test("a hook from before this boot is not legacy", () => {
    const state = classifyRuntime({
      config,
      engine: reachable,
      canary: { pid: 12345, loadedAt: 2000, token, hookAt: 1000 },
      now: 3000,
    })
    expect(state.runtime).toBe("unknown")
    expect(state.degraded).toBe(true)
    expect(state.evidence.reason).toBe("no-evidence")
  })

  test("a V2 turn event is the proof of v2", () => {
    const state = classifyRuntime({
      config,
      engine: reachable,
      canary: { pid: 12345, loadedAt: 1000, token, v2At: 1002, event: "session.next.prompted" },
      now: 2000,
    })
    expect(state.runtime).toBe("v2")
    expect(state.degraded).toBe(true)
    expect(state.evidence.reason).toBe("v2-turn-observed")
  })

  test("legacy wins when both signals are present", () => {
    const state = classifyRuntime({
      config,
      engine: reachable,
      canary: { pid: 12345, loadedAt: 1000, token, hookAt: 1001, v2At: 1002 },
      now: 2000,
    })
    expect(state.runtime).toBe("legacy")
  })

  test("an unreachable engine degrades whatever the canary says", () => {
    const state = classifyRuntime({
      config,
      engine: { reachable: false },
      canary: { pid: 12345, loadedAt: 1000, token, hookAt: 1001 },
      now: 2000,
    })
    expect(state.runtime).toBe("unknown")
    expect(state.evidence.reason).toBe("engine-unreachable")
    expect(state.evidence.engine.url).toBe("")
  })

  test("a canary without pid, loadedAt or token is unreadable, never legacy", () => {
    const noPid = classifyRuntime({
      config,
      engine: reachable,
      canary: { loadedAt: 1000, token, hookAt: 1001 },
      now: 2000,
    })
    expect(noPid.runtime).toBe("unknown")
    expect(noPid.evidence.reason).toBe("canary-unreadable")

    const noBoot = classifyRuntime({ config, engine: reachable, canary: { pid: 12345, token, hookAt: 1001 }, now: 2000 })
    expect(noBoot.runtime).toBe("unknown")
    expect(noBoot.evidence.reason).toBe("canary-unreadable")

    // A pid that looks current and a hook that fired after it still prove nothing without the token:
    // the OS reuses pids, so this file could be another process's.
    const noToken = classifyRuntime({
      config,
      engine: reachable,
      canary: { pid: 12345, loadedAt: 1000, hookAt: 1001, hook: "experimental.chat.system.transform" },
      now: 2000,
    })
    expect(noToken.runtime).toBe("unknown")
    expect(noToken.evidence.reason).toBe("canary-unreadable")
  })

  test("a missing canary is no evidence, not a failure", () => {
    const state = classifyRuntime({ config, engine: reachable, now: 2000 })
    expect(state.runtime).toBe("unknown")
    expect(state.evidence.reason).toBe("no-evidence")
    expect(state.evidence.canary).toBeUndefined()
  })

  test("the config can pin the runtime, and off disables the probe", () => {
    const pinnedLegacy = classifyRuntime({ config: { ...config, override: "legacy" }, engine: reachable, now: 1 })
    expect(pinnedLegacy.runtime).toBe("legacy")
    expect(pinnedLegacy.degraded).toBe(false)
    expect(pinnedLegacy.evidence.reason).toBe("config-override")

    const pinnedV2 = classifyRuntime({ config: { ...config, override: "v2" }, engine: reachable, now: 1 })
    expect(pinnedV2.runtime).toBe("v2")
    expect(pinnedV2.evidence.reason).toBe("config-override")

    const off = classifyRuntime({ config: { ...config, override: "off" }, engine: reachable, now: 1 })
    expect(off.runtime).toBe("unknown")
    expect(off.evidence.reason).toBe("probe-disabled")

    const disabled = classifyRuntime({ config: { ...config, enabled: false }, engine: reachable, now: 1 })
    expect(disabled.evidence.reason).toBe("probe-disabled")
  })

  test("an engine version maps to a runtime only when the map says so", () => {
    const state = classifyRuntime({
      config: { ...config, versionMap: { "1.2.3": "v2" } },
      engine: reachable,
      now: 1,
    })
    expect(state.runtime).toBe("v2")
    expect(state.evidence.reason).toBe("version-map")

    const unmapped = classifyRuntime({ config, engine: reachable, now: 1 })
    expect(unmapped.runtime).toBe("unknown")
    expect(unmapped.evidence.reason).toBe("no-evidence")
  })
})

describe("runtimeProbeFilePath", () => {
  test("prefers the explicit file, then the XDG data home", () => {
    expect(runtimeProbeFilePath({ FLUPCODE_RUNTIME_PROBE_FILE: "/tmp/probe.json" })).toBe("/tmp/probe.json")
    expect(runtimeProbeFilePath({ XDG_DATA_HOME: "/xdg" })).toBe(join("/xdg", "flupcode", "runtime-probe.json"))
    expect(runtimeProbeFilePath({})).toContain(join("flupcode", "runtime-probe.json"))
  })
})

describe("createRuntimeProbe", () => {
  const probe = (overrides: Partial<Parameters<typeof createRuntimeProbe>[0]>) =>
    createRuntimeProbe({ engineURL: "http://127.0.0.1:4096", config, ...overrides })

  test("starts unknown and classifies from the engine and the canary", async () => {
    let clock = 1000
    const seen: string[] = []
    const instance = probe({
      now: () => clock,
      engineHealth: async (url) => {
        seen.push(url)
        return reachable
      },
      readFile: async () => JSON.stringify({ pid: 1, loadedAt: 900, token, hookAt: 950 }),
    })

    expect(instance.state().runtime).toBe("unknown")
    expect(instance.capabilities().canUseLegacyHooks).toBe(false)

    const state = await instance.refresh(true)
    expect(state.runtime).toBe("legacy")
    expect(state.evidence.engine.url).toBe("http://127.0.0.1:4096")
    expect(seen).toEqual(["http://127.0.0.1:4096"])
    expect(instance.capabilities()).toMatchObject({ runtime: "legacy", canUseLegacyHooks: true, canUseSdkPath: true })
  })

  test("caches until the TTL passes, and force bypasses it", async () => {
    let clock = 1000
    let calls = 0
    const instance = probe({
      now: () => clock,
      engineHealth: async () => {
        calls += 1
        return { reachable: false }
      },
      readFile: async () => undefined,
    })

    await instance.refresh(true)
    expect(calls).toBe(1)

    await instance.refresh()
    expect(calls).toBe(1)

    clock += 60_001
    await instance.refresh()
    expect(calls).toBe(2)

    await instance.refresh(true)
    expect(calls).toBe(3)
  })

  test("coalesces concurrent refreshes into one pass", async () => {
    let calls = 0
    let reads = 0
    const gate: { release?: (health: EngineHealth) => void } = {}
    const pending = new Promise<EngineHealth>((resolve) => {
      gate.release = resolve
    })
    const instance = probe({
      engineHealth: async () => {
        calls += 1
        return pending
      },
      readFile: async () => {
        reads += 1
        return undefined
      },
    })

    const first = instance.refresh(true)
    const second = instance.refresh(true)
    gate.release?.({ reachable: true, version: "9" })
    await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(reads).toBe(1)
  })

  test("the first refresh probes without being forced", async () => {
    let calls = 0
    const instance = probe({
      now: () => 1000,
      engineHealth: async () => {
        calls += 1
        return reachable
      },
      readFile: async () => JSON.stringify({ pid: 1, loadedAt: 900, token, hookAt: 950 }),
    })

    // checkedAt starts at 0, so the freshness check cannot swallow the very first pass.
    expect(instance.state().checkedAt).toBe(0)
    const state = await instance.refresh()
    expect(calls).toBe(1)
    expect(state.runtime).toBe("legacy")
    expect(state.checkedAt).toBe(1000)
  })

  test("grants every legacy flag only on legacy, and none otherwise", async () => {
    const legacy = probe({
      now: () => 1000,
      engineHealth: async () => reachable,
      readFile: async () =>
        JSON.stringify({ pid: 1, loadedAt: 900, token, hookAt: 950, hook: "experimental.chat.system.transform" }),
    })
    await legacy.refresh(true)
    expect(legacy.capabilities()).toMatchObject({
      runtime: "legacy",
      degraded: false,
      canUseLegacyHooks: true,
      canInjectSystemPrompt: true,
      canObserveToolCalls: true,
      canObserveCompaction: true,
      canTransformMessages: true,
      canUseSdkPath: true,
    })

    const v2 = probe({
      now: () => 1000,
      engineHealth: async () => reachable,
      readFile: async () => JSON.stringify({ pid: 1, loadedAt: 900, token, v2At: 950 }),
    })
    await v2.refresh(true)
    expect(v2.capabilities()).toMatchObject({
      runtime: "v2",
      degraded: true,
      canUseLegacyHooks: false,
      canInjectSystemPrompt: false,
      canObserveToolCalls: false,
      canObserveCompaction: false,
      canTransformMessages: false,
      canUseSdkPath: true,
    })

    const unknown = probe({ now: () => 1000, engineHealth: async () => reachable, readFile: async () => undefined })
    await unknown.refresh(true)
    expect(unknown.capabilities()).toMatchObject({
      runtime: "unknown",
      degraded: true,
      canUseLegacyHooks: false,
      canInjectSystemPrompt: false,
      canObserveToolCalls: false,
      canObserveCompaction: false,
      canTransformMessages: false,
      canUseSdkPath: true,
    })
  })

  test("a canary file that cannot be understood never reads as legacy", async () => {
    const malformed = [
      "{not json",
      JSON.stringify({ pid: "1", loadedAt: 2, token, hookAt: 3 }),
      JSON.stringify({ loadedAt: 2, token, hookAt: 3 }),
      JSON.stringify({ pid: 1, loadedAt: 2, hookAt: 3 }),
      JSON.stringify({}),
    ]
    for (const text of malformed) {
      const instance = probe({ now: () => 1000, engineHealth: async () => reachable, readFile: async () => text })
      const state = await instance.refresh(true)
      expect(state.runtime).toBe("unknown")
      expect(state.evidence.reason).toBe("canary-unreadable")
      expect(instance.capabilities().canUseLegacyHooks).toBe(false)
    }
  })

  test("never throws when the engine or the canary is broken", async () => {
    const down = probe({
      now: () => 1,
      engineHealth: async () => {
        throw new Error("down")
      },
      readFile: async () => undefined,
    })
    const unreachable = await down.refresh(true)
    expect(unreachable.runtime).toBe("unknown")
    expect(unreachable.evidence.reason).toBe("engine-unreachable")

    const brokenCanary = probe({
      now: () => 1,
      engineHealth: async () => reachable,
      readFile: async () => {
        throw new Error("unreadable")
      },
    })
    const unreadable = await brokenCanary.refresh(true)
    expect(unreadable.runtime).toBe("unknown")
    expect(unreadable.evidence.reason).toBe("canary-unreadable")

    // A health check that answers with something other than the promised shape degrades, not throws.
    const garbageEngine = probe({
      now: () => 1,
      engineHealth: async () => null as unknown as EngineHealth,
      readFile: async () => undefined,
    })
    const garbage = await garbageEngine.refresh(true)
    expect(garbage.runtime).toBe("unknown")
    expect(garbage.evidence.reason).toBe("engine-unreachable")
  })
})
