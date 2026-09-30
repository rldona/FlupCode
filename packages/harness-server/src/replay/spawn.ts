/**
 * A throwaway engine for one replay variant (AH-D01): the native levers (`compaction.prune`,
 * `tool_output.max_bytes`, `compaction.tail_turns`, …) are opencode config the engine reads at
 * startup, so a variant that changes them gets its own engine on a free port, with the variant's
 * config layered on top of the user's through `OPENCODE_CONFIG_CONTENT` (merged last, after the
 * global and project files, and it keeps opencode from seeding the global config file).
 *
 * The user's own engine is never touched: the throwaway one listens on a port the OS hands out, and
 * `stop` only ever signals the process this module started.
 */

export type EngineSpawn = {
  /** The engine command; `{port}` is replaced with the free port. */
  command: string[]
  cwd?: string
  /** Layered over `process.env`; `undefined` removes a variable. */
  env?: Record<string, string | undefined>
  readyTimeoutMs?: number
  /** Only tests shorten these. */
  pollMs?: number
  stopTimeoutMs?: number
}

export async function spawnEngine(spawn: EngineSpawn, config: Record<string, unknown>) {
  const port = freePort()
  const child = Bun.spawn(
    spawn.command.map((part) => part.replaceAll("{port}", String(port))),
    {
      ...(spawn.cwd ? { cwd: spawn.cwd } : {}),
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...spawn.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  // Drained from the start so a chatty engine never blocks on a full pipe; read only if it fails.
  const stderr = new Response(child.stderr).text().catch(() => "")
  const url = `http://127.0.0.1:${port}`
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode) return
    child.kill("SIGTERM")
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(spawn.stopTimeoutMs ?? 5000)])
    if (exited) return
    child.kill("SIGKILL")
    await child.exited
  }
  const problem = await ready(url, child, config, spawn)
  if (!problem) return { url, pid: child.pid, stop }
  await stop()
  const tail = (await stderr).trim().split("\n").slice(-20).join("\n")
  throw new Error(`The engine for this variant did not start: ${problem}${tail ? `\n${tail}` : ""}`)
}

/**
 * Waits for `/global/health`, then checks the engine really reads the variant's config: a key the
 * engine does not know is dropped silently, and a variant that measured nothing would read as "no
 * effect". Returns what went wrong, or nothing.
 */
async function ready(url: string, child: Bun.Subprocess, config: Record<string, unknown>, spawn: EngineSpawn) {
  const deadline = Date.now() + (spawn.readyTimeoutMs ?? 90_000)
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) return `it exited (${child.exitCode ?? child.signalCode})`
    const healthy = await fetch(`${url}/global/health`).then(
      (response) => response.ok,
      () => false,
    )
    if (healthy) {
      const effective = await fetch(`${url}/config`).then(
        (response) => (response.ok ? (response.json() as Promise<unknown>) : undefined),
        () => undefined,
      )
      const missing = mismatches(effective, config)
      if (missing.length === 0) return undefined
      return `its effective config does not carry ${missing.join(", ")}`
    }
    await Bun.sleep(spawn.pollMs ?? 250)
  }
  return `it was not healthy after ${Math.round((spawn.readyTimeoutMs ?? 90_000) / 1000)}s`
}

/** The leaf paths of `expected` whose value `actual` does not hold. */
function mismatches(actual: unknown, expected: Record<string, unknown>, prefix = ""): string[] {
  const source = isPlainObject(actual) ? actual : {}
  return Object.entries(expected).flatMap(([key, value]) =>
    isPlainObject(value)
      ? mismatches(source[key], value, `${prefix}${key}.`)
      : Bun.deepEquals(source[key], value)
        ? []
        : [`${prefix}${key}=${JSON.stringify(value)}`],
  )
}

/** A port nothing listens on right now: the OS picks it, the probe lets it go. */
function freePort() {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = probe.port
  probe.stop(true)
  return port
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
