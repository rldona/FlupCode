/**
 * Decision fixtures: the FH-007 episodes, decided deterministically and offline (FH-015/FH-017).
 *
 * Each of the five replay sessions is seeded into a real repository and captured by the real
 * coordinator through injected readers — no filesystem, no engine, no network — and then the
 * deterministic decision is taken and asserted. This is the seed of the evaluation set: it says what
 * the harness decides with Jev off, on evidence that is already a fixture.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ToolUses } from "../context"
import { SqliteRoutineRepository } from "../repository"
import type { RunSource, RunStatus, TaskInput, TaskKind, TaskStatus } from "../types"
import { createEpisodeCoordinator } from "./coordinator"
import type { EpisodeOutcome, SessionEpisode } from "./episode"
import { runEpisodeID, sessionEpisodeID } from "./episode"
import { resolveAdaptiveConfig } from "./config"
import type { ContextItem, DecisionPolicy, DecisionRequest } from "./decision"
import { createDecisionService } from "./decision-service"
import { decisionID } from "./decision-record"
import { createAdaptiveEgressGuard } from "./egress"
import type { EpisodeEvents } from "./events"
import type { EpisodeSignals } from "./signals"

type FixtureTask = { name: string; prompt: string; kind?: string; attempt?: number; status?: string; error?: string; output?: string }

type Fixture = {
  name: string
  capture: "run" | "session" | "sweep"
  directory: string
  now: number
  run?: { source: RunSource; startedAt: number; finish?: { status: string; at: number; error?: string }; sessionID?: string }
  tasks?: FixtureTask[]
  session?: { sessionID: string; directory?: string }
  toolUses?: Record<string, ToolUses>
  signals?: Record<string, EpisodeSignals>
  events?: Record<string, EpisodeEvents>
  expect: { outcome: EpisodeOutcome; failures: Array<{ summary: string }>; files: string[]; commands: string[] }
}

const fixturesDirectory = join(import.meta.dir, "fixtures")
const load = (name: string): Fixture => JSON.parse(readFileSync(join(fixturesDirectory, `${name}.json`), "utf8")) as Fixture

const capture = (fixture: Fixture): { repository: SqliteRoutineRepository; episode: SessionEpisode } => {
  const repository = new SqliteRoutineRepository(":memory:")
  const run = fixture.run ? repository.startRun(fixture.run.source, fixture.run.startedAt, fixture.directory) : undefined
  if (run && fixture.run?.sessionID) repository.attachSession(run.id, fixture.run.sessionID)
  const seeds = (fixture.tasks ?? []).map(
    (task): TaskInput => ({
      name: task.name,
      prompt: task.prompt,
      ...(task.kind ? { kind: task.kind as TaskKind } : {}),
      ...(task.attempt !== undefined ? { attempt: task.attempt } : {}),
    }),
  )
  const tasks = run ? repository.addTasks(run.id, seeds) : []
  ;(fixture.tasks ?? []).forEach((task, index) => {
    const seeded = tasks[index]
    if (!seeded) return
    if (task.status)
      repository.finishTask(
        seeded.id,
        task.status as Exclude<TaskStatus, "queued" | "running">,
        { error: task.error, output: task.output },
        fixture.now,
      )
  })
  if (run && fixture.run?.finish)
    repository.finishRun(
      run.id,
      fixture.run.finish.status as Exclude<RunStatus, "running">,
      fixture.run.finish.error,
      fixture.run.finish.at,
    )
  if (run && fixture.capture === "sweep") repository.recoverRunning(fixture.now)

  const coordinator = createEpisodeCoordinator({
    repository,
    now: () => fixture.now,
    readToolUses: (sessionID) => fixture.toolUses?.[sessionID] ?? { tools: {}, calls: [] },
    readEpisodeSignals: (sessionID) => fixture.signals?.[sessionID] ?? { calls: [] },
    readEpisodeEvents: (sessionID) => fixture.events?.[sessionID] ?? { events: [] },
  })
  const episode = fixture.capture === "session"
    ? coordinator.captureSession({ sessionID: fixture.session!.sessionID, directory: fixture.session!.directory })
    : coordinator.captureRun(run!.id)
  return { repository, episode: episode! }
}

const completionRequest = (episode: SessionEpisode, policy: DecisionPolicy): DecisionRequest<"completion"> => ({
  kind: "completion",
  episodeID: episode.id,
  sessionID: episode.sessionID,
  projectID: episode.projectID,
  policy,
  state: {
    episodeID: episode.id,
    objective: episode.objective,
    outcome: episode.outcome,
    toolCalls: episode.toolCalls,
    verifications: episode.verifications,
    failures: episode.failures.length,
    projectID: episode.projectID,
  },
})

const contextRequest = (episode: SessionEpisode, policy: DecisionPolicy): DecisionRequest<"contextItem"> => ({
  kind: "contextItem",
  episodeID: episode.id,
  projectID: episode.projectID,
  policy,
  state: {
    objective: episode.objective,
    items: [
      ...episode.files.map((path): ContextItem => ({ id: `file:${path}`, kind: "file", tokens: 0, referenced: true, anchors: 0, archived: false })),
      ...episode.commands.map((command): ContextItem => ({ id: `command:${command}`, kind: "command", tokens: 0, referenced: true, anchors: 0, archived: false })),
      ...episode.failures.map((failure): ContextItem => ({ id: `failure:${failure.summary}`, kind: "error", tokens: 0, referenced: true, anchors: 0, archived: false })),
    ],
  },
})

const serviceFor = (repository: SqliteRoutineRepository) => {
  const config = resolveAdaptiveConfig({ block: {}, env: {} })
  return createDecisionService({
    repository,
    config: () => config,
    egress: createAdaptiveEgressGuard({ config: () => config }),
    now: () => 1_000,
  })
}

/** What the deterministic rule must answer for each fixture, hand-written from its evidence. */
const EXPECTED: Record<string, { verdict: "complete" | "not_complete"; contextItemIDs: string[] }> = {
  "run-red-then-green": {
    verdict: "not_complete",
    contextItemIDs: ["file:src/math.ts", "command:bun test", "failure:the check is red"],
  },
  "run-last-check-red": {
    verdict: "not_complete",
    contextItemIDs: ["failure:the last check is red"],
  },
  "session-fail-and-fix": {
    verdict: "not_complete",
    contextItemIDs: ["file:src/math.ts", "command:bun test", "failure:expect(received).toBe(expected)"],
  },
  "session-tool-error": {
    verdict: "not_complete",
    contextItemIDs: ["failure:edit failed: permission denied"],
  },
  "run-crashed-then-recovered": {
    verdict: "not_complete",
    contextItemIDs: ["file:src/math.ts", "command:bun test"],
  },
}

describe("decision fixtures over the FH-007 sessions (FH-015)", () => {
  for (const name of Object.keys(EXPECTED)) {
    test(`${name}: the deterministic decision matches the episode`, async () => {
      const fixture = load(name)
      const { repository, episode } = capture(fixture)
      expect(episode.outcome).toBe(fixture.expect.outcome)
      expect(episode.id).toBe(fixture.run ? runEpisodeID(episode.runID!) : sessionEpisodeID(fixture.session!.sessionID))

      const service = serviceFor(repository)
      const config = resolveAdaptiveConfig({ block: {}, env: {} })
      await service.predict(completionRequest(episode, config.decisions.completion))
      await service.predict(contextRequest(episode, config.decisions.contextItem))

      const expected = EXPECTED[name]!
      const completion = service.explain(decisionID("completion", episode.id))
      expect(completion?.answer).toEqual({ verdict: expected.verdict })
      expect(completion?.baseline).toEqual({ answer: { verdict: expected.verdict }, rule: "episode-outcome" })

      const context = service.explain(decisionID("contextItem", episode.id))
      expect((context?.answer as { decisions: Array<{ id: string }> }).decisions.map((entry) => entry.id)).toEqual(
        expected.contextItemIDs,
      )
      // The baseline is a rule: every item is kept, so nothing is dropped on its own.
      expect(
        (context?.baseline.answer as { decisions: Array<{ disposition: string }> }).decisions.every(
          (entry) => entry.disposition === "keep",
        ),
      ).toBe(true)
      repository.close()
    })
  }
})
