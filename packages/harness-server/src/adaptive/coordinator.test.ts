import { describe, expect, jest, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "../repository"
import { createEpisodeCoordinator } from "./coordinator"
import type { EpisodeCoordinatorDeps } from "./coordinator"
import { runEpisodeID, sessionEpisodeID } from "./episode"
import { OUTCOME_REF_LIMIT } from "./outcome"

const open = (path = ":memory:") => new SqliteRoutineRepository(path)

// Signals default to none so a test never reads whatever the machine's real signals folder holds; a
// test that wants evidence injects its own reader and overrides the default.
const episodeCoordinator = (deps: EpisodeCoordinatorDeps) =>
  createEpisodeCoordinator({ readEpisodeSignals: () => ({ calls: [] }), ...deps })

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
