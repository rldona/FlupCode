import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { SECRET_PATTERNS } from "./secret-patterns"

/**
 * The processes a FlupCode host starts — the engine, the harness server — kept alive (HE-03).
 *
 * A child that stops after it was ready is started again with a growing pause between attempts, and
 * one that keeps stopping is given up on, with the reason, instead of being restarted forever. What
 * it prints goes to a rotating log file under the host's data directory, not to an inherited stdio a
 * packaged app throws away. A pid file beside the logs lets the next launch find a child an earlier
 * one left behind. Node and Bun both run this module: the desktop's main process is Electron.
 */

export type ChildPhase = "starting" | "running" | "restarting" | "failed" | "stopped"

/** Why a child is not running, in words a dialog or a banner can show. */
export type ChildFailure = {
  reason: "spawn" | "exit" | "not-ready"
  message: string
  /** The last lines it printed, swept of secret shapes. */
  lastLines: string[]
}

export type ChildState = {
  name: string
  phase: ChildPhase
  pid?: number
  /** Restarts since it last ran steadily. */
  restarts: number
  failure?: ChildFailure
  log: string
}

export type SupervisorInput = {
  name: string
  command: string
  args: string[]
  options?: Pick<SpawnOptions, "cwd" | "env" | "shell">
  /** The host's data directory: logs go to `<dir>/logs`, the pid file to `<dir>/<name>.pid`. */
  dir: string
  /** Whether the child answers as the thing it is; polled after every start. */
  ready: () => Promise<boolean>
  readyTimeout?: number
  /** The pause before each restart in a row; the last one repeats. */
  backoff?: number[]
  /** Restarts allowed within `window` before the child is given up on. */
  maxRestarts?: number
  /** How long a child has to run for its restarts to stop counting against it. */
  window?: number
  /** Also copy what it prints to this process's stdout and stderr (a development build). */
  echo?: boolean
  /** Written to the pid file, for `reapOrphan`'s probe. */
  meta?: Record<string, unknown>
  onChange?: (state: ChildState) => void
}

const BACKOFF = [500, 1000, 2000, 4000, 8000]

export function superviseChild(input: SupervisorInput) {
  const log = openLog(join(input.dir, "logs", `${input.name}.log`))
  const pidFile = join(input.dir, `${input.name}.pid`)
  const backoff = input.backoff ?? BACKOFF
  const maxRestarts = input.maxRestarts ?? 5
  const window = input.window ?? 60_000
  let child: ChildProcess | undefined
  let state: ChildState = { name: input.name, phase: "stopped", restarts: 0, log: log.file }
  let stopping = false
  let readySince = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const set = (next: Partial<ChildState>) => {
    state = { ...state, ...next }
    input.onChange?.(state)
  }

  /** One child, started and waited on until it answers: nothing when it does, else why it did not. */
  async function launch(): Promise<ChildFailure | undefined> {
    log.note(`starting: ${[input.command, ...input.args].join(" ")}`)
    const started = spawn(input.command, input.args, { ...input.options, stdio: ["ignore", "pipe", "pipe"] })
    child = started
    const exited = new Promise<Exit>((resolve) => {
      started.once("error", (error) => resolve({ code: null, signal: null, error: error.message }))
      started.once("exit", (code, signal) => resolve({ code, signal }))
    })
    started.stdout?.on("data", (chunk: Buffer) => {
      log.write(chunk)
      if (input.echo) process.stdout.write(chunk)
    })
    started.stderr?.on("data", (chunk: Buffer) => {
      log.write(chunk)
      if (input.echo) process.stderr.write(chunk)
    })
    if (started.pid) writePidFile(pidFile, { pid: started.pid, command: input.command, meta: input.meta })
    set({ pid: started.pid })

    const outcome = await Promise.race([
      exited.then((exit) => ({ exit })),
      waitReady(input.ready, input.readyTimeout ?? 20_000).then((ok) => ({ ready: ok })),
    ])
    if ("ready" in outcome && outcome.ready && child === started) {
      readySince = Date.now()
      log.note(`ready (pid ${started.pid})`)
      void exited.then((exit) => onExit(started, exit))
      set({ phase: "running", failure: undefined })
      return undefined
    }
    child = undefined
    rmSync(pidFile, { force: true })
    if ("exit" in outcome) return failureOf(outcome.exit, log)
    // Alive but never answering: it is stopped, so a later attempt does not find the port taken.
    started.kill("SIGKILL")
    return {
      reason: "not-ready",
      message: `did not answer within ${Math.round((input.readyTimeout ?? 20_000) / 1000)} s`,
      lastLines: log.tail(20),
    }
  }

  function giveUp(failure: ChildFailure) {
    log.note(`failed: ${failure.message}`)
    set({ phase: "failed", pid: undefined, failure })
    return state
  }

  function onExit(exited: ChildProcess, exit: Exit) {
    if (stopping || child !== exited) return
    child = undefined
    rmSync(pidFile, { force: true })
    // A child that ran steadily for a while starts its count again: only a loop is given up on.
    restart(failureOf(exit, log), Date.now() - readySince > window ? 0 : state.restarts)
  }

  function restart(failure: ChildFailure, restarts: number) {
    if (restarts >= maxRestarts) {
      giveUp({ ...failure, message: `${failure.message}; gave up after ${restarts} restarts` })
      return
    }
    const delay = backoff[Math.min(restarts, backoff.length - 1)] ?? 0
    log.note(`${failure.message}; restarting in ${delay} ms`)
    set({ phase: "restarting", pid: undefined, restarts: restarts + 1, failure })
    timer = setTimeout(async () => {
      timer = undefined
      if (stopping) return
      const next = await launch()
      // A restart that cannot even come up counts as one more stop, until the cap ends the loop.
      if (next && !stopping) restart(next, state.restarts)
    }, delay)
  }

  return {
    state: () => state,
    /** Starts the child and resolves once it answers, or with the reason it did not. */
    start() {
      if (child) return Promise.resolve(state)
      if (timer) clearTimeout(timer)
      timer = undefined
      stopping = false
      set({ phase: "starting", restarts: 0, failure: undefined })
      return launch().then((failure) => (failure ? giveUp(failure) : state))
    },
    /** Stops the child for good: no restart follows. Resolves once it has exited. */
    async stop() {
      stopping = true
      if (timer) clearTimeout(timer)
      timer = undefined
      const running = child
      child = undefined
      rmSync(pidFile, { force: true })
      set({ phase: "stopped", pid: undefined })
      if (!running || running.exitCode !== null || running.signalCode !== null) return
      await terminate(running)
      log.note("stopped")
    },
  }
}

export type Supervisor = ReturnType<typeof superviseChild>

/**
 * A child an earlier run of this host left behind, stopped so it does not hold the port the new one
 * needs. Only a process this host recorded is touched, and only while it is still that process: alive,
 * still running the recorded command, and answering `probe` as the kind of server it was. A pid the
 * system has since handed to something else fails one of those and is left alone.
 */
export async function reapOrphan(input: { dir: string; name: string; probe: (record: PidRecord) => Promise<boolean> }) {
  const file = join(input.dir, `${input.name}.pid`)
  const record = readPidFile(file)
  if (!record) return { reaped: false as const }
  if (!alive(record.pid) || !runsCommand(record.pid, record.command) || !(await input.probe(record))) {
    rmSync(file, { force: true })
    return { reaped: false as const }
  }
  process.kill(record.pid, "SIGTERM")
  const gone = await until(() => !alive(record.pid), 5000)
  if (!gone) process.kill(record.pid, "SIGKILL")
  await until(() => !alive(record.pid), 2000)
  rmSync(file, { force: true })
  return { reaped: true as const, pid: record.pid }
}

export type PidRecord = { pid: number; command: string; meta?: Record<string, unknown> }

/** Whether something already listens on a loopback port: a child started there would only fail. */
export function portInUse(port: number, host = "127.0.0.1") {
  return new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(true))
    server.listen(port, host, () => server.close(() => resolve(false)))
  })
}

/** Where a FlupCode host that is not the desktop app keeps its own files: `$XDG_DATA_HOME/flupcode`. */
export function flupcodeDataDir(env: NodeJS.ProcessEnv = process.env) {
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "flupcode")
}

/** The last lines of a child's log, the previous file included when the current one is short. */
export function tailLog(file: string, lines = 200) {
  const text = [rotated(file, 1), file].map((path) => readTail(path, 64 * 1024)).join("")
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-lines)
}

/**
 * A log file that rotates at `maxBytes`: `name.log` becomes `name.1.log` and so on, `keep` files at
 * most, so a chatty child can never fill the disk. Written synchronously: children print little, and
 * a line must not be lost when the host is killed.
 */
export function openLog(file: string, input: { maxBytes?: number; keep?: number } = {}) {
  const maxBytes = input.maxBytes ?? 1024 * 1024
  const keep = input.keep ?? 3
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 })
  let size = existsSync(file) ? statSync(file).size : 0
  const write = (chunk: Buffer | string) => {
    if (size >= maxBytes) {
      Array.from({ length: keep - 1 }, (_, index) => keep - 1 - index).forEach((from) => {
        const source = from === 1 ? file : rotated(file, from - 1)
        if (existsSync(source)) renameSync(source, rotated(file, from))
      })
      size = 0
    }
    appendFileSync(file, chunk, { mode: 0o600 })
    if (size === 0) chmodSync(file, 0o600)
    size += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length
  }
  return {
    file,
    write,
    /** A line from the supervisor itself, told apart from the child's own output. */
    note: (message: string) => write(`[flupcode ${new Date().toISOString()}] ${message}\n`),
    tail: (lines: number) => tailLog(file, lines).map(sweep),
  }
}

function rotated(file: string, index: number) {
  return file.replace(/\.log$/, `.${index}.log`)
}

function readTail(file: string, bytes: number) {
  if (!existsSync(file)) return ""
  const size = statSync(file).size
  const length = Math.min(size, bytes)
  const buffer = Buffer.alloc(length)
  const handle = openSync(file, "r")
  readSync(handle, buffer, 0, length, size - length)
  closeSync(handle)
  return buffer.toString("utf8") + "\n"
}

type Exit = { code: number | null; signal: string | null; error?: string }

function failureOf(exit: Exit, log: ReturnType<typeof openLog>): ChildFailure {
  const lastLines = log.tail(20).filter((line) => !line.startsWith("[flupcode "))
  if (exit.error) return { reason: "spawn", message: `could not be started: ${exit.error}`, lastLines }
  return {
    reason: "exit",
    message: exit.signal ? `was stopped by ${exit.signal}` : `exited with code ${exit.code}`,
    lastLines,
  }
}

function sweep(line: string) {
  return SECRET_PATTERNS.reduce((text, entry) => text.replace(entry.pattern, entry.replacement ?? "[REDACTED]"), line)
}

async function waitReady(ready: () => Promise<boolean>, timeout: number) {
  return until(() => ready().catch(() => false), timeout, 250)
}

async function until(check: () => boolean | Promise<boolean>, timeout: number, every = 100) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, every))
  }
  return false
}

async function terminate(child: ChildProcess) {
  const exited = new Promise((resolve) => child.once("exit", resolve))
  child.kill("SIGTERM")
  const done = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(resolve, 10_000, false)),
  ])
  if (!done) child.kill("SIGKILL")
}

function writePidFile(file: string, record: PidRecord) {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 })
}

function readPidFile(file: string): PidRecord | undefined {
  if (!existsSync(file)) return undefined
  const parsed = parseJson(readFileSync(file, "utf8")) as Partial<PidRecord> | undefined
  if (!parsed || !Number.isInteger(parsed.pid) || typeof parsed.command !== "string") return undefined
  return { pid: parsed.pid as number, command: parsed.command, meta: parsed.meta }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function alive(pid: number) {
  // Signal 0 checks without signalling; EPERM still means a process has that pid.
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Whether `pid` still runs `command`. Windows has no `ps`; the probe alone decides there. */
function runsCommand(pid: number, command: string) {
  if (process.platform === "win32") return true
  const listed = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" })
  return listed.status === 0 && listed.stdout.includes(command)
}
