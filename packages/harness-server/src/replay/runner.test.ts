import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderMarkdown, runReplay, stat } from "./runner"

/** A stub engine and harness on one port: the routes the runner calls, and a log of what it did. */
function fakeEngine() {
  const seen = {
    sessions: 0,
    prompts: [] as Array<{
      sessionID: string
      text: string
      model?: unknown
      agent?: string
      directory: string | null
    }>,
    deleted: [] as string[],
    worktrees: { created: 0, removed: 0 },
    patches: [] as unknown[],
    config: { enabled: true, context: { enabled: false, apply: false } } as Record<string, unknown>,
  }
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      const path = url.pathname
      if (path === "/session" && request.method === "POST") {
        seen.sessions += 1
        return json({ id: `ses_${seen.sessions}`, directory: url.searchParams.get("directory") })
      }
      if (path === "/session/status") return json({})
      const prompt = path.match(/^\/session\/([^/]+)\/prompt_async$/)
      if (prompt) {
        const body = (await request.json()) as { parts: Array<{ text: string }>; model?: unknown; agent?: string }
        seen.prompts.push({
          sessionID: prompt[1]!,
          text: body.parts[0]!.text,
          model: body.model,
          agent: body.agent,
          directory: url.searchParams.get("directory"),
        })
        return new Response(null, { status: 204 })
      }
      if (path.match(/^\/session\/[^/]+\/message$/))
        return json([
          { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
          {
            info: {
              role: "assistant",
              cost: 0.01,
              tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 50, write: 0 } },
            },
            parts: [],
          },
        ])
      const session = path.match(/^\/session\/([^/]+)$/)
      if (session && request.method === "DELETE") {
        seen.deleted.push(session[1]!)
        return json(true)
      }
      if (path === "/experimental/worktree" && request.method === "POST") {
        seen.worktrees.created += 1
        return json({ name: "w", directory: mkdtempSync(join(tmpdir(), "replay-worktree-")) })
      }
      if (path === "/experimental/worktree" && request.method === "DELETE") {
        seen.worktrees.removed += 1
        return json(true)
      }
      if (path === "/harness/adaptive/metrics") {
        // Every other session has its `session_metrics`; the rest fall back to the engine's numbers.
        const id = Number(url.searchParams.get("sessionID")?.replace("ses_", ""))
        if (id % 2) return json({ data: [] })
        return json({
          data: [{ cost: 0.01, tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 50, cacheWrite: 0 } }],
        })
      }
      if (path === "/harness/adaptive/config" && request.method === "GET")
        return json({ data: { effective: seen.config } })
      if (path === "/harness/adaptive/config" && request.method === "PATCH") {
        const body = (await request.json()) as { patch: Record<string, unknown> }
        seen.patches.push(body.patch)
        return json({ data: {} })
      }
      return json({ error: "not found" }, 404)
    },
  })
  return { server, seen, url: `http://127.0.0.1:${server.port}` }
}

let running: ReturnType<typeof fakeEngine> | undefined

afterEach(async () => {
  await running?.server.stop(true)
  running = undefined
})

describe("replay runner", () => {
  test("replays every fixture × variant × repetition in throwaway sessions and reports them", async () => {
    running = fakeEngine()
    const fake = running
    const report = await runReplay({
      fixtures: [
        {
          version: 1,
          id: "synthetic",
          directory: tmpdir(),
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          prompts: ["first", "second"],
          verify: "test -d .",
        },
      ],
      variants: [
        { name: "baseline" },
        {
          name: "adaptive-off",
          adaptive: { enabled: false },
          model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
        },
      ],
      engine: fake.url,
      harness: { url: fake.url, token: "t" },
      pollMs: 1,
      settleMs: 0,
      metricsDelayMs: 0,
    })

    expect(report.runs).toHaveLength(6)
    expect(report.repeat).toBe(3)
    expect(report.seed).toBeNull()
    expect(report.runs.every((run) => run.status === "ok" && run.completed && run.verify?.passed)).toBe(true)
    // Both prompts, in order, in each session, in the worktree the engine made for it.
    expect(fake.seen.prompts.map((prompt) => prompt.text)).toEqual(
      Array.from({ length: 6 }, () => ["first", "second"]).flat(),
    )
    expect(fake.seen.prompts.every((prompt) => prompt.directory?.includes("replay-worktree-"))).toBe(true)
    // The model is pinned on every prompt, and the variant's override wins.
    expect(fake.seen.prompts[0]!.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" })
    expect(fake.seen.prompts.at(-1)!.model).toEqual({ providerID: "anthropic", modelID: "claude-haiku-4-5" })
    // Nothing is left behind, and the adaptive patch is applied and then restored.
    expect(fake.seen.deleted).toHaveLength(6)
    expect(fake.seen.worktrees).toEqual({ created: 6, removed: 6 })
    expect(fake.seen.patches).toEqual([{ enabled: false }, { enabled: true }])
    // The numbers come from `session_metrics` when it has them and from the engine otherwise.
    expect(new Set(report.runs.map((run) => run.source))).toEqual(new Set(["session_metrics", "engine"]))
    expect(report.runs[0]!.tokens).toEqual({ input: 100, cacheRead: 50, cacheWrite: 0, output: 20, reasoning: 0 })

    expect(report.aggregates).toHaveLength(2)
    const baseline = report.aggregates[0]!
    expect(baseline.runs).toBe(3)
    expect(baseline.completionRate).toBe(1)
    expect(baseline.usd.mean).toBeCloseTo(0.01)
    expect(baseline.reproducible).toBe(true)
    expect(renderMarkdown(report)).toContain("| synthetic | adaptive-off | 3/3 | 100.0% |")
  })

  test("a failed verify is reported as not completed, and an unreachable engine as an error", async () => {
    running = fakeEngine()
    const fixture = { version: 1 as const, id: "red", directory: tmpdir(), prompts: ["go"], verify: "exit 3" }
    const red = await runReplay({
      fixtures: [fixture],
      variants: [{ name: "baseline" }],
      repeat: 1,
      engine: running.url,
      isolation: "in-place",
      pollMs: 1,
      settleMs: 0,
    })
    expect(red.runs[0]).toMatchObject({ status: "ok", completed: false, verify: { passed: false, exitCode: 3 } })
    expect(red.isolation).toBe("in-place")

    const down = await runReplay({
      fixtures: [fixture],
      variants: [{ name: "baseline", engine: "http://127.0.0.1:1" }],
      repeat: 1,
      engine: running.url,
      pollMs: 1,
      settleMs: 0,
    })
    expect(down.runs[0]).toMatchObject({ status: "error", completed: false })
    expect(down.aggregates[0]!.reproducible).toBe(false)
  })

  test("the spread is the largest relative distance from the mean", () => {
    expect(stat([100, 104, 96])).toEqual({ mean: 100, p50: 100, min: 96, max: 104, spread: 0.04 })
    expect(stat([1, 2, 3, 4]).p50).toBe(2.5)
    expect(stat([])).toEqual({ mean: 0, p50: 0, min: 0, max: 0, spread: 0 })
  })
})
