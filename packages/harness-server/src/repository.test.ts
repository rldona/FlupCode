import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { SqliteRoutineRepository, routineLockKey } from "./repository"
import { resolveAdaptiveConfig } from "./adaptive/config"
import { createDecisionService } from "./adaptive/decision-service"
import { handleDecisionRequest } from "./adaptive/decision-routes"
import { createAdaptiveEgressGuard } from "./adaptive/egress"
import type {
  RunSource,
  StoredDecisionInput,
  StoredPlanInput,
  StoredReflectionJobInput,
  StoredSkillProposalInput,
} from "./types"

const plan = (overrides: Partial<StoredPlanInput> = {}): StoredPlanInput => ({
  id: "plan:episode:run:1",
  episodeID: "episode:run:1",
  sessionID: "ses_1",
  projectID: "/work/project",
  objectiveHash: "b".repeat(64),
  entries: [
    { id: "file:abc", kind: "file", score: 0.75, disposition: "keep", reason: "class-weight", protected: false, tokens: 30 },
    { id: "tool:def", kind: "tool", score: 0.12, disposition: "drop", reason: "low-value-payload", protected: false, tokens: 5 },
  ],
  scoreSource: "baseline",
  degraded: false,
  applied: false,
  tokensBefore: 35,
  tokensAfter: 30,
  ...overrides,
})

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

  test("a tasks table written before external commands keeps its rows and gains the column", () => {
    const path = scratch()
    const before = open(path)
    const run = before.startRun({ type: "manual" }, 1000)
    before.addTasks(run.id, [{ name: "one", prompt: "do it" }])
    // Put it back the way a server without external workers left it.
    before.db.exec("ALTER TABLE tasks DROP COLUMN command")
    before.close()

    const after = open(path)
    // A task filed before the column existed simply has no command, rather than an empty one.
    expect(after.listTasks(run.id)[0]!.command).toBeUndefined()
    after.addTasks(run.id, [
      { name: "codex", prompt: "", kind: "external", command: "codex exec {{prompt}}" },
    ])
    expect(after.listTasks(run.id).map((task) => task.command)).toEqual([undefined, "codex exec {{prompt}}"])
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

  test("a routines table written before scheduled actions keeps its rows and gains the columns", () => {
    const path = scratch()
    const before = open(path)
    const old = before.create(input)
    // Put it back the way a server without scheduled actions left it.
    before.db.exec("ALTER TABLE routines DROP COLUMN action_json")
    before.db.exec("ALTER TABLE routines DROP COLUMN allow_json")
    before.close()

    const after = open(path)
    // A routine saved before the columns existed simply has no action, rather than a broken one.
    expect(after.get(old.id)?.action).toBeUndefined()
    after.update(old.id, { ...input, action: { id: "publish" }, allow: [{ permission: "browser", pattern: "https://example.com", action: "allow" }] })
    expect(after.get(old.id)?.action).toEqual({ id: "publish" })
    expect(after.get(old.id)?.allow).toEqual([
      { permission: "browser", pattern: "https://example.com", action: "allow" },
    ])
    after.close()
  })

  test("a database written before context plans gains the table, keeping its other rows", () => {
    const path = scratch()
    const before = open(path)
    const run = before.startRun({ type: "manual" }, 1000)
    before.createPlan(plan({ id: "plan:run1:task1", runID: run.id, taskID: "task1" }), 1_000)
    // Put it back the way a server without plans left it: the table is simply absent.
    before.db.exec("DROP TABLE adaptive_plan")
    before.close()

    const after = open(path)
    expect(after.listPlans()).toHaveLength(0)
    // The run written before the table existed is untouched.
    expect(after.getRun(run.id)?.id).toBe(run.id)
    after.createPlan(plan({ id: "plan:run1:task1", runID: run.id, taskID: "task1" }), 2_000)
    expect(after.getPlan("plan:run1:task1")?.taskID).toBe("task1")
    after.close()
  })

  test("a plan table written before the truncated marker keeps its rows and gains the column", () => {
    const path = scratch()
    const before = open(path)
    before.createPlan(plan({ id: "plan:episode:1", episodeID: "episode:1" }), 1_000)
    before.db.exec("ALTER TABLE adaptive_plan DROP COLUMN truncated")
    before.close()

    const after = open(path)
    // A plan written before the marker existed simply reads as untruncated.
    expect(after.getPlan("plan:episode:1")).toMatchObject({ id: "plan:episode:1", truncated: false })
    after.close()
  })
})

// ---- the versioned migration of the decision audit (AH-C02) ------------------------------------

/**
 * A database the way a v1 server left it: no `schema_version`, the audit columns absent, and rows of
 * every v1 source — plus one a newer build wrote with a source this build does not know, one with an
 * unknown kind, and plans refined by Jev and by the scorer alone.
 */
const v1Fixture = (path: string) => {
  const repository = open(path)
  repository.db.exec(`
    DROP TABLE schema_version;
    ALTER TABLE adaptive_decision DROP COLUMN provider_id;
    ALTER TABLE adaptive_decision DROP COLUMN provider_version;
    ALTER TABLE adaptive_decision DROP COLUMN cost_usd;
    ALTER TABLE adaptive_decision DROP COLUMN input_tokens;
    ALTER TABLE adaptive_decision DROP COLUMN label;
    ALTER TABLE adaptive_decision DROP COLUMN labeled_at;
    ALTER TABLE adaptive_plan DROP COLUMN score_provider;
  `)
  const insert = repository.db.query(
    `INSERT INTO adaptive_decision (id, kind, inputs_hash, answer_json, baseline_answer_json, baseline_rule, provider,
       attempted_provider, model_version, source, degraded, degraded_reason, created_at, updated_at)
     VALUES (?1, ?2, 'h', '{"verdict":"complete"}', '{"verdict":"complete"}', 'episode-outcome', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  )
  insert.run("completion:jev", "completion", "jev", "jev", "jev-1.13.0", "jev", 0, null, 1_000)
  insert.run("completion:deterministic", "completion", "deterministic", null, null, "deterministic", 0, null, 1_001)
  insert.run("completion:fallback", "completion", "deterministic", "jev", null, "fallback", 1, "timeout", 1_002)
  // A fallback written before `attempted_provider` existed: which model it asked is not known.
  insert.run("completion:old-fallback", "completion", "deterministic", null, null, "fallback", 1, "network", 1_003)
  insert.run("completion:future", "completion", "ensemble", null, null, "ensemble", 0, null, 1_004)
  insert.run("future-kind:scope", "future-kind", "deterministic", null, null, "deterministic", 0, null, 1_005)
  const plan = repository.db.query(
    `INSERT INTO adaptive_plan (id, objective_hash, score_source, decision_id, created_at, updated_at)
     VALUES (?1, 'o', ?2, ?3, ?4, ?4)`,
  )
  plan.run("plan:jev", "jev", "contextItem:scope", 2_000)
  plan.run("plan:deterministic", "deterministic", null, 2_001)
  repository.close()
}

const backupsOf = (path: string) => readdirSync(dirname(path)).filter((name) => name.includes(".bak-v"))

const routeIDs = async (repository: SqliteRoutineRepository) => {
  const config = resolveAdaptiveConfig({ block: {}, env: {} })
  const service = createDecisionService({
    repository,
    config: () => config,
    egress: createAdaptiveEgressGuard({ config: () => config }),
  })
  const response = await handleDecisionRequest(
    new Request("http://x/harness/adaptive/decisions"),
    ["decisions"],
    service,
  )
  const body = (await response.json()) as { data: Array<{ id: string }> }
  return body.data.map((decision) => decision.id).sort()
}

describe("the versioned decision audit migration (AH-C02)", () => {
  test("backs the v1 file up first, maps every source and loses no row from the decisions route", async () => {
    const path = scratch()
    v1Fixture(path)
    const raw = new Database(path)
    const before = (raw.query("SELECT id FROM adaptive_decision ORDER BY id").all() as Array<{ id: string }>).map(
      (row) => row.id,
    )
    raw.close()

    const repository = open(path)
    // 0 rows lost: the same count and ids the v1 table held, through the route a client reads.
    expect(await routeIDs(repository)).toEqual([...before].sort())
    expect(before).toHaveLength(6)

    expect(repository.getDecision("completion:jev")).toMatchObject({
      source: "model",
      provider: "jev",
      providerID: "jev",
      providerVersion: "jev-1.13.0",
    })
    expect(repository.getDecision("completion:deterministic")).toMatchObject({ source: "baseline" })
    expect(repository.getDecision("completion:deterministic")?.providerID).toBeUndefined()
    expect(repository.getDecision("completion:fallback")).toMatchObject({ source: "fallback", providerID: "jev" })
    expect(repository.getDecision("completion:old-fallback")?.providerID).toBeUndefined()
    // Never measured, so never invented: historical cost stays missing rather than zero.
    expect(repository.getDecision("completion:jev")?.costUsd).toBeUndefined()
    expect(repository.getDecision("completion:future")).toMatchObject({ source: "unknown", raw: { source: "ensemble" } })
    expect(repository.getDecision("future-kind:scope")).toMatchObject({
      kind: "unknown",
      source: "baseline",
      raw: { kind: "future-kind" },
    })
    // The stored vocabulary is rewritten, not only read differently.
    const sources = repository.db.query("SELECT DISTINCT source FROM adaptive_decision ORDER BY source").all()
    expect(sources).toEqual([{ source: "baseline" }, { source: "ensemble" }, { source: "fallback" }, { source: "model" }])

    expect(repository.getPlan("plan:jev")).toMatchObject({ scoreSource: "model", scoreProvider: "jev" })
    expect(repository.getPlan("plan:deterministic")).toMatchObject({ scoreSource: "baseline" })
    expect(repository.listPlans()).toHaveLength(2)

    // The backup was taken before the rewrite: it still holds the v1 vocabulary.
    const [backup] = backupsOf(path)
    expect(backup).toMatch(/^harness\.sqlite\.bak-v1-/)
    const copy = new Database(join(dirname(path), backup!))
    expect(copy.query("SELECT source FROM adaptive_decision WHERE id = 'completion:jev'").get()).toEqual({ source: "jev" })
    expect((copy.query("SELECT COUNT(*) AS count FROM adaptive_decision").get() as { count: number }).count).toBe(6)
    copy.close()
    expect(repository.db.query("SELECT version, name, backup FROM schema_version").all()).toEqual([
      { version: 2, name: "decision-audit-v2", backup: join(dirname(path), backup!) },
      { version: 3, name: "workflow-identity", backup: join(dirname(path), backup!) },
      { version: 4, name: "referential-integrity", backup: join(dirname(path), backup!) },
      { version: 5, name: "usage-ledger", backup: join(dirname(path), backup!) },
      { version: 6, name: "usage-reconciled", backup: join(dirname(path), backup!) },
      { version: 7, name: "usage-attribution", backup: join(dirname(path), backup!) },
      { version: 8, name: "usage-summary", backup: join(dirname(path), backup!) },
      { version: 9, name: "task-verdict", backup: join(dirname(path), backup!) },
      { version: 10, name: "browser-policy", backup: join(dirname(path), backup!) },
      { version: 11, name: "artifact-versions", backup: join(dirname(path), backup!) },
    ])
    repository.close()
  })

  test("a second start is a no-op: no new backup, no new version row, the same rows", async () => {
    const path = scratch()
    v1Fixture(path)
    const first = open(path)
    const decisions = first.listDecisions()
    const plans = first.listPlans()
    first.close()

    const second = open(path)
    expect(backupsOf(path)).toHaveLength(1)
    expect(second.db.query("SELECT version FROM schema_version").all()).toEqual([{ version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }])
    expect(second.listDecisions()).toEqual(decisions)
    expect(second.listPlans()).toEqual(plans)
    second.close()
  })

  test("a new database starts at the latest version without a backup", () => {
    const path = scratch()
    const repository = open(path)
    expect(repository.db.query("SELECT version, backup FROM schema_version").all()).toEqual([
      { version: 2, backup: null },
      { version: 3, backup: null },
      { version: 4, backup: null },
      { version: 5, backup: null },
      { version: 6, backup: null },
      { version: 7, backup: null },
      { version: 8, backup: null },
      { version: 9, backup: null },
      { version: 10, backup: null },
      { version: 11, backup: null },
    ])
    expect(backupsOf(path)).toHaveLength(0)
    repository.close()
  })

  test("an in-memory database migrates and is never backed up", () => {
    const repository = open()
    expect(repository.db.query("SELECT version FROM schema_version").all()).toEqual([{ version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }])
    repository.close()
  })

  test("only the newest backups are kept beside the database", () => {
    const path = scratch()
    v1Fixture(path)
    const stale = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"].map((day, index) => {
      const file = `${path}.bak-v1-${day}T00-00-00-000Z`
      writeFileSync(file, "")
      utimesSync(file, index + 1, index + 1)
      return file
    })
    open(path).close()
    const kept = backupsOf(path)
    expect(kept).toHaveLength(3)
    // The one just taken is always among them; the oldest stale copies are the ones removed.
    expect(kept.filter((name) => !stale.some((file) => file.endsWith(name)))).toHaveLength(1)
    expect(kept.some((name) => stale[0]!.endsWith(name))).toBe(false)
  })

  test("a plan table recreated after the migration still has the audit column", () => {
    const path = scratch()
    open(path).close()
    const dropped = open(path)
    dropped.db.exec("DROP TABLE adaptive_plan")
    dropped.close()
    const reopened = open(path)
    reopened.createPlan(plan({ scoreSource: "model", scoreProvider: "small-llm" }), 1_000)
    expect(reopened.getPlan(plan().id)).toMatchObject({ scoreSource: "model", scoreProvider: "small-llm" })
    reopened.close()
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
    // Explicit times: two writes in the same millisecond used to leave "newest first" to the clock.
    repository.setSessionTags("ses_a", [" work ", "work", "", "  ", "shared"], 1000)
    repository.setSessionPinned("ses_b", true, 2000)

    expect(repository.getSessionPrefs("ses_a")?.tags).toEqual(["work", "shared"])
    // Newest change first, and a session with no prefs is not in the list.
    expect(repository.listSessionPrefs().map((prefs) => prefs.sessionID)).toEqual(["ses_b", "ses_a"])
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

describe("context packs (H-26)", () => {
  test("a pack belongs to a folder or to all of them, and the list shows both", () => {
    const repository = open()
    repository.savePack({ name: "review", refs: ["@src/a.ts", "@artifact:report"], directory: "/work/demo" })
    repository.savePack({ name: "shared", refs: ["@AGENTS.md"] })

    expect(repository.listPacks("/work/demo").map((pack) => pack.name)).toEqual(["review", "shared"])
    // A pack without a folder is not one project's; another folder only sees the global one.
    expect(repository.listPacks("/work/other").map((pack) => pack.name)).toEqual(["shared"])
    repository.close()
  })

  test("refs are trimmed and de-duplicated", () => {
    const repository = open()
    const pack = repository.savePack({ name: "p", refs: [" @a ", "@a", "", "  ", "@b"] })
    expect(pack.refs).toEqual(["@a", "@b"])
    repository.close()
  })

  test("saving the same name in the same folder replaces the pack", () => {
    const repository = open()
    const first = repository.savePack({ name: "review", refs: ["@a"], directory: "/work/demo" })
    const second = repository.savePack({ name: "review", refs: ["@b"], directory: "/work/demo" })

    expect(repository.listPacks("/work/demo")).toHaveLength(1)
    expect(repository.listPacks("/work/demo")[0]!.id).toBe(second.id)
    expect(repository.removePack(first.id)).toBe(false)
    repository.close()
  })

  test("removing one that is there", () => {
    const repository = open()
    const pack = repository.savePack({ name: "gone", refs: ["@a"] })
    expect(repository.removePack(pack.id)).toBe(true)
    expect(repository.listPacks()).toEqual([])
    repository.close()
  })
})

describe("shared conversations (H-35)", () => {
  test("keeps one and reads it back", () => {
    const repository = open()
    const share = repository.saveShare({ title: "Fix login", markdown: "# Fix login\n" })
    expect(repository.getShare(share.id)).toEqual(share)
    expect(repository.getShare("nope")).toBeUndefined()
    repository.close()
  })

  test("a conversation with no title still has one", () => {
    const repository = open()
    expect(repository.saveShare({ title: "   ", markdown: "x" }).title).toBe("Conversation")
    repository.close()
  })
})

describe("project memory (H-37)", () => {
  test("notes belong to a folder, read oldest first, and can be removed", () => {
    const repository = open()
    const first = repository.addProjectMemory({ directory: "/work/demo", text: "Use the server" })
    repository.addProjectMemory({ directory: "/work/demo", text: "Conventional commits" })
    repository.addProjectMemory({ directory: "/work/other", text: "Someone else's" })

    expect(repository.listProjectMemory("/work/demo").map((note) => note.text)).toEqual([
      "Use the server",
      "Conventional commits",
    ])
    expect(repository.listProjectMemory("/work/nowhere")).toEqual([])
    expect(repository.removeProjectMemory(first.id)).toBe(true)
    expect(repository.removeProjectMemory(first.id)).toBe(false)
    expect(repository.listProjectMemory("/work/demo")).toHaveLength(1)
    repository.close()
  })
})

describe("a task's place in the graph (H-28)", () => {  test("the tasks it waits for, and the condition that lets it run, survive a round trip", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, 1000)
    const [task] = repository.addTasks(run.id, [
      {
        name: "report",
        prompt: "say what broke",
        dependsOn: ["check"],
        when: { task: "check", is: ["failed"] },
        foreach: "plan",
      },
    ])

    expect(repository.getTask(task!.id)).toMatchObject({
      dependsOn: ["check"],
      when: { task: "check", is: ["failed"] },
      foreach: "plan",
    })
    // An explicit empty list is a root, and it must not read back as "no opinion".
    const [root] = repository.addTasks(run.id, [{ name: "parallel", prompt: "go", dependsOn: [] }])
    expect(repository.getTask(root!.id)!.dependsOn).toEqual([])
    repository.close()
  })

  test("a skipped task is a status like any other, with the reason it was skipped", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, 1000)
    const [task] = repository.addTasks(run.id, [{ name: "ship", prompt: "ship" }])
    repository.finishTask(task!.id, "skipped", { error: "Not run: check did not succeed" }, 1200)

    expect(repository.getTask(task!.id)).toMatchObject({
      status: "skipped",
      error: "Not run: check did not succeed",
      finishedAt: 1200,
    })
    repository.close()
  })
})

// WA-7: a routine can drive a web action, and the consent it runs under is stored beside it.
describe("a scheduled web action (WA-7)", () => {
  test("the action, its inputs and its allow rules survive a routine round trip", () => {
    const repository = open()
    const routine = repository.create({
      name: "Publish",
      description: "",
      prompt: "",
      schedule: { type: "daily", time: "09:00" },
      action: { id: "publish", inputs: { text: "hola", image: { artifactId: "art_1" } } },
      allow: [{ permission: "browser_sensitive", pattern: "https://example.com:publish", action: "allow" }],
    })

    expect(repository.get(routine.id)).toMatchObject({
      action: { id: "publish", inputs: { text: "hola", image: { artifactId: "art_1" } } },
      allow: [{ permission: "browser_sensitive", pattern: "https://example.com:publish", action: "allow" }],
    })
    repository.close()
  })

  test("an action task and the run's allow rules survive a round trip", () => {
    const repository = open()
    const run = repository.startRun({ type: "manual" }, 1000, undefined, {
      allow: [{ permission: "browser", pattern: "https://example.com", action: "allow" }],
    })
    repository.addTasks(run.id, [
      { name: "read", prompt: "", kind: "action", action: { id: "read_status", inputs: { page: "1" } } },
    ])

    expect(repository.getRun(run.id)?.allow).toEqual([
      { permission: "browser", pattern: "https://example.com", action: "allow" },
    ])
    expect(repository.listTasks(run.id)[0]).toMatchObject({
      kind: "action",
      action: { id: "read_status", inputs: { page: "1" } },
    })
    repository.close()
  })

  test("a routine saved without an action reads back without one", () => {
    const repository = open()
    const routine = repository.create(input)
    expect(repository.get(routine.id)?.action).toBeUndefined()
    expect(repository.get(routine.id)?.allow).toBeUndefined()
    repository.close()
  })
})

describe("the adaptive usage ledger (FH-013)", () => {
  test("a month starts empty and accumulates without replacing", () => {
    const repository = open()
    expect(repository.adaptiveUsage("2026-09")).toEqual({ tokens: 0, calls: 0 })

    repository.addAdaptiveUsage("2026-09", 120, 1, 1_000)
    repository.addAdaptiveUsage("2026-09", 80, 1, 2_000)
    expect(repository.adaptiveUsage("2026-09")).toEqual({ tokens: 200, calls: 2 })
    // Another month is a different row; the cap is per UTC month.
    expect(repository.adaptiveUsage("2026-10")).toEqual({ tokens: 0, calls: 0 })
    repository.close()
  })
})

describe("the decision audit (FH-015)", () => {
  const decision = (overrides: Partial<StoredDecisionInput> = {}): StoredDecisionInput => ({
    id: "completion:episode:run:1",
    kind: "completion",
    sessionID: "ses_1",
    episodeID: "episode:run:1",
    projectID: "/work/project",
    inputsHash: "a".repeat(64),
    stateSummary: { kind: "completion", bytes: 42 },
    answer: { verdict: "complete" },
    baselineAnswer: { verdict: "complete" },
    baselineRule: "episode-outcome",
    confidence: 0.9,
    probabilities: { complete: 0.9, not_complete: 0.1 },
    provider: "jev",
    modelVersion: "jev-1.13.0",
    source: "model",
    degraded: false,
    latencyMs: 12,
    policy: { allowJev: true, minConfidence: 0.6, minProbability: 0.5, timeoutMs: 400 },
    shadow: true,
    ...overrides,
  })

  test("writes and reads a row, and upserts on the deterministic id", () => {
    const repository = open()
    const created = repository.createDecision(decision(), 1_000)
    expect(created.createdAt).toBe(1_000)
    expect(repository.getDecision("completion:episode:run:1")).toMatchObject({
      answer: { verdict: "complete" },
      baselineRule: "episode-outcome",
      confidence: 0.9,
      source: "model",
      shadow: true,
    })

    const updated = repository.createDecision(decision({ answer: { verdict: "not_complete" }, degraded: true }), 2_000)
    expect(updated.createdAt).toBe(1_000)
    expect(updated.updatedAt).toBe(2_000)
    expect(repository.getDecision("completion:episode:run:1")?.answer).toEqual({ verdict: "not_complete" })
    expect(repository.listDecisions()).toHaveLength(1)
    repository.close()
  })

  test("lists by episode and kind, and counts for one episode", () => {
    const repository = open()
    repository.createDecision(decision(), 1_000)
    repository.createDecision(decision({ id: "skillRelevance:episode:run:1", kind: "skillRelevance" }), 1_001)
    repository.createDecision(decision({ id: "completion:episode:run:2", episodeID: "episode:run:2" }), 1_002)

    expect(repository.listDecisions({ episodeID: "episode:run:1" })).toHaveLength(2)
    expect(repository.listDecisions({ kind: "skillRelevance" })).toHaveLength(1)
    expect(repository.countDecisionsForEpisode("episode:run:1", "completion")).toBe(1)
    expect(repository.countDecisionsForEpisode("episode:run:1", "contextItem")).toBe(0)
    repository.close()
  })
})

describe("the context plan audit (FH-022)", () => {
  test("writes and reads a row, and upserts on the deterministic id", () => {
    const repository = open()
    const created = repository.createPlan(plan(), 1_000)
    expect(created.createdAt).toBe(1_000)
    expect(repository.getPlan("plan:episode:run:1")).toMatchObject({
      episodeID: "episode:run:1",
      scoreSource: "baseline",
      applied: false,
      truncated: false,
      tokensBefore: 35,
      tokensAfter: 30,
    })
    expect(repository.getPlan("plan:episode:run:1")?.entries.map((entry) => entry.id)).toEqual([
      "file:abc",
      "tool:def",
    ])

    const updated = repository.createPlan(
      plan({ scoreSource: "model", degraded: true, degradedReason: "low-confidence", applied: true }),
      2_000,
    )
    expect(updated.createdAt).toBe(1_000)
    expect(updated.updatedAt).toBe(2_000)
    expect(repository.getPlan("plan:episode:run:1")).toMatchObject({
      scoreSource: "model",
      degraded: true,
      degradedReason: "low-confidence",
      applied: true,
    })
    expect(repository.listPlans()).toHaveLength(1)
    repository.close()
  })

  test("lists by scope, newest first, and bounds a plan too large to store whole", () => {
    const repository = open()
    repository.createPlan(plan({ id: "plan:run1:task1", runID: "run1", taskID: "task1" }), 1_000)
    repository.createPlan(plan({ id: "plan:run2:task2", runID: "run2", taskID: "task2", sessionID: "ses_2" }), 1_002)

    expect(repository.listPlans({ runID: "run1" })).toHaveLength(1)
    expect(repository.listPlans({ taskID: "task2" })).toHaveLength(1)
    expect(repository.listPlans({ sessionID: "ses_2" }).map((entry) => entry.id)).toEqual(["plan:run2:task2"])
    expect(repository.listPlans()).toHaveLength(2)

    const huge = Array.from({ length: 5 }, (_, index) => ({
      id: `file:${index}`,
      kind: "file" as const,
      score: 0.5,
      disposition: "archive" as const,
      reason: "ambiguous",
      protected: false,
      tokens: 1,
      evidenceRef: "x".repeat(10_000),
    }))
    repository.createPlan(plan({ id: "plan:huge:task", runID: "huge", taskID: "task", entries: huge }), 1_003)
    const stored = repository.getPlan("plan:huge:task")!
    expect(stored.entries.length).toBeLessThan(5)
    expect(stored.truncated).toBe(true)
    repository.close()
  })
})

describe("the reflection job store (FH-030)", () => {
  const job = (overrides: Partial<StoredReflectionJobInput> = {}): StoredReflectionJobInput => ({
    episodeID: "episode:run:1",
    sessionID: "ses_1",
    projectID: "/work/project",
    status: "pending",
    attempts: 0,
    ...overrides,
  })

  test("a database written before the table gains it, keeping its other rows", () => {
    const path = scratch()
    const before = open(path)
    const run = before.startRun({ type: "manual" }, 1_000)
    // Put it back the way a server without reflection jobs left it.
    before.db.exec("DROP TABLE reflection_job")
    before.close()

    const after = open(path)
    expect(after.getReflectionJob("episode:run:1")).toBeUndefined()
    expect(after.getRun(run.id)?.id).toBe(run.id)
    // A job can be written again, which is what proves the table came back.
    expect(after.createReflectionJob(job(), 2_000)).toMatchObject({ episodeID: "episode:run:1", status: "pending" })
    after.close()
  })

  test("writes and reads a row, and upserts by episode id", () => {
    const repository = open()
    const created = repository.createReflectionJob(
      job({ status: "skipped", reason: "below-threshold", decisionID: "skillReflection:episode:run:1" }),
      1_000,
    )
    expect(created.createdAt).toBe(1_000)
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({
      status: "skipped",
      reason: "below-threshold",
      decisionID: "skillReflection:episode:run:1",
    })

    // The same episode converges on one row: the id is what makes "already tried" durable.
    const updated = repository.createReflectionJob(
      job({ status: "done", proposalID: "proposal:episode:run:1" }),
      2_000,
    )
    expect(updated.createdAt).toBe(1_000)
    expect(updated.updatedAt).toBe(2_000)
    expect(repository.listReflectionJobs()).toHaveLength(1)
    expect(repository.getReflectionJob("episode:run:1")?.status).toBe("done")
    repository.close()
  })

  test("lists by project and status, newest first", () => {
    const repository = open()
    repository.createReflectionJob(job({ episodeID: "episode:run:1", status: "done" }), 1_000)
    repository.createReflectionJob(job({ episodeID: "episode:run:2", status: "done" }), 1_001)
    repository.createReflectionJob(job({ episodeID: "episode:run:3", projectID: "/work/other" }), 1_002)

    expect(repository.listReflectionJobs({ status: "done" })).toHaveLength(2)
    expect(repository.listReflectionJobs({ projectID: "/work/other" }).map((entry) => entry.episodeID)).toEqual([
      "episode:run:3",
    ])
    expect(repository.listReflectionJobs({ limit: 1 })[0]!.episodeID).toBe("episode:run:3")
    repository.close()
  })
})

describe("the skill proposal store (FH-034)", () => {
  const proposal = (overrides: Partial<StoredSkillProposalInput> = {}): StoredSkillProposalInput => ({
    id: "proposal:episode:run:1",
    episodeID: "episode:run:1",
    sessionID: "ses_1",
    projectID: "/work/project",
    decisionID: "skillReflection:episode:run:1",
    intent: "add",
    name: "fix-failing-test",
    description: "Use when a test fails",
    body: "## Steps\nDo the minimal thing.",
    bodyHash: "a".repeat(64),
    evidenceRefs: ["episode:run:1"],
    confidence: 0.9,
    modelVersion: "prov/small",
    status: "proposed",
    ...overrides,
  })

  test("a database written before the table gains it, keeping its other rows", () => {
    const path = scratch()
    const before = open(path)
    const run = before.startRun({ type: "manual" }, 1_000)
    // Put it back the way a server without skill proposals left it.
    before.db.exec("DROP TABLE skill_proposals")
    before.close()

    const after = open(path)
    expect(after.getProposal("proposal:episode:run:1")).toBeUndefined()
    expect(after.getRun(run.id)?.id).toBe(run.id)
    // A proposal can be written again, which is what proves the table came back.
    expect(after.createProposal(proposal(), 2_000)).toMatchObject({
      id: "proposal:episode:run:1",
      status: "proposed",
      intent: "add",
    })
    after.close()
  })

  test("writes and reads a row, and upserts by proposal id", () => {
    const repository = open()
    const created = repository.createProposal(proposal(), 1_000)
    expect(created.createdAt).toBe(1_000)
    expect(repository.getProposal("proposal:episode:run:1")).toMatchObject({
      episodeID: "episode:run:1",
      evidenceRefs: ["episode:run:1"],
      bodyHash: "a".repeat(64),
      confidence: 0.9,
    })

    // The same episode converges on one row, and the promotion updates its status in place.
    const promoted = repository.createProposal(proposal({ status: "promoted" }), 2_000)
    expect(promoted.createdAt).toBe(1_000)
    expect(promoted.updatedAt).toBe(2_000)
    expect(repository.getProposal("proposal:episode:run:1")?.status).toBe("promoted")
    expect(repository.listProposals()).toHaveLength(1)
    repository.close()
  })

  test("drops a row whose intent or status is unknown rather than guessing", () => {
    const repository = open()
    repository.createProposal(proposal(), 1_000)
    repository.db.query("UPDATE skill_proposals SET status = 'invented' WHERE id = ?1").run("proposal:episode:run:1")
    expect(repository.getProposal("proposal:episode:run:1")).toBeUndefined()
    expect(repository.listProposals()).toEqual([])
    repository.close()
  })
})

describe("the adaptive retention purge (FH-082, ADR-0022 §2)", () => {
  test("the columns the purge correlates and filters on are indexed, so the delete does not scan", () => {
    const repository = open()
    const indexes = new Set(
      (repository.db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    )
    for (const name of [
      "adaptive_plan_decision",
      "adaptive_plan_applied_updated",
      "adaptive_decision_shadow_updated",
      "reflection_job_decision",
      "reflection_job_proposal",
      "reflection_job_status_updated",
      "skill_proposals_decision",
      "skill_proposals_status_updated",
    ])
      expect(indexes, name).toContain(name)
    // A representative window query resolves through the additive index instead of a full scan.
    const plan = repository.db
      .query("EXPLAIN QUERY PLAN SELECT 1 FROM adaptive_decision WHERE shadow = 1 AND updated_at < ?1")
      .all(1) as Array<{ detail: string }>
    expect(plan.some((step) => step.detail.includes("adaptive_decision_shadow_updated"))).toBe(true)
    repository.close()
  })

  const decision = (overrides: Partial<StoredDecisionInput> = {}): StoredDecisionInput => ({
    id: "decision:old",
    kind: "completion",
    sessionID: "ses_1",
    episodeID: "episode:run:1",
    projectID: "/work/project",
    inputsHash: "a".repeat(64),
    stateSummary: {},
    answer: { verdict: "complete" },
    baselineAnswer: { verdict: "complete" },
    baselineRule: "episode-outcome",
    provider: "deterministic",
    source: "baseline",
    degraded: false,
    latencyMs: 1,
    policy: { allowJev: false, minConfidence: 0.6, minProbability: 0.5, timeoutMs: 400 },
    shadow: true,
    ...overrides,
  })

  const job = (overrides: Partial<StoredReflectionJobInput> = {}): StoredReflectionJobInput => ({
    episodeID: "episode:run:1",
    sessionID: "ses_1",
    projectID: "/work/project",
    status: "done",
    attempts: 1,
    ...overrides,
  })

  const proposal = (overrides: Partial<StoredSkillProposalInput> = {}): StoredSkillProposalInput => ({
    id: "proposal:episode:run:1",
    episodeID: "episode:run:1",
    sessionID: "ses_1",
    projectID: "/work/project",
    intent: "add",
    name: "fix-failing-test",
    description: "Use when a test fails",
    body: "b",
    bodyHash: "a".repeat(64),
    evidenceRefs: [],
    status: "rejected",
    ...overrides,
  })

  /** One cutoff for every table: the common shape a caller builds from `retentionCutoffs`. */
  const cutoffs = (before: number) => ({
    decisionsBefore: before,
    actingBefore: before,
    plansBefore: before,
    appliedPlansBefore: before,
    reflectionBefore: before,
    proposalsBefore: before,
  })

  test("purges each table by its window and reports the counts", () => {
    const repository = open()
    repository.createDecision(decision({ id: "shadow:old" }), 1_000)
    repository.createDecision(decision({ id: "acting:old", shadow: false }), 1_000)
    repository.createPlan(plan({ id: "plan:shadow:old", episodeID: "episode:shadow" }), 1_000)
    repository.createPlan(plan({ id: "plan:applied:old", episodeID: "episode:applied", applied: true }), 1_000)
    repository.createReflectionJob(job({ episodeID: "job:old", status: "done" }), 1_000)
    repository.createReflectionJob(job({ episodeID: "job:pending", status: "pending" }), 1_000)
    repository.createProposal(proposal({ id: "prop:rejected", status: "rejected" }), 1_000)
    repository.createProposal(proposal({ id: "prop:proposed", status: "proposed" }), 1_000)
    repository.createProposal(proposal({ id: "prop:promoted", status: "promoted" }), 1_000)

    const purged = repository.purgeAdaptive(cutoffs(2_000))
    expect(purged).toEqual({ decisions: 1, actingDecisions: 1, plans: 2, reflectionJobs: 1, proposals: 1 })
    expect(repository.getDecision("shadow:old")).toBeUndefined()
    expect(repository.getDecision("acting:old")).toBeUndefined()
    expect(repository.getPlan("plan:shadow:old")).toBeUndefined()
    expect(repository.getPlan("plan:applied:old")).toBeUndefined()
    expect(repository.getReflectionJob("job:old")).toBeUndefined()
    // Hard exemptions: a pending job and proposed/promoted proposals never leave.
    expect(repository.getReflectionJob("job:pending")).toBeDefined()
    expect(repository.getProposal("prop:proposed")).toBeDefined()
    expect(repository.getProposal("prop:promoted")).toBeDefined()
    expect(repository.getProposal("prop:rejected")).toBeUndefined()
    repository.close()
  })

  test("a row inside its window is kept, and a cutoff before it deletes nothing", () => {
    const repository = open()
    repository.createDecision(decision({ id: "shadow:fresh" }), 5_000)
    expect(repository.purgeAdaptive(cutoffs(1_000))).toMatchObject({ decisions: 0, plans: 0 })
    expect(repository.getDecision("shadow:fresh")).toBeDefined()

    // The acting window is judged on its own cutoff: a shadow window would take it, the acting one not.
    repository.createDecision(decision({ id: "acting:young", shadow: false }), 5_000)
    expect(repository.purgeAdaptive({ ...cutoffs(1_000), actingBefore: 10_000 }).actingDecisions).toBe(1)

    // A cutoff is exclusive (`updated_at < cutoff`): a row touched exactly on its boundary is kept.
    repository.createDecision(decision({ id: "shadow:boundary" }), 2_000)
    expect(repository.purgeAdaptive(cutoffs(2_000)).decisions).toBe(0)
    expect(repository.getDecision("shadow:boundary")).toBeDefined()
    repository.close()
  })

  test("an applied plan keeps its longer window while an unapplied one goes", () => {
    const repository = open()
    repository.createPlan(plan({ id: "plan:shadow", episodeID: "episode:shadow" }), 1_000)
    repository.createPlan(plan({ id: "plan:applied", episodeID: "episode:applied", applied: true }), 1_000)
    // A cutoff is per state: the shadow window (2_000) takes the unapplied plan, while the shorter
    // applied window (500) leaves the applied one alone.
    const purged = repository.purgeAdaptive({ ...cutoffs(2_000), appliedPlansBefore: 500 })
    expect(purged.plans).toBe(1)
    expect(repository.getPlan("plan:shadow")).toBeUndefined()
    expect(repository.getPlan("plan:applied")).toBeDefined()
    repository.close()
  })

  test("never purges a row a surviving row references", () => {
    const repository = open()
    repository.createDecision(decision({ id: "decision:referenced-by-plan" }), 1_000)
    repository.createPlan(plan({ id: "plan:survivor", episodeID: "episode:survivor", decisionID: "decision:referenced-by-plan" }), 5_000)
    repository.createDecision(decision({ id: "decision:referenced-by-job" }), 1_000)
    repository.createReflectionJob(job({ episodeID: "job:pending", status: "pending", decisionID: "decision:referenced-by-job" }), 5_000)
    repository.createDecision(decision({ id: "decision:referenced-by-proposal" }), 1_000)
    repository.createProposal(proposal({ id: "prop:survivor", status: "proposed", decisionID: "decision:referenced-by-proposal" }), 5_000)

    expect(repository.purgeAdaptive(cutoffs(2_000)).decisions).toBe(0)
    expect(repository.getDecision("decision:referenced-by-plan")).toBeDefined()
    expect(repository.getDecision("decision:referenced-by-job")).toBeDefined()
    expect(repository.getDecision("decision:referenced-by-proposal")).toBeDefined()
    repository.close()
  })

  test("a rejected proposal a surviving job references is kept", () => {
    const repository = open()
    repository.createReflectionJob(job({ episodeID: "job:pending", status: "pending", proposalID: "prop:rejected" }), 5_000)
    repository.createProposal(proposal({ id: "prop:rejected", status: "rejected" }), 1_000)
    expect(repository.purgeAdaptive(cutoffs(2_000)).proposals).toBe(0)
    expect(repository.getProposal("prop:rejected")).toBeDefined()
    repository.close()
  })

  test("a decision reachable only through a terminal job goes with it, child-first", () => {
    const repository = open()
    repository.createDecision(decision({ id: "decision:terminal-only" }), 1_000)
    repository.createReflectionJob(job({ episodeID: "job:done", status: "done", decisionID: "decision:terminal-only" }), 1_000)
    const purged = repository.purgeAdaptive(cutoffs(2_000))
    expect(purged.reflectionJobs).toBe(1)
    expect(purged.decisions).toBe(1)
    expect(repository.getDecision("decision:terminal-only")).toBeUndefined()
    repository.close()
  })

  test("never touches episodes, evidence or artifacts", () => {
    const repository = open()
    repository.createEpisode(
      {
        id: "episode:run:1",
        sessionID: "ses_1",
        projectID: "/work/project",
        objective: "o",
        toolCalls: 1,
        files: [],
        commands: [],
        failures: [],
        verifications: [],
        outcome: "success",
        startedAt: 1,
        endedAt: 2,
        evidenceRefs: [],
      },
      1_000,
    )
    const slice = repository.putEvidence({ content: "evidence kept" }, 1_000)!
    const artifact = repository.addArtifact(
      { kind: "report", title: "kept", producer: "harness", content: "an artifact the purge must not touch" },
      1_000,
    )
    repository.createDecision(decision({ id: "shadow:old" }), 1_000)

    repository.purgeAdaptive(cutoffs(2_000))
    expect(repository.getEpisode("episode:run:1")).toBeDefined()
    expect(repository.listEpisodes()).toHaveLength(1)
    expect(repository.getEvidence(slice.hash, 3_000)).toBeDefined()
    expect(repository.getArtifact(artifact.id)).toBeDefined()
    expect(repository.listArtifacts()).toHaveLength(1)
    repository.close()
  })
})

describe("the reflection claim (AH-A07)", () => {
  const LEASE = 600_000
  const claim = (repository: SqliteRoutineRepository, now: number) =>
    repository.claimReflectionJob({ episodeID: "episode:run:1", sessionID: "ses_1", projectID: "/work/project" }, now, LEASE)

  test("one claimant wins; a live claim or a terminal job refuses; an expired claim is taken over", () => {
    const repository = open()
    expect(claim(repository, 1_000)).toBe(true)
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({ status: "pending", attempts: 1, claimedAt: 1_000 })
    // Still inside the lease: a second process or a restart does not reflect it again.
    expect(claim(repository, 1_000 + LEASE)).toBe(false)
    // Past the lease: the claimant died, so the episode is not left pending forever.
    expect(claim(repository, 1_001 + LEASE)).toBe(true)
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({ attempts: 2, claimedAt: 1_001 + LEASE })

    // The terminal write keeps the attempts the claims counted, and a finished job is never claimed.
    repository.createReflectionJob(
      { episodeID: "episode:run:1", sessionID: "ses_1", projectID: "/work/project", status: "done", attempts: 1 },
      2_000 + LEASE,
    )
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({ status: "done", attempts: 2 })
    expect(claim(repository, 10 * LEASE)).toBe(false)
    repository.close()
  })

  test("a database written before the claim column gains it, and its old pending rows are reclaimable", () => {
    const path = scratch()
    const before = open(path)
    // Put it back the way a server without the claim left it, with a job stuck in `pending`.
    before.db.exec("DROP TABLE reflection_job")
    before.db.exec(`CREATE TABLE reflection_job (
      episode_id TEXT PRIMARY KEY, session_id TEXT, project_id TEXT, status TEXT NOT NULL, reason TEXT,
      decision_id TEXT, proposal_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`)
    before.db.exec(
      "INSERT INTO reflection_job (episode_id, status, attempts, created_at, updated_at) VALUES ('episode:run:1', 'pending', 1, 1000, 1000)",
    )
    before.close()

    const after = open(path)
    expect(after.getReflectionJob("episode:run:1")?.claimedAt).toBeUndefined()
    // Without a claim time the lease runs from the last update.
    expect(claim(after, 1_000 + LEASE)).toBe(false)
    expect(claim(after, 1_001 + LEASE)).toBe(true)
    expect(after.getReflectionJob("episode:run:1")).toMatchObject({ status: "pending", attempts: 2 })
    after.close()
  })
})

// ---- RP-01: a run's workflow identity (migration 3) ---------------------------------------------

/** A database as a build at schema version 2 left it, with runs and tasks of its own. */
const v2Fixture = (path: string) => {
  const repository = open(path)
  const run = repository.startRun({ type: "manual" }, 1_000, "/work/demo")
  repository.addTasks(run.id, [{ name: "plan", prompt: "Plan it" }])
  repository.finishRun(run.id, "success", undefined, 2_000)
  repository.db.exec(`
    DELETE FROM schema_version WHERE version >= 3;
    DROP TABLE workflow_versions;
    ALTER TABLE runs DROP COLUMN workflow_json;
  `)
  repository.close()
  return run.id
}

describe("the workflow identity migration (RP-01)", () => {
  test("backs the file up, keeps every run as it was, and new runs can name their workflow", () => {
    const path = scratch()
    const runID = v2Fixture(path)

    const repository = open(path)
    const [backup] = backupsOf(path)
    expect(backup).toMatch(/^harness\.sqlite\.bak-v2-/)
    expect(repository.db.query("SELECT version, name, backup FROM schema_version WHERE version = 3").all()).toEqual([
      { version: 3, name: "workflow-identity", backup: join(dirname(path), backup!) },
    ])
    // The old run is intact and names no workflow: none was recorded, and none is guessed.
    expect(repository.getRun(runID)).toMatchObject({ id: runID, status: "success", directory: "/work/demo" })
    expect(repository.getRun(runID)?.workflow).toBeUndefined()
    expect(repository.listTasks(runID).map((task) => task.name)).toEqual(["plan"])
    const copy = new Database(join(dirname(path), backup!))
    expect((copy.query("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count).toBe(1)
    copy.close()

    const workflow = { name: "feature", scope: "project" as const, hash: "abc", inputs: { goal: "x" } }
    repository.recordWorkflowVersion({ hash: "abc", name: "feature", scope: "project", source: "name: feature\n" })
    const next = repository.startRun({ type: "manual" }, 3_000, "/work/demo", { workflow })
    expect(repository.getRun(next.id)?.workflow).toEqual(workflow)
    expect(repository.listWorkflowRuns("feature", "/work/demo").map((run) => run.id)).toEqual([next.id])
    expect(repository.getWorkflowVersion("abc")).toMatchObject({ name: "feature", source: "name: feature\n" })
    repository.close()
  })
})

// ---- RP-02: what deleting a run takes with it, and the migration that enforces it -----------------

/** A run with one of everything that hangs off it. */
const populatedRun = (repository: SqliteRoutineRepository, now = 1_000) => {
  const run = repository.startRun({ type: "manual" }, now, "/work/demo")
  const [task] = repository.addTasks(run.id, [{ name: "plan", prompt: "Plan it" }])
  repository.finishRun(run.id, "success", undefined, now + 1)
  const [finding] = repository.addFindings([
    { directory: "/work/demo", runID: run.id, taskID: task!.id, file: "a.ts", line: 1, severity: "high", title: "Broken" },
  ])
  const artifact = (producer: "harness" | "agent" | "user", pinned = false) =>
    repository.addArtifact({ kind: "report", title: `${producer}${pinned ? " pinned" : ""}`, producer, content: "x", runID: run.id, taskID: task!.id, pinned })
  return {
    run,
    task: task!,
    finding: finding!,
    harness: artifact("harness"),
    pinned: artifact("harness", true),
    agent: artifact("agent"),
    user: artifact("user"),
  }
}

describe("deleting a run (RP-02)", () => {
  test("takes its tasks, findings and unpinned harness artifacts, and keeps what a person kept", () => {
    const repository = open()
    const made = populatedRun(repository)
    const other = populatedRun(repository, 5_000)
    expect(repository.removeRun(made.run.id)).toBe(true)

    expect(repository.getTask(made.task.id)).toBeUndefined()
    expect(repository.listFindings({ runID: made.run.id })).toEqual([])
    expect(repository.getArtifact(made.harness.id)).toBeUndefined()
    // Pinned, or not the harness's own: kept, no longer pointing at a run that is gone.
    for (const kept of [made.pinned, made.agent, made.user]) {
      expect(repository.getArtifact(kept.id)).toMatchObject({ id: kept.id })
      expect(repository.getArtifact(kept.id)?.runID).toBeUndefined()
      expect(repository.getArtifact(kept.id)?.taskID).toBeUndefined()
    }
    // Another run is untouched.
    expect(repository.getTask(other.task.id)).toBeDefined()
    expect(repository.listFindings({ runID: other.run.id })).toHaveLength(1)
    expect(repository.getArtifact(other.harness.id)).toBeDefined()
    repository.close()
  })

  test("clearing finished runs and deleting a routine take the same with them", () => {
    const repository = open()
    const cleared = populatedRun(repository)
    repository.removeFinishedRuns()
    expect(repository.getTask(cleared.task.id)).toBeUndefined()
    expect(repository.listFindings({ runID: cleared.run.id })).toEqual([])
    expect(repository.getArtifact(cleared.harness.id)).toBeUndefined()
    expect(repository.getArtifact(cleared.pinned.id)).toBeDefined()

    const routine = repository.create({ name: "Nightly", description: "", prompt: "Go", schedule: { type: "manual" } })
    const run = repository.startRun({ type: "routine", routineID: routine.id }, 9_000)
    const [task] = repository.addTasks(run.id, [{ name: "go", prompt: "Go" }])
    const evidence = repository.addArtifact({ kind: "log", title: "log", producer: "harness", content: "x", runID: run.id })
    repository.remove(routine.id)
    expect(repository.getTask(task!.id)).toBeUndefined()
    expect(repository.getArtifact(evidence.id)).toBeUndefined()
    repository.close()
  })

  test("a row that names a run which does not exist is refused", () => {
    const repository = open()
    expect(() => repository.addTasks("no-such-run", [{ name: "x", prompt: "x" }])).toThrow()
    repository.close()
  })
})

/**
 * A database as a build at schema version 3 left it: no foreign keys, and rows of runs that were
 * deleted back when only their tasks went with them — some tasks too, from older builds.
 */
const v3Fixture = (path: string) => {
  const repository = open(path)
  const kept = populatedRun(repository)
  const gone = populatedRun(repository, 3_000)
  const checkpoint = { id: "cp_gone", directory: "/work/demo", sha: "abc", title: "Before", runID: gone.run.id, createdAt: 3_500 }
  repository.addCheckpoint(checkpoint)
  repository.db.exec(`
    DELETE FROM schema_version WHERE version >= 4;
    DROP TRIGGER IF EXISTS runs_take_harness_artifacts;
    PRAGMA foreign_keys = OFF;
  `)
  // Back to the version 3 tables, without their foreign keys.
  for (const table of ["tasks", "findings", "artifacts"]) {
    const sql = (repository.db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table) as { sql: string }).sql
    const plain = sql.replace(/\s+REFERENCES\s+\w+\s*\(\s*id\s*\)(\s+ON DELETE (CASCADE|SET NULL))?/gi, "")
    repository.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_fk; ${plain.replace(`CREATE TABLE "${table}"`, `CREATE TABLE ${table}`).replace(`CREATE TABLE ${table}_new`, `CREATE TABLE ${table}`)}; INSERT INTO ${table} SELECT * FROM ${table}_fk; DROP TABLE ${table}_fk;`)
  }
  // What an old build left behind: the run row went, what hung off it stayed.
  repository.db.exec(`DELETE FROM runs WHERE id = '${gone.run.id}'`)
  repository.close()
  return { kept, gone }
}

describe("the referential integrity migration (RP-02)", () => {
  test("backs the file up, drops the invisible orphans, keeps what the app shows, and enforces the keys", () => {
    const path = scratch()
    const { kept, gone } = v3Fixture(path)
    const raw = new Database(path)
    expect((raw.query("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?1").get(gone.run.id) as { count: number }).count).toBe(1)
    raw.close()

    const repository = open(path)
    const [backup] = backupsOf(path)
    expect(backup).toMatch(/^harness\.sqlite\.bak-v3-/)
    expect(repository.db.query("SELECT version, name FROM schema_version WHERE version = 4").all()).toEqual([
      { version: 4, name: "referential-integrity" },
    ])
    // The orphan task is gone: nothing could show it. The orphan finding and artifacts are kept,
    // detached from the run that no longer exists.
    expect(repository.getTask(gone.task.id)).toBeUndefined()
    expect(repository.listFindings({ directory: "/work/demo" }).map((finding) => [finding.id, finding.runID])).toContainEqual([
      gone.finding.id,
      undefined,
    ])
    for (const artifact of [gone.harness, gone.pinned, gone.agent, gone.user])
      expect(repository.getArtifact(artifact.id)?.runID).toBeUndefined()
    // The checkpoint of the gone run is left to the sweep, which also removes its git ref (TI-15).
    expect(repository.removeStaleCheckpoints().map((checkpoint) => checkpoint.id)).toEqual(["cp_gone"])
    // The live run lost nothing.
    expect(repository.getTask(kept.task.id)).toBeDefined()
    expect(repository.listFindings({ runID: kept.run.id })).toHaveLength(1)
    expect(repository.getArtifact(kept.harness.id)?.runID).toBe(kept.run.id)
    // The keys are there, and hold.
    expect(repository.db.query("PRAGMA foreign_key_check").all()).toEqual([])
    const keys = (table: string) =>
      (repository.db.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; from: string; on_delete: string }>)
        .map((key) => `${key.from}->${key.table}:${key.on_delete}`)
        .sort()
    expect(keys("tasks")).toEqual(["run_id->runs:CASCADE"])
    expect(keys("findings")).toEqual(["run_id->runs:CASCADE", "task_id->tasks:SET NULL"])
    expect(keys("artifacts")).toEqual(["run_id->runs:SET NULL", "task_id->tasks:SET NULL"])
    // The backup still holds what the migration dropped.
    const copy = new Database(join(dirname(path), backup!))
    expect((copy.query("SELECT COUNT(*) AS count FROM tasks WHERE id = ?1").get(gone.task.id) as { count: number }).count).toBe(1)
    copy.close()
    repository.close()
  })
})

describe("the usage-summary migration (UL-05)", () => {
  test("a populated database at version 7 is backed up, indexed for the summary, and keeps every row", () => {
    const path = scratch()
    const before = open(path)
    const run = before.startRun({ type: "manual" }, 1_000, "/work/demo")
    before.attributeSession("ses_1", { runID: run.id, purpose: "run-task" })
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    const step = (id: string, endedAt?: number) => ({
      id,
      kind: "step" as const,
      sessionID: "ses_1",
      tokens,
      costUSD: 0.01,
      costBasis: "engine-list-price" as const,
      billing: "unknown" as const,
      startedAt: 2_000,
      ...(endedAt ? { endedAt } : {}),
    })
    before.recordUsage({ events: [step("a", 3_000), step("b")], tools: [] })
    before.db.exec("DELETE FROM schema_version WHERE version >= 8; DROP INDEX usage_event_at;")
    before.close()

    const repository = open(path)
    const [backup] = backupsOf(path)
    expect(backup).toMatch(/^harness\.sqlite\.bak-v7-/)
    expect(repository.db.query("SELECT version, name FROM schema_version WHERE version = 8").all()).toEqual([
      { version: 8, name: "usage-summary" },
    ])
    expect(repository.usageEvents("ses_1").map((event) => event.id)).toEqual(["a", "b"])
    // A window reads by the end of a fact, or its start without one, through the new index.
    const plan = repository.db
      .query("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM usage_event WHERE COALESCE(ended_at, started_at) >= ?1")
      .all(0) as Array<{ detail: string }>
    expect(plan.map((step) => step.detail).join(" ")).toContain("usage_event_at")
    expect(repository.usageTotals({ from: 2_500 }).reduce((sum, row) => sum + row.events, 0)).toBe(1)
    expect(repository.usageTotals({ groupBy: "run" })).toEqual([
      expect.objectContaining({ fields: { runID: run.id }, events: 2, usd: 0.02 }),
    ])
    const copy = new Database(join(dirname(path), backup!))
    expect((copy.query("SELECT COUNT(*) AS count FROM usage_event").get() as { count: number }).count).toBe(2)
    copy.close()
    repository.close()
  })
})

describe("the usage-reconciled migration (UL-03)", () => {
  test("a database at version 5 is backed up and migrated with its ledger and runs intact", () => {
    const path = scratch()
    const before = open(path)
    const run = before.startRun({ type: "manual" }, 1_000, "/work/demo")
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    const step = { id: "ses_1:step:msg_1", kind: "step" as const, sessionID: "ses_1", tokens, costUSD: 0.01, costBasis: "engine-list-price" as const, billing: "unknown" as const }
    before.recordUsage({ events: [step], tools: [] })
    before.db.exec("DELETE FROM schema_version WHERE version >= 6; DROP TABLE usage_reconciled;")
    before.close()

    const repository = open(path)
    const [backup] = backupsOf(path)
    expect(backup).toMatch(/^harness\.sqlite\.bak-v5-/)
    expect(repository.db.query("SELECT version, name FROM schema_version WHERE version = 6").all()).toEqual([
      { version: 6, name: "usage-reconciled" },
    ])
    expect(repository.getRun(run.id)?.id).toBe(run.id)
    expect(repository.usageEvents("ses_1")).toEqual([step])
    expect(repository.usageReconciled("ses_1")).toBeUndefined()
    repository.markUsageReconciled("ses_1", 2_000, 3_000)
    repository.markUsageReconciled("ses_1", 2_500, 3_500)
    expect(repository.usageReconciled("ses_1")).toBe(2_500)
    const copy = new Database(join(dirname(path), backup!))
    expect((copy.query("SELECT COUNT(*) AS count FROM usage_event").get() as { count: number }).count).toBe(1)
    copy.close()
    repository.close()
  })
})

describe("the task-verdict migration (RP-06)", () => {
  test("a database at version 7 is backed up and migrated with its runs and tasks intact and unjudged", () => {
    const path = scratch()
    const before = open(path)
    const run = before.startRun({ type: "manual" }, 1_000, "/work/demo")
    const [task] = before.addTasks(run.id, [{ name: "plan", prompt: "Plan it" }])
    before.finishTask(task!.id, "success", { output: "I give up.", tokens: 10, cost: 0.01 }, 1_500)
    before.finishRun(run.id, "success", undefined, 2_000)
    before.db.exec(`
      DELETE FROM schema_version WHERE version >= 8;
      ALTER TABLE tasks DROP COLUMN verdict;
      ALTER TABLE tasks DROP COLUMN verdict_reason;
      ALTER TABLE tasks DROP COLUMN verdict_source;
      ALTER TABLE tasks DROP COLUMN require_verdict;
    `)
    before.close()

    const repository = open(path)
    const [backup] = backupsOf(path)
    expect(backup).toMatch(/^harness\.sqlite\.bak-v7-/)
    expect(repository.db.query("SELECT version, name FROM schema_version WHERE version = 9").all()).toEqual([
      { version: 9, name: "task-verdict" },
    ])
    // Nobody judged the old task, and its answer is not read into a verdict after the fact.
    expect(repository.getTask(task!.id)).toMatchObject({ status: "success", output: "I give up.", tokens: 10, cost: 0.01 })
    expect(repository.getTask(task!.id)?.verdict).toBeUndefined()
    expect(repository.getRun(run.id)).toMatchObject({ id: run.id, status: "success" })
    expect(repository.getRun(run.id)?.verdict).toBeUndefined()
    // New verdicts are kept, and the run's is derived from them.
    repository.setTaskVerdict(task!.id, { value: "failed", reason: "I give up.", source: "rule" })
    expect(repository.getRun(run.id)?.verdict).toEqual({ value: "failed", reason: "I give up.", source: "rule", taskID: task!.id })
    const copy = new Database(join(dirname(path), backup!))
    expect((copy.query("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count).toBe(1)
    copy.close()
    repository.close()
  })
})

describe("the browser-policy migration (BU-01)", () => {
  test("a populated database at version 9 is backed up, and the approver's always answers become grants", () => {
    const path = scratch()
    const before = open(path)
    const run = before.startRun({ type: "manual" }, 1_000, "/work/demo")
    before.db.exec("DELETE FROM schema_version WHERE version >= 10; DROP TABLE browser_grants; DROP TABLE browser_audit;")
    before.close()
    writeFileSync(
      join(dirname(path), "action-approvals.json"),
      JSON.stringify({ always: ["https://example.com", "https://example.com:publish", "not a url", 7] }),
    )

    const repository = open(path)
    const [backup] = backupsOf(path)
    expect(backup).toMatch(/^harness\.sqlite\.bak-v9-/)
    expect(repository.db.query("SELECT version, name FROM schema_version WHERE version = 10").all()).toEqual([
      { version: 10, name: "browser-policy" },
    ])
    expect(repository.getRun(run.id)?.id).toBe(run.id)
    // A bare origin was a read-only action's consent; a sensitive action's is not carried over.
    expect(repository.listBrowserGrants()).toMatchObject([{ origin: "https://example.com", tier: "navigate", scope: "always" }])
    expect(repository.listBrowserAudit()).toEqual([])
    const copy = new Database(join(dirname(path), backup!))
    expect((copy.query("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count).toBe(1)
    copy.close()
    repository.close()
  })
})

// ---- RP-03: artifact lineage and versions (migration 11) ----------------------------------------

describe("artifact versions (RP-03)", () => {
  const document = { kind: "document" as const, title: "Report", producer: "agent" as const, directory: "/work/demo", path: ".flupcode/artifacts/report.md" }

  test("a folder and path already kept is the next version of that document; anything else starts its own", () => {
    const repository = open()
    const first = repository.addArtifact({ ...document, content: "one" }, 1_000)
    const second = repository.addArtifact({ ...document, title: "Report, retitled", content: "two" }, 2_000)
    const elsewhere = repository.addArtifact({ ...document, directory: "/work/other", content: "two" }, 3_000)
    const otherKind = repository.addArtifact({ ...document, kind: "plan", content: "two" }, 4_000)
    const pathless = repository.addArtifact({ kind: "report", title: "Report", producer: "harness", content: "x" }, 5_000)
    const pathlessAgain = repository.addArtifact({ kind: "report", title: "Report", producer: "harness", content: "x" }, 6_000)

    expect(first).toMatchObject({ logicalID: first.id, version: 1 })
    expect(second).toMatchObject({ logicalID: first.id, version: 2 })
    for (const own of [elsewhere, otherKind, pathless, pathlessAgain]) expect(own).toMatchObject({ logicalID: own.id, version: 1 })
    expect(repository.getArtifact(second.id)).toMatchObject({ logicalID: first.id, version: 2 })
    expect(repository.listArtifactVersions(first.id).map((version) => version.id)).toEqual([second.id, first.id])
    repository.close()
  })

  test("keeping a file's state adds nothing when the newest version holds it, and fills in what wrote it", () => {
    const repository = open()
    const runID = repository.startRun({ type: "manual" }, 1_000, "/work/demo").id
    const lazy = repository.keepVersion({ ...document, content: "one", hash: "h1" })
    expect(lazy).toMatchObject({ added: true, artifact: { version: 1 } })
    expect(lazy.artifact.sessionID).toBeUndefined()

    const reported = repository.keepVersion({ ...document, content: "one", hash: "h1", sessionID: "ses_1", messageID: "msg_1", runID })
    expect(reported).toMatchObject({ added: false, artifact: { id: lazy.artifact.id, sessionID: "ses_1", messageID: "msg_1", runID } })
    // What wrote a version is not rewritten by a later report of the same content.
    repository.keepVersion({ ...document, content: "one", hash: "h1", sessionID: "ses_2", messageID: "msg_2" })
    expect(repository.getArtifact(lazy.artifact.id)).toMatchObject({ sessionID: "ses_1", messageID: "msg_1" })

    const rewritten = repository.keepVersion({ ...document, content: "two", hash: "h2", sessionID: "ses_2", messageID: "msg_2" })
    expect(rewritten).toMatchObject({ added: true, artifact: { logicalID: lazy.artifact.id, version: 2, messageID: "msg_2" } })
    expect(repository.db.query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 2 })
    repository.close()
  })

  test("the list is one row per document, the newest matching version, a page at a time", () => {
    const repository = open()
    const runA = repository.startRun({ type: "manual" }, 1_000, "/work/demo").id
    const runB = repository.startRun({ type: "manual" }, 1_000, "/work/demo").id
    repository.addArtifact({ ...document, content: "one", runID: runA }, 1_000)
    const newest = repository.addArtifact({ ...document, content: "two", runID: runB }, 2_000)
    for (let index = 0; index < 150; index++)
      repository.addArtifact({ kind: "report", title: `r${index}`, producer: "harness", content: `r${index}` }, 10_000 + index)

    const listed = repository.listArtifacts({ directory: "/work/demo" })
    expect(listed).toEqual([expect.objectContaining({ id: newest.id, version: 2, versions: 2 })])
    // A run sees the version it produced, still counted against the whole document.
    expect(repository.listArtifacts({ runID: runA })).toEqual([expect.objectContaining({ content: "one", version: 1, versions: 2 })])

    const first = repository.listArtifacts({}, 100)
    const second = repository.listArtifacts({ offset: 100 }, 100)
    expect(first).toHaveLength(100)
    expect(second).toHaveLength(51)
    expect(new Set([...first, ...second].map((artifact) => artifact.logicalID)).size).toBe(151)
    repository.close()
  })

  test("a pin and a retention belong to the document: new versions inherit them and the sweep spares them", () => {
    const repository = open()
    const first = repository.addArtifact({ ...document, content: "one" }, 1_000)
    repository.setArtifactRetention(first.id, 5_000)
    const second = repository.addArtifact({ ...document, content: "two" }, 2_000)
    expect(second.expiresAt).toBe(5_000)
    repository.setArtifactPinned(second.id, true)
    expect(repository.getArtifact(first.id)?.pinned).toBe(true)
    expect(repository.addArtifact({ ...document, content: "three" }, 3_000).pinned).toBe(true)
    expect(repository.removeExpiredArtifacts(10_000)).toBe(0)

    repository.setArtifactPinned(first.id, false)
    expect(repository.removeExpiredArtifacts(10_000)).toBe(3)
    repository.close()
  })

  test("deleting a version leaves the others; deleting the document takes every version", () => {
    const repository = open()
    const first = repository.addArtifact({ ...document, content: "one" }, 1_000)
    const second = repository.addArtifact({ ...document, content: "two" }, 2_000)
    repository.addArtifact({ ...document, content: "three" }, 3_000)
    expect(repository.removeArtifact(second.id)).toBe(true)
    expect(repository.listArtifactVersions(first.id).map((version) => version.version)).toEqual([3, 1])
    expect(repository.removeArtifact(first.id, { document: true })).toBe(true)
    expect(repository.db.query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 })
    repository.close()
  })
})

describe("the artifact-versions migration (RP-03)", () => {
  test("a populated database at version 10 is backed up, and its copies become versions without losing a row", () => {
    const path = scratch()
    const before = open(path)
    const run = before.startRun({ type: "manual" }, 1_000, "/work/demo")
    const add = (input: Parameters<SqliteRoutineRepository["addArtifact"]>[0], at: number) => before.addArtifact(input, at).id
    const doc = { kind: "document" as const, producer: "agent" as const, directory: "/work/demo", path: ".flupcode/artifacts/report.md" }
    // Four copies of one document as the lazy pass left them, retitled once, one of them pinned.
    const copies = [
      add({ ...doc, title: "Report", content: "one" }, 1_000),
      add({ ...doc, title: "Report", content: "two", pinned: true }, 2_000),
      add({ ...doc, title: "Final report", content: "three" }, 3_000),
      add({ ...doc, title: "Final report", content: "three" }, 3_500),
    ]
    // The same file name in another project, and another kind at the same path, are other documents.
    const otherProject = add({ ...doc, directory: "/work/other", title: "Report", content: "one" }, 1_500)
    const plan = add({ ...doc, kind: "plan", title: "Report", content: "one" }, 1_600)
    // Rows with no path share titles across runs and are never grouped; one carries an expiry.
    const reports = [
      add({ kind: "report", title: "Run report", producer: "harness", content: "a", runID: run.id }, 4_000),
      add({ kind: "report", title: "Run report", producer: "harness", content: "b", expiresAt: 9_000 }, 5_000),
    ]
    before.db.exec(`
      DROP INDEX artifacts_logical;
      DROP INDEX artifacts_document;
      ALTER TABLE artifacts DROP COLUMN logical_id;
      ALTER TABLE artifacts DROP COLUMN version;
      ALTER TABLE artifacts DROP COLUMN message_id;
      DELETE FROM schema_version WHERE version >= 11;
    `)
    const snapshot = before.db.query("SELECT * FROM artifacts ORDER BY id").all()
    before.close()

    const repository = open(path)
    const [backup] = backupsOf(path)
    expect(backup).toMatch(/^harness\.sqlite\.bak-v10-/)
    expect(repository.db.query("SELECT version, name, backup FROM schema_version WHERE version = 11").all()).toEqual([
      { version: 11, name: "artifact-versions", backup: join(dirname(path), backup!) },
    ])
    // No row is lost or changed beyond its new columns, except a copy taking its document's pin.
    const after = repository.db
      .query("SELECT id, directory, run_id, task_id, session_id, kind, title, mime, content, path, bytes, truncated, hash, producer, pinned, expires_at, created_at FROM artifacts ORDER BY id")
      .all() as Array<Record<string, unknown>>
    expect(after).toEqual(
      (snapshot as Array<Record<string, unknown>>).map((row) => (copies.includes(row.id as string) ? { ...row, pinned: 1 } : row)),
    )
    const copy = new Database(join(dirname(path), backup!))
    expect(copy.query("SELECT * FROM artifacts ORDER BY id").all()).toEqual(snapshot)
    copy.close()

    // The copies are one document, oldest first; everything else is its own.
    expect(copies.map((id) => repository.getArtifact(id))).toEqual(
      copies.map((_, index) => expect.objectContaining({ logicalID: copies[0], version: index + 1, pinned: true })),
    )
    for (const id of [otherProject, plan, ...reports]) expect(repository.getArtifact(id)).toMatchObject({ logicalID: id, version: 1 })
    expect(repository.getArtifact(reports[1]!)?.expiresAt).toBe(9_000)
    expect(repository.listArtifacts({ directory: "/work/demo", kind: "document" })).toEqual([
      expect.objectContaining({ id: copies[3], version: 4, versions: 4 }),
    ])
    // The next rewrite continues the document.
    expect(repository.addArtifact({ ...doc, title: "Final report", content: "four" }, 6_000)).toMatchObject({
      logicalID: copies[0],
      version: 5,
    })
    repository.close()
  })
})
