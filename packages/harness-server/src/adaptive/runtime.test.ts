import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import {
  classifyRuntime,
  createRuntimeProbe,
  runtimeProbeFilePath,
  runtimeWatchFilePath,
  watchRuntime,
} from "./runtime"
import type { EngineHealth, RuntimeCanary, RuntimeWatch } from "./runtime"
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

    const noBoot = classifyRuntime({
      config,
      engine: reachable,
      canary: { pid: 12345, token, hookAt: 1001 },
      now: 2000,
    })
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

describe("watchRuntime (AH-D05)", () => {
  const empty: RuntimeWatch = { alerts: [], acknowledgedAt: 0 }
  const legacyCanary: RuntimeCanary = {
    pid: 1,
    loadedAt: 900,
    token,
    hookAt: 950,
    hook: "experimental.chat.system.transform",
  }
  const v2Canary: RuntimeCanary = { pid: 2, loadedAt: 900, token: "2:900", v2At: 950, event: "session.next.prompted" }
  const classify = (canary: RuntimeCanary | undefined, engine: EngineHealth = reachable, now = 1000) =>
    classifyRuntime({ config, engine, ...(canary ? { canary } : {}), now })

  test("the first definitive observation sets the baseline and raises nothing", () => {
    const watch = watchRuntime(empty, classify(legacyCanary))
    expect(watch).toEqual({ runtime: "legacy", version: "1.2.3", alerts: [], acknowledgedAt: 0 })
  })

  test("a switch from legacy to v2 raises a runtime change", () => {
    const before = watchRuntime(empty, classify(legacyCanary))
    const after = watchRuntime(before, classify(v2Canary, reachable, 2000))
    expect(after.runtime).toBe("v2")
    expect(after.alerts).toEqual([{ kind: "runtime-changed", from: "legacy", to: "v2", at: 2000 }])
  })

  test("a new engine version raises a version change", () => {
    const before = watchRuntime(empty, classify(legacyCanary))
    const after = watchRuntime(before, classify(legacyCanary, { reachable: true, version: "1.3.0" }, 2000))
    expect(after.version).toBe("1.3.0")
    expect(after.alerts).toEqual([{ kind: "engine-version-changed", from: "1.2.3", to: "1.3.0", at: 2000 }])
  })

  test("an unknown reading moves nothing: an engine that is down is not a change", () => {
    const before = watchRuntime(empty, classify(legacyCanary))
    const down = watchRuntime(before, classify(undefined, { reachable: false }, 2000))
    expect(down).toEqual(before)
    const back = watchRuntime(down, classify(legacyCanary, reachable, 3000))
    expect(back.alerts).toEqual([])
  })

  test("a config override is the reader's statement, not the engine changing", () => {
    const before = watchRuntime(empty, classify(legacyCanary))
    const overridden = watchRuntime(
      before,
      classifyRuntime({ config: { ...config, override: "v2" }, engine: reachable, canary: legacyCanary, now: 2000 }),
    )
    expect(overridden.runtime).toBe("legacy")
    expect(overridden.alerts).toEqual([])
  })

  test("V2 turns in a process whose legacy hook fired raise one alert per engine boot", () => {
    const mixed: RuntimeCanary = { ...legacyCanary, v2At: 960, event: "session.next.step.started" }
    const state = classify(mixed, reachable, 2000)
    // The legacy hook is still the classification's proof, which is exactly why this needs its own alert.
    expect(state.runtime).toBe("legacy")
    const first = watchRuntime(empty, state)
    expect(first.alerts).toEqual([{ kind: "v2-turns-observed", to: "session.next.step.started", at: 2000 }])
    const again = watchRuntime(first, classify({ ...mixed, v2At: 990 }, reachable, 3000))
    expect(again.alerts).toHaveLength(1)
    const rebooted = watchRuntime(
      again,
      classify({ ...mixed, loadedAt: 2500, hookAt: 2600, v2At: 2700 }, reachable, 4000),
    )
    expect(rebooted.alerts).toHaveLength(2)
  })

  test("the history is bounded", () => {
    const flapping = Array.from({ length: 30 }, (_, index) => index).reduce(
      (watch, index) =>
        watchRuntime(watch, classify(index % 2 === 0 ? legacyCanary : v2Canary, reachable, 1000 + index)),
      empty,
    )
    expect(flapping.alerts).toHaveLength(20)
    expect(flapping.alerts.at(-1)?.at).toBe(1029)
  })
})

describe("the probe's runtime alerts (AH-D05)", () => {
  const legacy = JSON.stringify({ pid: 1, loadedAt: 900, token, hookAt: 950 })
  const v2 = JSON.stringify({ pid: 2, loadedAt: 900, token: "2:900", v2At: 950, event: "session.next.prompted" })

  test("raises an alert when the runtime changes, and acknowledging clears it", async () => {
    let clock = 1000
    let canary = legacy
    const instance = createRuntimeProbe({
      engineURL: "http://127.0.0.1:4096",
      config,
      now: () => clock,
      engineHealth: async () => reachable,
      readFile: async () => canary,
    })
    await instance.refresh(true)
    expect(instance.alerts()).toEqual([])

    canary = v2
    clock = 2000
    await instance.refresh(true)
    expect(instance.alerts()).toEqual([{ kind: "runtime-changed", from: "legacy", to: "v2", at: 2000 }])

    clock = 3000
    await instance.acknowledge()
    expect(instance.alerts()).toEqual([])
  })

  test("persists the baseline, so a harness restarted onto a V2 engine still warns", async () => {
    const directory = await mkdtemp(join(os.tmpdir(), "fc-runtime-watch-"))
    const watchFile = runtimeWatchFilePath(directory)
    const start = (canary: string, clock: number) =>
      createRuntimeProbe({
        engineURL: "http://127.0.0.1:4096",
        config,
        now: () => clock,
        engineHealth: async () => reachable,
        readFile: async () => canary,
        watchFile,
      })
    try {
      await start(legacy, 1000).refresh(true)
      expect(await Bun.file(watchFile).json()).toMatchObject({ runtime: "legacy", version: "1.2.3" })

      const restarted = start(v2, 2000)
      await restarted.refresh(true)
      expect(restarted.alerts()).toEqual([{ kind: "runtime-changed", from: "legacy", to: "v2", at: 2000 }])

      await restarted.acknowledge()
      const again = start(v2, 3000)
      await again.refresh(true)
      expect(again.alerts()).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("a watch file that is not a watch starts fresh instead of failing the probe", async () => {
    const directory = await mkdtemp(join(os.tmpdir(), "fc-runtime-watch-"))
    const watchFile = runtimeWatchFilePath(directory)
    await Bun.write(watchFile, "{ not json")
    try {
      const instance = createRuntimeProbe({
        engineURL: "http://127.0.0.1:4096",
        config,
        now: () => 1000,
        engineHealth: async () => reachable,
        readFile: async () => legacy,
        watchFile,
      })
      expect((await instance.refresh(true)).runtime).toBe("legacy")
      expect(instance.alerts()).toEqual([])
      expect(await Bun.file(watchFile).json()).toMatchObject({ runtime: "legacy" })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
