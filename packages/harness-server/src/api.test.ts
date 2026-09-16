import { afterAll, describe, expect, test } from "bun:test"
import { MAX_RETRIES, createHarnessHandler } from "./api"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
})
