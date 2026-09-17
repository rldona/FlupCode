import { describe, expect, test } from "bun:test"
import { CONFINED, Engine, ToolLimitReached, type Activity } from "./engine"

/**
 * The waiting itself (H-47).
 *
 * `Engine` builds its own client from a URL, so what is stubbed here is what it asks the engine —
 * whether the session is busy, what it is doing, and the abort — and what is exercised is the real
 * loop: the settling, the polling, when it looks at the running call and what it does about one
 * that has outstayed the run's ceiling.
 */
class Stub extends Engine {
  interrupted = 0
  polls = 0
  looks = 0

  constructor(
    private readonly script: { busy: () => boolean; doing?: () => Activity | undefined },
  ) {
    super("http://127.0.0.1:1")
  }

  override async isBusy() {
    this.polls++
    return this.script.busy()
  }

  override async activity() {
    this.looks++
    return this.script.doing?.()
  }

  override async interrupt() {
    this.interrupted++
  }
}

const fast = { pollMs: 5, checkEveryMs: 5, settleMs: 20 }

describe("waiting for a turn to finish", () => {
  test("returns when the engine says it is no longer busy", async () => {
    let calls = 0
    const engine = new Stub({ busy: () => ++calls < 4 })
    await engine.waitForIdle("ses_1", fast)
    expect(calls).toBeGreaterThan(1)
  })

  test("a run with no ceiling is never asked what it is doing", async () => {
    // It costs a request for the whole transcript every few seconds. A run that cannot act on the
    // answer should not be paying for it.
    let calls = 0
    const engine = new Stub({ busy: () => ++calls < 6, doing: () => ({ tool: "glob", since: 0 }) })
    await engine.waitForIdle("ses_1", fast)
    expect(engine.looks).toBe(0)
  })
})

describe("a tool call that outstays the run's ceiling", () => {
  test("is stopped where it runs, and says what it was and for how long", async () => {
    const engine = new Stub({
      busy: () => true,
      doing: () => ({ tool: "glob", since: Date.now() - 20 * 60_000 }),
    })

    const failure = await engine.waitForIdle("ses_1", { ...fast, toolLimitMs: 10 * 60_000 }).catch((cause) => cause)

    expect(failure).toBeInstanceOf(ToolLimitReached)
    expect((failure as ToolLimitReached).tool).toBe("glob")
    expect((failure as Error).message).toMatch(/`glob` ran for 20 minutes/)
    expect((failure as Error).message).toMatch(/limit of 10/)
    // Aborted rather than left to the thirty-minute cap with the engine still working on it.
    expect(engine.interrupted).toBe(1)
  })

  test("a call still inside the ceiling is left alone", async () => {
    let calls = 0
    const engine = new Stub({
      busy: () => ++calls < 8,
      doing: () => ({ tool: "bash", since: Date.now() - 60_000 }),
    })

    await engine.waitForIdle("ses_1", { ...fast, toolLimitMs: 10 * 60_000 })

    // It was watched, and nothing was done about it: a slow test suite is legitimate work.
    expect(engine.looks).toBeGreaterThan(0)
    expect(engine.interrupted).toBe(0)
  })

  test("a call the engine gave no start time for is not stopped on a guess", async () => {
    let calls = 0
    const engine = new Stub({ busy: () => ++calls < 8, doing: () => ({ tool: "glob" }) })

    await engine.waitForIdle("ses_1", { ...fast, toolLimitMs: 1 })

    expect(engine.interrupted).toBe(0)
  })

  test("nothing running is not something that outstayed anything", async () => {
    let calls = 0
    const engine = new Stub({ busy: () => ++calls < 8, doing: () => undefined })
    await engine.waitForIdle("ses_1", { ...fast, toolLimitMs: 1 })
    expect(engine.interrupted).toBe(0)
  })

  test("a stop asked for by a person wins over both", async () => {
    const engine = new Stub({ busy: () => true, doing: () => ({ tool: "glob", since: 0 }) })
    await engine.waitForIdle("ses_1", { ...fast, toolLimitMs: 10 * 60_000, stopped: () => true })
    expect(engine.interrupted).toBe(0)
  })
})

describe("the confinement rules", () => {
  test("deny anything outside the project, and nothing else", () => {
    // One rule, and it is a denial. Anything broader would be the harness deciding what an agent
    // may do inside the folder it was pointed at, which is the agent's own configuration to make.
    expect(CONFINED).toEqual([{ permission: "external_directory", pattern: "*", action: "deny" }])
  })
})
