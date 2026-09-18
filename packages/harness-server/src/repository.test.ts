import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository, routineLockKey } from "./repository"
import type { RunSource } from "./types"

const input = {
  name: "Dependency audit",
  description: "",
  prompt: "Check dependencies",
  schedule: { type: "interval" as const, intervalMinutes: 60 },
}

// In memory, always. A repository built with no path opens the database the desktop app uses, so a
// test run that forgets would write its fixtures into whatever the person has been doing.
const open = (path = ":memory:") => new SqliteRoutineRepository(path)

const directories: string[] = []
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "flupcode-harness-"))
  directories.push(directory)
  return join(directory, "harness.sqlite")
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

// A database written before a column existed does not get it from `CREATE TABLE IF NOT EXISTS`, and
// every desktop app that has ever run has one of those.
describe("opening a database written by an older server", () => {
  test("adds the column it is missing and reads its rows", () => {
    const path = scratch()
    const before = open(path)
    const run = before.startRun({ type: "manual" }, 1000)
    before.addTasks(run.id, [{ name: "one", prompt: "do it" }])
    // Put it back the way a server without task kinds left it.
    before.db.exec("ALTER TABLE tasks DROP COLUMN kind")
    before.close()

    const after = open(path)
    expect(after.listTasks(run.id).map((task) => task.kind)).toEqual(["agent"])
    after.addTasks(run.id, [{ name: "two", prompt: "check it", kind: "verify" }])
    expect(after.listTasks(run.id).map((task) => task.kind)).toEqual(["agent", "verify"])
    after.close()
  })

  test("a findings table written before findings had a source keeps its rows and gains the column", () => {
    const path = scratch()
    const before = open(path)
    const [old] = before.addFindings([{ file: "src/a.ts", line: 2, severity: "high", title: "Was here first" }])
    before.db.exec("ALTER TABLE findings DROP COLUMN source")
    before.close()

    const after = open(path)
    const [read] = after.listFindings({})
    expect(read!.id).toBe(old!.id)
    // A finding filed before the distinction existed is not claimed to be a check's.
    expect(read!.source).toBeUndefined()
    const [fresh] = after.addFindings([
      { file: "src/a.ts", line: 9, severity: "high", title: "From a check", source: "check" },
    ])
    expect(after.listFindings({}).find((entry) => entry.id === fresh!.id)?.source).toBe("check")
    after.close()
  })

  test("a checkpoint table written before points held a summary keeps its rows and gains the column", () => {
    const path = scratch()
    const before = open(path)
    const old = before.addCheckpoint({
      id: "cp_old",
      directory: "/work",
      sha: "a".repeat(40),
      title: "Before summaries",
      runID: "r1",
      taskID: "t1",
      createdAt: 10,
    })
    before.db.exec("ALTER TABLE checkpoints DROP COLUMN summary")
    before.close()

    const after = open(path)
    const read = after.getCheckpoint(old.id)
    expect(read).toMatchObject({ id: old.id, title: "Before summaries" })
    // A point taken before summaries existed simply has none, rather than an empty one.
    expect(read?.summary).toBeUndefined()
    const fresh = after.addCheckpoint({
      id: "cp_new",
      directory: "/work",
      sha: "b".repeat(40),
      title: "With a summary",
      summary: "The task concluded X",
      createdAt: 20,
    })
    expect(after.getCheckpoint(fresh.id)?.summary).toBe("The task concluded X")
    after.close()
  })
})

describe("SqliteRoutineRepository", () => {
  test("persists routines, runs, and session links", () => {
    const repository = open()
    const routine = repository.create(input)
    expect(repository.get(routine.id)?.name).toBe("Dependency audit")

    const source: RunSource = { type: "routine", routineID: routine.id }
    const run = repository.startRun(source, 1000)
    expect(run.status).toBe("running")
    repository.attachSession(run.id, "session_1")
    repository.finishRun(run.id, "success", undefined, 2000)

    expect(repository.listRuns(source)).toMatchObject([
      { id: run.id, source, sessionID: "session_1", status: "success", startedAt: 1000, finishedAt: 2000 },
    ])
    repository.close()
  })

  // The point of the redesign: a run belongs to whatever asked for it, and a routine is one of
  // those. Nothing about a run should require a routine to exist.
  test("a run can come from somewhere other than a routine", () => {
    const repository = open()
    const routine = repository.create(input)
    const manual = repository.startRun({ type: "manual" }, 1000)
    repository.startRun({ type: "routine", routineID: routine.id }, 1100)

    expect(repository.getRun(manual.id)?.source).toEqual({ type: "manual" })
    expect(repository.listRuns({ type: "manual" }).map((run) => run.id)).toEqual([manual.id])
    // And the routine's own list is not polluted by it.
    expect(repository.listRuns({ type: "routine", routineID: routine.id })).toHaveLength(1)
    repository.close()
  })

  test("allows one owner to hold a lock and reclaims expired locks", () => {
    const repository = open()
    const routine = repository.create(input)
    const key = routineLockKey(routine.id)
    expect(repository.acquire(key, "owner_a", 1000, 100)).toBe(true)
    expect(repository.acquire(key, "owner_b", 1050, 100)).toBe(false)
    expect(repository.acquire(key, "owner_b", 1101, 100)).toBe(true)
    repository.release(key, "owner_b")
    expect(repository.acquire(key, "owner_a", 1200, 100)).toBe(true)
    repository.close()
  })

  test("marks orphaned runs after a server restart", () => {
    const repository = open()
    const routine = repository.create(input)
    const run = repository.startRun({ type: "routine", routineID: routine.id }, 1000)
    repository.recoverRunning(2000)
    expect(repository.getRun(run.id)).toMatchObject({ status: "failed", finishedAt: 2000 })
    repository.close()
  })

  test("a finished run is reopened for a retry, and one still going is left alone", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, 1000)
    repository.finishRun(run.id, "failed", "the check failed", 2000)

    expect(repository.reopenRun(run.id)).toBe(true)
    const reopened = repository.getRun(run.id)!
    expect(reopened.status).toBe("running")
    // The old ending is cleared, or the run would read as finished while it is being done again.
    expect(reopened.finishedAt).toBeUndefined()
    expect(reopened.error).toBeUndefined()
    // Already running: there is nothing to reopen.
    expect(repository.reopenRun(run.id)).toBe(false)
    repository.close()
  })

  test("deleting a routine takes its runs with it", () => {
    const repository = open()
    const routine = repository.create(input)
    repository.startRun({ type: "routine", routineID: routine.id }, 1000)
    expect(repository.remove(routine.id)).toBe(true)
    expect(repository.listRuns({ type: "routine", routineID: routine.id })).toEqual([])
    repository.close()
  })

  // What a client that was away asks for, instead of polling every five seconds.
  test("what changed is written down in order, and readable from any point", () => {
    const repository = open()
    const routine = repository.create(input)
    const run = repository.startRun({ type: "routine", routineID: routine.id }, 1000)
    repository.finishRun(run.id, "success", undefined, 2000)

    const all = repository.listEvents(0)
    expect(all.map((entry) => entry.event.type)).toEqual(["routine.changed", "run.started", "run.changed"])
    expect(all.map((entry) => entry.seq)).toEqual([1, 2, 3])
    // Catching up from the middle returns only what came after it.
    expect(repository.listEvents(2).map((entry) => entry.event.type)).toEqual(["run.changed"])
    repository.close()
  })

  // Anyone who ran the first shape of this server has rows worth keeping.
  test("runs stored by the first shape of the server are carried over", () => {
    const path = scratch()
    const legacy = new Database(path, { create: true })
    legacy.exec(`
      CREATE TABLE routines (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, prompt TEXT NOT NULL,
        schedule_json TEXT NOT NULL, project_directory TEXT, agent TEXT, model_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_run_at INTEGER
      );
      CREATE TABLE routine_runs (
        id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL,
        started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT
      );
      CREATE TABLE routine_locks (
        routine_id TEXT PRIMARY KEY, owner TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      INSERT INTO routines (id, name, description, prompt, schedule_json, enabled, created_at)
        VALUES ('r1', 'Old', '', 'Do it', '{"type":"manual"}', 1, 10);
      INSERT INTO routine_runs (id, routine_id, session_id, status, started_at, finished_at)
        VALUES ('run1', 'r1', 'ses_old', 'success', 20, 30);
    `)
    legacy.close()

    const repository = open(path)
    expect(repository.getRun("run1")).toMatchObject({
      id: "run1",
      source: { type: "routine", routineID: "r1" },
      sessionID: "ses_old",
      status: "success",
    })
    // And the old tables are gone, so this happens once.
    const tables = repository.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name)
    expect(tables).not.toContain("routine_runs")
    expect(tables).toContain("runs")
    repository.close()
  })
})

describe("what a reader keeps about a session (H-18)", () => {
  test("pin and tags merge, so keeping one does not drop the other", () => {
    const repository = open()
    repository.setSessionPinned("ses_a", true)
    repository.setSessionTags("ses_a", ["work"])

    expect(repository.getSessionPrefs("ses_a")).toMatchObject({ sessionID: "ses_a", pinned: true, tags: ["work"] })

    // Unpinning keeps the tags, and the row stays because there is still something to say.
    repository.setSessionPinned("ses_a", false)
    expect(repository.getSessionPrefs("ses_a")).toMatchObject({ pinned: false, tags: ["work"] })
    repository.close()
  })

  test("a session that keeps nothing has no row, and says so once", () => {
    const repository = open()
    const seen: string[] = []
    repository.subscribe((entry) => seen.push(entry.event.type))

    repository.setSessionPinned("ses_a", true)
    // The change is published, and so is the emptying: a device that stopped pinning has to learn it.
    expect(repository.setSessionPinned("ses_a", false)).toMatchObject({ pinned: false, tags: [] })
    expect(seen).toEqual(["session.changed", "session.changed"])
    expect(repository.getSessionPrefs("ses_a")).toBeUndefined()
    expect(repository.listSessionPrefs()).toEqual([])
    repository.close()
  })

  test("tags are trimmed and de-duplicated, and only the ones kept are listed", () => {
    const repository = open()
    repository.setSessionTags("ses_a", [" work ", "work", "", "  ", "shared"])
    repository.setSessionPinned("ses_b", true)

    expect(repository.getSessionPrefs("ses_a")?.tags).toEqual(["work", "shared"])
    // Newest change first, and a session with no prefs is not in the list.
    expect(repository.listSessionPrefs().map((prefs) => prefs.sessionID)).toEqual(["ses_a", "ses_b"])
    repository.close()
  })

  test("a stash survives a restart because it is in the database, not a browser", () => {
    const path = scratch()
    const before = open(path)
    const added = before.addToStash("review the pull request", 1000)
    before.close()

    const after = open(path)
    expect(after.listStash()).toEqual([added])
    // Newest first.
    after.addToStash("later", 2000)
    expect(after.listStash().map((prompt) => prompt.text)).toEqual(["later", "review the pull request"])
    expect(after.removeFromStash(added.id)).toBe(true)
    expect(after.removeFromStash(added.id)).toBe(false)
    after.close()
  })
})
