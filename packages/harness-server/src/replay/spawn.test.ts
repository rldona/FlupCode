import { describe, expect, test } from "bun:test"
import { spawnEngine } from "./spawn"

/** An "engine" that is healthy and reports `CONFIG` (default: what it was given) as its config. */
const stub = (config = "process.env.OPENCODE_CONFIG_CONTENT") => [
  "bun",
  "-e",
  `Bun.serve({ port: {port}, hostname: "127.0.0.1", fetch: (request) =>
    new URL(request.url).pathname === "/global/health" ? Response.json(true) : new Response(${config}) })`,
]

describe("spawnEngine", () => {
  test("starts an engine on a free port with the config layered in, and stops it", async () => {
    const engine = await spawnEngine(
      { command: stub(), pollMs: 20 },
      { compaction: { prune: true, tail_turns: 2 }, tool_output: { max_bytes: 16384 } },
    )
    expect(engine.url).not.toContain(":4096")
    expect(await fetch(`${engine.url}/config`).then((response) => response.json())).toEqual({
      compaction: { prune: true, tail_turns: 2 },
      tool_output: { max_bytes: 16384 },
    })
    expect(() => process.kill(engine.pid, 0)).not.toThrow()
    await engine.stop()
    expect(() => process.kill(engine.pid, 0)).toThrow()
    // Stopping twice is harmless.
    await engine.stop()
  })

  test("an engine that ignores the config is refused and stopped", async () => {
    const failure = await spawnEngine(
      { command: stub(`JSON.stringify({ compaction: { prune: false } })`), pollMs: 20 },
      { compaction: { prune: true } },
    ).catch((cause: Error) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("does not carry compaction.prune=true")
  })

  test("an engine that exits or never gets healthy is reported with its stderr", async () => {
    const exited = await spawnEngine({ command: ["sh", "-c", "echo boom >&2; exit 3"], pollMs: 20 }, {}).catch(
      (cause: Error) => cause,
    )
    expect((exited as Error).message).toContain("exited (3)")
    expect((exited as Error).message).toContain("boom")

    const slow = await spawnEngine({ command: ["sleep", "30"], pollMs: 20, readyTimeoutMs: 200 }, {}).catch(
      (cause: Error) => cause,
    )
    expect((slow as Error).message).toContain("not healthy")
  })
})
