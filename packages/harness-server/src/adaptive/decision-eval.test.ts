/**
 * The Phase 2 evaluation, offline (FH-015/FH-017).
 *
 * This is a deliverable, not a unit test: it states the before/after metric of the phase with no
 * network and no model — deterministic coverage over all seven kinds, the three Jev answer types
 * parsed from a recorded response, fallback equality, single-flight dedupe, the shadow's zero
 * observable effect, and that no canary reaches an outbound body.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_JEV_CONFIG, resolveAdaptiveConfig } from "./config"
import { DEFAULT_DECISION_POLICY, decisionKinds } from "./decision"
import type { DecisionKind, DecisionRequest, DecisionSpec } from "./decision"
import { deterministicBaseline } from "./providers/deterministic"
import { createGovernor, DEFAULT_GOVERNOR_CONFIG } from "./providers/governor"
import { createRetryingModel } from "./providers/retry"
import { DecisionUnavailable } from "./providers/provider"
import { wireQuestions } from "./providers/jev-parse"
import type { Question } from "./predictive/model"
import { createJevClient } from "./providers/jev"
import type { JevFetch, JevFetchResponse } from "./providers/jev"
import type { GovernorStore } from "./providers/governor"
import { createAdaptiveEgressGuard } from "./egress"
import { createDecisionService } from "./decision-service"
import { createContextManager } from "./context-manager"
import { createShadowRunner, SHADOW_KINDS } from "./shadow"
import { createEpisodeCoordinator } from "./coordinator"
import { SqliteRoutineRepository } from "../repository"
import type { SessionEpisode } from "../types"

const NOW = 1_700_000_000_000

const request = <Q extends DecisionKind>(kind: Q, state: DecisionSpec[Q]["state"]): DecisionRequest<Q> => ({
  kind,
  state,
  policy: DEFAULT_DECISION_POLICY,
})

const SAMPLES: { [Q in DecisionKind]: DecisionRequest<Q> } = {
  completion: request("completion", {
    episodeID: "episode:1",
    objective: "fix the failing test",
    outcome: "success",
    toolCalls: 3,
    verifications: [{ step: "test", ok: true }],
    failures: 0,
    projectID: "/work/project",
  }),
  skillRelevance: request("skillRelevance", {
    sessionID: "session-1",
    objective: "fix the failing test",
    skills: [{ name: "testing", description: "write focused tests", learned: false }],
  }),
  contextItem: request("contextItem", {
    objective: "fix the failing test",
    items: [{ id: "item-1", kind: "file", tokens: 120, referenced: true, anchors: 0, archived: false }],
  }),
  modelRoute: request("modelRoute", { role: "build", taskName: "task-1", declared: "HIGH" }),
  agentRoute: request("agentRoute", { objective: "fix the failing test", signals: ["red-check"] }),
  toolRisk: request("toolRisk", { tool: "bash", argsDigest: "abc123" }),
  failure: request("failure", { repeatedCalls: 0, repeatedErrors: 0, stepsUsed: 1 }),
  skillReflection: request("skillReflection", {
    episodeID: "episode:1",
    objective: "fix the failing test",
    outcome: "success",
    toolCalls: 3,
    signals: ["verify:test ok"],
    skills: [{ name: "testing", description: "write focused tests", learned: false }],
  }),
}

const store: GovernorStore = {
  adaptiveUsage: () => ({ tokens: 0, calls: 0 }),
  addAdaptiveUsage: () => {},
}

describe("Phase 2 evaluation (offline, recorded)", () => {
  test("deterministic coverage: 8/8 kinds answer with Jev off", () => {
    const answered = decisionKinds().filter((kind) => deterministicBaseline(SAMPLES[kind]).answer !== undefined)
    expect(answered).toHaveLength(8)
  })

  test("parsing: 3/3 Jev answer types land on their question id", async () => {
    const payload: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "decisions", "systemone-mixed.json"), "utf8"),
    )
    const questions: Question[] = [
      { id: "gate", type: "binary", prompt: "gate?" },
      { id: "route", type: "choice", prompt: "route?", options: ["CHEAP", "BALANCED", "HIGH", "MAX"] },
      { id: "risk", type: "score", prompt: "risk?", options: ["low", "mid", "high"] },
    ]
    // The recorded fetch replays the fixture and nothing else touches the network.
    const canned: JevFetchResponse = {
      ok: true,
      status: 200,
      headers: new Headers({}),
      json: async () => payload,
    }
    const fetch: JevFetch = async () => canned
    const egress = createAdaptiveEgressGuard({
      config: () =>
        resolveAdaptiveConfig({ block: { jev: { enabled: true }, egress: { projects: ["/work/project"], kinds: { completion: true } } }, env: {} }),
    })
    const client = createJevClient({ fetch, egress, config: () => ({ ...DEFAULT_JEV_CONFIG, enabled: true }) })
    const prediction = await client.predictOne(
      { kind: "completion", projectID: "/work/project", text: JSON.stringify(SAMPLES.completion.state) },
      questions,
    )

    // The fixture shuffled w2 first: assembly is by id, not by arrival order.
    expect(prediction.modelVersion).toBe("jev-1.13.0")
    expect(prediction.answers.gate).toEqual({ type: "noul", probability: 0.82 })
    expect(prediction.answers.route?.type).toBe("choice")
    expect(prediction.answers.risk?.type).toBe("score")
    expect(Object.keys(prediction.answers).sort()).toEqual(["gate", "risk", "route"])
    // The wire ids the fixture was recorded against.
    expect(wireQuestions(questions).map((question) => question.id)).toEqual(["w0", "w1", "w2"])
  })

  test("fallback equality: 8/8 answers equal the deterministic baseline byte for byte", async () => {
    // A model that is down, asked for every kind through the registry: the service degrades each
    // decision to its baseline, whatever the kind.
    const down = createRetryingModel({
      model: {
        id: "down",
        locality: "local",
        supports: decisionKinds(),
        predict: async () => Promise.reject(new DecisionUnavailable("network")),
      },
      maxAttempts: 1,
    })
    const repository = new SqliteRoutineRepository(":memory:")
    const config = resolveAdaptiveConfig({
      // A breaker high enough that every kind reaches the model rather than the open breaker.
      block: {
        models: Object.fromEntries(decisionKinds().map((kind) => [kind, "down"])),
        governor: { breakerFailures: 100 },
      },
      env: {},
    })
    const service = createDecisionService({
      repository,
      config: () => config,
      egress: createAdaptiveEgressGuard({ config: () => config }),
      models: [down],
      governor: createGovernor({ config: () => config.governor, store, now: () => NOW }),
      now: () => NOW,
    })
    let equal = 0
    for (const kind of decisionKinds()) {
      const result = await service.predict(SAMPLES[kind])
      expect(result).toMatchObject({ degraded: true, degradedReason: "network" })
      if (JSON.stringify(result.answer) === JSON.stringify(deterministicBaseline(SAMPLES[kind]).answer)) equal += 1
    }
    expect(equal).toBe(8)
    repository.close()
  })

  test("dedupe: two identical concurrent states collapse into one call", async () => {
    const governor = createGovernor({ config: () => DEFAULT_GOVERNOR_CONFIG, store, now: () => NOW })
    let calls = 0
    const work = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 0))
      return "answer"
    }
    const [first, second] = await Promise.all([
      governor.runBatch("completion\u0000hash\u0000model", 10, work),
      governor.runBatch("completion\u0000hash\u0000model", 10, work),
    ])
    expect(calls).toBe(1)
    expect(first).toBe("answer")
    expect(second).toBe("answer")
  })

  test("shadow effect zero: the episode and run bytes do not move when decisions are recorded", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = repository.startRun({ type: "manual" }, NOW, "/work/project")
    const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.finishTask(task!.id, "success", { output: "done" }, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const config = resolveAdaptiveConfig({ block: {}, env: {} })
    const service = createDecisionService({
      repository,
      config: () => config,
      egress: createAdaptiveEgressGuard({ config: () => config }),
      now: () => NOW,
    })
    const context = createContextManager({
      repository,
      service,
      config: () => config,
      opaqueKey: () => Buffer.alloc(32, 1),
      now: () => NOW,
    })
    const shadow = createShadowRunner({
      service,
      repository,
      config: () => config,
      context,
      readSkills: () => [],
    })
    const coordinator = createEpisodeCoordinator({
      repository,
      now: () => NOW,
      readEpisodeSignals: () => ({ calls: [] }),
      readEpisodeEvents: () => ({ events: [] }),
      onEpisodeClosed: (episode: SessionEpisode) => shadow.onEpisodeClosed(episode),
    })
    const episode = coordinator.captureRun(run.id)!
    const episodeBytes = JSON.stringify(repository.getEpisode(episode.id))
    const runBytes = JSON.stringify(repository.getRun(run.id))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Two shadow decisions plus the context plan the manager wrote; the episode carries no evidence,
    // so the plan is empty and Jev is never asked.
    expect(repository.listDecisions({ episodeID: episode.id })).toHaveLength(SHADOW_KINDS.length)
    expect(repository.listPlans({ episodeID: episode.id })).toHaveLength(1)
    expect(JSON.stringify(repository.getEpisode(episode.id))).toBe(episodeBytes)
    expect(JSON.stringify(repository.getRun(run.id))).toBe(runBytes)
    repository.close()
  })

  test("egress: zero canaries reach the model input", () => {
    const known = "canary-value-that-is-long"
    const patterned = "sk-abcdefghijklmnopqrstuvwx"
    const egress = createAdaptiveEgressGuard({
      config: () => resolveAdaptiveConfig({ block: {}, env: {} }),
      secrets: () => [known],
    })
    const secretRequest: DecisionRequest<"completion"> = {
      kind: "completion",
      projectID: "/work/project",
      policy: DEFAULT_DECISION_POLICY,
      state: {
        episodeID: "episode:1",
        objective: `finish with ${known} and ${patterned}`,
        outcome: "success",
        toolCalls: 1,
        verifications: [],
        failures: 0,
        projectID: "/work/project",
      },
    }
    const prepared = egress.prepare(secretRequest)
    expect(prepared.serialized).not.toContain(known)
    expect(prepared.serialized).not.toContain(patterned)
    expect(prepared.serialized).toContain("[REDACTED]")
  })
})
