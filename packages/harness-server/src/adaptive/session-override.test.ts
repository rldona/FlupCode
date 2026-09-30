/**
 * The per-session override (AH-E02).
 *
 * The store is bounded and drops an override back at its defaults; the routes take the browser bearer
 * and exist only with it; and every capability that reads the override acts as off for a paused
 * session on its very next request, while the decisions it would have made are still recorded with
 * `degradedReason: "session-paused"`.
 */

import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "../api"
import type { HarnessHandlerOptions } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import { DEFAULT_SELECTION_CONFIG, resolveAdaptiveConfig } from "./config"
import type { AdaptiveConfig } from "./config"
import { DEFAULT_DECISION_POLICY, decisionKinds } from "./decision"
import type { DecisionKind, DecisionRequest } from "./decision"
import { createContextManager } from "./context-manager"
import { createDecisionService } from "./decision-service"
import { createAdaptiveEgressGuard } from "./egress"
import { createGuardrailService } from "./guardrails"
import type { PredictiveModel } from "./predictive/model"
import { createRelevanceService } from "./relevance"
import type { RuntimeCapabilities } from "./runtime"
import { MAX_EXCLUDED_SKILLS, createSessionOverrides } from "./session-override"

const NOW = 1_700_000_000_000
const BROWSER = "browser-secret"
const ADAPTIVE = "adaptive-secret"
const PROJECT = "/work/project"

const legacy: RuntimeCapabilities = {
  runtime: "legacy",
  degraded: false,
  canUseLegacyHooks: true,
  canInjectSystemPrompt: true,
  canObserveToolCalls: true,
  canObserveCompaction: true,
  canTransformMessages: true,
  canUseSdkPath: true,
  checkedAt: 0,
}

/** A predictive model that counts its calls: a paused session must never reach it. */
const spyModel = () => {
  const model = {
    id: "jev",
    locality: "remote" as const,
    supports: decisionKinds(),
    calls: 0,
    predict: async () => {
      model.calls += 1
      throw new Error("a paused session asked the model")
    },
  }
  return model satisfies PredictiveModel
}

/** The real decision service, relevance line and guardrails over one store and one override map. */
const stack = (block: Record<string, unknown> = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const config = (): AdaptiveConfig => resolveAdaptiveConfig({ block, env: {} })
  const overrides = createSessionOverrides()
  const model = spyModel()
  const egress = createAdaptiveEgressGuard({ config })
  const decisions = createDecisionService({
    repository,
    config,
    egress,
    models: [model],
    paused: overrides.paused,
    now: () => NOW,
  })
  const roster = [
    { name: "testing", description: "write focused tests for the parser", learned: false },
    { name: "parser", description: "work on the parser", learned: false },
  ]
  const asked: string[][] = []
  const relevance = createRelevanceService({
    service: {
      ...decisions,
      predict: <Q extends DecisionKind>(request: DecisionRequest<Q>, mode?: "hot" | "batch", shadow?: boolean) => {
        const state = request.state as { skills?: Array<{ name: string }> }
        asked.push((state.skills ?? []).map((skill) => skill.name))
        return decisions.predict(request, mode, shadow)
      },
    },
    curator: { roster: () => roster },
    runtimeProbe: { capabilities: () => legacy },
    config,
    overrides,
    now: () => NOW,
  })
  const guardrails = createGuardrailService({
    service: decisions,
    runtimeProbe: { capabilities: () => legacy },
    config,
    paused: overrides.paused,
    now: () => NOW,
  })
  return { repository, config, overrides, model, decisions, relevance, guardrails, asked }
}

const turn = (messageID = "msg_1") => ({
  projectID: PROJECT,
  sessionID: "ses_1",
  messageID,
  objective: "fix the parser test",
})

describe("the override store", () => {
  test("defaults to nothing, merges a partial write and drops an override back at its defaults", () => {
    const overrides = createSessionOverrides()
    expect(overrides.get("ses_1")).toEqual({ paused: false, excludedSkills: [] })
    expect(overrides.set("ses_1", { paused: true })).toEqual({ paused: true, excludedSkills: [] })
    expect(overrides.set("ses_1", { excludedSkills: ["alpha", "alpha", "beta"] })).toEqual({
      paused: true,
      excludedSkills: ["alpha", "beta"],
    })
    expect(overrides.paused("ses_1")).toBe(true)
    expect(overrides.paused(undefined)).toBe(false)
    expect(overrides.pausedSessions()).toEqual(["ses_1"])
    overrides.set("ses_1", { paused: false, excludedSkills: [] })
    expect(overrides.pausedSessions()).toEqual([])
    expect(overrides.get("ses_1")).toEqual({ paused: false, excludedSkills: [] })
  })

  test("is bounded: the oldest session is evicted past the cap", () => {
    const overrides = createSessionOverrides(2)
    overrides.set("ses_1", { paused: true })
    overrides.set("ses_2", { paused: true })
    overrides.set("ses_3", { paused: true })
    expect(overrides.pausedSessions()).toEqual(["ses_2", "ses_3"])
  })
})

describe("a paused session", () => {
  test("the decision service records the baseline as session-paused, asks no model and never acts", async () => {
    const { repository, overrides, model, decisions } = stack({
      jev: { enabled: true },
      egress: { projects: [PROJECT], kinds: { completion: true } },
    })
    overrides.set("ses_1", { paused: true })
    const result = await decisions.predict(
      {
        kind: "completion",
        episodeID: "episode:1",
        sessionID: "ses_1",
        projectID: PROJECT,
        policy: DEFAULT_DECISION_POLICY,
        state: {
          episodeID: "episode:1",
          objective: "fix it",
          outcome: "success",
          toolCalls: 1,
          verifications: [],
          failures: 0,
          projectID: PROJECT,
        },
      },
      "hot",
      false,
    )
    expect(model.calls).toBe(0)
    expect(result).toMatchObject({ source: "baseline", degraded: true, degradedReason: "session-paused" })
    const row = repository.listDecisions({ sessionID: "ses_1" })[0]
    expect(row).toMatchObject({ source: "baseline", degradedReason: "session-paused", shadow: true })
    expect(decisions.explain(row!.id)?.why).toContain("paused in this session")
  })

  test("the relevance line is inert from the next step and decides afresh on resume", async () => {
    const { repository, overrides, relevance, asked } = stack({ relevance: { enabled: true } })
    const before = await relevance.suggest(turn())
    expect(before.reason).toBe("ok")
    expect(before.line).not.toBeNull()

    // The same turn, next step: the cached line is not reused while paused, and the row says why.
    overrides.set("ses_1", { paused: true })
    const paused = await relevance.suggest(turn())
    expect(paused).toMatchObject({ line: null, reason: "session-paused", skills: [] })
    expect(repository.listDecisions({ sessionID: "ses_1", kind: "skillRelevance" })[0]).toMatchObject({
      degradedReason: "session-paused",
      shadow: true,
    })

    overrides.set("ses_1", { paused: false })
    const resumed = await relevance.suggest(turn())
    expect(resumed.reason).toBe("ok")
    expect(asked).toHaveLength(3)
    expect(repository.listDecisions({ sessionID: "ses_1", kind: "skillRelevance" })[0]).toMatchObject({ shadow: false })
  })

  test("the loop warning is recorded, not raised, and the status is hidden", async () => {
    const { repository, overrides, guardrails } = stack({ guardrails: { enabled: true } })
    overrides.set("ses_1", { paused: true })
    const observation = { kind: "call" as const, tool: "bash", argsDigest: "a".repeat(64) }
    const observe = () => guardrails.observe({ projectID: PROJECT, sessionID: "ses_1", observation })
    await observe()
    await observe()
    expect(await observe()).toMatchObject({ verdict: "continue", reason: "session-paused" })
    expect(guardrails.status("ses_1")).toBeNull()
    expect(repository.listDecisions({ sessionID: "ses_1", kind: "failure" })[0]).toMatchObject({
      degradedReason: "session-paused",
      shadow: true,
    })

    overrides.set("ses_1", { paused: false })
    expect(guardrails.status("ses_1")).toMatchObject({ reason: "loop" })
  })

  test("the context plan is skipped", async () => {
    const { repository, overrides, config, decisions } = stack({ context: { enabled: true } })
    const context = createContextManager({ repository, service: decisions, config, opaqueKey: () => Buffer.alloc(32) })
    const paused = createContextManager({
      repository,
      service: decisions,
      config,
      opaqueKey: () => Buffer.alloc(32),
      paused: overrides.paused,
    })
    overrides.set("ses_1", { paused: true })
    const input = {
      parts: [{ id: "objective", kind: "objective" as const, text: "fix the parser" }],
      objective: "fix the parser",
      runID: "run_1",
      taskID: "task_1",
      sessionID: "ses_1",
    }
    expect(await context.plan(input)).toBeDefined()
    expect(await paused.plan(input)).toBeUndefined()
  })
})

describe("don't suggest a skill", () => {
  test("leaves the skill out of the roster for that session only, from the next step", async () => {
    const { overrides, relevance, asked } = stack({ relevance: { enabled: true } })
    await relevance.suggest(turn())
    overrides.set("ses_1", { excludedSkills: ["testing"] })
    await relevance.suggest(turn())
    await relevance.suggest({ ...turn(), sessionID: "ses_2" })
    expect(asked).toEqual([["testing", "parser"], ["parser"], ["testing", "parser"]])
  })
})

const open = (options: HarnessHandlerOptions = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return { repository, handler: createHarnessHandler(repository, scheduler, options) }
}

const request = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
  new Request("http://127.0.0.1:4097" + path, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })

const OVERRIDE = "/harness/adaptive/sessions/ses_1/override"

describe("the override routes", () => {
  test("read and write the override behind the browser bearer, and announce the capability", async () => {
    const overrides = createSessionOverrides()
    const { repository, handler } = open({ token: BROWSER, adaptiveToken: ADAPTIVE, overrides })
    expect((await (await handler(request(OVERRIDE, { token: BROWSER }))).json()).data).toEqual({
      paused: false,
      excludedSkills: [],
    })
    const put = await handler(request(OVERRIDE, { method: "PUT", token: BROWSER, body: { paused: true } }))
    expect((await put.json()).data).toEqual({ paused: true, excludedSkills: [] })
    expect(overrides.paused("ses_1")).toBe(true)

    // The acting bearer is not the browser's, and no bearer is no read.
    expect((await handler(request(OVERRIDE, { token: ADAPTIVE }))).status).toBe(403)
    expect((await handler(request(OVERRIDE))).status).toBe(403)
    const health = await (await handler(request("/harness/health"))).json()
    expect(health.capabilities).toContain("adaptive-session")
    repository.close()
  })

  test("refuses a malformed override and an unknown path", async () => {
    const { repository, handler } = open({ token: BROWSER, overrides: createSessionOverrides() })
    for (const body of [
      { paused: "yes" },
      { excludedSkills: "alpha" },
      { excludedSkills: [""] },
      { excludedSkills: Array.from({ length: MAX_EXCLUDED_SKILLS + 1 }, (_, index) => `s${index}`) },
      [],
    ]) {
      expect((await handler(request(OVERRIDE, { method: "PUT", token: BROWSER, body }))).status).toBe(400)
    }
    expect((await handler(request("/harness/adaptive/sessions/ses_1/other", { token: BROWSER }))).status).toBe(404)
    expect((await handler(request(OVERRIDE, { method: "POST", token: BROWSER, body: {} }))).status).toBe(404)
    repository.close()
  })

  test("without the browser bearer there is no route and no capability", async () => {
    const { repository, handler } = open({ overrides: createSessionOverrides() })
    expect((await handler(request(OVERRIDE, { method: "PUT", body: { paused: true } }))).status).toBe(404)
    const health = await (await handler(request("/harness/health"))).json()
    expect(health.capabilities).not.toContain("adaptive-session")
    repository.close()
  })

  test("the turn summary reads the suggested skills, the applied plan and the consulted model from the audit", async () => {
    const overrides = createSessionOverrides()
    const repository = new SqliteRoutineRepository(":memory:")
    const config = () => resolveAdaptiveConfig({ env: {} })
    const decisions = createDecisionService({
      repository,
      config,
      egress: createAdaptiveEgressGuard({ config }),
      now: () => NOW,
    })
    const context = createContextManager({ repository, service: decisions, config, opaqueKey: () => Buffer.alloc(32) })
    const row = {
      inputsHash: "h".repeat(64),
      stateSummary: {},
      baselineAnswer: { load: [] },
      baselineRule: "lexical-objective-match",
      degraded: false,
      policy: DEFAULT_DECISION_POLICY,
      sessionID: "ses_1",
    }
    repository.createDecision(
      {
        ...row,
        id: "skillRelevance:ses_1:msg_1",
        kind: "skillRelevance",
        answer: { load: ["testing", "parser"] },
        provider: "jev",
        providerID: "jev",
        source: "model",
        latencyMs: 180,
        shadow: false,
      },
      NOW,
    )
    repository.createPlan(
      {
        id: "plan:run_1:task_1",
        sessionID: "ses_1",
        objectiveHash: "o".repeat(64),
        entries: [],
        scoreSource: "baseline",
        degraded: false,
        applied: true,
        tokensBefore: 5_000,
        tokensAfter: 3_800,
      },
      NOW,
    )
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const handler = createHarnessHandler(repository, scheduler, { token: BROWSER, overrides, decisions, context })
    overrides.set("ses_1", { excludedSkills: ["release"] })
    const summary = (await (await handler(request("/harness/adaptive/sessions/ses_1/turn", { token: BROWSER }))).json())
      .data
    expect(summary).toEqual({
      sessionID: "ses_1",
      override: { paused: false, excludedSkills: ["release"] },
      relevance: { decisionID: "skillRelevance:ses_1:msg_1", skills: ["testing", "parser"], acted: true, at: NOW },
      plan: { id: "plan:run_1:task_1", tokensSaved: 1_200, applied: true, at: NOW },
      model: {
        providerID: "jev",
        kind: "skillRelevance",
        latencyMs: 180,
        decisionID: "skillRelevance:ses_1:msg_1",
        at: NOW,
      },
    })
    // Another session has nothing to say.
    const empty = (await (await handler(request("/harness/adaptive/sessions/ses_2/turn", { token: BROWSER }))).json())
      .data
    expect(empty).toEqual({ sessionID: "ses_2", override: { paused: false, excludedSkills: [] } })
    repository.close()
  })
})

describe("the per-request routes of a paused session", () => {
  const post = (path: string, body: unknown) => request(path, { method: "POST", token: ADAPTIVE, body })

  test("the tool-output trim leaves the output whole, without backing the plugin off for everyone", async () => {
    const overrides = createSessionOverrides()
    const { repository, handler } = open({
      adaptiveToken: ADAPTIVE,
      overrides,
      toolTrimConfig: () =>
        resolveAdaptiveConfig({ block: { toolTrim: { enabled: true, thresholdBytes: 4_096 } }, env: {} }),
    })
    overrides.set("ses_1", { paused: true })
    const output = "x".repeat(20_000)
    const paused = (
      await (await handler(post("/harness/adaptive/tool-trim", { sessionID: "ses_1", tool: "bash", output }))).json()
    ).data
    expect(paused).toMatchObject({ trimmed: false, reason: "session-paused" })
    expect(paused.retryAfterMs).toBeUndefined()
    const other = (
      await (await handler(post("/harness/adaptive/tool-trim", { sessionID: "ses_2", tool: "bash", output }))).json()
    ).data
    expect(other.trimmed).toBe(true)
    repository.close()
  })

  test("the compaction anchors add nothing", async () => {
    const overrides = createSessionOverrides()
    const { repository, handler } = open({ adaptiveToken: ADAPTIVE, overrides, compactionAnchors: () => true })
    const body = { sessionID: "ses_1", goal: "fix the parser", reads: ["/work/project/parser.ts"] }
    expect((await (await handler(post("/harness/adaptive/anchors", body))).json()).data.block).toBeString()
    overrides.set("ses_1", { paused: true })
    expect((await (await handler(post("/harness/adaptive/anchors", body))).json()).data).toEqual({})
    repository.close()
  })

  test("the selection policy lists the paused sessions for the latched plugin", async () => {
    const overrides = createSessionOverrides()
    const { repository, handler } = open({
      adaptiveToken: ADAPTIVE,
      overrides,
      selectionPolicy: () => ({ ...DEFAULT_SELECTION_CONFIG, enabled: true }),
    })
    overrides.set("ses_1", { paused: true })
    const data = (await (await handler(request("/harness/adaptive/selection", { token: ADAPTIVE }))).json()).data
    expect(data).toMatchObject({ enabled: true, pausedSessions: ["ses_1"] })
    repository.close()
  })
})
