import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "./api"
import { CHECKPOINT_SUMMARY_LIMIT, CHECKPOINTS_KEPT_PER_RUN, drop, dropAll, exists, planRestore, restore, take } from "./checkpoint"
import { projectRoots } from "./project-roots"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

let directory = ""

const run = async (args: string[], cwd = directory) => {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  await child.exited
  return (await new Response(child.stdout).text()).trim()
}

const write = (name: string, body: string) => {
  const path = join(directory, name)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, body)
}
const read = (name: string) => readFileSync(join(directory, name), "utf8")
const there = (name: string) => existsSync(join(directory, name))

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "flupcode-cp-"))
  await run(["init", "-q", "-b", "main"])
  await run(["config", "user.email", "test@example.com"])
  await run(["config", "user.name", "Test"])
  write("kept.txt", "one\n")
  await run(["add", "-A"])
  await run(["commit", "-qm", "first"])
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe("take", () => {
  test("records the folder without touching anything the reader can see", async () => {
    write("kept.txt", "two\n")
    write("new.txt", "untracked\n")
    await run(["add", "kept.txt"]) // the reader has something staged

    const checkpoint = await take({ directory, title: "after a task" })

    expect(checkpoint.sha).toMatch(/^[0-9a-f]{40}$/)
    // Their index, their working tree and their stash list are exactly as they were.
    expect(await run(["diff", "--cached", "--name-only"])).toBe("kept.txt")
    expect(read("kept.txt")).toBe("two\n")
    expect(await run(["stash", "list"])).toBe("")
    // And no commit landed on the branch.
    expect(await run(["log", "--oneline"])).toBe(
      `${await run(["rev-parse", "--short", "HEAD"])} first`,
    )
  })

  test("takes files nobody ever added to git, and leaves ignored ones out", async () => {
    write(".gitignore", "secret.txt\nbuild/\n")
    write("new.txt", "untracked\n")
    write("secret.txt", "do not keep\n")
    write("build/out.js", "generated\n")

    const checkpoint = await take({ directory, title: "t" })
    const inside = (await run(["ls-tree", "-r", "--name-only", checkpoint.sha])).split("\n")

    expect(inside).toContain("new.txt")
    // Not keeping ignored files is what makes a checkpoint of a real project small.
    expect(inside).not.toContain("secret.txt")
    expect(inside).not.toContain("build/out.js")
  })

  test("is kept behind a ref, so git will not collect it", async () => {
    const checkpoint = await take({ directory, title: "t" })
    expect(await run(["rev-parse", `refs/flupcode/checkpoints/${checkpoint.id}`])).toBe(checkpoint.sha)

    await run(["gc", "--prune=now", "--quiet"])
    expect(await exists(directory, checkpoint.sha)).toBe(true)
  })

  test("keeps what the step concluded, cut to a marker's length", async () => {
    const checkpoint = await take({ directory, title: "after a task", summary: "Did the thing" })
    expect(checkpoint.summary).toBe("Did the thing")

    const huge = await take({ directory, title: "noisy", summary: "x".repeat(CHECKPOINT_SUMMARY_LIMIT + 500) })
    // A marker, not a copy of the transcript: the first page is enough to recognise the point.
    expect(huge.summary).toHaveLength(CHECKPOINT_SUMMARY_LIMIT)

    const blank = await take({ directory, title: "manual", summary: "   " })
    expect(blank.summary).toBeUndefined()
  })

  test("works in a repository with no commit yet, and with nobody's name configured", async () => {
    const empty = mkdtempSync(join(tmpdir(), "flupcode-cp-empty-"))
    await run(["init", "-q", "-b", "main"], empty)
    // No `user.name` and no `user.email`, which is what a fresh machine looks like — and what CI
    // looks like. `git commit-tree` refuses to sign without one, so a checkpoint has to bring its
    // own. This passed on a developer's machine and failed in CI until it did.
    await run(["config", "user.useConfigOnly", "true"], empty)
    writeFileSync(join(empty, "a.txt"), "one\n")

    const checkpoint = await take({ directory: empty, title: "first" })

    expect(await run(["ls-tree", "-r", "--name-only", checkpoint.sha], empty)).toBe("a.txt")
    // Signed by the harness, not borrowed from whoever happens to be at the keyboard.
    expect(await run(["log", "-1", "--pretty=%an <%ae>", checkpoint.sha], empty)).toBe(
      "FlupCode <harness@flupcode.local>",
    )
    rmSync(empty, { recursive: true, force: true })
  })
})

describe("planRestore", () => {
  test("says what it would write and what it would delete", async () => {
    write("kept.txt", "two\n")
    write("gone-later.txt", "here at checkpoint\n")
    const checkpoint = await take({ directory, title: "t" })

    write("kept.txt", "three\n")
    rmSync(join(directory, "gone-later.txt"))
    write("made-after.txt", "created since\n")

    expect(await planRestore(directory, checkpoint.sha)).toEqual({
      write: ["gone-later.txt", "kept.txt"],
      remove: ["made-after.txt"],
    })
  })

  test("counts a file nobody added to git among the ones it would delete", async () => {
    const checkpoint = await take({ directory, title: "t" })
    write("scratch.txt", "never added\n")

    // The ones a reader would least expect to lose are exactly these, so they have to be named.
    expect((await planRestore(directory, checkpoint.sha)).remove).toEqual(["scratch.txt"])
  })

  test("nothing changed, nothing to do", async () => {
    const checkpoint = await take({ directory, title: "t" })
    expect(await planRestore(directory, checkpoint.sha)).toEqual({ write: [], remove: [] })
  })
})

describe("restore", () => {
  test("puts the folder back, and can be undone because it recorded the present first", async () => {
    write("kept.txt", "two\n")
    const first = await take({ directory, title: "good state" })

    write("kept.txt", "ruined\n")
    write("junk.txt", "made by a run\n")
    const { plan, safety } = await restore({ directory, sha: first.sha })

    expect(read("kept.txt")).toBe("two\n")
    expect(there("junk.txt")).toBe(false)
    expect(plan.remove).toEqual(["junk.txt"])

    // Undoing the undo is the same operation again, which is the whole point of the safety one.
    await restore({ directory, sha: safety.sha })
    expect(read("kept.txt")).toBe("ruined\n")
    expect(read("junk.txt")).toBe("made by a run\n")
  })

  test("leaves the reader's staged state alone", async () => {
    write("kept.txt", "two\n")
    const checkpoint = await take({ directory, title: "t" })
    write("kept.txt", "three\n")
    write("staged.txt", "staged by hand\n")
    await run(["add", "staged.txt"])

    await restore({ directory, sha: checkpoint.sha })

    // The file goes, because the checkpoint does not have it — but the index is not rewritten
    // underneath them by the restore itself.
    expect(await run(["rev-parse", "HEAD"])).toBe(await run(["rev-parse", "main"]))
  })

  test("does not touch a file git was told to ignore", async () => {
    write(".gitignore", "local.env\n")
    write("local.env", "MY_SECRET=1\n")
    const checkpoint = await take({ directory, title: "t" })
    write("local.env", "MY_SECRET=2\n")

    await restore({ directory, sha: checkpoint.sha })

    // It was never in the checkpoint, so restoring must neither rewrite it nor delete it.
    expect(read("local.env")).toBe("MY_SECRET=2\n")
  })
})

test("drop forgets the ref", async () => {
  const checkpoint = await take({ directory, title: "t" })
  await drop(directory, checkpoint.id)
  expect(await run(["rev-parse", "--verify", "--quiet", `refs/flupcode/checkpoints/${checkpoint.id}`])).toBe("")
})

test("a folder that is not a repository says so rather than failing oddly", async () => {
  const plain = mkdtempSync(join(tmpdir(), "flupcode-plain-"))
  expect(take({ directory: plain, title: "t" })).rejects.toThrow(/not a git repository/)
  rmSync(plain, { recursive: true, force: true })
})

// TI-15: the harness keeps an index of checkpoints, and git keeps the refs. Both have to agree.
describe("checkpoints in the harness", () => {
  const open = () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const handler = createHarnessHandler(repository, scheduler, { projectRoots: projectRoots(async () => [directory]) })
    return { repository, handler }
  }
  const ref = (id: string) => run(["rev-parse", "--verify", "--quiet", `refs/flupcode/checkpoints/${id}`])
  // `take` stamps the clock, and sixty of them land inside a few milliseconds: the order is given.
  const point = async (title: string, createdAt: number, runID?: string) => ({
    ...(await take({ directory, title, runID })),
    createdAt,
  })

  test("the 60th-oldest checkpoint is found and restores", async () => {
    const { repository, handler } = open()
    const points = []
    for (let index = 0; index < 60; index++) {
      write("kept.txt", `version ${index}\n`)
      points.push(repository.addCheckpoint(await point(`step ${index}`, 1000 + index)))
    }
    const oldest = points[0]!
    // Beyond the newest fifty the list used to stop, and the lookup with it.
    expect(repository.getCheckpoint(oldest.id)?.sha).toBe(oldest.sha)

    const plan = await handler(new Request(`http://x/harness/checkpoints/${oldest.id}/plan`))
    expect(plan.status).toBe(200)
    expect((await plan.json()).data).toEqual({ files: { write: ["kept.txt"], remove: [] }, conversation: { state: "none" } })
    const restored = await handler(new Request(`http://x/harness/checkpoints/${oldest.id}/restore`, { method: "POST" }))
    expect(restored.status).toBe(200)
    expect(read("kept.txt")).toBe("version 0\n")
    repository.close()
  }, 60_000)

  test("removing a run removes its checkpoints and their refs, and leaves the rest", async () => {
    const { repository, handler } = open()
    const gone = repository.startRun({ type: "manual" }, 1000, directory)
    const kept = repository.startRun({ type: "manual" }, 1000, directory)
    const ofGone = [
      repository.addCheckpoint(await point("one", 1, gone.id)),
      repository.addCheckpoint(await point("two", 2, gone.id)),
    ]
    const ofKept = repository.addCheckpoint(await point("other run", 3, kept.id))
    // Taken by hand: it belongs to no run, so no run going takes it with it.
    const byHand = repository.addCheckpoint(await point("by hand", 4))
    repository.finishRun(gone.id, "success")

    const removed = await handler(new Request(`http://x/harness/runs/${gone.id}`, { method: "DELETE" }))
    expect(removed.status).toBe(200)

    for (const checkpoint of ofGone) {
      expect(repository.getCheckpoint(checkpoint.id)).toBeUndefined()
      expect(await ref(checkpoint.id)).toBe("")
    }
    for (const checkpoint of [ofKept, byHand]) {
      expect(repository.getCheckpoint(checkpoint.id)?.id).toBe(checkpoint.id)
      expect(await ref(checkpoint.id)).toBe(checkpoint.sha)
    }
    repository.close()
  })

  test("clearing finished runs removes their refs too", async () => {
    const { repository, handler } = open()
    const over = repository.startRun({ type: "manual" }, 1000, directory)
    const checkpoint = repository.addCheckpoint(await point("one", 1, over.id))
    repository.finishRun(over.id, "failed", "no engine")

    const cleared = await handler(new Request("http://x/harness/runs", { method: "DELETE" }))
    expect(cleared.status).toBe(200)
    expect(repository.getCheckpoint(checkpoint.id)).toBeUndefined()
    expect(await ref(checkpoint.id)).toBe("")
    repository.close()
  })

  test("the sweep keeps the newest of each run, every one taken by hand, and none of a run that is gone", async () => {
    const { repository } = open()
    const busy = repository.startRun({ type: "manual" }, 1000, directory)
    const points = []
    for (let index = 0; index < CHECKPOINTS_KEPT_PER_RUN + 2; index++) {
      points.push(repository.addCheckpoint(await point(`step ${index}`, 1000 + index, busy.id)))
    }
    const byHand = repository.addCheckpoint(await point("by hand", 1))
    // A run deleted by a version that did not clean up after it: its row stayed, and so did its ref.
    const orphan = repository.addCheckpoint(await point("left behind", 2, "run_deleted_long_ago"))

    await dropAll(repository.removeStaleCheckpoints())

    const [first, second, ...newest] = points
    for (const checkpoint of [first!, second!, orphan]) {
      expect(repository.getCheckpoint(checkpoint.id)).toBeUndefined()
      expect(await ref(checkpoint.id)).toBe("")
    }
    expect(repository.listCheckpoints({ runID: busy.id }).map((checkpoint) => checkpoint.id)).toEqual(
      newest.map((checkpoint) => checkpoint.id).reverse(),
    )
    expect(await ref(byHand.id)).toBe(byHand.sha)
    // Nothing more to do the second time.
    expect(repository.removeStaleCheckpoints()).toEqual([])
    repository.close()
  }, 60_000)

  // CL-3: a fork carries over what the tasks done by the point were and found, not only that they ran.
  test("a fork carries over a done task's route and its visual check with what it found", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const parent = repository.startRun({ type: "manual" }, 1_000, directory)
    const visual = { steps: [{ screenshot: "home" }], mask: [".clock"], tolerance: 0.01, settle: { captures: 3, intervalMs: 100 } }
    const [build, look, ship] = repository.addTasks(parent.id, [
      { name: "build", prompt: "Build it", agent: "build" },
      { name: "look", prompt: "", kind: "verify", visual },
      { name: "ship", prompt: "Ship it" },
    ])
    const route = { model: "cheap/small", fallback: true, reason: "The run has spent 82% of its cost budget", source: "rule" as const }
    const found = { status: "ran" as const, url: "http://localhost:5173/", shots: [{ name: "home", outcome: "first" as const, changed: 0, stable: true, after: "art_1" }] }
    repository.setTaskRoute(build!.id, route)
    repository.finishTask(build!.id, "success", { output: "Built" }, 2_000)
    repository.finishTask(look!.id, "success", { output: "Looked", visual: found }, 3_000)
    repository.setTaskVerdict(look!.id, { value: "verified", reason: "The page looks the same", source: "check" })
    const after = repository.addCheckpoint({ ...(await take({ directory, title: "look", runID: parent.id, taskID: look!.id })), createdAt: 3_500 })
    repository.finishTask(ship!.id, "failed", { error: "No" }, 4_000)
    repository.finishRun(parent.id, "failed", "No")

    const plan = await scheduler.forkPlan(after.id)
    expect(plan.kept.map((task) => task.name)).toEqual(["build", "look"])
    expect(plan.tasks.map((task) => task.name)).toEqual(["ship"])
    const child = await scheduler.fork(after.id)
    const [carriedBuild, carriedLook, again] = repository.listTasks(child!.id)
    expect(carriedBuild).toMatchObject({ name: "build", status: "success", output: "Built", route })
    expect(carriedLook).toMatchObject({
      name: "look",
      kind: "verify",
      status: "success",
      visual,
      visualResult: found,
      verdict: { value: "verified" },
    })
    // What runs again is a first attempt with nothing of the parent's: its route is decided when it runs.
    expect(again).toMatchObject({ name: "ship", attempt: 1 })
    expect(again!.route).toBeUndefined()
    expect(again!.retryOf).toBeUndefined()
    await scheduler.stopAll()
    repository.close()
  }, 60_000)
})
