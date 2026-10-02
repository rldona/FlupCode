import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { SqliteRoutineRepository } from "./repository"
import { TaskRunner } from "./runner"
import { handleUsageIngest, repositoryRoot, type SessionDescriber, type UsageEvent } from "./usage-ledger"
import type { RunWorkflow } from "./types"

const directories: string[] = []
const scratch = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "flupcode-attribution-")))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A priced step of a session, as the plugin or the reconciler reports it. */
const step = (sessionID: string, id = `${sessionID}:step`, extra: Partial<UsageEvent> = {}): UsageEvent => ({
  id,
  kind: "step",
  sessionID,
  tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  costUSD: 0.02,
  costBasis: "engine-list-price",
  billing: "metered",
  ...extra,
})

const workflow: RunWorkflow = { name: "feature", scope: "project", hash: "sha256-feature", inputs: {} }

const post = (repository: SqliteRoutineRepository, describe: SessionDescriber, events: UsageEvent[]) =>
  handleUsageIngest(
    new Request("http://127.0.0.1/harness/usage/events", { method: "POST", body: JSON.stringify({ events }) }),
    repository,
    describe,
  )

/** What the engine says of the sessions a test made up. */
const engineOf =
  (sessions: Record<string, { parentID?: string; directory?: string; createdAt?: number }>): SessionDescriber =>
  async (sessionID) => {
    const session = sessions[sessionID]
    if (!session) return undefined
    return { directory: session.directory ?? "/work/demo", title: "", createdAt: session.createdAt ?? Date.now(), ...(session.parentID ? { parentID: session.parentID } : {}) }
  }

const row = (repository: SqliteRoutineRepository, id: string) => repository.usageEvents(id.split(":")[0]!).find((event) => event.id === id)

describe("attribution (UL-04)", () => {
  test("a task's session is stamped with its run, task, attempt, routine and workflow", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const routine = repository.create({
      name: "nightly",
      description: "",
      prompt: "Check it",
      schedule: { type: "manual" },
      projectDirectory: "/work/demo",
    })
    const run = repository.startRun({ type: "routine", routineID: routine.id }, 1_000, "/work/demo", { workflow })
    const [task] = repository.addTasks(run.id, [{ name: "plan", prompt: "Plan it" }])
    repository.attachTaskSession(task!.id, "ses_task")
    repository.recordUsage({ events: [step("ses_task")], tools: [] })

    expect(repository.usageEvents("ses_task")[0]).toMatchObject({
      runID: run.id,
      taskID: task!.id,
      attempt: 1,
      routineID: routine.id,
      workflowName: "feature",
      workflowHash: "sha256-feature",
      purpose: "run-task",
      directory: "/work/demo",
    })
    repository.close()
  })

  test("the run's own thread is stamped with the run", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = repository.startRun({ type: "manual" }, 1_000, "/work/demo", { workflow })
    repository.attachSession(run.id, "ses_thread")
    repository.recordUsage({ events: [step("ses_thread")], tools: [] })
    expect(repository.usageEvents("ses_thread")[0]).toMatchObject({ runID: run.id, purpose: "run-task", workflowName: "feature" })
    expect(repository.usageEvents("ses_thread")[0]?.taskID).toBeUndefined()
    repository.close()
  })

  test("the runner stamps each task's session and its closing note's session", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    let sessions = 0
    const engine = {
      createSession: async () => ({ id: `ses_task_${++sessions}` }),
      prompt: async () => undefined,
      waitForIdle: async () => undefined,
      lastAnswer: async () => ({ text: "Done" }),
      // The real engine opens a session of its own for the note and says which, before prompting it.
      handoff: async (input: { task: string; onSession?: (sessionID: string) => void }) => {
        input.onSession?.(`ses_note_${input.task}`)
        return `Decided: ${input.task}`
      },
    } as never
    const run = repository.startRun({ type: "manual" }, 1_000, "/work/demo", { workflow })
    repository.addTasks(run.id, [
      { name: "one", prompt: "First" },
      { name: "two", prompt: "Second" },
    ])
    await new TaskRunner(repository, engine).execute(run, { directory: "/work/demo" })
    const tasks = repository.listTasks(run.id)
    repository.recordUsage({
      events: ["ses_task_1", "ses_task_2", "ses_note_one", "ses_note_two"].map((id) => step(id)),
      tools: [],
    })

    expect(repository.usageEvents("ses_task_2")[0]).toMatchObject({ runID: run.id, taskID: tasks[1]!.id, purpose: "run-task" })
    expect(repository.usageEvents("ses_note_one")[0]).toMatchObject({
      runID: run.id,
      taskID: tasks[0]!.id,
      attempt: 1,
      workflowName: "feature",
      purpose: "handoff",
    })
    expect(repository.usageEvents("ses_note_two")[0]).toMatchObject({ taskID: tasks[1]!.id, purpose: "handoff" })
    repository.close()
  })

  test("a subagent's session inherits its parent's attribution, however deep", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = repository.startRun({ type: "manual" }, 1_000, "/work/demo")
    const [task] = repository.addTasks(run.id, [{ name: "plan", prompt: "Plan it" }])
    repository.attachTaskSession(task!.id, "ses_task")
    const engine = engineOf({ ses_child: { parentID: "ses_task" }, ses_grandchild: { parentID: "ses_child" } })
    await post(repository, engine, [step("ses_grandchild"), step("ses_child")])

    for (const id of ["ses_child", "ses_grandchild"])
      expect(repository.usageEvents(id)[0]).toMatchObject({ runID: run.id, taskID: task!.id, purpose: "run-task" })
    repository.close()
  })

  test("a session nobody stamped, started after attribution existed, is a chat; its subagents too", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const engine = engineOf({ ses_chat: {}, ses_helper: { parentID: "ses_chat" } })
    await post(repository, engine, [step("ses_helper"), step("ses_chat")])
    expect(repository.usageEvents("ses_chat")[0]).toMatchObject({ purpose: "chat" })
    expect(repository.usageEvents("ses_helper")[0]).toMatchObject({ purpose: "chat" })
    expect(repository.usageEvents("ses_chat")[0]?.runID).toBeUndefined()
    repository.close()
  })

  test("a session from before attribution existed is not called a chat: nobody knows what it was", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    await post(repository, engineOf({ ses_old: { createdAt: 1_000 } }), [step("ses_old")])
    expect(repository.usageEvents("ses_old")[0]?.purpose).toBeUndefined()
    repository.close()
  })

  test("an engine that cannot be asked leaves the row unattributed, and the next event fills it", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = repository.startRun({ type: "manual" }, 1_000, "/work/demo")
    const [task] = repository.addTasks(run.id, [{ name: "plan", prompt: "Plan it" }])
    repository.attachTaskSession(task!.id, "ses_task")
    const down: SessionDescriber = async () => {
      throw new Error("engine down")
    }
    const response = await post(repository, down, [step("ses_child", "ses_child:1")])
    expect(response.status).toBe(200)
    expect(row(repository, "ses_child:1")?.runID).toBeUndefined()

    await post(repository, engineOf({ ses_child: { parentID: "ses_task" } }), [step("ses_child", "ses_child:2")])
    expect(repository.usageEvents("ses_child").map((event) => [event.id, event.runID])).toEqual([
      ["ses_child:1", run.id],
      ["ses_child:2", run.id],
    ])
    repository.close()
  })

  test("rows stored before their session was stamped are filled in, and nothing stamped is overwritten", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    repository.recordUsage({
      events: [
        step("ses_late", "ses_late:step"),
        step("ses_late", "ses_late:title", { kind: "title" }),
        step("ses_sub", "ses_sub:step", { parentSessionID: "ses_late" }),
      ],
      tools: [],
    })
    expect(row(repository, "ses_late:step")?.runID).toBeUndefined()
    expect(row(repository, "ses_late:title")?.purpose).toBe("title")

    const run = repository.startRun({ type: "manual" }, 1_000, "/work/demo")
    const [task] = repository.addTasks(run.id, [{ name: "plan", prompt: "Plan it" }])
    repository.attachTaskSession(task!.id, "ses_late")

    expect(row(repository, "ses_late:step")).toMatchObject({ runID: run.id, purpose: "run-task" })
    // The title call is billed to the run but stays labelled as what it was.
    expect(row(repository, "ses_late:title")).toMatchObject({ runID: run.id, purpose: "title" })
    expect(row(repository, "ses_sub:step")).toMatchObject({ runID: run.id, purpose: "run-task" })
    // The facts themselves are untouched.
    expect(row(repository, "ses_late:step")).toMatchObject({ costUSD: 0.02, tokens: { input: 10, output: 5 } })
    repository.close()
  })

  test("a commit message's session is labelled as one", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    repository.attributeSession("ses_commit", { purpose: "commit-message", directory: "/work/demo" })
    repository.recordUsage({ events: [step("ses_commit")], tools: [] })
    expect(repository.usageEvents("ses_commit")[0]).toMatchObject({ purpose: "commit-message", directory: "/work/demo" })
    expect(repository.usageEvents("ses_commit")[0]?.runID).toBeUndefined()
    repository.close()
  })

  test("a worktree resolves to the repository it belongs to", async () => {
    const root = scratch()
    const repo = join(root, "repo")
    mkdirSync(repo)
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "ignore" })
    git("init", "-q")
    writeFileSync(join(repo, "README.md"), "demo\n")
    git("add", ".")
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init")
    git("worktree", "add", "-q", join(root, "tree"))
    expect(repositoryRoot(join(root, "tree"))).toBe(repo)
    expect(repositoryRoot(repo)).toBe(repo)
    expect(repositoryRoot(join(root, "nowhere"))).toBe(join(root, "nowhere"))

    const repository = new SqliteRoutineRepository(":memory:")
    await post(repository, engineOf({ ses_tree: { directory: join(root, "tree") } }), [
      step("ses_tree", "ses_tree:1", { directory: join(root, "tree") }),
    ])
    expect(repository.usageEvents("ses_tree")[0]).toMatchObject({ directory: repo, purpose: "chat" })
    repository.close()
  })
})

describe("the attribution migration (UL-04)", () => {
  test("a populated database is backed up, its run sessions attributed and its ledger rows stamped", () => {
    const path = join(scratch(), "harness.sqlite")
    const before = new SqliteRoutineRepository(path)
    const run = before.startRun({ type: "manual" }, 1_000, "/work/demo", { workflow })
    const [task] = before.addTasks(run.id, [{ name: "plan", prompt: "Plan it" }])
    before.attachTaskSession(task!.id, "ses_task")
    before.attachSession(run.id, "ses_thread")
    // Back to before attribution, with a row the ledger took then.
    before.db.exec(`
      DELETE FROM schema_version WHERE version >= 7;
      DROP TABLE session_attribution;
      INSERT INTO usage_event (id, kind, session_id, cost_usd, cost_basis, billing)
        VALUES ('ses_task:step', 'step', 'ses_task', 0.02, 'engine-list-price', 'metered');
    `)
    expect(before.usageEvents("ses_task")[0]?.runID).toBeUndefined()
    before.close()

    const repository = new SqliteRoutineRepository(path)
    const backups = readdirSync(dirname(path)).filter((name) => name.includes(".bak-v"))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^harness\.sqlite\.bak-v\d+-/)
    expect(repository.db.query("SELECT version, name FROM schema_version WHERE version = 7").all()).toEqual([
      { version: 7, name: "usage-attribution" },
    ])
    expect(repository.usageEvents("ses_task")[0]).toMatchObject({ runID: run.id, taskID: task!.id, purpose: "run-task", workflowName: "feature" })
    repository.recordUsage({ events: [step("ses_thread")], tools: [] })
    expect(repository.usageEvents("ses_thread")[0]).toMatchObject({ runID: run.id })
    expect(repository.getRun(run.id)).toMatchObject({ id: run.id })
    const copy = new Database(join(dirname(path), backups[0]!))
    expect((copy.query("SELECT COUNT(*) AS count FROM usage_event").get() as { count: number }).count).toBe(1)
    copy.close()
    repository.close()
  })
})
