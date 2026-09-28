import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FAILURE_LIMIT } from "../failures"
import {
  EVIDENCE_COMMAND_LIMIT,
  EVIDENCE_FILE_LIMIT,
  MOST_SIGNALS,
  SIGNAL_OUT_LIMIT,
  SIGNAL_PATH_LIMIT,
  episodeEvidence,
  episodeSignals,
  episodeSignalsDirectory,
} from "./signals"

const DIRECTORY = "/work/demo"

// Copied from a real `bun test` run (see failures.test.ts): two failures anchored on the lines the
// stacks point at, which is what a shell's captured tail has to turn into evidence.
const BUN_TEST = `bun test v1.4.2 (744846f84)

src/a.test.ts:
error: expect(received).toBe(expected)

Expected: 3
Received: 2

      at <anonymous> (/work/demo/src/a.test.ts:3:17)
(fail) adds [3.67ms]
error: boom
      at <anonymous> (/work/demo/src/a.test.ts:6:25)
(fail) throws [0.38ms]

 2 fail
Ran 3 tests across 1 file. [23.00ms]`

const dirs: string[] = []
const signalsDir = async () => {
  const dir = mkdtempSync(join(tmpdir(), "flupcode-signals-"))
  dirs.push(dir)
  process.env.FLUPCODE_EPISODE_SIGNALS_DIR = dir
  return dir
}

const writeSignals = (dir: string, sessionID: string, data: unknown) =>
  writeFileSync(join(dir, `${sessionID}.json`), typeof data === "string" ? data : JSON.stringify(data))

afterEach(() => {
  delete process.env.FLUPCODE_EPISODE_SIGNALS_DIR
  delete process.env.XDG_DATA_HOME
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("episodeSignalsDirectory", () => {
  test("follows the env, then XDG, then the home default", () => {
    process.env.FLUPCODE_EPISODE_SIGNALS_DIR = "/custom/signals"
    expect(episodeSignalsDirectory()).toBe("/custom/signals")

    delete process.env.FLUPCODE_EPISODE_SIGNALS_DIR
    process.env.XDG_DATA_HOME = "/xdg"
    expect(episodeSignalsDirectory()).toBe(join("/xdg", "flupcode", "episode-signals"))
  })
})

describe("episodeSignals", () => {
  test("reads the shell evidence and the edit paths a session left", async () => {
    const dir = await signalsDir()
    writeSignals(dir, "ses_a", {
      at: 1,
      calls: [
        { tool: "bash", start: 10, ms: 812, ok: true, exit: 1, command: "bun test", out: BUN_TEST, truncated: false },
        { tool: "edit", start: 20, ms: 14, ok: true, paths: ["/work/demo/src/add.ts"] },
      ],
    })

    const { calls } = episodeSignals("ses_a")
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ tool: "bash", exit: 1, command: "bun test", ok: true })
    expect(calls[0]!.out).toContain("(fail) adds")
    expect(calls[1]).toEqual({ tool: "edit", start: 20, ms: 14, ok: true, paths: ["/work/demo/src/add.ts"] })
  })

  test("a corrupt file, a missing one or an invalid id all read as no signals", async () => {
    const dir = await signalsDir()
    writeSignals(dir, "ses_bad", "{ this is not json")
    expect(episodeSignals("ses_bad")).toEqual({ calls: [] })
    expect(episodeSignals("ses_missing")).toEqual({ calls: [] })
    expect(episodeSignals("../escape")).toEqual({ calls: [] })
  })

  test("unknown fields and malformed entries are ignored, not guessed at", async () => {
    const dir = await signalsDir()
    writeSignals(dir, "ses_a", {
      at: 1,
      extra: "ignored",
      calls: [
        "noise",
        { tool: 3, ok: true },
        { tool: "read", ok: true, future: { nested: true } },
      ],
    })

    expect(episodeSignals("ses_a").calls).toEqual([{ tool: "read", ok: true, paths: [] }])
  })

  test("an absent ok reads as success; only an explicit false is a failure", async () => {
    const dir = await signalsDir()
    writeSignals(dir, "ses_a", {
      calls: [
        { tool: "read", paths: [] },
        { tool: "task", ok: false, paths: [] },
      ],
    })

    const { calls } = episodeSignals("ses_a")
    expect(calls[0]!.ok).toBe(true)
    expect(calls[1]!.ok).toBe(false)
  })

  test("a file past the ring is read back to its newest two hundred calls", async () => {
    const dir = await signalsDir()
    writeSignals(dir, "ses_a", {
      at: 1,
      calls: Array.from({ length: 5000 }, (_, index) => ({
        tool: "bash",
        ok: true,
        exit: 1,
        command: `cmd-${index}`,
        paths: [],
      })),
    })

    // A hand-edit or an older build can leave a longer ring; the reader bounds it to the last
    // entries, matching what the plugin would have kept.
    const { calls } = episodeSignals("ses_a")
    expect(calls).toHaveLength(MOST_SIGNALS)
    expect(calls[0]!.command).toBe("cmd-4800")
    expect(calls[MOST_SIGNALS - 1]!.command).toBe("cmd-4999")
  })

  test("a value past its limit is clamped when it is read back", async () => {
    const dir = await signalsDir()
    writeSignals(dir, "ses_a", {
      calls: [
        {
          tool: "bash",
          ok: true,
          command: "c".repeat(2_000),
          out: "o".repeat(SIGNAL_OUT_LIMIT * 2),
          paths: Array.from({ length: SIGNAL_PATH_LIMIT + 5 }, (_, index) => `src/${index}.ts`),
        },
      ],
    })

    const [call] = episodeSignals("ses_a").calls
    expect(call!.command).toHaveLength(500)
    expect(call!.out).toHaveLength(SIGNAL_OUT_LIMIT)
    expect(call!.paths).toHaveLength(SIGNAL_PATH_LIMIT)
  })
})

describe("episodeEvidence", () => {
  test("derives commands, relative files and failures, and never counts a clean exit", () => {
    const evidence = episodeEvidence(
      [
        { tool: "bash", ok: true, exit: 1, command: "bun test", out: BUN_TEST, paths: [] },
        { tool: "bash", ok: true, exit: 0, command: "bun test", out: "src/a.test.ts:1:1: would be noise", paths: [] },
        { tool: "edit", ok: true, paths: ["/work/demo/src/add.ts"] },
        { tool: "edit", ok: true, paths: ["/work/demo/src/add.ts"] },
      ],
      DIRECTORY,
    )

    expect(evidence.commands).toEqual(["bun test"])
    expect(evidence.files).toEqual(["src/add.ts"])
    expect(evidence.failures).toHaveLength(2)
    expect(evidence.failures[0]).toMatchObject({ summary: "expect(received).toBe(expected)", file: "src/a.test.ts", line: 3 })
  })

  test("a shell with no exit is still read; the failures it printed are evidence", () => {
    const evidence = episodeEvidence(
      [{ tool: "bash", ok: true, command: "bun test", out: BUN_TEST, paths: [] }],
      DIRECTORY,
    )
    expect(evidence.failures).toHaveLength(2)
  })

  test("a session's file with a red shell and an edit becomes commands, files and failures", async () => {
    // The ticket's acceptance, all the way through: one signal file carries the failing test and the
    // edit it should anchor to, the reader returns both calls, and the evidence names the command,
    // the relative file and the failures.
    const dir = await signalsDir()
    writeSignals(dir, "ses_a", {
      at: 1,
      calls: [
        { tool: "bash", ok: true, exit: 1, command: "bun test", out: BUN_TEST, paths: [] },
        { tool: "edit", ok: true, paths: ["/work/demo/src/add.ts"] },
      ],
    })

    const { calls } = episodeSignals("ses_a")
    const evidence = episodeEvidence(calls, DIRECTORY)

    expect(evidence.commands).toEqual(["bun test"])
    expect(evidence.files).toEqual(["src/add.ts"])
    expect(evidence.failures).toHaveLength(2)
    expect(evidence.failures[0]).toMatchObject({ file: "src/a.test.ts", line: 3 })
  })

  test("a failure repeated across calls is kept once, keyed by file, line and summary", () => {
    const red = { tool: "bash" as const, ok: true, exit: 1, command: "bun test", out: BUN_TEST, paths: [] }
    const evidence = episodeEvidence([red, { ...red }, { ...red }], DIRECTORY)

    expect(evidence.commands).toEqual(["bun test"])
    expect(evidence.failures).toHaveLength(2)
  })

  test("failures are capped without losing the file and line of the first", () => {
    const out = Array.from(
      { length: FAILURE_LIMIT + 5 },
      (_, index) => `error: boom-${index}\n      at <anonymous> (/work/demo/src/f${index}.test.ts:${index + 1}:1)\n(fail) t${index}`,
    ).join("\n")
    const evidence = episodeEvidence([{ tool: "bash", ok: true, exit: 1, command: "bun test", out, paths: [] }], DIRECTORY)

    expect(evidence.failures).toHaveLength(FAILURE_LIMIT)
    expect(evidence.failures[0]).toMatchObject({ file: "src/f0.test.ts", line: 1 })
  })

  test("commands and files are capped without repeating", () => {
    const commands = Array.from({ length: EVIDENCE_COMMAND_LIMIT + 5 }, (_, index) => ({
      tool: "bash",
      ok: true,
      exit: 1,
      command: `run-${index}`,
      paths: [],
    }))
    const evidence = episodeEvidence(
      [
        ...commands,
        { tool: "bash", ok: true, exit: 1, command: "run-0", paths: [] },
        {
          tool: "edit",
          ok: true,
          paths: Array.from({ length: EVIDENCE_FILE_LIMIT + 10 }, (_, index) => `/work/demo/src/${index}.ts`),
        },
      ],
      DIRECTORY,
    )
    expect(evidence.commands).toHaveLength(EVIDENCE_COMMAND_LIMIT)
    expect(evidence.files).toHaveLength(EVIDENCE_FILE_LIMIT)
  })
})
