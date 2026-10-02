import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { openLog, portInUse, reapOrphan, superviseChild, tailLog, type ChildState, type Supervisor } from "./supervisor"

/**
 * The supervisor against real child processes: a few lines of Bun that serve a health route the way
 * the engine and the harness do, and stop when told to through their environment.
 */

const FAKE_CHILD = `
const port = Number(process.env.FAKE_PORT)
console.log("fake child up on " + port + " with token sk-ant-" + "a".repeat(30))
if (process.env.FAKE_FAIL_AT_START) { console.error("Failed to start server. Is port " + port + " in use?"); process.exit(3) }
if (!process.env.FAKE_SILENT) Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") })
if (process.env.FAKE_EXIT_AFTER) setTimeout(() => process.exit(7), Number(process.env.FAKE_EXIT_AFTER))
setInterval(() => {}, 1000)
`

const dirs: string[] = []
const supervisors: Supervisor[] = []
const orphans: ChildProcess[] = []
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()))
  orphans.splice(0).forEach((child) => child.kill("SIGKILL"))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-supervisor-"))
  dirs.push(dir)
  return dir
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  await new Promise((resolve) => server.close(resolve))
  return port
}

const answers = (port: number) => () =>
  fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }).then(
    (response) => response.ok,
    () => false,
  )

async function fakeChild(input: { env?: Record<string, string>; readyTimeout?: number; maxRestarts?: number } = {}) {
  const dir = await temp()
  const port = await freePort()
  const states: ChildState[] = []
  const supervisor = superviseChild({
    name: "fake",
    command: process.execPath,
    args: ["-e", FAKE_CHILD],
    options: { env: { ...process.env, FAKE_PORT: String(port), ...input.env } },
    dir,
    ready: answers(port),
    readyTimeout: input.readyTimeout ?? 5000,
    backoff: [50, 100],
    maxRestarts: input.maxRestarts ?? 3,
    onChange: (state) => states.push(state),
  })
  supervisors.push(supervisor)
  return { supervisor, states, dir, port }
}

async function until(check: () => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(25)
  }
}

describe("superviseChild", () => {
  test("starts a child, writes its pid file and its log", async () => {
    const child = await fakeChild()
    const state = await child.supervisor.start()
    expect(state.phase).toBe("running")
    expect(existsSync(path.join(child.dir, "fake.pid"))).toBe(true)
    await until(() => tailLog(state.log).some((line) => line.includes("fake child up")))
    expect(statSync(state.log).mode & 0o777).toBe(0o600)
  })

  test("a killed child is started again, on the same port, and answers", async () => {
    const child = await fakeChild()
    const first = await child.supervisor.start()
    process.kill(first.pid as number, "SIGKILL")
    await until(() => child.states.some((state) => state.phase === "restarting"))
    await until(() => child.supervisor.state().phase === "running" && child.supervisor.state().pid !== first.pid)
    expect(await answers(child.port)()).toBe(true)
    expect(child.supervisor.state().restarts).toBe(1)
    expect(child.states.find((state) => state.phase === "restarting")?.failure?.message).toBe("was stopped by SIGKILL")
  })

  test("a child that keeps stopping is given up on, and says why", async () => {
    const child = await fakeChild({ env: { FAKE_EXIT_AFTER: "300" }, maxRestarts: 2 })
    await child.supervisor.start()
    await until(() => child.supervisor.state().phase === "failed")
    const state = child.supervisor.state()
    expect(state.restarts).toBe(2)
    expect(state.failure?.message).toBe("exited with code 7; gave up after 2 restarts")
    // Nothing more is started once it gave up.
    await Bun.sleep(500)
    expect(child.supervisor.state().phase).toBe("failed")
  })

  test("a child that cannot start fails at once with its own last words, secrets swept", async () => {
    const child = await fakeChild({ env: { FAKE_FAIL_AT_START: "1" } })
    const state = await child.supervisor.start()
    expect(state.phase).toBe("failed")
    expect(state.failure?.reason).toBe("exit")
    expect(state.failure?.message).toBe("exited with code 3")
    expect(state.failure?.lastLines.join("\n")).toContain(`Is port ${child.port} in use?`)
    expect(state.failure?.lastLines.join("\n")).not.toContain("sk-ant-aaaa")
    expect(existsSync(path.join(child.dir, "fake.pid"))).toBe(false)
  })

  test("a child that never answers fails with the time it was given", async () => {
    const child = await fakeChild({ env: { FAKE_SILENT: "1" }, readyTimeout: 600 })
    const state = await child.supervisor.start()
    expect(state.failure).toMatchObject({ reason: "not-ready", message: "did not answer within 1 s" })
  })

  test("a command that does not exist fails as a spawn failure", async () => {
    const dir = await temp()
    const supervisor = superviseChild({
      name: "missing",
      command: path.join(dir, "no-such-binary"),
      args: [],
      dir,
      ready: async () => false,
    })
    supervisors.push(supervisor)
    const state = await supervisor.start()
    expect(state.failure?.reason).toBe("spawn")
  })

  test("stop is final: no restart follows", async () => {
    const child = await fakeChild()
    const state = await child.supervisor.start()
    await child.supervisor.stop()
    await Bun.sleep(300)
    expect(child.supervisor.state().phase).toBe("stopped")
    expect(await answers(child.port)()).toBe(false)
    expect(existsSync(path.join(child.dir, "fake.pid"))).toBe(false)
    expect(tailLog(state.log).at(-1)).toContain("stopped")
  })
})

describe("reapOrphan", () => {
  /** A child an earlier host started and left behind when it went away: its pid file stays. */
  async function orphan() {
    const dir = await temp()
    const port = await freePort()
    const child = spawn(process.execPath, ["-e", FAKE_CHILD], {
      env: { ...process.env, FAKE_PORT: String(port) },
      stdio: "ignore",
    })
    orphans.push(child)
    writeFileSync(path.join(dir, "fake.pid"), JSON.stringify({ pid: child.pid, command: process.execPath }))
    const deadline = Date.now() + 5000
    while (!(await answers(port)()) && Date.now() < deadline) await Bun.sleep(50)
    return { dir, port, pid: child.pid as number }
  }

  test("stops a child an earlier host left behind, once it answers as one", async () => {
    const left = await orphan()
    const result = await reapOrphan({ dir: left.dir, name: "fake", probe: answers(left.port) })
    expect(result).toEqual({ reaped: true, pid: left.pid })
    expect(await answers(left.port)()).toBe(false)
    expect(existsSync(path.join(left.dir, "fake.pid"))).toBe(false)
  })

  test("leaves a process alone when the probe does not answer as the expected kind", async () => {
    const left = await orphan()
    const result = await reapOrphan({ dir: left.dir, name: "fake", probe: async () => false })
    expect(result.reaped).toBe(false)
    expect(await answers(left.port)()).toBe(true)
  })

  test("leaves a reused pid alone: the recorded command is not what runs under it", async () => {
    const dir = await temp()
    // This test's own pid, recorded as some other program: alive, but not that program.
    writeFileSync(path.join(dir, "fake.pid"), JSON.stringify({ pid: process.pid, command: "/opt/not-this-program" }))
    const result = await reapOrphan({ dir, name: "fake", probe: async () => true })
    expect(result.reaped).toBe(false)
    expect(existsSync(path.join(dir, "fake.pid"))).toBe(false)
  })

  test("a missing or unreadable pid file reaps nothing", async () => {
    const dir = await temp()
    expect((await reapOrphan({ dir, name: "fake", probe: async () => true })).reaped).toBe(false)
    writeFileSync(path.join(dir, "fake.pid"), "{not json")
    expect((await reapOrphan({ dir, name: "fake", probe: async () => true })).reaped).toBe(false)
  })
})

describe("openLog", () => {
  test("rotates at its size and keeps a bounded number of files", async () => {
    const dir = await temp()
    const log = openLog(path.join(dir, "logs", "engine.log"), { maxBytes: 100, keep: 3 })
    Array.from({ length: 50 }, (_, index) => log.write(`line ${index} ${"x".repeat(20)}\n`))
    const files = readdirSync(path.join(dir, "logs")).sort()
    expect(files).toEqual(["engine.1.log", "engine.2.log", "engine.log"])
    files.forEach((file) => expect(statSync(path.join(dir, "logs", file)).size).toBeLessThan(200))
    expect(tailLog(log.file).at(-1)).toContain("line 49")
  })
})

test("portInUse tells a taken port from a free one", async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  expect(await portInUse(port)).toBe(true)
  await new Promise((resolve) => server.close(resolve))
  expect(await portInUse(port)).toBe(false)
})
