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
import { createFallbackProvider } from "./providers/fallback"
import { createGovernor, DEFAULT_GOVERNOR_CONFIG } from "./providers/governor"
import { DecisionUnavailable } from "./providers/provider"
import { wireQuestions } from "./providers/jev-parse"
import type { JevQuestion } from "./providers/jev-parse"
import { createJevClient } from "./providers/jev"
import type { JevFetch, JevFetchResponse } from "./providers/jev"
import type { GovernorStore } from "./providers/governor"
import { createAdaptiveEgressGuard } from "./egress"
import { createDecisionService } from "./decision-service"
import { createShadowRunner } from "./shadow"
import { createEpisodeCoordinator } from "./coordinator"
import { SqliteRoutineRepository } from "../repository"
import type { SessionEpisode } from "../types"

const NOW = 1_700_000_000_000
const signal = new AbortController().signal

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
    items: [{ id: "item-1", kind: "file", tokens: 120, referenced: true }],
  }),
  modelRoute: request("modelRoute", { role: "build", taskName: "task-1", declared: "HIGH" }),
  agentRoute: request("agentRoute", { objective: "fix the failing test", signals: ["red-check"] }),
  toolRisk: request("toolRisk", { tool: "bash", argsDigest: "abc123" }),
  failure: request("failure", { repeatedCalls: 0, repeatedErrors: 0, stepsUsed: 1 }),
}

const store: GovernorStore = {
  adaptiveUsage: () => ({ tokens: 0, calls: 0 }),
  addAdaptiveUsage: () => {},
}

describe("Phase 2 evaluation (offline, recorded)", () => {
  test("deterministic coverage: 7/7 kinds answer with Jev off", () => {
    const answered = decisionKinds().filter((kind) => deterministicBaseline(SAMPLES[kind]).answer !== undefined)
    expect(answered).toHaveLength(7)
  })

  test("parsing: 3/3 Jev answer types land on their question id", async () => {
    const payload: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "decisions", "systemone-mixed.json"), "utf8"),
    )
    const questions: JevQuestion[] = [
      { id: "gate", type: "noul", prompt: "gate?" },
      { id: "route", type: "choice", prompt: "route?", choices: ["CHEAP", "BALANCED", "HIGH", "MAX"] },
      { id: "risk", type: "score", prompt: "risk?", choices: ["low", "mid", "high"] },
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
    const prediction = await client.predictOne({ ...SAMPLES.completion, projectID: "/work/project" }, questions)

    // The fixture shuffled w2 first: assembly is by id, not by arrival order.
    expect(prediction.modelVersion).toBe("jev-1.13.0")
    expect(prediction.answers.gate).toEqual({ type: "noul", probability: 0.82 })
    expect(prediction.answers.route?.type).toBe("choice")
    expect(prediction.answers.risk?.type).toBe("score")
    expect(Object.keys(prediction.answers).sort()).toEqual(["gate", "risk", "route"])
    // The wire ids the fixture was recorded against.
    expect(wireQuestions(questions).map((question) => question.id)).toEqual(["w0", "w1", "w2"])
  })

  test("fallback equality: 7/7 answers equal the deterministic baseline byte for byte", async () => {
    let equal = 0
    for (const kind of decisionKinds()) {
      const fallback = createFallbackProvider({
        external: { id: "down", answer: async () => Promise.reject(new DecisionUnavailable("network")) },
        maxAttempts: 1,
        now: () => NOW,
      })
      const answer = await fallback.answer(SAMPLES[kind], signal)
      if (JSON.stringify(answer.answer) === JSON.stringify(deterministicBaseline(SAMPLES[kind]).answer)) equal += 1
    }
    expect(equal).toBe(7)
  })

  test("dedupe: two identical concurrent states collapse into one call", async () => {
    const governor = createGovernor({ config: DEFAULT_GOVERNOR_CONFIG, store, now: () => NOW })
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
    const shadow = createShadowRunner({
      service,
      repository,
      config: () => config,
      opaqueKey: () => Buffer.alloc(32, 1),
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

    expect(repository.listDecisions({ episodeID: episode.id })).toHaveLength(3)
    expect(JSON.stringify(repository.getEpisode(episode.id))).toBe(episodeBytes)
    expect(JSON.stringify(repository.getRun(run.id))).toBe(runBytes)
    repository.close()
  })

  test("egress: zero canaries reach the outbound body", () => {
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
    expect(prepared.body).not.toContain(known)
    expect(prepared.body).not.toContain(patterned)
    expect(prepared.body).toContain("[REDACTED]")
  })
})
