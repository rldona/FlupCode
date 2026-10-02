import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { SqliteRoutineRepository } from "../repository"
import { createVault } from "../vault"
import { resolveAdaptiveConfig } from "./config"
import { DEFAULT_DECISION_POLICY } from "./decision"
import type { DecisionRequest } from "./decision"
import { createDecisionService } from "./decision-service"
import { createAdaptiveEgressGuard } from "./egress"
import { createModelKeys } from "./model-key"
import { createGovernor } from "./providers/governor"
import { createHttpModel, jevSettings } from "./providers/jev"
import type { JevFetch } from "./providers/jev"

// Test values only: none of these is a real key.
const SECRET = "provider-test-key-0001"
const LEGACY_SECRET = "legacy-stored-test-key-0002"
const NOW = Date.parse("2026-10-03T12:00:00Z")

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const completion = (): DecisionRequest<"completion"> => ({
  kind: "completion",
  episodeID: "episode:run:1",
  sessionID: "ses_1",
  projectID: "/work/project",
  policy: DEFAULT_DECISION_POLICY,
  state: {
    episodeID: "episode:run:1",
    objective: `fix the failing test ${"and keep the change small ".repeat(60)}`,
    outcome: "success",
    toolCalls: 3,
    verifications: [{ step: "test", ok: true }],
    failures: 0,
    projectID: "/work/project",
  },
})

/** Only the network boundary is faked: every call is recorded and answered "complete". */
const recorder = () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  const fetch: JevFetch = async (input) => {
    calls.push({ url: input.url, headers: input.headers, body: input.body })
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ model: "classifier-2", answers: { w0: { type: "noul", probability: 0.95 } } }),
    }
  }
  return { calls, fetch }
}

/** The live composition `index.ts` builds, on one repository: vault, keys, egress, governor, HTTP model. */
const stack = (input: { block: Record<string, unknown>; env?: NodeJS.ProcessEnv; repository?: SqliteRoutineRepository }) => {
  const repository = input.repository ?? new SqliteRoutineRepository(":memory:")
  cleanups.push(() => repository.close())
  const vault = createVault({ store: repository, key: Buffer.alloc(32, 9) })
  const keys = createModelKeys({ env: input.env ?? {}, vault })
  const config = resolveAdaptiveConfig({ block: input.block, env: {} })
  const egress = createAdaptiveEgressGuard({ config: () => config })
  const { calls, fetch } = recorder()
  const model = createHttpModel({ egress, providers: () => config.providers, keys, fetch })
  const governor = createGovernor({ config: () => config.governor, store: repository, now: () => NOW })
  const service = createDecisionService({ repository, config: () => config, egress, models: [model], governor, now: () => NOW })
  return { repository, vault, keys, config, egress, model, service, calls }
}

describe("a config using only adaptive.providers (PI-01)", () => {
  const block = {
    models: { completion: "jev" },
    providers: {
      jev: {
        endpoint: "https://classifier.test/v2/predict",
        model: "classifier-2",
        timeoutMs: 250,
        maxInputChars: 600,
        keyRef: "classifier-key",
        budget: { monthlyTokens: 5_000 },
      },
    },
    egress: { providers: { jev: { enabled: true, projects: ["/work/project"], kinds: { completion: true } } } },
  }

  test("resolves every field, and nothing else", () => {
    const config = resolveAdaptiveConfig({ block, env: {} })
    expect(config.providers).toEqual({ jev: block.providers.jev })
    expect(config.models).toEqual({ completion: "jev" })
    expect(jevSettings(config.providers.jev)).toEqual({
      endpoint: "https://classifier.test/v2/predict",
      model: "classifier-2",
      timeoutMs: 250,
      keyRef: "classifier-key",
    })
  })

  test("a malformed field is dropped, not guessed", () => {
    const config = resolveAdaptiveConfig({
      block: {
        providers: {
          jev: { endpoint: "", timeoutMs: -1, maxInputChars: "600", keyRef: "has space", budget: { monthlyTokens: 0 } },
          "bad id": { model: "x" },
        },
      },
      env: {},
    })
    expect(config.providers).toEqual({ jev: {} })
  })

  test("the model asks its endpoint and model with the key stored under its reference, within its input bound", async () => {
    const { keys, service, calls, model, egress } = stack({ block })
    expect(model.keySlot?.()).toEqual({ ref: "classifier-key", endpoint: "https://classifier.test/v2/predict" })
    keys.set(model.keySlot!(), SECRET)

    const result = await service.predict(completion())
    expect(result.source).toBe("model")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://classifier.test/v2/predict")
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(calls[0]!.body).model).toBe("classifier-2")
    // The bound is on the serialized state and questions the guard prepares, and the body carries that state.
    const prepared = egress.prepare(completion())
    expect(prepared.serialized.length).toBeLessThanOrEqual(600)
    expect(JSON.stringify(completion().state).length).toBeGreaterThan(600)
    expect(JSON.parse(calls[0]!.body).state).toBe(prepared.state.text)
  })

  test("the provider's own budget stops it before the layer's does", async () => {
    const tight = { ...block, providers: { jev: { ...block.providers.jev, budget: { monthlyTokens: 1 } } } }
    const { service, calls } = stack({ block: tight })
    const result = await service.predict(completion())
    expect(calls).toHaveLength(0)
    expect(result.source).toBe("fallback")
    expect(result.degradedReason).toBe("budget-exhausted")
  })

  test("the key is read from FLUPCODE_<REF> first", async () => {
    const { calls, service } = stack({ block, env: { FLUPCODE_CLASSIFIER_KEY: SECRET } })
    await service.predict(completion())
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`)
  })
})

describe("an old config still loads (PI-01)", () => {
  // The config file as an older build wrote it, read the way the server reads the global block.
  const fixture = parse(readFileSync(join(import.meta.dir, "fixtures/legacy/opencode.jsonc"), "utf8")) as {
    flupcode: { adaptive: Record<string, unknown> }
  }
  const legacy = fixture.flupcode.adaptive

  test("jev.* is read as the provider's settings, its switch and its consent; allowJev as allowModel", () => {
    const config = resolveAdaptiveConfig({ block: legacy, env: {} })
    expect(config.providers).toEqual({
      jev: { endpoint: "https://api.typesafe.test/v1/systemone", model: "jev-1.12.0", timeoutMs: 300, maxInputChars: 900 },
    })
    expect(Object.values(config.models)).toEqual(Array(5).fill("jev"))
    expect(config.egress.providers.jev).toMatchObject({ enabled: true, projects: ["/work/project"] })
    expect(config.egress.providers.jev?.kinds).toMatchObject({ completion: true, skillRelevance: true })
    expect(config.decisions.skillRelevance).toMatchObject({ allowModel: false, minConfidence: 0.7 })
    expect(config.decisions.completion.allowModel).toBe(true)
    expect(config.budget.monthlyTokens).toBe(50_000)
  })

  test("a field the new block sets wins over the old one, field by field", () => {
    const config = resolveAdaptiveConfig({
      block: { ...legacy, providers: { jev: { model: "classifier-2" } }, decisions: { skillRelevance: { allowJev: false, allowModel: true } } },
      env: {},
    })
    expect(config.providers.jev).toEqual({
      endpoint: "https://api.typesafe.test/v1/systemone",
      model: "classifier-2",
      timeoutMs: 300,
      maxInputChars: 900,
    })
    expect(config.decisions.skillRelevance.allowModel).toBe(true)
  })

  test("a key an older build stored is still sent, with no move and no re-encryption", async () => {
    const { vault, calls, service } = stack({ block: legacy })
    // What the panel stored before PI-01: the fixed name, bound to the configured endpoint's origin.
    vault.set({ name: "typesafe-api-key", origin: "https://api.typesafe.test", secret: LEGACY_SECRET })
    const before = vault.list()

    await service.predict(completion())
    expect(calls[0]!.url).toBe("https://api.typesafe.test/v1/systemone")
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${LEGACY_SECRET}`)
    expect(vault.list()).toEqual(before)
  })

  test("TYPESAFE_API_KEY is still read, and the new variable wins over it", async () => {
    const legacyEnv = stack({ block: legacy, env: { TYPESAFE_API_KEY: LEGACY_SECRET } })
    await legacyEnv.service.predict(completion())
    expect(legacyEnv.calls[0]!.headers.authorization).toBe(`Bearer ${LEGACY_SECRET}`)
    expect(legacyEnv.keys.status(legacyEnv.model.keySlot!()).env).toBe("FLUPCODE_TYPESAFE_API_KEY")

    const both = stack({ block: legacy, env: { TYPESAFE_API_KEY: LEGACY_SECRET, FLUPCODE_TYPESAFE_API_KEY: SECRET } })
    await both.service.predict(completion())
    expect(both.calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`)
  })

  test("a persisted policy row written with allowJev reads back as allowModel", () => {
    const directory = mkdtempSync(join(tmpdir(), "flupcode-pi01-"))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, "harness.sqlite")
    const writer = new SqliteRoutineRepository(path)
    const stored = writer.createDecision({
      id: "skillRelevance:ses_1:msg_1",
      kind: "skillRelevance",
      inputsHash: "a".repeat(64),
      stateSummary: {},
      answer: { skills: [] },
      baselineAnswer: { skills: [] },
      baselineRule: "lexical",
      provider: "deterministic",
      source: "baseline",
      degraded: false,
      latencyMs: 1,
      policy: { ...DEFAULT_DECISION_POLICY, allowModel: false },
      shadow: true,
    })
    writer.close()
    // Rewrite the row's policy exactly as an older build stored it.
    const db = new Database(path)
    db.query("UPDATE adaptive_decision SET policy_json = ?1 WHERE id = ?2").run(
      JSON.stringify({ allowJev: false, minConfidence: 0.6, minProbability: 0.5, timeoutMs: 400 }),
      stored.id,
    )
    db.close()

    const reader = new SqliteRoutineRepository(path)
    cleanups.push(() => reader.close())
    expect(reader.getDecision(stored.id)?.policy).toEqual({
      allowModel: false,
      minConfidence: 0.6,
      minProbability: 0.5,
      timeoutMs: 400,
    })
  })
})
