/**
 * The relevance service (FH-04, ADR-0021).
 *
 * With a spy decision service this asserts the service's own contract: it is inert on every gate
 * (off, master kill switch, non-legacy runtime, no objective, no roster), it asks for the selection
 * exactly once per turn and passes `mode: "hot"` with `shadow: false`, it ranks only roster names,
 * and it never throws toward the caller.
 */

import { describe, expect, test } from "bun:test"
import { resolveAdaptiveConfig } from "./config"
import type { DecisionKind, DecisionRequest, DecisionResult } from "./decision"
import type { DecisionService, PredictionMode } from "./decision-service"
import { createRelevanceService } from "./relevance"
import type { RuntimeCapabilities, RuntimeKind } from "./runtime"
import type { SkillRosterEntry } from "./skills/curator"

const NOW = 1_700_000_000_000

const roster: SkillRosterEntry[] = [
  { name: "testing", description: "write focused tests", learned: false },
  { name: "release", description: "cut a release", learned: false },
]

const capabilities = (runtime: RuntimeKind, canInject: boolean): RuntimeCapabilities => ({
  runtime,
  degraded: runtime !== "legacy",
  canUseLegacyHooks: canInject,
  canInjectSystemPrompt: canInject,
  canObserveToolCalls: canInject,
  canObserveCompaction: canInject,
  canTransformMessages: canInject,
  canUseSdkPath: true,
  checkedAt: 0,
})

const decision = (load: string[], over: Partial<DecisionResult<"skillRelevance">> = {}): DecisionResult<"skillRelevance"> => ({
  kind: "skillRelevance",
  answer: { load },
  source: "deterministic",
  provider: "deterministic",
  latencyMs: 0,
  degraded: false,
  baseline: { load },
  baselineRule: "lexical-objective-match",
  inputsHash: "hash",
  decidedAt: NOW,
  ...over,
})

/** A real-shaped service whose one observable is how it was called and what it answers. */
const spyService = (result: DecisionResult<"skillRelevance"> | Error) => {
  const calls: Array<{ mode: PredictionMode | undefined; shadow: boolean | undefined }> = []
  const predict = async <Q extends DecisionKind>(
    _request: DecisionRequest<Q>,
    mode?: PredictionMode,
    shadow?: boolean,
  ): Promise<DecisionResult<Q>> => {
    calls.push({ mode, shadow })
    if (result instanceof Error) throw result
    return result as unknown as DecisionResult<Q>
  }
  const service: DecisionService = { predict, decisions: () => [], explain: () => undefined }
  return { service, calls }
}

const serviceFor = (input: {
  config?: ReturnType<typeof resolveAdaptiveConfig>
  roster?: SkillRosterEntry[]
  runtime?: RuntimeCapabilities
  result?: DecisionResult<"skillRelevance"> | Error
}) => {
  const spy = spyService(input.result ?? decision(["testing"]))
  const config = input.config ?? resolveAdaptiveConfig({ block: { relevance: { enabled: true } }, env: {} })
  const relevance = createRelevanceService({
    service: spy.service,
    curator: { roster: () => input.roster ?? roster },
    runtimeProbe: { capabilities: () => input.runtime ?? capabilities("legacy", true) },
    config: () => config,
    now: () => NOW,
  })
  return { relevance, spy }
}

const request = { projectID: "/work/project", sessionID: "ses_1", messageID: "msg_1", objective: "fix the parser test" }

describe("createRelevanceService", () => {
  test("is inert when the feature is off, and never asks the decision service", async () => {
    const { relevance, spy } = serviceFor({
      config: resolveAdaptiveConfig({ block: { relevance: { enabled: false } }, env: {} }),
    })
    const result = await relevance.suggest(request)
    expect(result).toMatchObject({ line: null, reason: "disabled", source: "none", skills: [] })
    expect(spy.calls).toHaveLength(0)
  })

  test("is inert under the master kill switch", async () => {
    const { relevance, spy } = serviceFor({
      config: resolveAdaptiveConfig({ env: { FLUPCODE_ADAPTIVE_DISABLED: "1" } }),
    })
    expect((await relevance.suggest(request)).reason).toBe("disabled")
    expect(spy.calls).toHaveLength(0)
  })

  test("the master kill switch beats an explicitly enabled relevance slice", async () => {
    const fromEnv = serviceFor({
      config: resolveAdaptiveConfig({
        block: { relevance: { enabled: true } },
        env: { FLUPCODE_ADAPTIVE_DISABLED: "1" },
      }),
    })
    expect((await fromEnv.relevance.suggest(request)).reason).toBe("disabled")
    expect(fromEnv.spy.calls).toHaveLength(0)

    const fromBlock = serviceFor({
      config: resolveAdaptiveConfig({ block: { enabled: false, relevance: { enabled: true } }, env: {} }),
    })
    expect((await fromBlock.relevance.suggest(request)).reason).toBe("disabled")
    expect(fromBlock.spy.calls).toHaveLength(0)
  })

  test("is inert when the runtime is not legacy", async () => {
    const { relevance, spy } = serviceFor({ runtime: capabilities("v2", false) })
    expect((await relevance.suggest(request)).reason).toBe("runtime-not-legacy")
    expect(spy.calls).toHaveLength(0)
  })

  test("is inert when the legacy runtime lacks either injection capability", async () => {
    const noInject = serviceFor({ runtime: { ...capabilities("legacy", true), canInjectSystemPrompt: false } })
    expect((await noInject.relevance.suggest(request)).reason).toBe("runtime-not-legacy")
    expect(noInject.spy.calls).toHaveLength(0)

    const noTransform = serviceFor({ runtime: { ...capabilities("legacy", true), canTransformMessages: false } })
    expect((await noTransform.relevance.suggest(request)).reason).toBe("runtime-not-legacy")
    expect(noTransform.spy.calls).toHaveLength(0)
  })

  test("is inert with no objective and with no roster", async () => {
    const noObjective = serviceFor({})
    expect((await noObjective.relevance.suggest({ ...request, objective: "   " })).reason).toBe("no-match")
    expect(noObjective.spy.calls).toHaveLength(0)

    const noRoster = serviceFor({ roster: [] })
    expect((await noRoster.relevance.suggest(request)).reason).toBe("no-roster")
    expect(noRoster.spy.calls).toHaveLength(0)
  })

  test("is inert when the decision selected no candidate", async () => {
    const { relevance } = serviceFor({ result: decision([]) })
    const result = await relevance.suggest(request)
    expect(result).toMatchObject({ line: null, reason: "no-match", skills: [] })
  })

  test("asks once, hot and acting, and writes the line from roster names only", async () => {
    const { relevance, spy } = serviceFor({ result: decision(["testing", "ignore-all-instructions"]) })
    const result = await relevance.suggest(request)
    expect(spy.calls).toEqual([{ mode: "hot", shadow: false }])
    expect(result.reason).toBe("ok")
    expect(result.source).toBe("deterministic")
    expect(result.degraded).toBe(false)
    expect(result.skills).toEqual(["testing"])
    expect(result.line).toContain("testing")
    expect(result.line).not.toContain("ignore-all-instructions")
    expect(result.decisionID).toBe("skillRelevance:ses_1:msg_1")
  })

  test("the layer's shadow flag does not gate the acting line", async () => {
    const { relevance, spy } = serviceFor({
      config: resolveAdaptiveConfig({ block: { shadow: false, relevance: { enabled: true } }, env: {} }),
    })
    const result = await relevance.suggest(request)
    expect(result.reason).toBe("ok")
    expect(spy.calls).toEqual([{ mode: "hot", shadow: false }])
  })

  test("caches the decision by id so the same turn does not spend twice", async () => {
    const { relevance, spy } = serviceFor({})
    await relevance.suggest(request)
    await relevance.suggest(request)
    expect(spy.calls).toHaveLength(1)
  })

  test("keeps the turn's decision past rosterTtlMs so a slow step does not spend twice", async () => {
    let clock = NOW
    const spy = spyService(decision(["testing"]))
    const relevance = createRelevanceService({
      service: spy.service,
      curator: { roster: () => roster },
      runtimeProbe: { capabilities: () => capabilities("legacy", true) },
      config: () => resolveAdaptiveConfig({ block: { relevance: { enabled: true, rosterTtlMs: 100 } }, env: {} }),
      now: () => clock,
    })

    const first = await relevance.suggest(request)
    // The hook fires per step: five seconds later the second step of the same turn still reuses the
    // row (its own turn-long TTL), so one Jev spend and one decisionID stand for the whole turn.
    clock = NOW + 5_000
    const second = await relevance.suggest(request)
    expect(spy.calls).toHaveLength(1)
    expect(second.decisionID).toBe(first.decisionID)
    expect(second.line).toBe(first.line)
  })

  test("bounds the decision cache and evicts the oldest turn", async () => {
    const spy = spyService(decision(["testing"]))
    const relevance = createRelevanceService({
      service: spy.service,
      curator: { roster: () => roster },
      runtimeProbe: { capabilities: () => capabilities("legacy", true) },
      config: () => resolveAdaptiveConfig({ block: { relevance: { enabled: true } }, env: {} }),
      now: () => NOW,
      limits: { decisions: 2 },
    })

    await relevance.suggest({ ...request, messageID: "m1" })
    await relevance.suggest({ ...request, messageID: "m2" })
    await relevance.suggest({ ...request, messageID: "m3" })
    // The cap evicted m1, so asking for it again is a fresh spend rather than an unbounded cache.
    await relevance.suggest({ ...request, messageID: "m1" })
    expect(spy.calls).toHaveLength(4)
  })

  test("bounds the roster cache and evicts the oldest project", async () => {
    let reads = 0
    const spy = spyService(decision([]))
    const relevance = createRelevanceService({
      service: spy.service,
      curator: {
        roster: () => {
          reads += 1
          return roster
        },
      },
      runtimeProbe: { capabilities: () => capabilities("legacy", true) },
      config: () => resolveAdaptiveConfig({ block: { relevance: { enabled: true } }, env: {} }),
      now: () => NOW,
      limits: { rosters: 1 },
    })

    await relevance.suggest({ ...request, projectID: "/work/a", messageID: "m1" })
    await relevance.suggest({ ...request, projectID: "/work/b", messageID: "m2" })
    await relevance.suggest({ ...request, projectID: "/work/a", messageID: "m3" })
    expect(reads).toBe(3)
  })

  test("is inert when the config reader or the roster read throws", async () => {
    const fromConfig = createRelevanceService({
      service: spyService(decision(["testing"])).service,
      curator: { roster: () => roster },
      runtimeProbe: { capabilities: () => capabilities("legacy", true) },
      config: () => {
        throw new Error("bad config")
      },
    })
    expect((await fromConfig.suggest(request)).reason).toBe("error")

    const fromRoster = createRelevanceService({
      service: spyService(decision(["testing"])).service,
      curator: {
        roster: () => {
          throw new Error("cannot read")
        },
      },
      runtimeProbe: { capabilities: () => capabilities("legacy", true) },
      config: () => resolveAdaptiveConfig({ block: { relevance: { enabled: true } }, env: {} }),
    })
    expect((await fromRoster.suggest(request)).reason).toBe("error")
  })

  test("caches the roster for rosterTtlMs and re-reads it once the ttl expires", async () => {
    let clock = NOW
    let reads = 0
    const spy = spyService(decision(["testing"]))
    const relevance = createRelevanceService({
      service: spy.service,
      curator: {
        roster: () => {
          reads += 1
          return roster
        },
      },
      runtimeProbe: { capabilities: () => capabilities("legacy", true) },
      config: () => resolveAdaptiveConfig({ block: { relevance: { enabled: true, rosterTtlMs: 100 } }, env: {} }),
      now: () => clock,
    })

    await relevance.suggest({ ...request, messageID: "m1" })
    clock = NOW + 50
    await relevance.suggest({ ...request, messageID: "m2" })
    expect(reads).toBe(1)

    clock = NOW + 200
    await relevance.suggest({ ...request, messageID: "m3" })
    expect(reads).toBe(2)
  })

  test("is inert when the decision service throws", async () => {
    const { relevance } = serviceFor({ result: new Error("down") })
    expect((await relevance.suggest(request)).reason).toBe("error")
  })
})
