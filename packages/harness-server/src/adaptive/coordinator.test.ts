import { describe, expect, jest, test } from "bun:test"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolUses } from "../context"
import { SqliteRoutineRepository } from "../repository"
import { createEpisodeCoordinator, sessionActivity } from "./coordinator"
import type { EpisodeCoordinatorDeps, EpisodeEvidenceStore, SessionActivity, SessionIdentity } from "./coordinator"
import { EVIDENCE_EPISODE_SLICE_LIMIT, EVIDENCE_OVERFLOW_CONTENT } from "./evidence"
import { DEFAULT_EPISODE_BOUNDARY_CONFIG, runEpisodeID, sessionEpisodeID } from "./episode"
import { OUTCOME_REF_LIMIT } from "./outcome"

const open = (path = ":memory:") => new SqliteRoutineRepository(path)

// Signals and events default to none so a test never reads whatever the machine's real folders hold;
// a test that wants evidence injects its own reader and overrides the default.
const episodeCoordinator = (deps: EpisodeCoordinatorDeps) =>
  createEpisodeCoordinator({
    readEpisodeSignals: () => ({ calls: [] }),
    readEpisodeEvents: () => ({ events: [] }),
    ...deps,
  })

const NOW = 1_000_000

// The tail a `bun test` run leaves in a shell signal, in the shape failures.ts reads.
const BUN_TEST_SAMPLE = "error: expected\n      at <anonymous> (/work/proj/src/a.test.ts:3:17)\n(fail) adds [3.67ms]"

describe("the episode coordinator (FH-002)", () => {
  test("a run of one task yields one episode under its deterministic id", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW, "/work/proj")
    const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.finishTask(task!.id, "success", { output: "done" }, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const coordinator = episodeCoordinator({ repository, now: () => NOW })
    const episode = coordinator.captureRun(run.id)

    expect(episode?.id).toBe(runEpisodeID(run.id))
    expect(episode).toMatchObject({
      sessionID: run.id,
      projectID: "/work/proj",
      runID: run.id,
      objective: "build",
      outcome: "success",
      startedAt: NOW,
      endedAt: NOW,
    })
    expect(repository.listEpisodes({ runID: run.id })).toHaveLength(1)
    repository.close()
  })

  test("a run of many tasks is still one episode, carrying its failures and checks", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW)
    const tasks = repository.addTasks(run.id, [
      { name: "plan", prompt: "plan" },
      { name: "build", prompt: "build" },
      { name: "check", prompt: "", kind: "verify" },
    ])
    repository.finishTask(tasks[0]!.id, "success", {}, NOW)
    repository.finishTask(tasks[1]!.id, "failed", { error: "nope" }, NOW)
    repository.finishTask(tasks[2]!.id, "failed", {}, NOW)
    repository.finishRun(run.id, "failed", "the check failed", NOW)

    const episode = episodeCoordinator({ repository, now: () => NOW }).captureRun(run.id)

    expect(repository.listEpisodes({ runID: run.id })).toHaveLength(1)
    expect(episode).toMatchObject({ objective: "plan → build → check", outcome: "failed" })
    expect(episode?.failures).toEqual([{ summary: "nope" }, { summary: "Task failed: check" }])
    expect(episode?.verifications).toEqual([{ step: "check", ok: false }])
    expect(episode?.evidenceRefs).toEqual([
      `run:${run.id}`,
      `task:${tasks[0]!.id}`,
      `task:${tasks[1]!.id}`,
      `task:${tasks[2]!.id}`,
    ])
    repository.close()
  })

  test("capturing twice, or a retry, converges on one row and keeps timeCreated", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW)
    const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.finishTask(task!.id, "success", {}, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const coordinator = episodeCoordinator({ repository, now: () => NOW })
    const first = coordinator.captureRun(run.id)!
    const second = coordinator.captureRun(run.id)!

    expect(repository.listEpisodes({ runID: run.id })).toHaveLength(1)
    expect(second.id).toBe(first.id)
    expect(second.timeCreated).toBe(first.timeCreated)
    repository.close()
  })

  test("sweep writes a terminal run with no episode and leaves a captured one alone", () => {
    const repository = open()
    const captured = repository.startRun({ type: "manual" }, NOW)
    repository.addTasks(captured.id, [{ name: "a", prompt: "a" }])
    repository.finishRun(captured.id, "success", undefined, NOW)
    const missed = repository.startRun({ type: "manual" }, NOW)
    repository.addTasks(missed.id, [{ name: "b", prompt: "b" }])
    repository.finishRun(missed.id, "failed", "boom", NOW)

    const coordinator = episodeCoordinator({ repository, now: () => NOW })
    coordinator.captureRun(captured.id)

    expect(coordinator.sweep()).toBe(1)
    expect(repository.listEpisodes({ runID: missed.id })).toHaveLength(1)
    expect(coordinator.sweep()).toBe(0)
    expect(repository.listEpisodes()).toHaveLength(2)
    repository.close()
  })

  test("a restart over the same store sweeps every terminal run exactly once", () => {
    const repository = open()
    const first = repository.startRun({ type: "manual" }, NOW)
    repository.addTasks(first.id, [{ name: "a", prompt: "a" }])
    repository.finishRun(first.id, "success", undefined, NOW)
    const second = repository.startRun({ type: "manual" }, NOW)
    repository.addTasks(second.id, [{ name: "b", prompt: "b" }])
    repository.finishRun(second.id, "failed", "x", NOW)

    // A fresh coordinator over the same store is what a restart looks like.
    const restarted = episodeCoordinator({ repository, now: () => NOW })
    expect(restarted.sweep()).toBe(2)
    expect(repository.listEpisodes({ runID: first.id })).toHaveLength(1)
    expect(repository.listEpisodes({ runID: second.id })).toHaveLength(1)
    expect(restarted.sweep()).toBe(0)
    repository.close()
  })

  test("cadence rewrites a live run only after enough tool calls; terminal always converges", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW)
    repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.attachSession(run.id, "ses_1")

    let calls = 0
    const coordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      config: { cadenceCalls: 50 },
      readToolUses: () => ({ tools: { bash: { count: calls, last: NOW } }, calls: [] }),
    })

    coordinator.captureRun(run.id)
    expect(repository.getEpisode(runEpisodeID(run.id))?.toolCalls).toBe(0)

    calls = 10
    coordinator.captureRun(run.id)
    expect(repository.getEpisode(runEpisodeID(run.id))?.toolCalls).toBe(0)

    calls = 50
    coordinator.captureRun(run.id)
    expect(repository.getEpisode(runEpisodeID(run.id))?.toolCalls).toBe(50)

    repository.finishRun(run.id, "success", undefined, NOW)
    calls = 60
    coordinator.captureRun(run.id)
    expect(repository.getEpisode(runEpisodeID(run.id))).toMatchObject({
      toolCalls: 60,
      outcome: "success",
      endedAt: NOW,
    })
    repository.close()
  })

  test("captureSession on a task's session captures the run, never a session episode", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW)
    const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.attachTaskSession(task!.id, "ses_task")
    repository.finishTask(task!.id, "success", {}, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const coordinator = episodeCoordinator({ repository, now: () => NOW })
    coordinator.captureSession({ sessionID: "ses_task", runID: run.id, directory: "/work" })

    expect(repository.getEpisode(runEpisodeID(run.id))?.sessionID).toBe("ses_task")
    expect(repository.getEpisode(sessionEpisodeID("ses_task"))).toBeUndefined()
    expect(repository.listEpisodes().some((entry) => entry.id.startsWith("episode:session:"))).toBe(false)
    repository.close()
  })

  test("captureSession without a run writes one episode of its own", () => {
    const repository = open()
    const coordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      readToolUses: () => ({ tools: { read: { count: 3, last: NOW } }, calls: [] }),
    })

    const episode = coordinator.captureSession({ sessionID: "ses_free", directory: "/work" })

    expect(episode).toMatchObject({ id: sessionEpisodeID("ses_free"), sessionID: "ses_free", toolCalls: 3 })
    expect(repository.listEpisodes()).toHaveLength(1)
    repository.close()
  })

  test("captured signals fill an episode's files, commands and failures", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW, "/work/proj")
    const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.attachSession(run.id, "ses_1")
    repository.finishTask(task!.id, "success", {}, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const coordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      readEpisodeSignals: (sessionID) =>
        sessionID === "ses_1"
          ? {
              calls: [
                { tool: "bash", ok: true, exit: 1, command: "bun test", out: BUN_TEST_SAMPLE, paths: [] },
                { tool: "edit", ok: true, paths: ["/work/proj/src/add.ts"] },
              ],
            }
          : { calls: [] },
    })

    const episode = coordinator.captureRun(run.id)!

    expect(episode.commands).toEqual(["bun test"])
    expect(episode.files).toEqual(["src/add.ts"])
    expect(episode.failures).toEqual([{ summary: "expected", file: "src/a.test.ts", line: 3 }])
    expect(episode.verifications).toEqual([])
    expect(episode.outcome).toBe("success")
    repository.close()
  })

  test("captured signals merge with task failures and leave outcome and verifications intact", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW, "/work/proj")
    const tasks = repository.addTasks(run.id, [
      { name: "build", prompt: "go" },
      { name: "check", prompt: "", kind: "verify" },
    ])
    repository.attachSession(run.id, "ses_1")
    repository.finishTask(tasks[0]!.id, "success", {}, NOW)
    repository.finishTask(tasks[1]!.id, "failed", { error: "the check failed" }, NOW)
    repository.finishRun(run.id, "failed", "the check failed", NOW)

    const coordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      readEpisodeSignals: () => ({
        calls: [
          { tool: "bash", ok: true, exit: 1, command: "bun test", out: BUN_TEST_SAMPLE, paths: [] },
          { tool: "edit", ok: true, paths: ["/work/proj/src/add.ts"] },
        ],
      }),
    })

    const episode = coordinator.captureRun(run.id)!

    // What the tasks said and what the shell printed both land, in that order and without repeating.
    expect(episode.files).toEqual(["src/add.ts"])
    expect(episode.commands).toEqual(["bun test"])
    expect(episode.failures).toEqual([
      { summary: "the check failed" },
      { summary: "expected", file: "src/a.test.ts", line: 3 },
    ])
    // Evidence fills only files, commands and failures; FH-005 owns outcome and verifications.
    expect(episode.verifications).toEqual([{ step: "check", ok: false }])
    expect(episode.outcome).toBe("failed")
    repository.close()
  })

  test("with no signals an episode carries no evidence, exactly as before", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW, "/work/proj")
    const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.finishTask(task!.id, "success", {}, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const coordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      readEpisodeSignals: () => ({ calls: [] }),
    })
    const episode = coordinator.captureRun(run.id)!

    expect(episode).toMatchObject({ files: [], commands: [], failures: [] })
    repository.close()
  })

  test("a tool error event fills an episode's failures", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW, "/work/proj")
    const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.attachSession(run.id, "ses_1")
    repository.finishTask(task!.id, "success", {}, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const coordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      readEpisodeEvents: (sessionID) =>
        sessionID === "ses_1"
          ? {
              events: [
                {
                  kind: "tool.error",
                  seq: 1,
                  at: NOW,
                  tool: "edit",
                  callID: "call_1",
                  message: "permission denied",
                },
              ],
            }
          : { events: [] },
    })

    const episode = coordinator.captureRun(run.id)!

    expect(episode.failures).toEqual([{ summary: "edit failed: permission denied" }])
    repository.close()
  })

  test("a session with only a session error reads partial, not unknown", () => {
    const repository = open()
    const coordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      readEpisodeEvents: () => ({
        events: [{ kind: "session.error", seq: 1, at: NOW, error: "APIError", message: "rate limited" }],
      }),
    })

    const episode = coordinator.captureSession({ sessionID: "ses_free", directory: "/work/proj" })!

    expect(episode.failures).toEqual([{ summary: "APIError: rate limited" }])
    expect(episode.outcome).toBe("partial")
    expect(episode.evidenceRefs).toContain("failure:unknown:0")
    repository.close()
  })

  test("a thrown reader or a refusing store is swallowed and leaves the run untouched", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW)
    const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.attachSession(run.id, "ses_1")
    repository.finishTask(task!.id, "success", {}, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const seen: unknown[] = []
    const throwingReader = episodeCoordinator({
      repository,
      now: () => NOW,
      onError: (cause) => seen.push(cause),
      readToolUses: () => {
        throw new Error("unreadable")
      },
    })
    expect(() => throwingReader.captureRun(run.id)).not.toThrow()
    expect(repository.getEpisode(runEpisodeID(run.id))).toBeUndefined()
    expect(seen).toHaveLength(1)

    repository.createEpisode = () => {
      throw new Error("store refused")
    }
    const refusingStore = episodeCoordinator({ repository, now: () => NOW, onError: (cause) => seen.push(cause) })
    expect(() => refusingStore.captureRun(run.id)).not.toThrow()
    expect(refusingStore.captureRun(run.id)).toBeUndefined()
    expect(seen).toHaveLength(3)

    // The run is untouched by both failures.
    expect(repository.getRun(run.id)).toMatchObject({ status: "success" })
    repository.close()
  })

  test("start sweeps once and stop clears the timer without throwing", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW)
    repository.addTasks(run.id, [{ name: "a", prompt: "a" }])
    repository.finishRun(run.id, "success", undefined, NOW)

    const coordinator = episodeCoordinator({ repository, now: () => NOW, config: { sweepMs: 60_000 } })
    coordinator.start()
    expect(repository.listEpisodes({ runID: run.id })).toHaveLength(1)
    coordinator.stop()
    coordinator.stop()
    repository.close()
  })

  test("a resumed run keeps its one episode across the pause", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW)
    repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.awaitRun(run.id)

    const coordinator = episodeCoordinator({ repository, now: () => NOW })
    const waiting = coordinator.captureRun(run.id)!
    expect(waiting).toMatchObject({ outcome: "unknown" })
    expect(waiting.endedAt).toBeUndefined()

    repository.resumeRun(run.id)
    repository.finishRun(run.id, "success", undefined, NOW + 10)
    const settled = coordinator.captureRun(run.id)!

    expect(settled.id).toBe(waiting.id)
    expect(settled.timeCreated).toBe(waiting.timeCreated)
    expect(settled).toMatchObject({ outcome: "success", endedAt: NOW + 10 })
    expect(repository.listEpisodes({ runID: run.id })).toHaveLength(1)
    repository.close()
  })

  test("a later capture converges on the same row and keeps the original timeCreated", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW)
    repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.finishRun(run.id, "success", undefined, NOW)

    let clock = NOW
    const coordinator = episodeCoordinator({ repository, now: () => clock })
    coordinator.captureRun(run.id)
    clock = NOW + 500
    const second = coordinator.captureRun(run.id)!

    expect(second.timeCreated).toBe(NOW)
    expect(second.timeUpdated).toBe(NOW + 500)
    expect(repository.listEpisodes({ runID: run.id })).toHaveLength(1)
    repository.close()
  })

  test("a sweep respects its run limit", () => {
    const repository = open()
    for (const startedAt of [NOW, NOW + 1, NOW + 2]) {
      const run = repository.startRun({ type: "manual" }, startedAt)
      repository.addTasks(run.id, [{ name: "a", prompt: "a" }])
      repository.finishRun(run.id, "success", undefined, startedAt + 10)
    }

    const coordinator = episodeCoordinator({ repository, now: () => NOW + 100, sweepLimit: 2 })

    expect(coordinator.sweep()).toBe(2)
    expect(repository.listEpisodes().filter((episode) => episode.runID)).toHaveLength(2)
    repository.close()
  })

  test("a sweep pages past its limit until every terminal run has an episode", () => {
    const repository = open()
    for (const startedAt of [NOW, NOW + 1, NOW + 2]) {
      const run = repository.startRun({ type: "manual" }, startedAt)
      repository.addTasks(run.id, [{ name: "a", prompt: "a" }])
      repository.finishRun(run.id, "success", undefined, startedAt + 10)
    }

    const coordinator = episodeCoordinator({ repository, now: () => NOW + 100, sweepLimit: 2 })

    expect(coordinator.sweep()).toBe(2)
    expect(coordinator.sweep()).toBe(1)
    expect(coordinator.sweep()).toBe(0)
    expect(repository.listEpisodes().filter((episode) => episode.runID)).toHaveLength(3)
    repository.close()
  })

  test("already-captured runs do not consume the sweep limit and starve uncaptured ones", () => {
    const repository = open()
    const runs = [NOW, NOW + 1, NOW + 2, NOW + 3].map((startedAt) => {
      const run = repository.startRun({ type: "manual" }, startedAt)
      repository.addTasks(run.id, [{ name: "a", prompt: "a" }])
      repository.finishRun(run.id, "success", undefined, startedAt + 10)
      return run
    })

    const coordinator = episodeCoordinator({ repository, now: () => NOW + 100, sweepLimit: 2 })
    // The three newest runs already have an episode; only the oldest still needs one. A limit that
    // looked at the newest runs before discarding captures would see nothing to do here.
    for (const run of runs.slice(1)) coordinator.captureRun(run.id)

    expect(coordinator.sweep()).toBe(1)
    expect(repository.getEpisode(runEpisodeID(runs[0]!.id))).toBeDefined()
    repository.close()
  })

  test("a sweep fills a terminal run only when it ended inside the backfill window", () => {
    const repository = open()
    const recent = repository.startRun({ type: "manual" }, NOW - 500)
    repository.addTasks(recent.id, [{ name: "recent", prompt: "r" }])
    repository.finishRun(recent.id, "success", undefined, NOW - 100)
    // Exactly at the cutoff: the window is inclusive, so this one is still captured.
    const boundary = repository.startRun({ type: "manual" }, NOW - 1_500)
    repository.addTasks(boundary.id, [{ name: "boundary", prompt: "b" }])
    repository.finishRun(boundary.id, "failed", "b", NOW - 1_000)
    const old = repository.startRun({ type: "manual" }, NOW - 5_000)
    repository.addTasks(old.id, [{ name: "old", prompt: "o" }])
    repository.finishRun(old.id, "failed", "o", NOW - 4_000)

    const coordinator = episodeCoordinator({ repository, now: () => NOW, config: { backfillMs: 1_000 } })

    expect(coordinator.sweep()).toBe(2)
    expect(repository.listEpisodes({ runID: recent.id })).toHaveLength(1)
    expect(repository.listEpisodes({ runID: boundary.id })).toHaveLength(1)
    expect(repository.getEpisode(runEpisodeID(old.id))).toBeUndefined()
    repository.close()
  })

  test("a real restart over the same database file sweeps each run exactly once", () => {
    const directory = mkdtempSync(join(tmpdir(), "flupcode-coordinator-"))
    const path = join(directory, "harness.sqlite")
    try {
      const before = open(path)
      const run = before.startRun({ type: "manual" }, NOW)
      before.addTasks(run.id, [{ name: "a", prompt: "a" }])
      before.finishRun(run.id, "failed", "restart", NOW)
      before.close()

      const after = open(path)
      const coordinator = episodeCoordinator({ repository: after, now: () => NOW })
      expect(coordinator.sweep()).toBe(1)
      expect(after.listEpisodes({ runID: run.id })).toHaveLength(1)
      expect(coordinator.sweep()).toBe(0)
      after.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("a restart settles a live checkpoint a crashed run left behind", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW)
    repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.attachSession(run.id, "ses_1")

    const coordinator = episodeCoordinator({ repository, now: () => NOW })
    // The run is still going, so its capture is a live checkpoint: no outcome, no endedAt.
    const live = coordinator.captureRun(run.id)!
    expect(live).toMatchObject({ id: runEpisodeID(run.id), outcome: "unknown" })
    expect(live.endedAt).toBeUndefined()

    // The server goes down and comes back: recovery marks the orphaned run failed.
    repository.recoverRunning(NOW)
    expect(repository.getRun(run.id)).toMatchObject({ status: "failed" })

    // The sweep no longer skips it just because a row exists: it settles the same episode.
    expect(coordinator.sweep()).toBe(1)
    const settled = repository.getEpisode(runEpisodeID(run.id))!
    expect(settled).toMatchObject({ outcome: "failed", endedAt: NOW, timeCreated: live.timeCreated })
    expect(repository.listEpisodes({ runID: run.id })).toHaveLength(1)
    expect(coordinator.sweep()).toBe(0)
    repository.close()
  })

  test("a failing session capture or sweep is swallowed and reported", () => {
    const repository = open()
    const seen: unknown[] = []

    const failingSession = episodeCoordinator({
      repository,
      now: () => NOW,
      onError: (cause) => seen.push(cause),
      readToolUses: () => {
        throw new Error("unreadable session")
      },
    })
    expect(failingSession.captureSession({ sessionID: "ses_free" })).toBeUndefined()
    expect(repository.listEpisodes()).toHaveLength(0)

    repository.listRunsWithoutTerminalEpisode = () => {
      throw new Error("no runs")
    }
    const failingSweep = episodeCoordinator({
      repository,
      now: () => NOW,
      onError: (cause) => seen.push(cause),
    })
    expect(failingSweep.sweep()).toBe(0)

    expect(seen).toHaveLength(2)
    repository.close()
  })

  test("the timer sweeps on its interval, refuses a reentrant sweep, and stop clears it", () => {
    jest.useFakeTimers()
    try {
      const repository = open()
      const first = repository.startRun({ type: "manual" }, NOW)
      repository.addTasks(first.id, [{ name: "a", prompt: "a" }])
      repository.finishRun(first.id, "success", undefined, NOW)

      const coordinator = episodeCoordinator({ repository, now: () => NOW, config: { sweepMs: 100 } })
      coordinator.start()
      expect(repository.listEpisodes({ runID: first.id })).toHaveLength(1)

      const second = repository.startRun({ type: "manual" }, NOW + 1)
      repository.addTasks(second.id, [{ name: "b", prompt: "b" }])
      repository.finishRun(second.id, "failed", "x", NOW + 1)

      // A sweep triggered from inside a sweep must be refused, not stack.
      let reentrant = -1
      const listRunsWithoutTerminalEpisode = repository.listRunsWithoutTerminalEpisode.bind(repository)
      repository.listRunsWithoutTerminalEpisode = (input) => {
        reentrant = coordinator.sweep()
        return listRunsWithoutTerminalEpisode(input)
      }

      jest.advanceTimersByTime(100)
      expect(reentrant).toBe(0)
      expect(repository.listEpisodes()).toHaveLength(2)

      coordinator.stop()
      const afterStop = repository.startRun({ type: "manual" }, NOW + 2)
      repository.addTasks(afterStop.id, [{ name: "c", prompt: "c" }])
      repository.finishRun(afterStop.id, "failed", "y", NOW + 2)
      jest.advanceTimersByTime(1_000)
      expect(repository.getEpisode(runEpisodeID(afterStop.id))).toBeUndefined()
      repository.close()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("outcome extraction (FH-005)", () => {
  test("a recovered check reads as success and cites verify:check once", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW)
    const tasks = repository.addTasks(run.id, [
      { name: "check", prompt: "", kind: "verify" },
      { name: "check", prompt: "", kind: "verify" },
    ])
    repository.finishTask(tasks[0]!.id, "failed", { error: "red" }, NOW)
    repository.finishTask(tasks[1]!.id, "success", {}, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const episode = episodeCoordinator({ repository, now: () => NOW }).captureRun(run.id)!

    expect(episode.verifications).toEqual([
      { step: "check", ok: false },
      { step: "check", ok: true },
    ])
    expect(episode.outcome).toBe("success")
    expect(episode.evidenceRefs.filter((ref) => ref === "verify:check")).toHaveLength(1)
    repository.close()
  })

  test("a successful run whose last check is red reads as partial", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW)
    const tasks = repository.addTasks(run.id, [
      { name: "check", prompt: "", kind: "verify" },
      { name: "check", prompt: "", kind: "verify" },
    ])
    repository.finishTask(tasks[0]!.id, "success", {}, NOW)
    repository.finishTask(tasks[1]!.id, "failed", {}, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const episode = episodeCoordinator({ repository, now: () => NOW }).captureRun(run.id)!

    expect(episode.outcome).toBe("partial")
    expect(episode.evidenceRefs).toContain("verify:check")
    repository.close()
  })

  test("a skipped check is not a verdict: a successful run stays success and cites no ref", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW)
    const tasks = repository.addTasks(run.id, [
      { name: "build", prompt: "go" },
      { name: "check", prompt: "", kind: "verify" },
      { name: "extra", prompt: "", kind: "verify" },
    ])
    repository.finishTask(tasks[0]!.id, "success", {}, NOW)
    repository.finishTask(tasks[1]!.id, "success", {}, NOW)
    // A conditional check whose `when` was not met: skipped, so it never produced a verdict.
    repository.finishTask(tasks[2]!.id, "skipped", { error: "Not run" }, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const episode = episodeCoordinator({ repository, now: () => NOW }).captureRun(run.id)!

    expect(episode.verifications).toEqual([{ step: "check", ok: true }])
    expect(episode.outcome).toBe("success")
    expect(episode.evidenceRefs).not.toContain("verify:extra")
    repository.close()
  })

  test("a successful run whose last check is red reads as partial", () => {
    const repository = open()
    const coordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      readEpisodeSignals: () => ({
        calls: [{ tool: "bash", ok: true, exit: 1, command: "bun test", out: BUN_TEST_SAMPLE, paths: [] }],
      }),
    })

    const episode = coordinator.captureSession({ sessionID: "ses_free", directory: "/work/proj" })!

    expect(episode.outcome).toBe("partial")
    expect(episode.evidenceRefs).toContain("failure:src/a.test.ts:3")
    repository.close()
  })

  test("a session with no signals stays unknown", () => {
    const repository = open()
    const episode = episodeCoordinator({ repository, now: () => NOW }).captureSession({
      sessionID: "ses_free",
      directory: "/work/proj",
    })

    expect(episode).toMatchObject({ outcome: "unknown", evidenceRefs: ["session:ses_free"] })
    repository.close()
  })

  test("the reading's refs keep their room when the run's own anchors fill the cap", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW)
    const tasks = repository.addTasks(
      run.id,
      Array.from({ length: 60 }, (_, index) => ({ name: `s${index}`, prompt: "", kind: "verify" as const })),
    )
    for (const task of tasks) repository.finishTask(task.id, "success", {}, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const episode = episodeCoordinator({ repository, now: () => NOW }).captureRun(run.id)!

    // 50 slots in all: the anchors yield so the derived evidence is never crowded out by them.
    expect(episode.evidenceRefs).toHaveLength(50)
    expect(episode.evidenceRefs).toContain(`run:${run.id}`)
    expect(episode.evidenceRefs).toContain("verify:s0")
    expect(episode.evidenceRefs).toContain(`verify:s${OUTCOME_REF_LIMIT - 1}`)
    expect(episode.evidenceRefs).not.toContain(`verify:s${OUTCOME_REF_LIMIT}`)
    repository.close()
  })
})

describe("episode evidence store (FH-006)", () => {
  const linkCount = (repository: SqliteRoutineRepository) =>
    (repository.db.query("SELECT COUNT(*) AS n FROM episode_evidence").get() as { n: number }).n

  const redShell = { tool: "bash" as const, ok: true, exit: 1, command: "bun test", out: BUN_TEST_SAMPLE, paths: [] }

  test("a red shell's output is kept and read back from the episode", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW, "/work/proj")
    const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.attachSession(run.id, "ses_1")
    repository.finishTask(task!.id, "success", {}, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const coordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      readEpisodeSignals: (sessionID) => (sessionID === "ses_1" ? { calls: [redShell] } : { calls: [] }),
    })
    const episode = coordinator.captureRun(run.id)!

    expect(repository.evidenceFor(episode, NOW)).toEqual([
      expect.objectContaining({ kind: "signal", source: "bun test", content: BUN_TEST_SAMPLE }),
    ])
    // The store keeps the association; the episode's own refs are not touched.
    expect(episode.evidenceRefs.some((ref) => ref.startsWith("evidence:"))).toBe(false)
    repository.close()
  })

  test("a tool error is kept as an event slice", () => {
    const repository = open()
    const coordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      readEpisodeEvents: () => ({
        events: [{ kind: "tool.error", seq: 1, at: NOW, tool: "edit", callID: "call_1", message: "permission denied" }],
      }),
    })

    const episode = coordinator.captureSession({ sessionID: "ses_free", directory: "/work/proj" })!

    expect(repository.evidenceFor(episode, NOW)).toEqual([
      expect.objectContaining({ kind: "event", source: "tool:edit", content: "permission denied" }),
    ])
    repository.close()
  })

  test("a shell that succeeded leaves no evidence", () => {
    const repository = open()
    const coordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      readEpisodeSignals: () => ({ calls: [{ ...redShell, exit: 0, out: "all green" }] }),
    })

    const episode = coordinator.captureSession({ sessionID: "ses_free", directory: "/work/proj" })!

    expect(repository.evidenceFor(episode, NOW)).toEqual([])
    expect(linkCount(repository)).toBe(0)
    repository.close()
  })

  test("capturing twice keeps the same associations without growing the store", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW, "/work/proj")
    const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.attachSession(run.id, "ses_1")
    repository.finishTask(task!.id, "success", {}, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const coordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      readEpisodeSignals: () => ({ calls: [redShell] }),
    })
    const first = coordinator.captureRun(run.id)!
    const links = repository.evidenceFor(first, NOW).map((slice) => slice.hash)
    const count = linkCount(repository)

    const second = coordinator.captureRun(run.id)!

    expect(second.id).toBe(first.id)
    expect(repository.evidenceFor(second, NOW).map((slice) => slice.hash)).toEqual(links)
    expect(linkCount(repository)).toBe(count)
    repository.close()
  })

  test("more candidates than the episode keeps become an explicit overflow slice", () => {
    const repository = open()
    const coordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      readEpisodeSignals: () => ({
        calls: Array.from({ length: EVIDENCE_EPISODE_SLICE_LIMIT + 5 }, (_, index) => ({
          ...redShell,
          command: `cmd-${index}`,
          out: `error-${index}`,
        })),
      }),
    })

    const episode = coordinator.captureSession({ sessionID: "ses_free", directory: "/work/proj" })!
    const slices = repository.evidenceFor(episode, NOW)

    expect(slices).toHaveLength(EVIDENCE_EPISODE_SLICE_LIMIT + 1)
    expect(slices.filter((slice) => slice.kind === "overflow")).toHaveLength(1)
    expect(slices[slices.length - 1]!.content).toBe(EVIDENCE_OVERFLOW_CONTENT)
    repository.close()
  })

  test("a store that refuses loses evidence, never the episode", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW, "/work/proj")
    const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.attachSession(run.id, "ses_1")
    repository.finishTask(task!.id, "success", {}, NOW)
    repository.finishRun(run.id, "success", undefined, NOW)

    const seen: unknown[] = []
    const throwing: EpisodeEvidenceStore = {
      putEvidence() {
        throw new Error("store refused")
      },
      setEpisodeEvidence() {},
    }
    const refusing = episodeCoordinator({
      repository,
      now: () => NOW,
      evidence: throwing,
      onError: (cause) => seen.push(cause),
      readEpisodeSignals: () => ({ calls: [redShell] }),
    })

    const episode = refusing.captureRun(run.id)
    expect(episode).toBeDefined()
    expect(repository.evidenceFor(episode!, NOW)).toEqual([])
    expect(seen).toHaveLength(1)

    // A store that answers with nothing stores no associations, and the episode still lands.
    const dropping: EpisodeEvidenceStore = { putEvidence: () => undefined, setEpisodeEvidence: () => {} }
    const droppingCoordinator = episodeCoordinator({
      repository,
      now: () => NOW,
      evidence: dropping,
      readEpisodeSignals: () => ({ calls: [redShell] }),
    })

    expect(droppingCoordinator.captureRun(run.id)).toBeDefined()
    expect(repository.evidenceFor(repository.getEpisode(runEpisodeID(run.id))!, NOW)).toEqual([])
    repository.close()
  })
})

describe("interactive session episodes (AH-B03)", () => {
  const IDLE = DEFAULT_EPISODE_BOUNDARY_CONFIG.idleMs
  const LATER = NOW + 10 * IDLE
  const EDIT = { tool: "edit", start: NOW - 500, ok: true, paths: ["/work/proj/src/a.ts"] }
  const identity: SessionIdentity = { directory: "/work/proj", title: "Fix the parser", createdAt: NOW - 1_000 }

  // A session list, a describer that records who it was asked about, and a close log, all in memory.
  const interactiveCoordinator = (
    repository: SqliteRoutineRepository,
    input: {
      activity: () => SessionActivity[]
      identities?: Record<string, SessionIdentity | undefined>
      on?: () => boolean
      at?: () => number
      deps?: Partial<EpisodeCoordinatorDeps>
    },
  ) => {
    const described: string[] = []
    const closed: string[] = []
    const coordinator = episodeCoordinator({
      repository,
      now: input.at ?? (() => LATER),
      interactive: input.on ?? (() => true),
      listSessionActivity: input.activity,
      describeSession: async (sessionID) => {
        described.push(sessionID)
        return input.identities ? input.identities[sessionID] : identity
      },
      readToolUses: () => ({ tools: { edit: { count: 4, last: NOW } }, calls: [{ tool: "edit", start: NOW - 500, ms: 10 }] }),
      readEpisodeSignals: () => ({ calls: [EDIT] }),
      onEpisodeClosed: (episode) => closed.push(episode.id),
      ...input.deps,
    })
    return { coordinator, described, closed }
  }

  test("a session that went quiet closes one episode with an outcome, and only once", async () => {
    const repository = open()
    const { coordinator, closed } = interactiveCoordinator(repository, {
      activity: () => [{ sessionID: "ses_chat", at: NOW }],
    })

    expect(await coordinator.sweepSessions()).toBe(1)
    const episode = repository.getEpisode(sessionEpisodeID("ses_chat"))!
    expect(episode).toMatchObject({
      sessionID: "ses_chat",
      projectID: "/work/proj",
      objective: "Fix the parser",
      toolCalls: 4,
      files: ["src/a.ts"],
      outcome: "partial",
      startedAt: NOW - 500,
      endedAt: NOW,
    })
    expect(episode.runID).toBeUndefined()
    expect(closed).toEqual([episode.id])

    // The same activity is already covered: nothing is written or announced twice.
    expect(await coordinator.sweepSessions()).toBe(0)
    expect(repository.listEpisodes()).toHaveLength(1)
    expect(closed).toHaveLength(1)
    repository.close()
  })

  test("a session still inside the idle window, or older than the backfill, is left alone", async () => {
    const repository = open()
    const { coordinator, described } = interactiveCoordinator(repository, {
      activity: () => [
        { sessionID: "ses_busy", at: LATER - IDLE + 1 },
        { sessionID: "ses_old", at: LATER - DEFAULT_EPISODE_BOUNDARY_CONFIG.backfillMs - 1 },
      ],
    })

    expect(await coordinator.sweepSessions()).toBe(0)
    expect(described).toEqual([])
    expect(repository.listEpisodes()).toHaveLength(0)
    repository.close()
  })

  test("the idle boundary comes from the episode config", async () => {
    const repository = open()
    const { coordinator } = interactiveCoordinator(repository, {
      activity: () => [{ sessionID: "ses_chat", at: NOW }],
      at: () => NOW + 1_000,
      deps: { config: { idleMs: 1_000 } },
    })

    expect(await coordinator.sweepSessions()).toBe(1)
    repository.close()
  })

  test("with the switch off nothing is listed, described or written", async () => {
    const repository = open()
    let listed = 0
    const off = interactiveCoordinator(repository, {
      activity: () => {
        listed++
        return [{ sessionID: "ses_chat", at: NOW }]
      },
      on: () => false,
    })
    expect(await off.coordinator.sweepSessions()).toBe(0)
    expect(listed).toBe(0)
    expect(off.described).toEqual([])

    // Absent is off too: a coordinator built without the switch never observes a session.
    const absent = createEpisodeCoordinator({
      repository,
      now: () => LATER,
      listSessionActivity: () => {
        listed++
        return []
      },
    })
    expect(await absent.sweepSessions()).toBe(0)
    expect(listed).toBe(0)

    // Thrown while the engine is being asked: the write after the wait does not happen.
    let on = true
    const midway = interactiveCoordinator(repository, {
      activity: () => [{ sessionID: "ses_chat", at: NOW }],
      on: () => on,
      deps: {
        describeSession: async () => {
          on = false
          return identity
        },
      },
    })
    expect(await midway.coordinator.sweepSessions()).toBe(0)
    expect(repository.listEpisodes()).toHaveLength(0)
    repository.close()
  })

  test("a run's sessions stay the run's, and a subagent's child is set aside until it is active again", async () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW, "/work/proj")
    repository.attachSession(run.id, "ses_run")
    const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.attachTaskSession(task!.id, "ses_task")
    let childAt = NOW
    const { coordinator, described } = interactiveCoordinator(repository, {
      activity: () => [
        { sessionID: "ses_run", at: NOW },
        { sessionID: "ses_task", at: NOW },
        { sessionID: "ses_child", at: childAt },
      ],
      identities: { ses_child: { ...identity, parentID: "ses_parent" } },
    })

    expect(await coordinator.sweepSessions()).toBe(0)
    expect(described).toEqual(["ses_child"])
    expect(repository.listEpisodes()).toHaveLength(0)

    // The same activity is not asked about twice; new activity is judged again.
    await coordinator.sweepSessions()
    expect(described).toEqual(["ses_child"])
    childAt = NOW + 1
    await coordinator.sweepSessions()
    expect(described).toEqual(["ses_child", "ses_child"])
    expect(repository.listEpisodes()).toHaveLength(0)
    repository.close()
  })

  test("work after a close is a new objective: a second episode with only what came after", async () => {
    const repository = open()
    let at = NOW
    let clock = LATER
    const resumed = NOW + 20 * IDLE
    const bash = { tool: "bash", start: resumed - 100, ok: false, exit: 1, command: "bun test", paths: [] }
    const { coordinator, closed } = interactiveCoordinator(repository, {
      activity: () => [{ sessionID: "ses_chat", at }],
      at: () => clock,
      deps: {
        readToolUses: (): ToolUses =>
          at === NOW
            ? { tools: { edit: { count: 4, last: NOW } }, calls: [{ tool: "edit", start: NOW - 500 }] }
            : {
                tools: { edit: { count: 4, last: NOW }, bash: { count: 3, last: resumed } },
                calls: [
                  { tool: "edit", start: NOW - 500 },
                  { tool: "bash", start: resumed - 100 },
                ],
              },
        readEpisodeSignals: () => ({ calls: at === NOW ? [EDIT] : [EDIT, bash] }),
      },
    })

    expect(await coordinator.sweepSessions()).toBe(1)
    at = resumed
    clock = resumed + IDLE
    expect(await coordinator.sweepSessions()).toBe(1)

    const second = repository.getEpisode(sessionEpisodeID("ses_chat", 2))!
    expect(second).toMatchObject({
      toolCalls: 3,
      files: [],
      commands: ["bun test"],
      startedAt: resumed - 100,
      endedAt: resumed,
      outcome: "partial",
    })
    expect(repository.getEpisode(sessionEpisodeID("ses_chat"))).toMatchObject({ toolCalls: 4, endedAt: NOW })
    expect(closed).toEqual([sessionEpisodeID("ses_chat"), sessionEpisodeID("ses_chat", 2)])
    repository.close()
  })

  test("one sweep closes at most sessionLimit sessions, newest first, and the next takes the rest", async () => {
    const repository = open()
    const { coordinator } = interactiveCoordinator(repository, {
      activity: () => [
        { sessionID: "ses_a", at: NOW - 2 },
        { sessionID: "ses_b", at: NOW },
        { sessionID: "ses_c", at: NOW - 1 },
      ],
      deps: { config: { sessionLimit: 2 } },
    })

    expect(await coordinator.sweepSessions()).toBe(2)
    expect(repository.listEpisodes().map((episode) => episode.sessionID).toSorted()).toEqual(["ses_b", "ses_c"])
    expect(await coordinator.sweepSessions()).toBe(1)
    expect(await coordinator.sweepSessions()).toBe(0)
    repository.close()
  })

  test("an engine that cannot be asked ends the sweep, is reported, and the next sweep closes it", async () => {
    const repository = open()
    const seen: unknown[] = []
    let reachable = false
    const { coordinator } = interactiveCoordinator(repository, {
      activity: () => [{ sessionID: "ses_chat", at: NOW }],
      deps: {
        onError: (cause) => seen.push(cause),
        describeSession: async () => {
          if (!reachable) throw new Error("engine down")
          return identity
        },
      },
    })

    expect(await coordinator.sweepSessions()).toBe(0)
    expect(seen).toHaveLength(1)
    expect(repository.listEpisodes()).toHaveLength(0)
    reachable = true
    expect(await coordinator.sweepSessions()).toBe(1)
    repository.close()
  })

  test("a session the engine does not know is set aside, and no engine files it under local", async () => {
    const repository = open()
    const unknown = interactiveCoordinator(repository, {
      activity: () => [{ sessionID: "ses_gone", at: NOW }],
      identities: {},
    })
    expect(await unknown.coordinator.sweepSessions()).toBe(0)
    expect(repository.listEpisodes()).toHaveLength(0)

    const bare = interactiveCoordinator(repository, {
      activity: () => [{ sessionID: "ses_chat", at: NOW }],
      deps: { describeSession: undefined },
    })
    expect(await bare.coordinator.sweepSessions()).toBe(1)
    expect(repository.getEpisode(sessionEpisodeID("ses_chat"))).toMatchObject({
      projectID: "local",
      objective: "Interactive session",
    })
    repository.close()
  })

  test("a live checkpoint is never announced as closed and keeps its start", () => {
    const repository = open()
    let clock = NOW
    const closed: string[] = []
    const coordinator = episodeCoordinator({
      repository,
      now: () => clock,
      config: { cadenceCalls: 1 },
      readToolUses: () => ({ tools: { read: { count: clock === NOW ? 1 : 5, last: clock } }, calls: [] }),
      onEpisodeClosed: (episode) => closed.push(episode.id),
    })

    coordinator.captureSession({ sessionID: "ses_free", directory: "/work" })
    clock = NOW + 100
    const checkpoint = coordinator.captureSession({ sessionID: "ses_free", directory: "/work" })!

    expect(checkpoint).toMatchObject({ startedAt: NOW, toolCalls: 5 })
    expect(checkpoint.endedAt).toBeUndefined()
    expect(closed).toEqual([])
    repository.close()
  })

  test("a run is untouched by the session sweep", async () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, NOW, "/work/proj")
    repository.attachSession(run.id, "ses_run")
    repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.finishRun(run.id, "success", undefined, NOW)
    const { coordinator } = interactiveCoordinator(repository, {
      activity: () => [{ sessionID: "ses_run", at: NOW }],
    })

    expect(coordinator.sweep()).toBe(1)
    const before = repository.getEpisode(runEpisodeID(run.id))!
    expect(await coordinator.sweepSessions()).toBe(0)
    expect(repository.listEpisodes()).toEqual([before])
    repository.close()
  })

  test("the default lister reads each session's last activity from the tool-uses folder", () => {
    const directory = mkdtempSync(join(tmpdir(), "flupcode-tool-uses-"))
    const previous = process.env.FLUPCODE_TOOL_USES_DIR
    try {
      writeFileSync(join(directory, "ses_chat.json"), "{}")
      utimesSync(join(directory, "ses_chat.json"), NOW / 1000, NOW / 1000)
      writeFileSync(join(directory, "not a session.json"), "{}")
      writeFileSync(join(directory, "ses_chat.json.tmp-1-2"), "{}")
      process.env.FLUPCODE_TOOL_USES_DIR = directory
      expect(sessionActivity()).toEqual([{ sessionID: "ses_chat", at: NOW }])
      process.env.FLUPCODE_TOOL_USES_DIR = join(directory, "missing")
      expect(sessionActivity()).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.FLUPCODE_TOOL_USES_DIR
      else process.env.FLUPCODE_TOOL_USES_DIR = previous
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
