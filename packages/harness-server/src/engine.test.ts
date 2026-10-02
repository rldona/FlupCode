import { describe, expect, test } from "bun:test"
import {
  CONFINED,
  Engine,
  McpNotConnectedError,
  NO_SHELL,
  ToolLimitReached,
  engineAuthorization,
  sessionPermission,
  type Activity,
} from "./engine"

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

  test("a wait past its timeout says the timeout it was given, not thirty minutes", async () => {
    const engine = new Stub({ busy: () => true })
    const failure = await engine.waitForIdle("ses_1", { ...fast, timeoutMs: 100 }).catch((cause) => cause)
    expect((failure as Error).message).toBe("The work was still running after 0.1 seconds")
    // Out of time ends the turn too, so the task is not written down as failed while it still runs.
    expect(engine.interrupted).toBe(1)
  })

  test("a stop interrupts the turn before the wait returns", async () => {
    const engine = new Stub({ busy: () => true })
    await engine.waitForIdle("ses_1", { ...fast, stopped: () => true })
    expect(engine.interrupted).toBe(1)
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
    // Returns rather than throwing the limit, having interrupted the turn once, for the stop.
    await engine.waitForIdle("ses_1", { ...fast, toolLimitMs: 10 * 60_000, stopped: () => true })
    expect(engine.interrupted).toBe(1)
    expect(engine.looks).toBe(0)
  })
})

describe("the confinement rules", () => {
  test("deny anything outside the project, and nothing else", () => {
    // One rule, and it is a denial. Anything broader would be the harness deciding what an agent
    // may do inside the folder it was pointed at, which is the agent's own configuration to make.
    expect(CONFINED).toEqual([{ permission: "external_directory", pattern: "*", action: "deny" }])
  })

  test("a run with no shell is denied the tool, on its own and alongside confinement (H-47)", () => {
    expect(NO_SHELL).toEqual([{ permission: "bash", pattern: "*", action: "deny" }])
    // The default: confined, with the engine's own shell.
    expect(sessionPermission({})).toEqual(CONFINED)
    // Opened up: no external boundary, and nothing declared about the shell.
    expect(sessionPermission({ outside: true })).toEqual([])
    expect(sessionPermission({ shell: false })).toEqual([...CONFINED, ...NO_SHELL])
    // Both at once: the shell is still refused inside a project the run may otherwise leave.
    expect(sessionPermission({ outside: true, shell: false })).toEqual(NO_SHELL)
  })
})

describe("signing in to the engine", () => {
  test("the desktop's base64 credential is used as the Basic header", () => {
    expect(engineAuthorization({ FLUPCODE_ENGINE_AUTH: "b3BlbmNvZGU6c2VjcmV0" })).toBe("Basic b3BlbmNvZGU6c2VjcmV0")
  })

  test("an engine's own username and password are encoded when no credential was handed over", () => {
    expect(engineAuthorization({ OPENCODE_SERVER_PASSWORD: "secret" })).toBe(
      `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    )
    expect(engineAuthorization({ OPENCODE_SERVER_USERNAME: "alice", OPENCODE_SERVER_PASSWORD: "secret" })).toBe(
      `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    )
  })

  test("an engine with no password needs no header", () => {
    expect(engineAuthorization({})).toBeUndefined()
  })
})

/**
 * Bringing a project's MCP servers up.
 *
 * `Engine` builds its own 2.x client from a URL, so the client is replaced here with one that answers
 * the two calls this concerns — the servers' status and connect — and what is exercised is the real
 * decision: who is connected, who is left alone, and who makes the run refuse to start.
 */
const mcpEngine = (script: {
  status?: () => Record<string, { status?: string }>
  connect?: (name: string) => void
  unavailable?: boolean
}) => {
  const connects: string[] = []
  const engine = new Engine("http://127.0.0.1:1")
  Object.assign(engine, {
    backend: Promise.resolve({
      mcpServers: async () => {
        // An engine whose MCP routes fail answers with an error, not a status list.
        if (script.unavailable) throw new Error("404 Not Found")
        return Object.entries(script.status?.() ?? {}).map(([name, server]) => ({ name, status: server.status }))
      },
      connectMcp: async (name: string) => {
        connects.push(name)
        script.connect?.(name)
      },
    }),
  })
  return { engine, connects }
}

describe("bringing a project's MCP servers up", () => {
  test("connects what needs it and leaves the connected and disabled alone", async () => {
    const servers: Record<string, { status?: string }> = {
      up: { status: "connected" },
      off: { status: "disabled" },
      auth: { status: "needs_auth" },
      broken: { status: "failed" },
    }
    const { engine, connects } = mcpEngine({
      status: () => servers,
      connect: (name) => {
        servers[name] = { status: "connected" }
      },
    })

    await engine.ensureMcp("/tmp/project")

    expect(connects).toEqual(["auth", "broken"])
    // Disabled means disabled: the run may not be started with a server somebody turned off.
    expect(servers.off).toEqual({ status: "disabled" })
  })

  test("a server that stays unauthenticated after connect refuses the run by name", async () => {
    // Connecting answers success even when the OAuth flow was never finished, so the second read is
    // what decides — and the run must not start with a reduced toolset.
    const { engine } = mcpEngine({ status: () => ({ solo: { status: "needs_auth" } }) })

    const failure = await engine.ensureMcp("/tmp/project").catch((cause) => cause)

    expect(failure).toBeInstanceOf(McpNotConnectedError)
    expect((failure as Error).message).toContain("solo")
    expect((failure as Error).message).toContain("/tmp/project")
  })

  test("an engine whose MCP routes fail does not break the run", async () => {
    const { engine, connects } = mcpEngine({ unavailable: true })

    await engine.ensureMcp("/tmp/project")

    expect(connects).toEqual([])
  })
})
