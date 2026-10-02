import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "./api"
import { Engine, NeedsPerson, type PendingRequest } from "./engine"
import { SqliteRoutineRepository } from "./repository"
import { TaskRunner } from "./runner"
import { RoutineScheduler } from "./scheduler"
import { parseWorkflow } from "./workflow"
import type { RunSource } from "./types"

/**
 * A task whose session waits on a person (RP-05), on a stand-in for the engine.
 *
 * What is stubbed is what `Engine` asks the engine — whether the session is busy, what it waits on,
 * the refusal and the interrupt — and what runs is the real wait, the real runner and the real store.
 * The same flows against the pinned engine are in `unattended.engine.test.ts`.
 */
class Stub extends Engine {
  interrupted = 0
  refused: Array<{ request: PendingRequest; message: string }> = []
  asked = 0

  constructor(
    private readonly script: {
      busy: () => boolean
      pending?: () => PendingRequest | undefined
    },
  ) {
    super("http://127.0.0.1:1")
  }

  override async createSession() {
    return { id: "ses_task" }
  }

  override async prompt() {}

  override async isBusy() {
    return this.script.busy()
  }

  override async pendingRequest() {
    this.asked++
    return this.script.pending?.()
  }

  override async refuseRequest(request: PendingRequest, message: string) {
    this.refused.push({ request, message })
  }

  override async interrupt() {
    this.interrupted++
  }

  override async lastAnswer() {
    return { text: "Edited the file", tokens: undefined, cost: 0 }
  }
}

const fast = { pollMs: 5, checkEveryMs: 5, settleMs: 20 }
const manual: RunSource = { type: "manual" }
const edit: PendingRequest = {
  kind: "permission",
  id: "per_1",
  sessionID: "ses_task",
  action: "edit",
  resources: ["src/app.ts"],
}
const planExit: PendingRequest = {
  kind: "form",
  id: "frm_1",
  sessionID: "ses_task",
  title: "The plan is complete. Would you like to switch to the build agent and start implementing?",
}

/** The runner's wait, at test speed: the runner passes the run's options and these are added. */
const quick = (engine: Stub) => {
  const wait = engine.waitForIdle.bind(engine)
  engine.waitForIdle = (sessionID, options = {}) => wait(sessionID, { ...options, ...fast })
  return engine
}

describe("the wait on a turn, when the session asks a person (RP-05)", () => {
  test("deny refuses the request, stops the turn and fails with the tool it needed", async () => {
    const engine = new Stub({ busy: () => true, pending: () => edit })
    const failure = await engine.waitForIdle("ses_task", { ...fast, unattended: "deny" }).catch((cause) => cause)
    expect(failure).toBeInstanceOf(NeedsPerson)
    expect((failure as Error).message).toBe(
      "Needed approval to use `edit` on src/app.ts, and this run fails a task that needs a person",
    )
    expect(engine.refused.map((entry) => entry.request.id)).toEqual(["per_1"])
    expect(engine.interrupted).toBe(1)
  })

  test("deny names the question a form asked", async () => {
    const engine = new Stub({ busy: () => true, pending: () => planExit })
    const failure = await engine.waitForIdle("ses_task", { ...fast, unattended: "deny" }).catch((cause) => cause)
    expect((failure as Error).message).toStartWith('Asked "The plan is complete.')
    expect(engine.refused.map((entry) => entry.request.kind)).toEqual(["form"])
  })

  test("gate says when the wait starts and ends, and the time waited is not the turn's", async () => {
    const started = Date.now()
    // Waits on a person for longer than the turn's whole timeout, then finishes.
    const engine = new Stub({
      busy: () => Date.now() - started < 400,
      pending: () => (Date.now() - started < 300 ? edit : undefined),
    })
    const seen: Array<string | undefined> = []
    await engine.waitForIdle("ses_task", {
      ...fast,
      timeoutMs: 150,
      unattended: "gate",
      onWaiting: (request) => seen.push(request?.id),
    })
    expect(seen).toEqual(["per_1", undefined])
    expect(engine.interrupted).toBe(0)
    expect(engine.refused).toEqual([])
  })

  test("a wait that was not told what to do does not ask the engine what it waits on", async () => {
    let polls = 0
    const engine = new Stub({ busy: () => ++polls < 5, pending: () => edit })
    await engine.waitForIdle("ses_task", fast)
    expect(engine.asked).toBe(0)
  })
})

describe("a run's task that needs a person (RP-05)", () => {
  test("deny fails the task within the wait, with the request as its error and its verdict", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = repository.startRun(manual, 1000, undefined, { policy: { unattended: "deny" } })
    repository.addTasks(run.id, [
      { name: "edit", prompt: "Change the file" },
      { name: "after", prompt: "Then this", dependsOn: ["edit"] },
    ])
    const engine = quick(new Stub({ busy: () => true, pending: () => edit }))
    await expect(new TaskRunner(repository, engine).execute(run)).rejects.toThrow("`edit`")

    const [task, after] = repository.listTasks(run.id)
    expect(task).toMatchObject({
      status: "failed",
      error: "Needed approval to use `edit` on src/app.ts, and this run fails a task that needs a person",
      // Failed, and judged as needing the user: only a person can give what it asked for.
      verdict: {
        value: "needs-user",
        reason: "Needed approval to use `edit` on src/app.ts, and this run fails a task that needs a person",
      },
    })
    expect(after!.status).toBe("queued")
    // It never held the run: there was nobody to hold it for.
    expect(repository.getRun(run.id)?.paused).toBeUndefined()
    repository.close()
  })

  test("gate holds the run as awaiting while the request waits, and lets it go once answered", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [{ name: "edit", prompt: "Change the file" }])
    let answered = false
    const engine = quick(new Stub({ busy: () => !answered, pending: () => (answered ? undefined : edit) }))
    const going = new TaskRunner(repository, engine).execute(run)

    const deadline = Date.now() + 2000
    while (repository.getRun(run.id)?.status !== "awaiting" && Date.now() < deadline) await Bun.sleep(5)
    expect(repository.getRun(run.id)).toMatchObject({ status: "awaiting", paused: "request" })
    expect(repository.listTasks(run.id)[0]!.status).toBe("running")
    answered = true
    expect(await going).toBe("done")

    expect(repository.getRun(run.id)?.status).toBe("running")
    expect(repository.getRun(run.id)?.paused).toBeUndefined()
    expect(repository.listTasks(run.id)[0]).toMatchObject({ status: "success", output: "Edited the file" })
    repository.close()
  })

  test("the project's default applies to a run that does not say, and a run that says wins", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    repository.setProjectUnattended("/work/demo", "deny")
    const engine = quick(new Stub({ busy: () => true, pending: () => edit }))

    const plain = repository.startRun(manual, 1000, "/work/demo")
    repository.addTasks(plain.id, [{ name: "edit", prompt: "Change the file" }])
    await expect(new TaskRunner(repository, engine).execute(plain, { directory: "/work/demo" })).rejects.toThrow(
      "this run fails a task that needs a person",
    )

    let answered = false
    const gated = quick(new Stub({ busy: () => !answered, pending: () => (answered ? undefined : edit) }))
    const declared = repository.startRun(manual, 2000, "/work/demo", { policy: { unattended: "gate" } })
    repository.addTasks(declared.id, [{ name: "edit", prompt: "Change the file" }])
    const going = new TaskRunner(repository, gated).execute(declared, { directory: "/work/demo" })
    const deadline = Date.now() + 2000
    while (repository.getRun(declared.id)?.status !== "awaiting" && Date.now() < deadline) await Bun.sleep(5)
    expect(repository.getRun(declared.id)?.paused).toBe("request")
    answered = true
    expect(await going).toBe("done")
    repository.close()
  })

  test("a run held for a request is not let through by approve, and stopping it stops the turn", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    const engine = quick(new Stub({ busy: () => true, pending: () => edit }))
    Object.assign(scheduler, { engine })
    const run = await scheduler.runTasks({ tasks: [{ name: "edit", prompt: "Change the file" }] })
    const deadline = Date.now() + 2000
    while (repository.getRun(run.id)?.status !== "awaiting" && Date.now() < deadline) await Bun.sleep(5)
    expect(repository.getRun(run.id)?.paused).toBe("request")

    expect(scheduler.approve(run.id)).toBeUndefined()
    const handler = createHarnessHandler(repository, scheduler)
    const approve = await handler(new Request(`http://x/harness/runs/${run.id}/approve`, { method: "POST" }))
    expect(approve.status).toBe(409)

    await scheduler.stopRun(run.id)
    const stopped = Date.now() + 2000
    while (repository.getRun(run.id)?.status !== "stopped" && Date.now() < stopped) await Bun.sleep(5)
    expect(repository.getRun(run.id)?.status).toBe("stopped")
    // Stopped the way a running run is: the turn was interrupted, not left waiting in the engine.
    expect(engine.interrupted).toBeGreaterThan(0)
    expect(repository.listTasks(run.id)[0]!.status).toBe("stopped")
    repository.close()
  })
})

describe("where the mode is declared (RP-05)", () => {
  test("a project's default is read and picked through the API", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const handler = createHarnessHandler(repository, new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" }))
    const read = async () =>
      (await (await handler(new Request("http://x/harness/projects/unattended?directory=/work/demo"))).json()) as {
        data: { unattended: string }
      }
    expect((await read()).data.unattended).toBe("gate")
    const put = (body: unknown) =>
      handler(
        new Request("http://x/harness/projects/unattended", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    expect((await put({ directory: "/work/demo", unattended: "deny" })).status).toBe(200)
    expect((await read()).data.unattended).toBe("deny")
    expect(repository.projectUnattended("/work/other")).toBeUndefined()
    expect((await put({ directory: "/work/demo", unattended: "ask" })).status).toBe(400)
    expect((await put({ unattended: "deny" })).status).toBe(400)
    repository.close()
  })

  test("a workflow file says it, and a run's policy keeps it", async () => {
    const workflow = parseWorkflow(
      ["name: nightly", "unattended: deny", "tasks:", "  - id: work", "    prompt: Do it"].join("\n"),
      "nightly",
    )
    expect(workflow?.unattended).toBe("deny")
    expect(parseWorkflow(["unattended: maybe", "tasks:", "  - id: work", "    prompt: Do it"].join("\n"), "x")?.unattended).toBeUndefined()

    const repository = new SqliteRoutineRepository(":memory:")
    const run = repository.startRun(manual, 1000, undefined, { policy: { unattended: "deny" } })
    expect(repository.getRun(run.id)?.policy).toEqual({ unattended: "deny" })
    repository.close()
  })
})
