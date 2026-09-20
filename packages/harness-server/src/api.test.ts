import { afterAll, describe, expect, test } from "bun:test"
import { MAX_RETRIES, createHarnessHandler } from "./api"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

/**
 * Waits for a run the request only started.
 *
 * `POST /harness/runs` answers 202 and leaves the runner going, so a test that closes its database
 * straight after loses a race with the run's own last write — which is exactly how this test failed
 * in CI and passed on a faster machine.
 */
const settled = async (repository: SqliteRoutineRepository, runID: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (repository.getRun(runID)?.status === "running" && Date.now() < deadline) {
    await Bun.sleep(10)
  }
  expect(repository.getRun(runID)?.status).not.toBe("running")
}

const made: string[] = []
afterAll(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const input = {
  name: "Check CI",
  description: "",
  prompt: "Inspect CI failures",
  schedule: { type: "manual" },
}

// Always in memory. Constructed without a path the repository opens whatever database this machine
// actually uses, and a test run then writes its fixtures into somebody's real routines.
const open = () => {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return { repository, scheduler, handler: createHarnessHandler(repository, scheduler) }
}

describe("harness routines API", () => {
  test("creates, updates, toggles, and removes routines", async () => {
    const { repository, handler } = open()

    const created = await handler(
      new Request("http://localhost/harness/routines", { method: "POST", body: JSON.stringify(input) }),
    )
    expect(created.status).toBe(201)
    const routine = (await created.json()).data

    const updated = await handler(
      new Request(`http://localhost/harness/routines/${routine.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...input, name: "Updated CI" }),
      }),
    )
    expect((await updated.json()).data.name).toBe("Updated CI")

    const toggled = await handler(
      new Request(`http://localhost/harness/routines/${routine.id}/enabled`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
    )
    expect((await toggled.json()).data.enabled).toBe(false)

    const removed = await handler(new Request(`http://localhost/harness/routines/${routine.id}`, { method: "DELETE" }))
    expect(removed.status).toBe(200)
    repository.close()
  })
})

describe("harness runs API", () => {
  // A finished run can be forgotten, and its tasks go with it. The supervisor lists runs and knows
  // nothing about what started them, so the run's own id is all it takes.
  test("deletes a run and the tasks it was made of", async () => {
    const { repository, handler } = open()
    const run = repository.startRun({ type: "manual" }, Date.now())
    repository.addTasks(run.id, [{ name: "one", prompt: "do it" }])
    repository.finishRun(run.id, "success")

    const removed = await handler(new Request(`http://localhost/harness/runs/${run.id}`, { method: "DELETE" }))
    expect(removed.status).toBe(200)
    expect((await removed.json()).data).toBe(true)
    expect(repository.getRun(run.id)).toBeUndefined()
    expect(repository.listTasks(run.id)).toEqual([])

    const again = await handler(new Request(`http://localhost/harness/runs/${run.id}`, { method: "DELETE" }))
    expect(again.status).toBe(404)
    repository.close()
  })

  // Deleting a run the runner is still writing to would leave it writing into nothing, so the
  // answer is no until it has been stopped.
  test("refuses to delete a run that is still going", async () => {
    const { repository, handler } = open()
    const run = repository.startRun({ type: "manual" }, Date.now())

    const refused = await handler(new Request(`http://localhost/harness/runs/${run.id}`, { method: "DELETE" }))
    expect(refused.status).toBe(409)
    expect(repository.getRun(run.id)?.id).toBe(run.id)
    repository.close()
  })

  // Clearing the list clears what is over. A run still going is not history, so it stays.
  test("clears every finished run and leaves the running one", async () => {
    const { repository, handler } = open()
    const first = repository.startRun({ type: "manual" }, Date.now())
    repository.addTasks(first.id, [{ name: "one", prompt: "do it" }])
    repository.finishRun(first.id, "failed", "no engine")
    const second = repository.startRun({ type: "manual" }, Date.now())
    repository.finishRun(second.id, "success")
    const going = repository.startRun({ type: "manual" }, Date.now())

    const cleared = await handler(new Request("http://localhost/harness/runs", { method: "DELETE" }))
    expect(cleared.status).toBe(200)
    expect((await cleared.json()).data).toEqual({ removed: 2 })
    expect(repository.listRuns().map((run) => run.id)).toEqual([going.id])
    expect(repository.listTasks(first.id)).toEqual([])
    repository.close()
  })

  // One button for everything going at once, however many pages of history sit behind it.
  test("stops every run that is going", async () => {
    const { repository, handler } = open()
    const first = repository.startRun({ type: "manual" }, Date.now())
    const second = repository.startRun({ type: "manual" }, Date.now())
    const over = repository.startRun({ type: "manual" }, Date.now())
    repository.finishRun(over.id, "success")

    const stopped = await handler(new Request("http://localhost/harness/runs/stop", { method: "POST" }))
    expect(stopped.status).toBe(200)
    expect((await stopped.json()).data).toEqual({ stopped: 2 })
    // Neither had a session yet, so there was nothing for the engine to interrupt; both are marked.
    expect([first.id, second.id].every((id) => repository.getRun(id)?.id === id)).toBe(true)
    repository.close()
  })

  // Every retry is a model turn and another round of the project's commands, so a number typed by
  // mistake must not be able to spend an afternoon.
  test("caps how many attempts a failed check may ask for", async () => {
    const { repository, handler } = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-api-verify-"))
    made.push(directory)

    const started = await handler(
      new Request("http://localhost/harness/runs", {
        method: "POST",
        body: JSON.stringify({ tasks: [{ name: "verify", kind: "verify", retries: 99 }], directory }),
      }),
    )
    expect(started.status).toBe(202)
    const run = (await started.json()).data
    expect(repository.listTasks(run.id)[0]!.retries).toBe(MAX_RETRIES)
    // The run keeps going after the request answers: closing the database under it is what a server
    // being shut down mid-run looks like, and the writes it is about to make would throw.
    await settled(repository, run.id)
    repository.close()
  })

  // H-21: a workflow is a file that turns into a run of tasks. Everything after that is the path a
  // manual run already takes.
  test("starts a run from a workflow the project wrote down", async () => {
    const { repository, handler } = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-api-workflow-"))
    made.push(directory)
    // `listWorkflows` merges the shared templates in with the project's own, and it finds those
    // under `XDG_DATA_HOME`. Left alone, this test reads whoever is running it — on a machine that
    // has ever started the server, the four seeded templates are there and the list is not "the
    // project's". Point it somewhere empty so the assertion is about this folder.
    const shared = mkdtempSync(join(tmpdir(), "flupcode-api-shared-"))
    made.push(shared)
    const previousDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = shared
    mkdirSync(join(directory, ".flupcode", "workflows"), { recursive: true })
    writeFileSync(
      join(directory, ".flupcode", "workflows", "feature.yaml"),
      `name: feature
inputs: [goal]
tasks:
  - id: plan
    agent: plan
    prompt: "Plan {{goal}}"
  - id: verify
    kind: verify
    onFail: { max: 2 }
`,
    )

    const listed = await handler(
      new Request(`http://localhost/harness/workflows?directory=${encodeURIComponent(directory)}`),
    )
    expect((await listed.json()).data.map((entry: { name: string }) => entry.name)).toEqual(["feature"])

    const started = await handler(
      new Request("http://localhost/harness/workflows/feature/runs", {
        method: "POST",
        body: JSON.stringify({ inputs: { goal: "search" }, directory }),
      }),
    )
    expect(started.status).toBe(202)
    const run = (await started.json()).data
    // The file decided the tasks; the inputs are already in the prompt.
    expect(repository.listTasks(run.id).map((task) => `${task.name}:${task.kind}`)).toEqual([
      "plan:agent",
      "verify:verify",
    ])
    expect(repository.listTasks(run.id)[0]!.prompt).toBe("Plan search")
    expect(repository.listTasks(run.id)[1]!.retries).toBe(2)
    await settled(repository, run.id)
    repository.close()
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
  })

  test("says which input it is missing, and which workflow it has never heard of", async () => {
    const { repository, handler } = open()
    const directory = mkdtempSync(join(tmpdir(), "flupcode-api-workflow-"))
    made.push(directory)
    mkdirSync(join(directory, ".flupcode", "workflows"), { recursive: true })
    writeFileSync(
      join(directory, ".flupcode", "workflows", "feature.yaml"),
      "name: feature\ninputs: [goal]\ntasks:\n  - id: plan\n    prompt: \"Plan {{goal}}\"\n",
    )

    const empty = await handler(
      new Request("http://localhost/harness/workflows/feature/runs", {
        method: "POST",
        body: JSON.stringify({ inputs: { goal: "  " }, directory }),
      }),
    )
    expect(empty.status).toBe(400)
    expect((await empty.json()).error).toContain("goal")

    const missing = await handler(
      new Request("http://localhost/harness/workflows/nope/runs", {
        method: "POST",
        body: JSON.stringify({ directory }),
      }),
    )
    expect(missing.status).toBe(404)
    repository.close()
  })

  // Stopping answers for any run, not just a routine's: the supervisor has the run id and nothing else.
  test("stops a run by its own id", async () => {
    const { repository, handler } = open()
    const run = repository.startRun({ type: "manual" }, Date.now())

    const stopped = await handler(new Request(`http://localhost/harness/runs/${run.id}/stop`, { method: "POST" }))
    expect(stopped.status).toBe(200)
    expect((await stopped.json()).data.id).toBe(run.id)

    const missing = await handler(new Request("http://localhost/harness/runs/nope/stop", { method: "POST" }))
    expect(missing.status).toBe(404)
    repository.close()
  })
})

describe("harness git API", () => {
  /** A throwaway repository, because every one of these writes. */
  const repo = async () => {
    const directory = mkdtempSync(join(tmpdir(), "flupcode-api-git-"))
    made.push(directory)
    const run = async (args: string[]) => {
      const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
      await child.exited
      return (await new Response(child.stdout).text()).trim()
    }
    await run(["init", "-q", "-b", "main"])
    await run(["config", "user.email", "test@example.com"])
    await run(["config", "user.name", "Test"])
    writeFileSync(join(directory, "a.txt"), "one\n")
    await run(["add", "-A"])
    await run(["commit", "-qm", "first"])
    return { directory, run }
  }

  const post = (handler: ReturnType<typeof createHarnessHandler>, path: string, body: unknown) =>
    handler(new Request(`http://x/harness/git/${path}`, { method: "POST", body: JSON.stringify(body) }))

  test("commits what the reader picked, and says what it made", async () => {
    const { handler, repository } = open()
    const { directory, run } = await repo()
    writeFileSync(join(directory, "a.txt"), "two\n")
    writeFileSync(join(directory, "b.txt"), "new\n")

    const response = await post(handler, "commit", { directory, message: "only a", paths: ["a.txt"] })
    const body = (await response.json()) as { data: { sha: string; subject: string; branch: string } }

    expect(response.status).toBe(200)
    expect(body.data.subject).toBe("only a")
    expect(body.data.branch).toBe("main")
    expect(await run(["show", "--name-only", "--pretty=", "HEAD"])).toBe("a.txt")
    expect(await run(["status", "--porcelain"])).toContain("b.txt")
    repository.close()
  })

  test("answers 409 for a path that is no longer changed, and 400 without a folder", async () => {
    const { handler, repository } = open()
    const { directory } = await repo()

    const stale = await post(handler, "commit", { directory, message: "m", paths: ["a.txt"] })
    expect(stale.status).toBe(409)

    const nowhere = await post(handler, "commit", { message: "m", paths: ["a.txt"] })
    expect(nowhere.status).toBe(400)
    expect((await nowhere.json()) as { error: string }).toEqual({ error: "A folder is required" })
    repository.close()
  })

  test("starts a branch, reads it back, and refuses to take one that exists", async () => {
    const { handler, repository } = open()
    const { directory } = await repo()

    const made = await post(handler, "branch", { directory, name: "feature/x" })
    expect(await made.json()).toEqual({ data: { branch: "feature/x" } })

    const read = await handler(new Request(`http://x/harness/git/branch?directory=${encodeURIComponent(directory)}`))
    expect(await read.json()).toEqual({ data: { branch: "feature/x" } })

    expect((await post(handler, "branch", { directory, name: "main" })).status).toBe(409)
    repository.close()
  })

  test("commits only the hunk that was picked", async () => {
    const { handler, repository } = open()
    const { directory, run } = await repo()
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    writeFileSync(join(directory, "many.txt"), `${lines.join("\n")}\n`)
    await run(["add", "-A"])
    await run(["commit", "-qm", "add many"])
    writeFileSync(join(directory, "many.txt"), [`CHANGED 1`, ...lines.slice(1, 19), `CHANGED 20`].join("\n") + "\n")

    const response = await post(handler, "commit", {
      directory,
      message: "one hunk",
      paths: ["many.txt"],
      hunks: { "many.txt": [0] },
    })

    expect(response.status).toBe(200)
    const committed = await run(["show", "--pretty=", "HEAD"])
    expect(committed).toContain("CHANGED 1")
    expect(committed).not.toContain("CHANGED 20")
    repository.close()
  })

  test("discards a change, and says when there is none to discard", async () => {
    const { handler, repository } = open()
    const { directory } = await repo()
    writeFileSync(join(directory, "a.txt"), "two\n")

    const discarded = await post(handler, "discard", { directory, path: "a.txt" })
    expect(discarded.status).toBe(200)
    expect(readFileSync(join(directory, "a.txt"), "utf8")).toBe("one\n")

    expect((await post(handler, "discard", { directory, path: "a.txt" })).status).toBe(409)
    expect((await post(handler, "discard", { directory })).status).toBe(400)
    repository.close()
  })

  test("refuses to generate a message with nothing picked, before it reaches the engine", async () => {
    const { handler, repository } = open()
    const { directory } = await repo()
    expect((await post(handler, "message", { directory, paths: [] })).status).toBe(400)
    // A path git does not report as changed never gets as far as a model call either.
    expect((await post(handler, "message", { directory, paths: ["a.txt"] })).status).toBe(409)
    repository.close()
  })
})

describe("harness usage API", () => {
  test("adds up the tasks the runs actually recorded, retries apart", async () => {
    const { handler, repository } = open()
    const run = repository.startRun({ type: "manual" }, 1_000, "/work/app")
    repository.addTasks(run.id, [
      { name: "write", prompt: "p", agent: "build", model: { providerID: "anthropic", id: "opus" } },
      { name: "write", prompt: "p", agent: "build", model: { providerID: "anthropic", id: "opus" }, attempt: 2 },
      { name: "verify", prompt: "", kind: "verify" },
    ])
    const tasks = repository.listTasks(run.id)
    repository.startTask(tasks[0]!.id, 1_000)
    repository.finishTask(tasks[0]!.id, "success", { tokens: 100, cost: 0.5 })
    repository.startTask(tasks[1]!.id, 2_000)
    repository.finishTask(tasks[1]!.id, "success", { tokens: 80, cost: 0.4 })

    const response = await handler(new Request("http://x/harness/usage"))
    const report = (await response.json()).data

    expect(report.totals).toMatchObject({ runs: 1, tasks: 3, tokens: 180 })
    expect(report.totals.cost).toBeCloseTo(0.9, 5)
    // The second attempt is a second bill, and it is the number nobody could see before.
    expect(report.retries).toMatchObject({ tasks: 1, tokens: 80 })
    expect(report.retries.cost).toBeCloseTo(0.4, 5)
    // The verify task ran no model, so it is filed under none.
    expect(report.byModel).toHaveLength(1)
    expect(report.byModel[0].key).toBe("anthropic/opus")
    expect(report.byProject[0]).toMatchObject({ key: "/work/app", runs: 1 })
    repository.close()
  })

  test("a folder filter answers about that folder alone", async () => {
    const { handler, repository } = open()
    for (const directory of ["/work/a", "/work/b"]) {
      const run = repository.startRun({ type: "manual" }, 1_000, directory)
      repository.addTasks(run.id, [{ name: "t", prompt: "p", agent: "build" }])
      const task = repository.listTasks(run.id)[0]!
      repository.startTask(task.id, 1_000)
      repository.finishTask(task.id, "success", { tokens: 10, cost: 0.1 })
    }

    const response = await handler(new Request(`http://x/harness/usage?directory=${encodeURIComponent("/work/a")}`))
    const report = (await response.json()).data

    expect(report.totals.tasks).toBe(1)
    expect(report.byProject.map((entry: { key: string }) => entry.key)).toEqual(["/work/a"])
    repository.close()
  })
})

// The one part of the context the engine cannot report: FlupCode's own engine plugin records it as
// the request goes out, and these are the two ways that can go wrong from a browser's point of view.
describe("the captured system prompt", () => {
  test("answers with what the plugin recorded for that session, newest first", async () => {
    const shared = mkdtempSync(join(tmpdir(), "flupcode-api-prompts-"))
    made.push(shared)
    const previous = process.env.FLUPCODE_SYSTEM_PROMPTS_DIR
    process.env.FLUPCODE_SYSTEM_PROMPTS_DIR = shared
    mkdirSync(join(shared, "ses_abc"), { recursive: true })
    for (const [name, text] of [
      ["1700000000000-a.json", "first"],
      ["1700000000005-b.json", "second"],
    ]) {
      writeFileSync(
        join(shared, "ses_abc", name!),
        JSON.stringify({ at: Number(name!.slice(0, 13)), providerID: "deepseek", modelID: "flash", system: [text!] }),
      )
    }

    const { handler, repository } = open()
    const response = await handler(new Request("http://x/harness/context/system-prompt?sessionID=ses_abc"))
    const prompts = (await response.json()).data
    expect(prompts.map((prompt: { system: string[] }) => prompt.system[0])).toEqual(["second", "first"])
    expect(prompts[0].modelID).toBe("flash")
    repository.close()
    if (previous === undefined) delete process.env.FLUPCODE_SYSTEM_PROMPTS_DIR
    else process.env.FLUPCODE_SYSTEM_PROMPTS_DIR = previous
  })

  test("asks for a session, and does not go looking outside the folder it keeps them in", async () => {
    const { handler, repository } = open()
    const missing = await handler(new Request("http://x/harness/context/system-prompt"))
    expect(missing.status).toBe(400)
    const escape = await handler(new Request("http://x/harness/context/system-prompt?sessionID=../../etc"))
    expect((await escape.json()).data).toEqual([])
    repository.close()
  })
})

// Which tools a session ran. The engine reports no list of what an MCP server offers, so this is what
// its plugin could see: the calls themselves.
describe("the tools a session ran", () => {
  test("answers with what the plugin recorded, and nothing for a session it has not seen", async () => {
    const shared = mkdtempSync(join(tmpdir(), "flupcode-api-uses-"))
    made.push(shared)
    const previous = process.env.FLUPCODE_TOOL_USES_DIR
    process.env.FLUPCODE_TOOL_USES_DIR = shared
    writeFileSync(
      join(shared, "ses_abc.json"),
      JSON.stringify({ at: 5, tools: { bash: { count: 2, last: 1_700_000_000_000 } } }),
    )

    const { handler, repository } = open()
    const response = await handler(new Request("http://x/harness/context/tool-uses?sessionID=ses_abc"))
    expect((await response.json()).data.tools).toEqual({ bash: { count: 2, last: 1_700_000_000_000 } })

    const unknown = await handler(new Request("http://x/harness/context/tool-uses?sessionID=ses_missing"))
    expect((await unknown.json()).data.tools).toEqual({})
    const missing = await handler(new Request("http://x/harness/context/tool-uses"))
    expect(missing.status).toBe(400)
    repository.close()
    if (previous === undefined) delete process.env.FLUPCODE_TOOL_USES_DIR
    else process.env.FLUPCODE_TOOL_USES_DIR = previous
  })

  test("what each task spent its time on is read through the session it ran in (H-16)", async () => {
    const shared = mkdtempSync(join(tmpdir(), "flupcode-api-task-tools-"))
    made.push(shared)
    const previous = process.env.FLUPCODE_TOOL_USES_DIR
    process.env.FLUPCODE_TOOL_USES_DIR = shared
    writeFileSync(
      join(shared, "ses_task.json"),
      JSON.stringify({
        at: 5,
        tools: { bash: { count: 1, last: 1_700_000_000_000 } },
        calls: [{ tool: "bash", ms: 12 }],
      }),
    )

    const { handler, repository } = open()
    const run = repository.startRun({ type: "manual" }, 1000)
    const [task] = repository.addTasks(run.id, [{ name: "do it", prompt: "x" }])
    repository.attachTaskSession(task!.id, "ses_task")

    const response = await handler(new Request(`http://x/harness/runs/${run.id}/tools`))
    expect((await response.json()).data).toEqual([
      { taskID: task!.id, name: "do it", calls: [{ tool: "bash", ms: 12 }] },
    ])

    const missing = await handler(new Request("http://x/harness/runs/nope/tools"))
    expect(missing.status).toBe(404)
    repository.close()
    if (previous === undefined) delete process.env.FLUPCODE_TOOL_USES_DIR
    else process.env.FLUPCODE_TOOL_USES_DIR = previous
  })
})

describe("doing a task again (H-12)", () => {
  test("a retry is a new task of the same run, which is reopened to pick it up", async () => {
    const { handler, repository } = open()
    const run = repository.startRun({ type: "manual" }, 1000)
    const [task] = repository.addTasks(run.id, [{ name: "do it", prompt: "x" }])
    repository.finishRun(run.id, "failed", "the check failed", 2000)

    const response = await handler(new Request(`http://x/harness/tasks/${task!.id}/retry`, { method: "POST" }))
    expect(response.status).toBe(202)
    const created = (await response.json()).data
    expect(created).toMatchObject({ name: "do it", attempt: 2, retryOf: task!.id, status: "queued" })
    // The run was finished; it is open again so the new task is actually run.
    expect(repository.getRun(run.id)?.status).toBe("running")
    await settled(repository, run.id)

    const missing = await handler(new Request("http://x/harness/tasks/nope/retry", { method: "POST" }))
    expect(missing.status).toBe(404)
    repository.close()
  })

  test("a run waiting at a gate refuses a retry, saying why", async () => {
    const { handler, repository } = open()
    const run = repository.startRun({ type: "manual" }, 1000)
    const [task] = repository.addTasks(run.id, [{ name: "do it", prompt: "x" }])
    repository.awaitRun(run.id)

    const response = await handler(new Request(`http://x/harness/tasks/${task!.id}/retry`, { method: "POST" }))
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/approve or stop/i)
    repository.close()
  })
})

describe("what a reader keeps about a session (H-18)", () => {
  const json = { "content-type": "application/json" }

  test("a session can be pinned and tagged, and the two do not clobber each other", async () => {
    const { handler, repository } = open()
    const patch = (body: unknown) =>
      handler(
        new Request("http://x/harness/session-prefs/ses_a", { method: "PATCH", headers: json, body: JSON.stringify(body) }),
      )

    expect((await (await patch({ pinned: true })).json()).data).toMatchObject({ sessionID: "ses_a", pinned: true })
    // The same tag twice is one tag.
    expect((await (await patch({ tags: ["work", "work"] })).json()).data).toMatchObject({
      pinned: true,
      tags: ["work"],
    })

    const list = await handler(new Request("http://x/harness/session-prefs"))
    expect((await list.json()).data).toHaveLength(1)
    repository.close()
  })

  test("a prompt can be stashed, listed and removed", async () => {
    const { handler, repository } = open()
    const created = await handler(
      new Request("http://x/harness/stash", { method: "POST", headers: json, body: JSON.stringify({ text: "later" }) }),
    )
    expect(created.status).toBe(201)
    const prompt = (await created.json()).data

    expect((await (await handler(new Request("http://x/harness/stash"))).json()).data).toEqual([prompt])

    const blank = await handler(
      new Request("http://x/harness/stash", { method: "POST", headers: json, body: JSON.stringify({ text: "   " }) }),
    )
    expect(blank.status).toBe(400)

    const removed = await handler(new Request(`http://x/harness/stash/${prompt.id}`, { method: "DELETE" }))
    expect(removed.status).toBe(200)
    repository.close()
  })
})

describe("health", () => {
  test("says what the server can answer, so a newer client does not ask for what is not here", async () => {
    const { handler, repository } = open()
    const response = await handler(new Request("http://x/harness/health"))
    expect(await response.json()).toMatchObject({
      healthy: true,
      capabilities: expect.arrayContaining(["session-prefs", "stash"]),
    })
    repository.close()
  })
})

describe("harness commands API", () => {
  test("writes, lists and removes a command file, and refuses a name that would escape", async () => {
    const { handler, repository } = open()
    const root = mkdtempSync(join(tmpdir(), "flupcode-cmd-api-"))
    made.push(root)
    const config = join(root, "config")
    const project = join(root, "project")
    mkdirSync(config, { recursive: true })
    mkdirSync(project, { recursive: true })
    const savedConfig = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = config

    try {
      const written = await handler(
        new Request("http://x/harness/commands", {
          method: "POST",
          body: JSON.stringify({
            name: "git/release",
            scope: "project",
            fields: { description: "Cut a release" },
            template: "Release it.",
            directory: project,
            project,
          }),
        }),
      )
      expect(written.status).toBe(200)
      const path = (await written.json()).data.path
      expect(path).toBe(join(project, ".opencode", "command", "git", "release.md"))

      const listed = await handler(
        new Request(
          `http://x/harness/commands?directory=${encodeURIComponent(project)}&project=${encodeURIComponent(project)}`,
        ),
      )
      expect((await listed.json()).data).toEqual([
        expect.objectContaining({ name: "git/release", template: "Release it." }),
      ])

      const refused = await handler(
        new Request("http://x/harness/commands", {
          method: "POST",
          body: JSON.stringify({ name: "../escape", scope: "project", directory: project, project }),
        }),
      )
      expect(refused.status).toBe(400)

      const removed = await handler(
        new Request(
          `http://x/harness/commands?path=${encodeURIComponent(path)}&directory=${encodeURIComponent(project)}&project=${encodeURIComponent(project)}`,
          { method: "DELETE" },
        ),
      )
      expect((await removed.json()).data.removed).toBe(true)
    } finally {
      if (savedConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = savedConfig
      repository.close()
    }
  })
})

describe("harness context packs API", () => {
  test("saves, lists and removes a pack, and asks for a name and a reference", async () => {
    const { handler, repository } = open()

    const saved = await handler(
      new Request("http://x/harness/packs", {
        method: "POST",
        body: JSON.stringify({ name: "review", refs: ["@src/a.ts"], directory: "/work/demo" }),
      }),
    )
    expect(saved.status).toBe(201)
    const pack = (await saved.json()).data

    const listed = await handler(
      new Request(`http://x/harness/packs?directory=${encodeURIComponent("/work/demo")}`),
    )
    expect((await listed.json()).data).toEqual([expect.objectContaining({ name: "review", refs: ["@src/a.ts"] })])

    expect(
      (
        await handler(new Request("http://x/harness/packs", { method: "POST", body: JSON.stringify({ name: "" }) }))
      ).status,
    ).toBe(400)
    expect(
      (
        await handler(
          new Request("http://x/harness/packs", {
            method: "POST",
            body: JSON.stringify({ name: "empty", refs: [] }),
          }),
        )
      ).status,
    ).toBe(400)

    expect((await handler(new Request(`http://x/harness/packs/${pack.id}`, { method: "DELETE" }))).status).toBe(200)
    expect((await handler(new Request(`http://x/harness/packs/${pack.id}`, { method: "DELETE" }))).status).toBe(404)
    repository.close()
  })
})

describe("harness files API", () => {
  test("reads a file inside the folder and refuses one outside it", async () => {
    const { handler, repository } = open()
    const root = mkdtempSync(join(tmpdir(), "flupcode-files-api-"))
    made.push(root)
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")

    const read = await handler(
      new Request(
        `http://x/harness/files/read?directory=${encodeURIComponent(root)}&path=${encodeURIComponent("src/a.ts")}`,
      ),
    )
    expect(await read.json()).toEqual({
      data: { path: "src/a.ts", content: "export const a = 1\n", bytes: 19, truncated: false, binary: false },
    })

    const outside = await handler(
      new Request(
        `http://x/harness/files/read?directory=${encodeURIComponent(root)}&path=${encodeURIComponent("../escape")}`,
      ),
    )
    expect(outside.status).toBe(400)

    const noFolder = await handler(new Request("http://x/harness/files/read?path=a.ts"))
    expect(noFolder.status).toBe(400)
    repository.close()
  })
})

describe("harness runs API", () => {
  test("a run remembers the context packs it was started with", async () => {
    const { handler, repository } = open()
    const started = await handler(
      new Request("http://x/harness/runs", {
        method: "POST",
        body: JSON.stringify({ tasks: [{ name: "one", prompt: "go" }], packs: ["ctx", "notes"] }),
      }),
    )
    const run = (await started.json()).data
    expect(run.packs).toEqual(["ctx", "notes"])
    await settled(repository, run.id)
    repository.close()
  })
})

describe("harness worktree API", () => {
  test("cleans up a run's worktrees through the engine, and leaves the folder alone", async () => {
    const { handler, repository, scheduler } = open()
    const removed: string[] = []
    Object.assign(scheduler, {
      engine: { removeWorktree: async (input: { directory: string }) => void removed.push(input.directory) },
    })

    const run = repository.startRun({ type: "manual" }, 1000, "/work/demo")
    repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    const task = repository.listTasks(run.id)[0]!
    repository.attachTaskDirectory(task.id, "/work/.flupcode/wt/build")

    const response = await handler(new Request(`http://x/harness/runs/${run.id}/worktrees/cleanup`, { method: "POST" }))
    expect(await response.json()).toEqual({ data: { removed: ["/work/.flupcode/wt/build"] } })
    expect(removed).toEqual(["/work/.flupcode/wt/build"])
    repository.close()
  })
})

describe("harness run policy API", () => {
  test("a run keeps the policy it was started with, and drops what it cannot read", async () => {
    const { handler, repository } = open()
    const started = await handler(
      new Request("http://x/harness/runs", {
        method: "POST",
        body: JSON.stringify({
          tasks: [{ name: "one", prompt: "go" }],
          policy: { models: { build: "a/b" }, fallback: "a/c", budget: { tokens: 100 } },
        }),
      }),
    )
    const run = (await started.json()).data
    expect(run.policy).toEqual({ models: { build: "a/b" }, fallback: "a/c", budget: { tokens: 100 } })
    await settled(repository, run.id)

    // A budget that is not a number is not a budget, so nothing is enforced.
    const garbage = await handler(
      new Request("http://x/harness/runs", {
        method: "POST",
        body: JSON.stringify({ tasks: [{ name: "one", prompt: "go" }], policy: { budget: { tokens: -5 } } }),
      }),
    )
    const clean = (await garbage.json()).data
    expect(clean.policy).toBeUndefined()
    await settled(repository, clean.id)
    repository.close()
  })
})

describe("harness shares API", () => {
  test("keeps a conversation and serves it at its link", async () => {
    const { handler, repository } = open()

    const created = await handler(
      new Request("http://x/harness/shares", {
        method: "POST",
        body: JSON.stringify({ title: "Fix login", markdown: "# Fix login\n" }),
      }),
    )
    expect(created.status).toBe(201)
    const share = (await created.json()).data
    expect(share.url).toBe(`/harness/shares/${share.id}`)

    const read = await handler(new Request(`http://x${share.url}`))
    expect(read.headers.get("content-type")).toContain("text/markdown")
    expect(await read.text()).toBe("# Fix login\n")

    expect(
      (await handler(new Request("http://x/harness/shares", { method: "POST", body: JSON.stringify({ title: "x" }) })))
        .status,
    ).toBe(400)
    expect((await handler(new Request("http://x/harness/shares/nope"))).status).toBe(404)
    repository.close()
  })
})
