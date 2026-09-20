import { OUTPUT_LIMIT } from "./verify"

/**
 * A task another vendor's CLI executes (H-38).
 *
 * There is no adapter per vendor on purpose: what a CLI is called and which flags make it
 * non-interactive changes between versions, and guessing them from here would break on the next
 * release. The workflow declares the command; this module owns the boundary around it — the prompt
 * is handed over quoted, the process runs in the task's tree, stop and the run's ceiling reach it
 * because it is a process this server holds, and what it printed is kept.
 */

/**
 * `{{prompt}}` replaced by the task's prompt, quoted for the shell it is handed to.
 *
 * Quoting is a pure function with tests because a prompt is arbitrary text: one with an apostrophe
 * — "don't" — is enough to break a command that pasted it in raw, and the failure would look like
 * the CLI rejecting valid input.
 */
export function externalCommand(command: string, prompt: string) {
  return command.replace(/\{\{\s*prompt\s*\}\}/g, shellQuote(prompt))
}

/** One POSIX word, whatever the text: `'…'` with the apostrophes closed and escaped. */
export function shellQuote(text: string) {
  return `'${text.replace(/'/g, "'\\''")}'`
}

export type ExternalResult = {
  ok: boolean
  exitCode: number
  output: string
  stopped: boolean
  timedOut: boolean
}

/** How long between two looks at whether the run was stopped or went past its ceiling. */
const POLL_MS = 500

/** Kept in memory while it runs, so three minutes of log does not become three hundred megabytes. */
const LIVE_LIMIT = 64_000

const tail = (text: string) => (text.length <= OUTPUT_LIMIT ? text : `…${text.slice(text.length - OUTPUT_LIMIT)}`)

/**
 * Run one external command, and keep what it printed.
 *
 * Through a login shell like the project's own checks (H-22): the server is started by the desktop
 * app, which on macOS gets the launch environment rather than the one a terminal would give it, so a
 * CLI installed for the user is often not on its PATH at all. `NO_COLOR` is set because what is kept
 * is read later, not watched.
 */
export async function runExternal(input: {
  command: string
  directory: string
  stopped?: () => boolean
  /** The run's declared ceiling for one tool call (H-47); an external task is one. */
  limitMs?: number
  /** Called with the output so far as it grows, for the activity endpoint (H-12). */
  onOutput?: (output: string) => void
  /** Tests only: how often stop and the ceiling are checked. */
  pollMs?: number
}): Promise<ExternalResult> {
  if (input.stopped?.()) return { ok: false, exitCode: -1, output: "", stopped: true, timedOut: false }

  const child = Bun.spawn(["sh", "-lc", input.command], {
    cwd: input.directory,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // Its own process group, so a stop can take the whole thing. A login shell may fork the command
    // instead of replacing itself with it, and killing only the shell leaves the real process alive
    // holding the pipes — which reads as a hang, not as a kill, and is how this failed on Linux.
    detached: true,
    env: { ...process.env, NO_COLOR: "1" },
  })

  let output = ""
  let stopped = false
  let timedOut = false
  const startedAt = Date.now()
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      output = (output + new TextDecoder().decode(value)).slice(-LIVE_LIMIT)
      input.onOutput?.(output)
    }
  }
  /** The group goes, not just the shell: what was started is the command, whatever it forked. */
  const kill = () => {
    if (child.exitCode !== null) return
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      // Windows has no process groups. The direct child is still better than nothing.
      child.kill()
    }
  }
  const watcher = setInterval(() => {
    if (child.exitCode !== null) return
    if (input.stopped?.()) {
      stopped = true
      kill()
      return
    }
    if (input.limitMs && Date.now() - startedAt > input.limitMs) {
      timedOut = true
      kill()
    }
  }, input.pollMs ?? POLL_MS)

  const [exitCode] = await Promise.all([child.exited, consume(child.stdout), consume(child.stderr)])
  clearInterval(watcher)
  return {
    // A killed process exits non-zero, which is not the same answer as the command saying no.
    ok: exitCode === 0 && !stopped && !timedOut,
    exitCode,
    output: tail(output),
    stopped,
    timedOut,
  }
}
