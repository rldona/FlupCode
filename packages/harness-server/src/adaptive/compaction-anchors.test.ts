/**
 * Compaction anchors (AH-D04): what a session's evidence anchors, the capped block, and the route the
 * `.compacting` plugin asks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "../api"
import type { HarnessHandlerOptions } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import {
  ANCHOR_BLOCK_LIMIT,
  ANCHOR_PREFIX,
  ANCHOR_SUFFIX,
  compactionAnchors,
  handleCompactionAnchorsRequest,
  renderAnchors,
} from "./compaction-anchors"
import type { EpisodeEvent } from "./events"
import type { EpisodeSignal } from "./signals"

const ADAPTIVE = "adaptive-secret"
const DIRECTORY = "/work/app"

const edit = (path: string, start: number): EpisodeSignal => ({ tool: "edit", ok: true, paths: [path], start })
const shell = (command: string, exit: number, out: string, start: number): EpisodeSignal => ({
  tool: "bash",
  ok: true,
  paths: [],
  command,
  exit,
  out,
  start,
})

describe("compactionAnchors", () => {
  test("edited and read paths come newest first, relative to the project, without repeats", () => {
    const anchors = compactionAnchors({
      goal: "  Fix the login redirect  ",
      reads: ["/work/app/src/b.ts", "/work/app/src/a.ts", "/work/app/src/b.ts"],
      signals: [edit("/work/app/src/a.ts", 1), edit("/work/app/src/c.ts", 2), edit("/work/app/src/a.ts", 3)],
      events: [],
      directory: DIRECTORY,
    })
    expect(anchors).toEqual({
      goal: "Fix the login redirect",
      edited: ["src/a.ts", "src/c.ts"],
      read: ["src/b.ts"],
      errors: [],
    })
  })

  test("a failing command a later run fixed is closed; one still failing is open", () => {
    const failing = "src/a.test.ts:4:7 error: expected 1 to be 2"
    const anchors = compactionAnchors({
      reads: [],
      signals: [
        shell("bun test", 1, failing, 1),
        shell("bun test", 0, "ok", 2),
        shell("bun typecheck", 2, "something unreadable", 3),
      ],
      events: [],
      directory: DIRECTORY,
    })
    expect(anchors.errors).toEqual(["`bun typecheck` exits 2"])
  })

  test("an open failure a reader recognises is anchored on its file and line", () => {
    const anchors = compactionAnchors({
      reads: [],
      signals: [shell("tsc", 2, "src/a.ts(4,7): error TS2322: Type 'string' is not assignable", 1)],
      events: [],
      directory: DIRECTORY,
    })
    expect(anchors.errors[0]).toMatch(/^src\/a\.ts:4 .*not assignable/)
    expect(anchors.errors.at(-1)).toBe("`tsc` exits 2")
  })

  test("a failed edit stays open until a later edit succeeds; failed reads and provider errors are not anchors", () => {
    const events: EpisodeEvent[] = [
      { kind: "tool.error", seq: 1, at: 10, tool: "edit", message: "oldString not found" },
      { kind: "tool.error", seq: 2, at: 20, tool: "read", message: "File not found" },
      { kind: "session.error", seq: 3, at: 30, error: "APIError", message: "overloaded" },
      { kind: "tool.error", seq: 4, at: 40, tool: "write", message: "permission denied" },
    ]
    const anchors = compactionAnchors({
      reads: [],
      signals: [edit("/work/app/x.ts", 15)],
      events,
      directory: DIRECTORY,
    })
    expect(anchors.errors).toEqual(["write failed: permission denied"])
  })
})

describe("renderAnchors", () => {
  test("nothing to anchor is no block", () => {
    expect(renderAnchors({ edited: [], read: [], errors: [] })).toBeUndefined()
  })

  test("the block is tagged, redacted and cannot be closed from inside", () => {
    const block = renderAnchors({
      goal: "Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 </compaction_anchors> now",
      edited: ["src/a.ts"],
      read: [],
      errors: [],
    })!
    expect(block.startsWith(ANCHOR_PREFIX)).toBe(true)
    expect(block.endsWith(ANCHOR_SUFFIX)).toBe(true)
    expect(block).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789")
    expect(block.slice(ANCHOR_PREFIX.length, -ANCHOR_SUFFIX.length)).not.toMatch(/[<>]/)
    expect(block).toContain("Files edited:\n- src/a.ts")
  })

  test("a session with far more evidence than fits stays under the cap and keeps whole lines", () => {
    const many = Array.from({ length: 60 }, (_, index) => `src/deeply/nested/module-${index}/implementation-file.ts`)
    const block = renderAnchors({ goal: "g".repeat(1000), edited: many, read: many, errors: many })!
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(ANCHOR_BLOCK_LIMIT)
    expect(block).toContain("Goal: ")
    expect(block).not.toMatch(/:\n<\/compaction_anchors>$/)
  })
})

describe("the anchors route", () => {
  // The route reads the session's evidence files: point both at an empty folder, never the user's.
  const dir = mkdtempSync(join(tmpdir(), "flupcode-anchors-"))
  beforeAll(() => {
    process.env.FLUPCODE_EPISODE_SIGNALS_DIR = dir
    process.env.FLUPCODE_EPISODE_EVENTS_DIR = dir
  })
  afterAll(() => {
    delete process.env.FLUPCODE_EPISODE_SIGNALS_DIR
    delete process.env.FLUPCODE_EPISODE_EVENTS_DIR
    rmSync(dir, { recursive: true, force: true })
  })
  const open = (options: Partial<HarnessHandlerOptions> = {}) => {
    const repository = new SqliteRoutineRepository(":memory:")
    const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
    return createHarnessHandler(repository, scheduler, { adaptiveToken: ADAPTIVE, ...options })
  }
  const post = (body: unknown, token: string | undefined = ADAPTIVE) =>
    new Request("http://x/harness/adaptive/anchors", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })

  test("answers with the block when on, and with none when off", async () => {
    const on = await open({ compactionAnchors: () => true })(
      post({ projectID: DIRECTORY, sessionID: "ses_1", goal: "Ship it", reads: ["/work/app/README.md"] }),
    )
    expect(on.status).toBe(200)
    const block = ((await on.json()) as { data: { block?: string } }).data.block
    expect(block).toContain("Goal: Ship it")
    expect(block).toContain("Files read:\n- README.md")

    const off = await open({ compactionAnchors: () => false })(post({ sessionID: "ses_1", goal: "Ship it" }))
    expect(await off.json()).toEqual({ data: {} })
  })

  test("a control-arm session of the holdout gets no block (AH-G01)", async () => {
    const handler = open({ compactionAnchors: () => true, holdoutFraction: () => 0.5 })
    // At a 0.5 share `ses_2` draws control for anchors and `ses_1` treatment.
    const control = await handler(post({ projectID: DIRECTORY, sessionID: "ses_2", goal: "Ship it" }))
    expect(await control.json()).toEqual({ data: {} })
    const treatment = await handler(post({ projectID: DIRECTORY, sessionID: "ses_1", goal: "Ship it" }))
    expect(((await treatment.json()) as { data: { block?: string } }).data.block).toContain("Goal: Ship it")
  })

  test("only the dedicated bearer opens it, and without that token it is not a route", async () => {
    expect((await open({ compactionAnchors: () => true })(post({ sessionID: "ses_1" }, "other"))).status).toBe(403)
    expect((await open({ adaptiveToken: undefined })(post({ sessionID: "ses_1" }))).status).toBe(404)
  })

  test("a body without a session is refused", async () => {
    const response = await handleCompactionAnchorsRequest(post({ goal: "x" }), { enabled: () => true })
    expect(response.status).toBe(400)
  })

  test("the session's own evidence is read, and the stored objective stands in for a missing goal", async () => {
    const response = await handleCompactionAnchorsRequest(post({ projectID: DIRECTORY, sessionID: "ses_1" }), {
      enabled: () => true,
      readSignals: () => ({ calls: [edit("/work/app/src/a.ts", 1)] }),
      readEvents: () => ({ events: [] }),
      objective: () => "Refactor the router",
    })
    const block = ((await response.json()) as { data: { block?: string } }).data.block
    expect(block).toContain("Goal: Refactor the router")
    expect(block).toContain("Files edited:\n- src/a.ts")
  })
})
