import { describe, expect, test } from "bun:test"
import { DEFAULT_RUNTIME_PROBE_CONFIG, resolveRuntimeConfig } from "./runtime-config"

describe("resolveRuntimeConfig", () => {
  test("falls back to defaults with nothing set", () => {
    expect(resolveRuntimeConfig({ env: {} })).toEqual(DEFAULT_RUNTIME_PROBE_CONFIG)
  })

  test("reads the flupcode.adaptive block", () => {
    const config = resolveRuntimeConfig({
      block: {
        runtime: "v2",
        probe: { enabled: false, ttlMs: 5000 },
        runtimeMap: { "1.2.3": "legacy", broken: "nope", other: 7 },
      },
      env: {},
    })
    expect(config).toEqual({ enabled: false, ttlMs: 5000, override: "v2", versionMap: { "1.2.3": "legacy" } })
  })

  test("the environment wins over the block", () => {
    const config = resolveRuntimeConfig({
      block: { runtime: "legacy", probe: { enabled: true, ttlMs: 5000 }, runtimeMap: { "9": "v2" } },
      env: {
        FLUPCODE_ADAPTIVE_RUNTIME: "off",
        FLUPCODE_ADAPTIVE_PROBE_DISABLED: "1",
        FLUPCODE_ADAPTIVE_PROBE_TTL_MS: "7000",
      },
    })
    expect(config).toEqual({ enabled: false, ttlMs: 7000, override: "off", versionMap: { "9": "v2" } })
  })

  test("ignores malformed values rather than guessing", () => {
    const config = resolveRuntimeConfig({
      block: { runtime: "nope", probe: { enabled: "yes", ttlMs: -1 }, runtimeMap: [] },
      env: { FLUPCODE_ADAPTIVE_RUNTIME: "nope", FLUPCODE_ADAPTIVE_PROBE_TTL_MS: "abc" },
    })
    expect(config).toEqual(DEFAULT_RUNTIME_PROBE_CONFIG)
  })
})
