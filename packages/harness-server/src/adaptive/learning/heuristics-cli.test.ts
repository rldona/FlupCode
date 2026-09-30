import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "../../repository"

let root = ""

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

test("the review CLI prints candidates from a database it opens read-only", () => {
  root = mkdtempSync(join(tmpdir(), "flupcode-heuristics-cli-"))
  const database = join(root, "harness.sqlite")
  const signals = join(root, "signals")
  mkdirSync(signals, { recursive: true })
  const repository = new SqliteRoutineRepository(database)
  repository.createEpisode(
    {
      id: "episode:session:ses_cli",
      sessionID: "ses_cli",
      projectID: "/work/proj",
      objective: "Fix the math test",
      toolCalls: 9,
      files: ["src/math.ts"],
      commands: ["bun test src/math.test.ts"],
      failures: [{ summary: "expected 3, received 4", file: "src/math.test.ts", line: 3 }],
      verifications: [],
      outcome: "partial",
      startedAt: 1_000,
      endedAt: 9_000,
      evidenceRefs: ["session:ses_cli"],
    },
    9_000,
  )
  repository.close()
  writeFileSync(
    join(signals, "ses_cli.json"),
    JSON.stringify({
      calls: [
        { tool: "bash", command: "bun test src/math.test.ts", exit: 1, ok: true, paths: [], start: 2_000 },
        { tool: "edit", ok: true, paths: ["/work/proj/src/math.ts"], start: 3_000 },
        { tool: "bash", command: "bun test src/math.test.ts", exit: 0, ok: true, paths: [], start: 4_000 },
      ],
    }),
  )
  const before = readFileSync(database)

  const result = Bun.spawnSync(["bun", join(import.meta.dir, "heuristics-cli.ts"), "--db", database, "--json"], {
    env: { ...process.env, FLUPCODE_EPISODE_SIGNALS_DIR: signals },
  })
  expect(result.exitCode).toBe(0)
  const output = JSON.parse(result.stdout.toString()) as { episodes: number; candidates: Array<{ name: string; pattern: string }> }
  expect(output.episodes).toBe(1)
  expect(output.candidates).toMatchObject([{ name: "fix-bun-test-src-math-test-ts", pattern: "fix-verify" }])
  // Read-only: the database file is byte-identical afterwards.
  expect(readFileSync(database).equals(before)).toBe(true)
})
