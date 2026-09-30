/**
 * The outcome labeler (AH-C06): the joiner per kind against recorded events, the settle window, the
 * max age, idempotency, the kill switch and the coverage stat.
 *
 * The recorded events are what the engine plugins leave behind: `session_metrics` turns folded
 * through the real repository, and the episode-events and episode-signals entries a session wrote.
 * The acceptance case is a synthetic day of sessions whose relevance decisions must be ≥80% labelled
 * within 24 hours, measured with the same coverage stat the route serves.
 */

import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import type { StoredDecisionInput } from "../types"
import { resolveAdaptiveConfig } from "./config"
import { DEFAULT_DECISION_POLICY } from "./decision"
import type { DecisionKind } from "./decision"
import { createDecisionService } from "./decision-service"
import { createAdaptiveEgressGuard } from "./egress"
import type { EpisodeEvent } from "./events"
import {
  FAILURE_WINDOW_MS,
  LABEL_MAX_AGE_MS,
  LABEL_SETTLE_MS,
  createOutcomeLabeler,
  labelCoverage,
} from "./labeler"
import { opaqueItemID } from "./opaque-id"
import type { EpisodeSignal } from "./signals"

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const T0 = 1_700_000_000_000
const KEY = Buffer.alloc(32, 7)
const PROJECT = "/work/project"

type Recorded = { events: Map<string, EpisodeEvent[]>; signals: Map<string, EpisodeSignal[]> }

const setup = (options: { enabled?: () => boolean; limit?: number } = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const recorded: Recorded = { events: new Map(), signals: new Map() }
  const clock = { now: T0 }
  const labeler = createOutcomeLabeler({
    repository,
    enabled: options.enabled ?? (() => true),
    key: () => KEY,
    readEvents: (sessionID) => recorded.events.get(sessionID) ?? [],
    readSignals: (sessionID) => recorded.signals.get(sessionID) ?? [],
    now: () => clock.now,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  })
  return { repository, recorded, clock, labeler }
}

const decide = (
  repository: SqliteRoutineRepository,
  input: { kind: DecisionKind; id: string; answer: unknown; baselineAnswer: unknown } & Partial<StoredDecisionInput>,
  at: number,
) =>
  repository.createDecision(
    {
      inputsHash: "hash",
      stateSummary: {},
      baselineRule: "rule",
      provider: "deterministic",
      source: "baseline",
      degraded: false,
      latencyMs: 1,
      policy: DEFAULT_DECISION_POLICY,
      shadow: false,
      ...input,
    },
    at,
  )

/** A relevance decision for one turn, keyed the way the acting line keys it. */
const relevance = (
  repository: SqliteRoutineRepository,
  sessionID: string,
  turnID: string,
  load: string[],
  baseline: string[],
  at: number,
  extra: Partial<StoredDecisionInput> = {},
) =>
  decide(
    repository,
    {
      kind: "skillRelevance",
      id: `skillRelevance:${sessionID}:${turnID}`,
      sessionID,
      answer: { load },
      baselineAnswer: { load: baseline },
      ...extra,
    },
    at,
  )

/** One turn as the metrics plugin records it: a provider step, then one `skill` call per load. */
const turn = (repository: SqliteRoutineRepository, sessionID: string, turnID: string, at: number, skills: string[] = []) => {
  repository.recordSessionMetric(
    {
      sessionID,
      observation: {
        kind: "step",
        id: `${turnID}:step`,
        turnID,
        tokens: { input: 10, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        ms: 0,
      },
    },
    at,
  )
  skills.forEach((skill, index) =>
    repository.recordSessionMetric(
      {
        sessionID,
        observation: { kind: "tool", id: `${turnID}:skill:${index}`, turnID, tool: "skill", error: false, bytes: 10, skill },
      },
      at + 1 + index,
    ),
  )
}

const labelOf = (repository: SqliteRoutineRepository, id: string) => repository.getDecision(id)?.label

describe("skillRelevance", () => {
  test("chosen and loaded agree over the turn and its lookahead: correct, and the baseline is scored too", () => {
    const { repository, clock, labeler } = setup()
    relevance(repository, "ses_a", "msg_1", ["review", "tests"], ["review"], T0)
    turn(repository, "ses_a", "msg_1", T0 + 1_000, ["review"])
    // The second skill is loaded one turn later: still "loaded for this objective".
    turn(repository, "ses_a", "msg_2", T0 + 60_000, ["tests"])
    turn(repository, "ses_a", "msg_3", T0 + 120_000)
    clock.now = T0 + LABEL_SETTLE_MS.skillRelevance
    expect(labeler.sweep()).toBe(1)
    expect(labelOf(repository, "skillRelevance:ses_a:msg_1")).toEqual({
      outcome: "correct",
      baselineOutcome: "incorrect",
      source: "skill-loads",
      labeledAt: clock.now,
    })
  })

  test("chosen but not loaded, or loaded but not chosen, is incorrect", () => {
    const { repository, clock, labeler } = setup()
    relevance(repository, "ses_b", "msg_1", ["review"], [], T0)
    turn(repository, "ses_b", "msg_1", T0 + 1_000)
    relevance(repository, "ses_c", "msg_1", [], ["deploy"], T0)
    turn(repository, "ses_c", "msg_1", T0 + 1_000, ["deploy"])
    clock.now = T0 + LABEL_SETTLE_MS.skillRelevance + MINUTE
    expect(labeler.sweep()).toBe(2)
    expect(labelOf(repository, "skillRelevance:ses_b:msg_1")).toMatchObject({ outcome: "incorrect", baselineOutcome: "correct" })
    expect(labelOf(repository, "skillRelevance:ses_c:msg_1")).toMatchObject({ outcome: "incorrect", baselineOutcome: "correct" })
  })

  test("a control-arm row is labelled too: it is the counterfactual", () => {
    const { repository, clock, labeler } = setup()
    relevance(repository, "ses_d", "msg_1", ["review"], ["review"], T0, { arm: "control" })
    turn(repository, "ses_d", "msg_1", T0 + 1_000)
    clock.now = T0 + LABEL_SETTLE_MS.skillRelevance + MINUTE
    labeler.sweep()
    expect(repository.getDecision("skillRelevance:ses_d:msg_1")).toMatchObject({
      arm: "control",
      label: { outcome: "incorrect", baselineOutcome: "incorrect" },
    })
  })

  test("a matching answer in a turn that ended in a session error cannot be called correct", () => {
    const { repository, recorded, clock, labeler } = setup()
    relevance(repository, "ses_e", "msg_1", [], ["review"], T0)
    turn(repository, "ses_e", "msg_1", T0 + 1_000)
    recorded.events.set("ses_e", [{ kind: "session.error", seq: 1, at: T0 + 2_000, error: "APIError", message: "" }])
    clock.now = T0 + LABEL_SETTLE_MS.skillRelevance + MINUTE
    labeler.sweep()
    expect(labelOf(repository, "skillRelevance:ses_e:msg_1")).toMatchObject({ outcome: "unknown", baselineOutcome: "incorrect" })
  })

  test("a turn still followed by activity waits for its lookahead or for the session to go quiet", () => {
    const { repository, clock, labeler } = setup()
    relevance(repository, "ses_f", "msg_1", ["review"], [], T0)
    turn(repository, "ses_f", "msg_1", T0 + 1_000)
    turn(repository, "ses_f", "msg_2", T0 + 9 * MINUTE)
    clock.now = T0 + LABEL_SETTLE_MS.skillRelevance + MINUTE
    expect(labeler.sweep()).toBe(0)
    clock.now = T0 + 9 * MINUTE + LABEL_SETTLE_MS.skillRelevance
    expect(labeler.sweep()).toBe(1)
  })

  test("a shadow decision on a closed episode compares against the episode's turns", () => {
    const { repository, clock, labeler } = setup()
    repository.createEpisode(
      {
        id: "episode:ses_g:1",
        sessionID: "ses_g",
        projectID: PROJECT,
        objective: "fix",
        toolCalls: 2,
        files: [],
        commands: [],
        failures: [],
        verifications: [],
        outcome: "success",
        startedAt: T0,
        endedAt: T0 + 5 * MINUTE,
        evidenceRefs: [],
      },
      T0 + 5 * MINUTE,
    )
    turn(repository, "ses_g", "msg_1", T0 + 1_000, ["review"])
    decide(
      repository,
      {
        kind: "skillRelevance",
        id: "skillRelevance:episode:ses_g:1",
        episodeID: "episode:ses_g:1",
        sessionID: "ses_g",
        answer: { load: ["review"] },
        baselineAnswer: { load: [] },
        shadow: true,
      },
      T0 + 5 * MINUTE,
    )
    clock.now = T0 + 5 * MINUTE + LABEL_SETTLE_MS.skillRelevance
    labeler.sweep()
    expect(labelOf(repository, "skillRelevance:episode:ses_g:1")).toMatchObject({
      outcome: "correct",
      baselineOutcome: "incorrect",
    })
  })
})

describe("the sweep", () => {
  test("never judges a decision inside its settle window", () => {
    const { repository, clock, labeler } = setup()
    relevance(repository, "ses_s", "msg_1", [], [], T0)
    // The turn and its whole lookahead were observed, so only the settle window holds it back.
    turn(repository, "ses_s", "msg_1", T0 + 1_000)
    turn(repository, "ses_s", "msg_2", T0 + 2_000)
    turn(repository, "ses_s", "msg_3", T0 + 3_000)
    clock.now = T0 + LABEL_SETTLE_MS.skillRelevance - 1
    expect(labeler.sweep()).toBe(0)
    expect(labelOf(repository, "skillRelevance:ses_s:msg_1")).toBeUndefined()
    clock.now = T0 + LABEL_SETTLE_MS.skillRelevance
    expect(labeler.sweep()).toBe(1)
    expect(labelOf(repository, "skillRelevance:ses_s:msg_1")?.outcome).toBe("correct")
  })

  test("an unknowable decision stays unlabelled until the max age, then reads unknown", () => {
    const { repository, clock, labeler } = setup()
    // No metrics turn was ever recorded for this turn: nothing to join.
    relevance(repository, "ses_m", "msg_1", ["review"], [], T0)
    clock.now = T0 + LABEL_MAX_AGE_MS - 1
    expect(labeler.sweep()).toBe(0)
    clock.now = T0 + LABEL_MAX_AGE_MS
    expect(labeler.sweep()).toBe(1)
    expect(labelOf(repository, "skillRelevance:ses_m:msg_1")).toMatchObject({
      outcome: "unknown",
      baselineOutcome: "unknown",
      source: "max-age",
    })
  })

  test("is idempotent: a second pass relabels nothing and the first label stands", () => {
    const { repository, clock, labeler } = setup()
    relevance(repository, "ses_i", "msg_1", ["review"], [], T0)
    turn(repository, "ses_i", "msg_1", T0 + 1_000, ["review"])
    clock.now = T0 + LABEL_SETTLE_MS.skillRelevance + MINUTE
    expect(labeler.sweep()).toBe(1)
    const first = labelOf(repository, "skillRelevance:ses_i:msg_1")
    // New evidence after the label does not move it, and a re-capture of the row keeps it.
    turn(repository, "ses_i", "msg_2", T0 + 20 * MINUTE, ["deploy"])
    relevance(repository, "ses_i", "msg_1", ["review"], [], T0 + 30 * MINUTE)
    clock.now = T0 + HOUR
    expect(labeler.sweep()).toBe(0)
    expect(labelOf(repository, "skillRelevance:ses_i:msg_1")).toEqual(first!)
    expect(repository.labelDecision("skillRelevance:ses_i:msg_1", { outcome: "incorrect", source: "x" })).toBe(false)
  })

  test("writes nothing while the kill switch is thrown", () => {
    const flag = { enabled: false }
    const { repository, clock, labeler } = setup({ enabled: () => flag.enabled })
    relevance(repository, "ses_k", "msg_1", [], [], T0)
    turn(repository, "ses_k", "msg_1", T0 + 1_000)
    clock.now = T0 + LABEL_MAX_AGE_MS
    expect(labeler.sweep()).toBe(0)
    expect(labelOf(repository, "skillRelevance:ses_k:msg_1")).toBeUndefined()
    flag.enabled = true
    expect(labeler.sweep()).toBe(1)
  })

  test("is bounded per pass and a page of unknowable rows does not starve the rows behind it", () => {
    const { repository, clock, labeler } = setup({ limit: 2 })
    relevance(repository, "ses_p1", "msg_1", [], [], T0)
    relevance(repository, "ses_p2", "msg_1", [], [], T0 + 1)
    relevance(repository, "ses_p3", "msg_1", [], [], T0 + 2)
    turn(repository, "ses_p3", "msg_1", T0 + 1_000)
    clock.now = T0 + LABEL_SETTLE_MS.skillRelevance + MINUTE
    expect(labeler.sweep()).toBe(0)
    expect(labeler.sweep()).toBe(1)
    expect(labelOf(repository, "skillRelevance:ses_p3:msg_1")?.outcome).toBe("correct")
  })

  test("leaves kinds with no real outcome alone", () => {
    const { repository, clock, labeler } = setup()
    decide(repository, { kind: "toolRisk", id: "toolRisk:ses_x:bash:d", sessionID: "ses_x", answer: { risk: "ALLOW" }, baselineAnswer: { risk: "ALLOW" } }, T0)
    clock.now = T0 + LABEL_MAX_AGE_MS * 2
    expect(labeler.sweep()).toBe(0)
    expect(labelOf(repository, "toolRisk:ses_x:bash:d")).toBeUndefined()
  })
})

const episode = (
  repository: SqliteRoutineRepository,
  id: string,
  sessionID: string,
  extra: { outcome?: "success" | "partial" | "failed" | "unknown"; endedAt?: number; files?: string[] } = {},
) =>
  repository.createEpisode(
    {
      id,
      sessionID,
      projectID: PROJECT,
      objective: "fix the test",
      toolCalls: 3,
      files: extra.files ?? [],
      commands: [],
      failures: [],
      verifications: [],
      outcome: extra.outcome ?? "success",
      startedAt: T0 - 10 * MINUTE,
      ...(extra.endedAt === undefined ? {} : { endedAt: extra.endedAt }),
      evidenceRefs: [],
    },
    T0,
  )

describe("completion", () => {
  test("scores the verdict against the closed episode's outcome", () => {
    const { repository, clock, labeler } = setup()
    episode(repository, "episode:ses_c1:1", "ses_c1", { outcome: "success", endedAt: T0 })
    episode(repository, "episode:ses_c2:1", "ses_c2", { outcome: "failed", endedAt: T0 })
    episode(repository, "episode:ses_c3:1", "ses_c3", { outcome: "unknown" })
    for (const id of ["episode:ses_c1:1", "episode:ses_c2:1", "episode:ses_c3:1"])
      decide(
        repository,
        {
          kind: "completion",
          id: `completion:${id}`,
          episodeID: id,
          answer: { verdict: "complete" },
          baselineAnswer: { verdict: "not_complete" },
          shadow: true,
        },
        T0,
      )
    clock.now = T0 + LABEL_SETTLE_MS.completion
    expect(labeler.sweep()).toBe(2)
    expect(labelOf(repository, "completion:episode:ses_c1:1")).toMatchObject({
      outcome: "correct",
      baselineOutcome: "incorrect",
      source: "episode-outcome",
    })
    expect(labelOf(repository, "completion:episode:ses_c2:1")).toMatchObject({ outcome: "incorrect", baselineOutcome: "correct" })
    // Still open: not knowable yet.
    expect(labelOf(repository, "completion:episode:ses_c3:1")).toBeUndefined()
  })
})

describe("contextItem", () => {
  const fileID = (path: string) => opaqueItemID("file", path, KEY)
  const plan = (repository: SqliteRoutineRepository, sessionID: string, archived: string) =>
    decide(
      repository,
      {
        kind: "contextItem",
        id: `contextItem:episode:${sessionID}:1`,
        episodeID: `episode:${sessionID}:1`,
        sessionID,
        answer: { decisions: [{ id: fileID(archived), disposition: "archive" }] },
        baselineAnswer: { decisions: [{ id: fileID(archived), disposition: "keep" }] },
        shadow: true,
      },
      T0,
    )

  test("an archived file re-read after the close is a recall miss; no re-read after later activity is correct", () => {
    const { repository, recorded, clock, labeler } = setup()
    episode(repository, "episode:ses_x1:1", "ses_x1", { endedAt: T0, files: ["src/a.ts"] })
    episode(repository, "episode:ses_x2:1", "ses_x2", { endedAt: T0, files: ["src/a.ts"] })
    episode(repository, "episode:ses_x3:1", "ses_x3", { endedAt: T0, files: ["src/a.ts"] })
    plan(repository, "ses_x1", "src/a.ts")
    plan(repository, "ses_x2", "src/a.ts")
    plan(repository, "ses_x3", "src/a.ts")
    // The session came back and read the archived file by its absolute path.
    recorded.signals.set("ses_x1", [{ tool: "read", start: T0 + 5 * MINUTE, ok: true, paths: [`${PROJECT}/src/a.ts`] }])
    recorded.signals.set("ses_x2", [{ tool: "read", start: T0 + 5 * MINUTE, ok: true, paths: ["src/b.ts"] }])
    clock.now = T0 + LABEL_SETTLE_MS.contextItem
    expect(labeler.sweep()).toBe(2)
    expect(labelOf(repository, "contextItem:episode:ses_x1:1")).toMatchObject({
      outcome: "incorrect",
      baselineOutcome: "correct",
      source: "recall",
    })
    expect(labelOf(repository, "contextItem:episode:ses_x2:1")).toMatchObject({ outcome: "correct", baselineOutcome: "correct" })
    // No later activity at all: nothing could have been re-read yet.
    expect(labelOf(repository, "contextItem:episode:ses_x3:1")).toBeUndefined()
  })
})

describe("failure", () => {
  const loop = (repository: SqliteRoutineRepository, sessionID: string, verdict: "intervene" | "continue") =>
    decide(
      repository,
      {
        kind: "failure",
        id: `failure:${sessionID}:bash:abc123`,
        sessionID,
        answer: { verdict },
        baselineAnswer: { verdict: verdict === "intervene" ? "continue" : "intervene" },
      },
      T0,
    )
  const toolError = (seq: number, at: number, tool = "bash"): EpisodeEvent => ({ kind: "tool.error", seq, at, tool, message: "" })

  test("intervene is correct when the loop ended in a session error inside the window", () => {
    const { repository, recorded, clock, labeler } = setup()
    loop(repository, "ses_f1", "intervene")
    recorded.events.set("ses_f1", [{ kind: "session.error", seq: 1, at: T0 + 2 * MINUTE, error: "APIError", message: "" }])
    clock.now = T0 + LABEL_SETTLE_MS.failure
    labeler.sweep()
    expect(labelOf(repository, "failure:ses_f1:bash:abc123")).toMatchObject({
      outcome: "correct",
      baselineOutcome: "incorrect",
      source: "loop-course",
    })
  })

  test("continue is incorrect when the same tool kept failing inside the window", () => {
    const { repository, recorded, clock, labeler } = setup()
    loop(repository, "ses_f2", "continue")
    // Another tool failing does not count; the looping one failing twice more does.
    recorded.events.set("ses_f2", [toolError(1, T0 + MINUTE, "read"), toolError(2, T0 + 2 * MINUTE), toolError(3, T0 + 3 * MINUTE)])
    clock.now = T0 + LABEL_SETTLE_MS.failure
    labeler.sweep()
    expect(labelOf(repository, "failure:ses_f2:bash:abc123")).toMatchObject({ outcome: "incorrect", baselineOutcome: "correct" })
  })

  test("intervene is incorrect when the loop resolved on its own; silence afterwards is not judged", () => {
    const { repository, recorded, clock, labeler } = setup()
    loop(repository, "ses_f3", "intervene")
    recorded.events.set("ses_f3", [toolError(1, T0 + MINUTE)])
    turn(repository, "ses_f3", "msg_9", T0 + FAILURE_WINDOW_MS + MINUTE)
    loop(repository, "ses_f4", "intervene")
    clock.now = T0 + LABEL_SETTLE_MS.failure
    expect(labeler.sweep()).toBe(1)
    expect(labelOf(repository, "failure:ses_f3:bash:abc123")).toMatchObject({ outcome: "incorrect", baselineOutcome: "correct" })
    expect(labelOf(repository, "failure:ses_f4:bash:abc123")).toBeUndefined()
  })
})

describe("labeling coverage", () => {
  /**
   * The AC, with recorded events: a synthetic day of 40 sessions of three turns each, one relevance
   * decision per turn, decided through the day. One session in ten never reported metrics (a plugin
   * that was not installed), and one turn in five loaded a skill the answer did not choose. The
   * sweep runs on its own cadence through the day, bounded per pass.
   */
  test("≥80% of relevance decisions are labelled within 24 h of synthetic usage", () => {
    const { repository, clock, labeler } = setup({ limit: 50 })
    const day = T0
    for (let session = 0; session < 40; session++) {
      const sessionID = `ses_day${session}`
      const start = day + session * 30 * MINUTE
      for (let index = 0; index < 3; index++) {
        const turnID = `msg_${index}`
        const at = start + index * 2 * MINUTE
        relevance(repository, sessionID, turnID, ["review"], [], at)
        if (session % 10 === 9) continue
        turn(repository, sessionID, turnID, at + 1_000, (session + index) % 5 === 0 ? ["deploy"] : ["review"])
      }
    }
    for (clock.now = day; clock.now <= day + 24 * HOUR; clock.now += 5 * MINUTE) labeler.sweep()
    const coverage = labelCoverage(repository, day + 24 * HOUR).kinds.skillRelevance
    expect(coverage.eligible).toBe(120)
    expect(coverage.coverage).toBeGreaterThanOrEqual(0.8)
    // The judged share alone, without the max-age unknowns, already clears the bar.
    expect(coverage.judgedCoverage).toBeGreaterThanOrEqual(0.8)
    expect(coverage.correct).toBeGreaterThan(0)
    expect(coverage.incorrect).toBeGreaterThan(0)
  })

  test("counts only settled decisions inside the window, and a hand-edited label never throws", () => {
    const { repository } = setup()
    relevance(repository, "ses_w1", "msg_1", [], [], T0 - 25 * HOUR)
    relevance(repository, "ses_w2", "msg_1", [], [], T0 - HOUR)
    relevance(repository, "ses_w3", "msg_1", [], [], T0 - MINUTE)
    repository.labelDecision("skillRelevance:ses_w2:msg_1", { outcome: "correct", source: "test" }, T0)
    expect(labelCoverage(repository, T0).kinds.skillRelevance).toEqual({
      eligible: 1,
      labeled: 1,
      correct: 1,
      incorrect: 0,
      unknown: 0,
      coverage: 1,
      judgedCoverage: 1,
    })
    expect(labelCoverage(repository, T0).kinds.failure.coverage).toBeNull()
  })

  test("the route serves it under the artifacts bearer, and explain carries the label", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const config = resolveAdaptiveConfig({ block: {}, env: {} })
    const decisions = createDecisionService({
      repository,
      config: () => config,
      egress: createAdaptiveEgressGuard({ config: () => config }),
    })
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const handler = createHarnessHandler(repository, scheduler, { token: "secret", decisions })
    const now = Date.now()
    relevance(repository, "ses_r", "msg_1", ["review"], [], now - HOUR)
    repository.labelDecision(
      "skillRelevance:ses_r:msg_1",
      { outcome: "correct", baselineOutcome: "incorrect", source: "skill-loads" },
      now,
    )

    expect((await handler(new Request("http://x/harness/adaptive/labels/coverage"))).status).toBe(403)
    const response = await handler(
      new Request("http://x/harness/adaptive/labels/coverage", { headers: { authorization: "Bearer secret" } }),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.kinds.skillRelevance).toMatchObject({ eligible: 1, labeled: 1, coverage: 1 })

    const explained = await (
      await handler(
        new Request("http://x/harness/adaptive/decisions/skillRelevance:ses_r:msg_1", {
          headers: { authorization: "Bearer secret" },
        }),
      )
    ).json()
    expect(explained.data.label).toEqual({
      outcome: "correct",
      baselineOutcome: "incorrect",
      source: "skill-loads",
      labeledAt: now,
    })
    repository.close()
  })
})
