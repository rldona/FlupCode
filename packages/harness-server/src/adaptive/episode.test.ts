import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "../repository"
import type { EpisodeInput } from "../types"
import {
  DEFAULT_EPISODE_BOUNDARY_CONFIG,
  isTerminalRunStatus,
  normalizeOutcome,
  outcomeForRun,
  parseFailures,
  parseStringList,
  parseVerifications,
  resolveEpisodeBoundaryConfig,
  runEpisodeID,
  sessionEpisodeID,
  shouldCheckpoint,
} from "./episode"

const open = (path = ":memory:") => new SqliteRoutineRepository(path)

const directories: string[] = []
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "flupcode-episode-"))
  directories.push(directory)
  return join(directory, "harness.sqlite")
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const episode = (overrides: Partial<EpisodeInput> = {}): EpisodeInput => ({
  sessionID: "s1",
  projectID: "p1",
  objective: "Make the tests pass",
  toolCalls: 3,
  files: ["src/a.ts"],
  commands: ["bun test"],
  failures: [{ summary: "one failed", file: "src/a.ts", line: 4 }],
  verifications: [{ step: "bun test", ok: false }],
  outcome: "partial",
  startedAt: 100,
  endedAt: 200,
  evidenceRefs: ["artifact:1"],
  ...overrides,
})

describe("the episode model (FH-001)", () => {
  test("an outcome that is not one of the four reads as unknown", () => {
    expect(normalizeOutcome("success")).toBe("success")
    expect(normalizeOutcome("partial")).toBe("partial")
    expect(normalizeOutcome("failed")).toBe("failed")
    expect(normalizeOutcome("unknown")).toBe("unknown")
    expect(normalizeOutcome("banana")).toBe("unknown")
    expect(normalizeOutcome(undefined)).toBe("unknown")
  })

  test("broken structured fields read as empty, and malformed entries are dropped", () => {
    expect(parseStringList("{not json")).toEqual([])
    expect(parseStringList(JSON.stringify(["a", 2, "b"]))).toEqual(["a", "b"])
    expect(parseFailures(JSON.stringify([{ file: "src/a.ts" }, { summary: "real" }, "noise"]))).toEqual([
      { summary: "real" },
    ])
    expect(parseVerifications(JSON.stringify([{ step: "check" }, { step: "check", ok: true }, 7]))).toEqual([
      { step: "check", ok: true },
    ])
  })

  test("creates an episode, generates its id, and reads it back", () => {
    const repository = open()
    const created = repository.createEpisode(episode())
    expect(created.id).toBeTruthy()
    expect(created.timeCreated).toBe(created.timeUpdated)
    expect(repository.getEpisode(created.id)).toEqual(created)
    repository.close()
  })

  test("an id that was never written reads as undefined", () => {
    const repository = open()
    expect(repository.getEpisode("never-written")).toBeUndefined()
    repository.close()
  })

  test("a second write with the same id updates instead of duplicating, keeping timeCreated", () => {
    const repository = open()
    repository.createEpisode(episode({ id: "ep-1", objective: "first" }), 1000)
    repository.createEpisode(episode({ id: "ep-1", objective: "second", outcome: "success" }), 2000)

    const [stored] = repository.listEpisodes()
    expect(repository.listEpisodes()).toHaveLength(1)
    expect(stored).toMatchObject({ id: "ep-1", objective: "second", outcome: "success", timeCreated: 1000, timeUpdated: 2000 })
    repository.close()
  })

  test("an outcome left out at capture is stored as unknown", () => {
    const repository = open()
    const created = repository.createEpisode(episode({ outcome: undefined }), 1000)

    expect(created.outcome).toBe("unknown")
    expect(repository.getEpisode(created.id)?.outcome).toBe("unknown")
    repository.close()
  })

  test("lists newest first and filters by project, session and run", () => {
    const repository = open()
    const first = repository.createEpisode(episode({ sessionID: "s1", projectID: "p1", runID: "r1" }), 1000)
    const second = repository.createEpisode(episode({ sessionID: "s2", projectID: "p1" }), 2000)
    const third = repository.createEpisode(episode({ sessionID: "s3", projectID: "p2" }), 3000)

    expect(repository.listEpisodes().map((entry) => entry.id)).toEqual([third.id, second.id, first.id])
    expect(repository.listEpisodes({ projectID: "p1" }).map((entry) => entry.id)).toEqual([second.id, first.id])
    expect(repository.listEpisodes({ sessionID: "s3" }).map((entry) => entry.id)).toEqual([third.id])
    expect(repository.listEpisodes({ runID: "r1" }).map((entry) => entry.id)).toEqual([first.id])
    expect(repository.listEpisodes({ projectID: "p1", limit: 1 }).map((entry) => entry.id)).toEqual([second.id])
    repository.close()
  })

  test("episodes written at the same instant keep insertion order as a stable tie-break", () => {
    const repository = open()
    for (const id of ["a", "b", "c"]) repository.createEpisode(episode({ id, sessionID: "s1", projectID: "p1" }), 1000)

    // `created_at DESC, rowid ASC`: the same timestamp must not reshuffle rows between reads.
    expect(repository.listEpisodes().map((entry) => entry.id)).toEqual(["a", "b", "c"])
    expect(repository.listEpisodes().map((entry) => entry.id)).toEqual(["a", "b", "c"])
    expect(repository.listEpisodes({ limit: 2 }).map((entry) => entry.id)).toEqual(["a", "b"])
    repository.close()
  })

  test("a run filter leaves out episodes with no run, and filters combine", () => {
    const repository = open()
    const withRun = repository.createEpisode(
      episode({ id: "with-run", sessionID: "s1", projectID: "p1", runID: "r1" }),
      1000,
    )
    const withoutRun = repository.createEpisode(episode({ id: "no-run", sessionID: "s1", projectID: "p1" }), 2000)
    const other = repository.createEpisode(
      episode({ id: "other", sessionID: "s9", projectID: "p2", runID: "r1" }),
      3000,
    )

    expect(repository.listEpisodes({ runID: "r1" }).map((entry) => entry.id)).toEqual([other.id, withRun.id])
    expect(repository.listEpisodes({ sessionID: "s1", runID: "r1" }).map((entry) => entry.id)).toEqual([withRun.id])
    expect(repository.listEpisodes({ sessionID: "s1" }).map((entry) => entry.id)).toEqual([withoutRun.id, withRun.id])
    repository.close()
  })

  test("a limit is normalized: zero reads nothing, a count floors, and a broken one is ignored", () => {
    const repository = open()
    repository.createEpisode(episode({ id: "first" }), 1000)
    const second = repository.createEpisode(episode({ id: "second" }), 2000)
    const all = [second.id, "first"]

    expect(repository.listEpisodes({ limit: 0 })).toEqual([])
    expect(repository.listEpisodes({ limit: 50 }).map((entry) => entry.id)).toEqual(all)
    expect(repository.listEpisodes({ limit: 1.5 }).map((entry) => entry.id)).toEqual([second.id])
    expect(repository.listEpisodes({ limit: Number.NaN }).map((entry) => entry.id)).toEqual(all)
    expect(repository.listEpisodes({ limit: Number.POSITIVE_INFINITY }).map((entry) => entry.id)).toEqual(all)
    expect(repository.listEpisodes({ limit: -1 }).map((entry) => entry.id)).toEqual(all)
    repository.close()
  })

  test("a limit past the safe integer range is capped rather than reaching SQLite as itself", () => {
    const repository = open()
    repository.createEpisode(episode({ id: "only" }), 1000)

    // `Math.floor(1e21)` is still `1e21`, which SQLite cannot bind as an integer.
    expect(repository.listEpisodes({ limit: 1e21 }).map((entry) => entry.id)).toEqual(["only"])
    expect(repository.listEpisodes({ limit: Number.MAX_VALUE }).map((entry) => entry.id)).toEqual(["only"])
    repository.close()
  })

  test("survives a reopen: the new table is idempotent and the episode is still there", () => {
    const path = scratch()
    const before = open(path)
    const created = before.createEpisode(episode({ runID: "r9" }))
    before.close()

    const after = open(path)
    expect(after.getEpisode(created.id)).toEqual(created)
    after.close()

    // A third open proves the `CREATE TABLE IF NOT EXISTS` and its indexes are idempotent too.
    const again = open(path)
    expect(again.listEpisodes()).toHaveLength(1)
    again.close()
  })

  test("an existing database without session_episodes opens cleanly and gains the table", () => {
    const path = scratch()
    // A file another build left behind: it has rows, but no episodes table.
    const legacy = new Database(path, { create: true })
    legacy.exec("CREATE TABLE legacy_marker (id TEXT PRIMARY KEY); INSERT INTO legacy_marker (id) VALUES ('old')")
    legacy.close()

    const repository = open(path)
    expect(repository.listEpisodes()).toEqual([])
    expect(repository.getEpisode("anything")).toBeUndefined()
    const created = repository.createEpisode(episode({ runID: "r1" }))
    expect(repository.getEpisode(created.id)).toEqual(created)
    repository.close()
  })

  test("a row with broken JSON or an invalid outcome does not throw on read", () => {
    const repository = open()
    repository.db
      .query(
        `INSERT INTO session_episodes
           (id, session_id, project_id, run_id, objective, tool_calls, files_json, commands_json,
            failures_json, verifications_json, outcome, started_at, ended_at, evidence_refs_json,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, ?4, 2, ?5, ?5, ?5, ?5, ?6, 10, NULL, ?5, 10, 10)`,
      )
      .run("broken", "s1", "p1", "hand edited", "{not json", "banana")

    expect(repository.getEpisode("broken")).toMatchObject({
      id: "broken",
      files: [],
      commands: [],
      failures: [],
      verifications: [],
      evidenceRefs: [],
      outcome: "unknown",
      toolCalls: 2,
    })
    repository.close()
  })

  test("the boundary's settings resolve from the environment first, then the block, then defaults", () => {
    expect(resolveEpisodeBoundaryConfig()).toEqual(DEFAULT_EPISODE_BOUNDARY_CONFIG)
    expect(resolveEpisodeBoundaryConfig({ block: { episode: { cadenceCalls: 5 } } })).toMatchObject({ cadenceCalls: 5 })
    expect(
      resolveEpisodeBoundaryConfig({
        block: { episode: { cadenceCalls: 5, sweepMs: 9 } },
        env: { FLUPCODE_ADAPTIVE_EPISODE_CADENCE_CALLS: "7" },
      }),
    ).toMatchObject({ cadenceCalls: 7, sweepMs: 9 })
    // A broken value is ignored rather than reaching a timer as itself.
    expect(
      resolveEpisodeBoundaryConfig({
        block: { episode: { sweepMs: -1 } },
        env: { FLUPCODE_ADAPTIVE_EPISODE_SWEEP_MS: "nope" },
      }).sweepMs,
    ).toBe(DEFAULT_EPISODE_BOUNDARY_CONFIG.sweepMs)
  })

  test("ids are deterministic per run and per session", () => {
    expect(runEpisodeID("r1")).toBe("episode:run:r1")
    expect(sessionEpisodeID("s1")).toBe("episode:session:s1")
  })

  test("a run's status reads as terminal and as an outcome", () => {
    expect(isTerminalRunStatus("success")).toBe(true)
    expect(isTerminalRunStatus("failed")).toBe(true)
    expect(isTerminalRunStatus("stopped")).toBe(true)
    expect(isTerminalRunStatus("running")).toBe(false)
    expect(isTerminalRunStatus("awaiting")).toBe(false)
    expect(outcomeForRun("success")).toBe("success")
    expect(outcomeForRun("failed")).toBe("failed")
    expect(outcomeForRun("stopped")).toBe("partial")
    expect(outcomeForRun("running")).toBe("unknown")
  })

  test("a checkpoint is wanted when terminal, when first, or once cadence has passed", () => {
    const base = { previous: { toolCalls: 0 }, toolCalls: 0, terminal: false, cadenceCalls: 50 }
    expect(shouldCheckpoint({ ...base, terminal: true })).toBe(true)
    expect(shouldCheckpoint({ ...base, previous: undefined })).toBe(true)
    expect(shouldCheckpoint({ ...base, toolCalls: 10 })).toBe(false)
    expect(shouldCheckpoint({ ...base, toolCalls: 50 })).toBe(true)
  })

  test("a row with wrongly typed scalars reads back as typed defaults instead of throwing", () => {
    const repository = open()
    // SQLite is dynamically typed: an edited row can hand back text where the schema says integer,
    // and a blob where it says text. `zeroblob` stands in for the non-string scalars.
    repository.db
      .query(
        `INSERT INTO session_episodes
           (id, session_id, project_id, run_id, objective, tool_calls, files_json, commands_json,
            failures_json, verifications_json, outcome, started_at, ended_at, evidence_refs_json,
            created_at, updated_at)
         VALUES (?1, zeroblob(2), ?2, zeroblob(1), ?3, 'abc', '[]', '[]', '[]', '[]', 'unknown',
                 'start', 'soon', '[]', 'created', 'updated')`,
      )
      .run("scalar-corrupt", "p1", "hand edited")

    expect(repository.getEpisode("scalar-corrupt")).toEqual({
      id: "scalar-corrupt",
      sessionID: "",
      projectID: "p1",
      objective: "hand edited",
      toolCalls: 0,
      files: [],
      commands: [],
      failures: [],
      verifications: [],
      outcome: "unknown",
      startedAt: 0,
      evidenceRefs: [],
      timeCreated: 0,
      timeUpdated: 0,
    })
    repository.close()
  })
})
