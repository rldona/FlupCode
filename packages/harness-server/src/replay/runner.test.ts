import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compare, renderMarkdown, runReplay, stat } from "./runner"
import type { ReplayAggregate } from "./runner"

/** A stub OpenCode 2 engine and harness on one port: the routes the runner calls, and a log of what it did. */
function fakeEngine() {
  const seen = {
    sessions: 0,
    prompts: [] as Array<{
      via?: string
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
  // 2.x keeps a session's folder, model and agent as session state, set before the prompt.
  const sessions = new Map<string, { directory: string | null; model?: unknown; agent?: string }>()
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      const path = url.pathname
      if (path === "/api/session" && request.method === "POST") {
        const body = (await request.json()) as { location?: { directory?: string } }
        seen.sessions += 1
        const id = `ses_${seen.sessions}`
        sessions.set(id, { directory: body.location?.directory ?? null })
        return json({ data: { id, location: { directory: body.location?.directory } } })
      }
      if (path === "/api/session/active") return json({ data: {} })
      const state = path.match(/^\/api\/session\/([^/]+)\/(model|agent)$/)
      if (state && request.method === "POST") {
        const body = (await request.json()) as { model?: unknown; agent?: string }
        const session = sessions.get(state[1]!)
        if (session && state[2] === "model") session.model = body.model
        if (session && state[2] === "agent") session.agent = body.agent
        return new Response(null, { status: 204 })
      }
      const prompt = path.match(/^\/api\/session\/([^/]+)\/prompt$/)
      if (prompt) {
        const body = (await request.json()) as { text: string }
        const session = sessions.get(prompt[1]!)
        seen.prompts.push({
          via: request.headers.get("x-via") ?? undefined,
          sessionID: prompt[1]!,
          text: body.text,
          model: session?.model,
          agent: session?.agent,
          directory: session?.directory ?? null,
        })
        return json({ data: { id: `msg_${seen.prompts.length}` } })
      }
      // Newest first, as 2.x pages them.
      if (path.match(/^\/api\/session\/[^/]+\/message$/))
        return json({
          data: [
            {
              type: "assistant",
              agent: "build",
              model: { providerID: "stub", id: "stub-model" },
              cost: 0.01,
              tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 50, write: 0 } },
              content: [],
            },
            { type: "user", text: "go" },
          ],
          cursor: {},
        })
      const session = path.match(/^\/api\/session\/([^/]+)$/)
      if (session && request.method === "DELETE") {
        seen.deleted.push(session[1]!)
        return new Response(null, { status: 204 })
      }
      if (path === "/api/location") return json({ project: { id: "prj_1" } })
      if (path === "/api/worktree" && request.method === "POST") {
        seen.worktrees.created += 1
        return json({ directory: mkdtempSync(join(tmpdir(), "replay-worktree-")) })
      }
      if (path === "/api/worktree" && request.method === "DELETE") {
        seen.worktrees.removed += 1
        return new Response(null, { status: 204 })
      }
      if (path === "/harness/adaptive/metrics") {
        // Every other session has its `session_metrics`; the rest fall back to the engine's numbers.
        const id = Number(url.searchParams.get("sessionID")?.replace("ses_", ""))
        if (id % 2) return json({ data: [] })
        return json({
          data: [
            {
              cost: 0.01,
              tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 50, cacheWrite: 0 },
              compactions: 1,
              rereadsAfterCompaction: 2,
              summaryTokens: 300,
            },
          ],
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
    expect(fake.seen.prompts[0]!.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-4-5" })
    expect(fake.seen.prompts.at(-1)!.model).toEqual({ providerID: "anthropic", id: "claude-haiku-4-5" })
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
    // Compaction numbers come only from `session_metrics`, and the report says so per variant.
    expect(report.runs.find((run) => run.source === "session_metrics")!.compaction).toEqual({
      compactions: 1,
      rereadsAfterCompaction: 2,
      summaryTokens: 300,
    })
    expect(report.runs.find((run) => run.source === "engine")!.compaction).toBeUndefined()
    expect(renderMarkdown(report)).toContain("## Compaction")
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

  test("a variant with engineConfig runs on its own engine, which carries the config and is stopped", async () => {
    running = fakeEngine()
    const fake = running
    const lines: string[] = []
    const report = await runReplay({
      fixtures: [{ version: 1, id: "synthetic", directory: tmpdir(), prompts: ["go"] }],
      variants: [{ name: "baseline" }, { name: "prune", engineConfig: { compaction: { prune: true } } }],
      repeat: 2,
      engine: fake.url,
      isolation: "in-place",
      spawn: { command: ["bun", "-e", proxyEngine], env: { REPLAY_TARGET: fake.url }, pollMs: 20 },
      pollMs: 1,
      settleMs: 0,
      log: (line) => lines.push(line),
    })

    // The baseline talks to the given engine; the variant to its own one, and only to it.
    expect(fake.seen.prompts.map((prompt) => prompt.via)).toEqual([undefined, undefined, "proxy", "proxy"])
    expect(report.runs.every((run) => run.status === "ok")).toBe(true)
    expect(report.variants[1]!.engineConfig).toEqual({ compaction: { prune: true } })
    // The throwaway engine is gone once the variant is done.
    const pid = Number(lines.find((line) => line.startsWith("prune: engine"))?.match(/pid (\d+)/)?.[1])
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(report.baseline).toBe("baseline")
    expect(report.comparisons).toMatchObject([{ variant: "prune", fixtures: 1, completionPp: 0, recommended: true }])
    expect(renderMarkdown(report)).toContain("## Recommendation")
  })

  test("an engine that does not start fails its variant only, and bad variants are refused up front", async () => {
    running = fakeEngine()
    const fixture = { version: 1 as const, id: "synthetic", directory: tmpdir(), prompts: ["go"] }
    const report = await runReplay({
      fixtures: [fixture],
      variants: [{ name: "baseline" }, { name: "broken", engineConfig: { compaction: { prune: true } } }],
      repeat: 2,
      engine: running.url,
      isolation: "in-place",
      spawn: { command: ["sh", "-c", "exit 7"], pollMs: 20 },
      pollMs: 1,
      settleMs: 0,
    })
    expect(report.runs.filter((run) => run.variant === "baseline").every((run) => run.status === "ok")).toBe(true)
    expect(report.runs.filter((run) => run.variant === "broken")).toHaveLength(2)
    expect(report.runs.find((run) => run.variant === "broken")!.error).toContain("exited (7)")

    const refused = (variants: Parameters<typeof runReplay>[0]["variants"], spawn?: { command: string[] }) =>
      runReplay({ fixtures: [fixture], variants, engine: running!.url, ...(spawn ? { spawn } : {}) })
    await expect(refused([{ name: "levers", engineConfig: {} }])).rejects.toThrow("needs a spawn command")
    await expect(
      refused([{ name: "levers", engineConfig: {}, engine: "http://127.0.0.1:1" }], { command: ["true"] }),
    ).rejects.toThrow("cannot set engine")
  })

  test("comparisons sum per-fixture means against the baseline and apply the preregistered rule", () => {
    const row = (fixture: string, variant: string, uncached: number, completionRate: number, usd = 1, wallMs = 1000) =>
      ({
        fixture,
        variant,
        runs: 3,
        ok: 3,
        completionRate,
        uncachedInput: stat([uncached]),
        cached: stat([0]),
        output: stat([0]),
        usd: stat([usd]),
        wallMs: stat([wallMs]),
        reproducible: true,
      }) satisfies ReplayAggregate
    const rows = [
      row("a", "baseline", 1000, 1),
      row("b", "baseline", 3000, 1),
      row("a", "smaller", 800, 1, 0.8, 900),
      row("b", "smaller", 2200, 1, 0.8, 900),
      row("a", "lossy", 500, 0.9),
      row("b", "lossy", 1500, 1),
      row("a", "bigger", 1200, 1),
      row("b", "bigger", 3000, 1),
      row("c", "orphan", 1, 1),
    ]
    const result = compare(rows, "baseline")
    expect(result.map((entry) => [entry.variant, entry.recommended])).toEqual([
      ["smaller", true],
      // −5 pp of completion is a regression whatever it saves.
      ["lossy", false],
      ["bigger", false],
    ])
    expect(result[0]).toMatchObject({
      fixtures: 2,
      uncachedInput: { baseline: 4000, variant: 3000, delta: -1000, relative: -0.25 },
      completionPp: 0,
    })
    expect(result[0]!.usd.delta).toBeCloseTo(-0.4)
    expect(result[0]!.wallMs.relative).toBeCloseTo(-0.1)
    expect(result[1]!.completionPp).toBeCloseTo(-5)
  })

  test("a variant's idleMs waits between prompts, outside the wall time, and a bad one is refused", async () => {
    running = fakeEngine()
    const fake = running
    const fixture = {
      version: 1 as const,
      id: "synthetic",
      directory: tmpdir(),
      prompts: ["first", "second", "third"],
    }
    const started = Date.now()
    const report = await runReplay({
      fixtures: [fixture],
      variants: [{ name: "baseline", idleMs: 60 }],
      engine: fake.url,
      repeat: 1,
      pollMs: 1,
      settleMs: 0,
      metricsDelayMs: 0,
    })
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(120)
    expect(fake.seen.prompts.map((prompt) => prompt.text)).toEqual(["first", "second", "third"])
    expect(report.runs[0]!.wallMs).toBeLessThanOrEqual(elapsed - 120)
    await expect(
      runReplay({ fixtures: [fixture], variants: [{ name: "baseline", idleMs: -1 }], engine: fake.url }),
    ).rejects.toThrow("idleMs")
  })

  test("the spread is the largest relative distance from the mean", () => {
    expect(stat([100, 104, 96])).toEqual({ mean: 100, p50: 100, min: 96, max: 104, spread: 0.04 })
    expect(stat([1, 2, 3, 4]).p50).toBe(2.5)
    expect(stat([])).toEqual({ mean: 0, p50: 0, min: 0, max: 0, spread: 0 })
  })
})

/**
 * A throwaway "engine" for the spawn tests: answers health and its config from
 * `OPENCODE_CONFIG_CONTENT`, and forwards everything else to the stub engine, marked as proxied.
 */
const proxyEngine = `
Bun.serve({
  port: {port},
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/global/health") return Response.json({ healthy: true })
    if (url.pathname === "/config") return Response.json(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT))
    const headers = new Headers(request.headers)
    headers.set("x-via", "proxy")
    return fetch(process.env.REPLAY_TARGET + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    })
  },
})
`
