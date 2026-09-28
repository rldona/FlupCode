/**
 * Episode replay fixtures (FH-007).
 *
 * Each fixture is a synthetic, anonymised session or run that the adaptive layer should derive one
 * way and only one way. The test seeds a real in-memory repository, writes the fixture's signals and
 * tool uses to a temporary directory, points the real readers (`episodeSignals`, `usedTools`) at it
 * through their environment seams, and drives the operation the fixture's `capture` names with a
 * fixed clock. No engine, no network, no injected fake of the behaviour under test: only the
 * upstream plugin files are replayed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolUses } from "../context"
import { SqliteRoutineRepository } from "../repository"
import type { Run, RunSource, RunStatus, Task, TaskInput, TaskKind, TaskStatus } from "../types"
import { createEpisodeCoordinator } from "./coordinator"
import type { EpisodeCoordinator } from "./coordinator"
import type { EpisodeFailure, EpisodeOutcome, EpisodeVerification, SessionEpisode } from "./episode"
import { runEpisodeID, sessionEpisodeID } from "./episode"
import type { EpisodeSignals } from "./signals"

type TerminalRunStatus = Exclude<RunStatus, "running" | "awaiting">
type TerminalTaskStatus = Exclude<TaskStatus, "queued" | "running">

type FixtureTask = {
  name: string
  prompt: string
  kind?: TaskKind
  attempt?: number
  /** A task with no status stays queued, which is what a crashed run leaves behind. */
  status?: TerminalTaskStatus
  error?: string
  output?: string
  sessionID?: string
}

type FixtureRun = {
  source: RunSource
  startedAt: number
  finish?: { status: TerminalRunStatus; at: number; error?: string }
  sessionID?: string
}

type FixtureExpect = {
  outcome: EpisodeOutcome
  toolCalls: number
  files: string[]
  commands: string[]
  failures: EpisodeFailure[]
  verifications: EpisodeVerification[]
  /** The whole list, in order. */
  evidenceRefs?: string[]
  /** Each of these appears exactly once. */
  evidenceRefsContains?: string[]
  /** At least one ref starts with each of these. */
  evidenceRefsPrefixes?: string[]
  rows: number
}

type Capture = "run" | "session" | "sweep"

type Fixture = {
  name: string
  capture: Capture
  directory: string
  now: number
  run?: FixtureRun
  tasks?: FixtureTask[]
  session?: { sessionID: string; directory?: string }
  toolUses?: Record<string, ToolUses>
  signals?: Record<string, EpisodeSignals>
  expectCheckpoint?: { outcome: EpisodeOutcome; toolCalls: number }
  expect: FixtureExpect
}

/** What a seeded fixture leaves behind: the store, and the run and tasks that came out of it. */
type Seeded = { repository: SqliteRoutineRepository; run: Run | undefined; tasks: Task[] }

const repositories: SqliteRoutineRepository[] = []
const tempDirectories: string[] = []
let signalsDirectoryBefore: string | undefined
let toolUsesDirectoryBefore: string | undefined

// The env seams are process-global, so remember what they were and put them back rather than
// assuming the test owns them; a seam that was unset stays unset.
beforeEach(() => {
  signalsDirectoryBefore = process.env.FLUPCODE_EPISODE_SIGNALS_DIR
  toolUsesDirectoryBefore = process.env.FLUPCODE_TOOL_USES_DIR
})

const restoreEnv = (key: string, previous: string | undefined) => {
  if (previous === undefined) delete process.env[key]
  else process.env[key] = previous
}

afterEach(() => {
  restoreEnv("FLUPCODE_EPISODE_SIGNALS_DIR", signalsDirectoryBefore)
  restoreEnv("FLUPCODE_TOOL_USES_DIR", toolUsesDirectoryBefore)
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const fixturesDirectory = join(import.meta.dir, "fixtures")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isCapture = (value: unknown): value is Capture => value === "run" || value === "session" || value === "sweep"

const REQUIRED_KEYS = ["name", "capture", "directory", "now", "expect"] as const

/**
 * Reads a fixture and checks it before it is used. `name` is the file's own name and `capture`
 * chooses the operation, so a fixture that is missing a key or lies about either fails here, naming
 * what is wrong, instead of seeding half a scenario.
 */
const loadFixture = (name: string, directory = fixturesDirectory): Fixture => {
  const path = join(directory, `${name}.json`)
  const source: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!isRecord(source)) throw new Error(`Fixture ${name}: the file must hold a JSON object`)
  for (const key of REQUIRED_KEYS) {
    if (!(key in source)) throw new Error(`Fixture ${name}: missing required key "${key}"`)
  }
  if (source.name !== name) throw new Error(`Fixture ${name}: "name" says "${String(source.name)}"`)
  if (!isCapture(source.capture)) throw new Error(`Fixture ${name}: unknown "capture" "${String(source.capture)}"`)
  if (typeof source.directory !== "string") throw new Error(`Fixture ${name}: "directory" must be a string`)
  if (typeof source.now !== "number") throw new Error(`Fixture ${name}: "now" must be a number`)
  if (!isRecord(source.expect)) throw new Error(`Fixture ${name}: "expect" must be an object`)
  if (source.capture === "session" && !isRecord(source.session))
    throw new Error(`Fixture ${name}: capture "session" needs a "session" block`)
  if (source.capture !== "session" && !isRecord(source.run))
    throw new Error(`Fixture ${name}: capture "${source.capture}" needs a "run" block`)
  if (source.capture === "sweep" && !isRecord(source.expectCheckpoint))
    throw new Error(`Fixture ${name}: capture "sweep" needs an "expectCheckpoint" block`)
  return source as Fixture
}

/** Writes the fixture's plugin files to a temp directory and points both real readers at it. */
const seedSignalFiles = (source: Fixture) => {
  const root = mkdtempSync(join(tmpdir(), "flupcode-episode-fixture-"))
  tempDirectories.push(root)
  const signalsDirectory = join(root, "episode-signals")
  const toolUsesDirectory = join(root, "tool-uses")
  mkdirSync(signalsDirectory, { recursive: true })
  mkdirSync(toolUsesDirectory, { recursive: true })
  Object.entries(source.signals ?? {}).forEach(([sessionID, data]) =>
    writeFileSync(join(signalsDirectory, `${sessionID}.json`), JSON.stringify(data)),
  )
  Object.entries(source.toolUses ?? {}).forEach(([sessionID, data]) =>
    writeFileSync(join(toolUsesDirectory, `${sessionID}.json`), JSON.stringify(data)),
  )
  process.env.FLUPCODE_EPISODE_SIGNALS_DIR = signalsDirectory
  process.env.FLUPCODE_TOOL_USES_DIR = toolUsesDirectory
}

/** Seeds the run, its tasks and its files exactly as the fixture states them. */
const seedFixture = (source: Fixture): Seeded => {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  const run = source.run
    ? repository.startRun(source.run.source, source.run.startedAt, source.directory)
    : undefined
  if (run && source.run?.sessionID) repository.attachSession(run.id, source.run.sessionID)

  const taskSeeds = source.tasks ?? []
  const taskInputs: TaskInput[] = taskSeeds.map((task) => ({
    name: task.name,
    prompt: task.prompt,
    ...(task.kind ? { kind: task.kind } : {}),
    ...(task.attempt !== undefined ? { attempt: task.attempt } : {}),
  }))
  const tasks = run && taskInputs.length > 0 ? repository.addTasks(run.id, taskInputs) : []
  taskSeeds.forEach((task, index) => {
    const seeded = tasks[index]
    if (!seeded) return
    if (task.sessionID) repository.attachTaskSession(seeded.id, task.sessionID)
    if (task.status) repository.finishTask(seeded.id, task.status, { error: task.error, output: task.output }, source.now)
  })

  if (run && source.run?.finish) {
    repository.finishRun(run.id, source.run.finish.status, source.run.finish.error, source.run.finish.at)
  }

  seedSignalFiles(source)
  return { repository, run, tasks }
}

const coordinatorFor = (repository: SqliteRoutineRepository, source: Fixture) =>
  createEpisodeCoordinator({ repository, now: () => source.now })

/**
 * Drives the coordinator the way the fixture's `capture` names: a run is captured as a run, a
 * session with no run as a session, and a crashed run is recovered and settled by a sweep. A sweep
 * answers with how many runs it settled, so that count comes back beside the episode.
 */
const captureFixture = (
  coordinator: EpisodeCoordinator,
  source: Fixture,
  seeded: Seeded,
): { episode?: SessionEpisode; swept?: number } => {
  switch (source.capture) {
    case "run":
      return { episode: coordinator.captureRun(seeded.run!.id) }
    case "session": {
      const session = source.session!
      return { episode: coordinator.captureSession({ sessionID: session.sessionID, directory: session.directory }) }
    }
    case "sweep":
      seeded.repository.recoverRunning(source.now)
      return { swept: coordinator.sweep() }
  }
}

const expectEpisode = (episode: SessionEpisode | undefined, expected: FixtureExpect) => {
  expect(episode).toBeDefined()
  const actual = episode!
  expect(actual.outcome).toBe(expected.outcome)
  expect(actual.toolCalls).toBe(expected.toolCalls)
  expect(actual.files).toEqual(expected.files)
  expect(actual.commands).toEqual(expected.commands)
  expect(actual.failures).toEqual(expected.failures)
  expect(actual.verifications).toEqual(expected.verifications)
  if (expected.evidenceRefs) expect(actual.evidenceRefs).toEqual(expected.evidenceRefs)
  for (const ref of expected.evidenceRefsContains ?? []) {
    expect(actual.evidenceRefs.filter((entry) => entry === ref)).toHaveLength(1)
  }
  for (const prefix of expected.evidenceRefsPrefixes ?? []) {
    expect(actual.evidenceRefs.some((entry) => entry.startsWith(prefix))).toBe(true)
  }
}

/**
 * Same fixture over a fresh store must derive the same episode. The run and task ids are random per
 * seed, so the run/task anchors are normalised; everything the fixture actually states stays exact.
 */
const normalizeEpisode = (episode: SessionEpisode, runID: string | undefined, taskIDs: string[]): SessionEpisode => ({
  ...episode,
  ...(runID ? { id: "episode:run:*", runID: "*" } : {}),
  evidenceRefs: episode.evidenceRefs.map((ref) => {
    if (runID && ref === `run:${runID}`) return "run:*"
    if (ref.startsWith("task:") && taskIDs.includes(ref.slice("task:".length))) return "task:*"
    return ref
  }),
})

describe("episode replay fixtures (FH-007)", () => {
  test("run-red-then-green: a check fixed on retry settles as success citing one verify:check", () => {
    const source = loadFixture("run-red-then-green")
    const seeded = seedFixture(source)
    const coordinator = coordinatorFor(seeded.repository, source)
    const { episode } = captureFixture(coordinator, source, seeded)

    expectEpisode(episode, source.expect)
    expect(episode!.id).toBe(runEpisodeID(seeded.run!.id))
    expect(seeded.repository.listEpisodes({ runID: seeded.run!.id })).toHaveLength(source.expect.rows)

    // Idempotency: a retried capture converges on the row and keeps timeCreated.
    const retried = captureFixture(coordinator, source, seeded).episode!
    expect(retried.id).toBe(episode!.id)
    expect(retried.timeCreated).toBe(episode!.timeCreated)
    expect(seeded.repository.listEpisodes({ runID: seeded.run!.id })).toHaveLength(1)

    // Determinism: the same fixture over a fresh store derives the same episode.
    const replay = seedFixture(source)
    const replayed = captureFixture(coordinatorFor(replay.repository, source), source, replay).episode!
    expect(normalizeEpisode(replayed, replay.run!.id, replay.tasks.map((task) => task.id))).toEqual(
      normalizeEpisode(episode!, seeded.run!.id, seeded.tasks.map((task) => task.id)),
    )
  })

  test("run-last-check-red: a settled success with a red last check reads partial", () => {
    const source = loadFixture("run-last-check-red")
    const seeded = seedFixture(source)
    const coordinator = coordinatorFor(seeded.repository, source)
    const { episode } = captureFixture(coordinator, source, seeded)

    expectEpisode(episode, source.expect)
    expect(episode!.id).toBe(runEpisodeID(seeded.run!.id))
    expect(seeded.repository.listEpisodes({ runID: seeded.run!.id })).toHaveLength(source.expect.rows)

    const retried = captureFixture(coordinator, source, seeded).episode!
    expect(retried.timeCreated).toBe(episode!.timeCreated)
    expect(seeded.repository.listEpisodes({ runID: seeded.run!.id })).toHaveLength(1)

    const replay = seedFixture(source)
    const replayed = captureFixture(coordinatorFor(replay.repository, source), source, replay).episode!
    expect(normalizeEpisode(replayed, replay.run!.id, replay.tasks.map((task) => task.id))).toEqual(
      normalizeEpisode(episode!, seeded.run!.id, seeded.tasks.map((task) => task.id)),
    )
  })

  test("session-fail-and-fix: a failing test and the edit that fixed it anchor a partial episode", () => {
    const source = loadFixture("session-fail-and-fix")
    const seeded = seedFixture(source)
    const { repository } = seeded
    const session = source.session!
    const coordinator = coordinatorFor(repository, source)
    const { episode } = captureFixture(coordinator, source, seeded)

    expectEpisode(episode, source.expect)
    expect(episode!.id).toBe(sessionEpisodeID(session.sessionID))
    expect(repository.listEpisodes()).toHaveLength(source.expect.rows)

    // Idempotency: the tool count has not moved, so a second capture leaves the stored row alone.
    const retried = captureFixture(coordinator, source, seeded).episode!
    expect(retried.id).toBe(episode!.id)
    expect(retried.timeCreated).toBe(episode!.timeCreated)
    expect(retried.timeUpdated).toBe(episode!.timeUpdated)
    expect(repository.listEpisodes()).toHaveLength(1)

    // Determinism: same fixture, fresh store, identical episode.
    const replay = seedFixture(source)
    const replayed = captureFixture(coordinatorFor(replay.repository, source), source, replay).episode!
    expect(replayed).toEqual(episode!)
  })

  test("run-crashed-then-recovered: a live checkpoint converges when the sweep settles it", () => {
    const source = loadFixture("run-crashed-then-recovered")
    const seeded = seedFixture(source)
    const { repository, run, tasks } = seeded
    const coordinator = coordinatorFor(repository, source)

    // The checkpoint is taken while the run is still going, so it is a run capture, not the
    // fixture's declared sweep: the sweep is what settles it after the crash.
    const checkpoint = coordinator.captureRun(run!.id)!
    expect(checkpoint).toMatchObject({
      id: runEpisodeID(run!.id),
      outcome: source.expectCheckpoint!.outcome,
      toolCalls: source.expectCheckpoint!.toolCalls,
    })
    expect(checkpoint.endedAt).toBeUndefined()

    // The server went down while the run was active: recovery marks it terminal, and the sweep
    // settles the same row.
    const { swept } = captureFixture(coordinator, source, seeded)
    expect(swept).toBe(1)
    const settled = repository.getEpisode(runEpisodeID(run!.id))!
    expectEpisode(settled, source.expect)
    expect(settled.id).toBe(checkpoint.id)
    expect(settled.timeCreated).toBe(checkpoint.timeCreated)
    expect(settled.endedAt).toBe(source.now)
    expect(settled.evidenceRefs.some((ref) => ref.startsWith("verify:") || ref.startsWith("failure:"))).toBe(false)
    expect(repository.listEpisodes({ runID: run!.id })).toHaveLength(1)
    expect(coordinator.sweep()).toBe(0)

    // Idempotency: a later capture still converges on the settled row.
    const retried = coordinator.captureRun(run!.id)!
    expect(retried.timeCreated).toBe(settled.timeCreated)
    expect(repository.listEpisodes({ runID: run!.id })).toHaveLength(1)

    // Determinism: the same fixture replays the same checkpoint and the same settled episode.
    const replay = seedFixture(source)
    const replayCoordinator = coordinatorFor(replay.repository, source)
    const replayedCheckpoint = replayCoordinator.captureRun(replay.run!.id)!
    expect(replayedCheckpoint.outcome).toBe(source.expectCheckpoint!.outcome)
    expect(captureFixture(replayCoordinator, source, replay).swept).toBe(1)
    const replayedSettled = replay.repository.getEpisode(runEpisodeID(replay.run!.id))!
    expect(normalizeEpisode(replayedSettled, replay.run!.id, replay.tasks.map((task) => task.id))).toEqual(
      normalizeEpisode(settled, run!.id, tasks.map((task) => task.id)),
    )
  })

  test("a malformed fixture fails at load instead of being used half-seeded", () => {
    const directory = mkdtempSync(join(tmpdir(), "flupcode-episode-fixture-bad-"))
    tempDirectories.push(directory)

    const base = { capture: "run", directory: "/work/proj", now: 1700000000000, expect: {} }

    writeFileSync(join(directory, "wrong-name.json"), JSON.stringify({ ...base, name: "other" }))
    expect(() => loadFixture("wrong-name", directory)).toThrow('Fixture wrong-name: "name" says "other"')

    writeFileSync(join(directory, "missing-key.json"), JSON.stringify({ ...base, name: "missing-key", now: undefined }))
    expect(() => loadFixture("missing-key", directory)).toThrow('Fixture missing-key: missing required key "now"')
  })
})
