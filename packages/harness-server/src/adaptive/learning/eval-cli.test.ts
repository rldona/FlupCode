import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "../../repository"
import { evidenceHash } from "../evidence"
import type { EvalRun } from "./eval"

let root = ""
let database = ""
let signals = ""

const CLI = join(import.meta.dir, "eval-cli.ts")

// A synthetic database only: 12 episodes that clear the gate across three projects and outcomes, two
// that do not, one open one, evidence for each, and one fix → verify trace for the heuristic.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-reflection-eval-"))
  database = join(root, "harness.sqlite")
  signals = join(root, "signals")
  mkdirSync(signals, { recursive: true })
  const repository = new SqliteRoutineRepository(database)
  const projects = ["/work/alpha", "/work/beta", "/work/gamma"]
  const outcomes = ["success", "partial", "failed"] as const
  Array.from({ length: 15 }, (_, index) => index).forEach((index) => {
    const id = `episode:session:ses_${index}`
    repository.createEpisode(
      {
        id,
        sessionID: `ses_${index}`,
        projectID: projects[index % 3]!,
        objective: `Fix the math test ${index}`,
        toolCalls: index >= 12 ? 2 : 9,
        files: ["src/math.ts"],
        commands: ["bun test src/math.test.ts"],
        failures: [{ summary: "expected 3, received 4", file: "src/math.test.ts", line: 3 }],
        verifications: [],
        outcome: outcomes[Math.floor(index / 3) % 3]!,
        startedAt: 1_000 + index * 10_000,
        ...(index === 14 ? {} : { endedAt: 9_000 + index * 10_000 }),
        evidenceRefs: [`session:ses_${index}`],
      },
      9_000 + index * 10_000,
    )
    const content = `bun test src/math.test.ts failed in run ${index}`
    repository.putEvidence({ content })
    repository.setEpisodeEvidence(id, [{ hash: evidenceHash(content), kind: "signal", position: 0 }])
  })
  repository.close()
  writeFileSync(
    join(signals, "ses_0.json"),
    JSON.stringify({
      calls: [
        { tool: "bash", command: "bun test src/math.test.ts", exit: 1, ok: true, paths: [], start: 2_000 },
        { tool: "edit", ok: true, paths: ["/work/alpha/src/math.ts"], start: 3_000 },
        { tool: "bash", command: "bun test src/math.test.ts", exit: 0, ok: true, paths: [], start: 4_000 },
      ],
    }),
  )
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** The CLI with an empty home and config, so the user's own settings are never read, and CI unset. */
const run = (args: string[], env: Record<string, string> = {}) => {
  const result = Bun.spawnSync(["bun", CLI, ...args], {
    env: {
      ...process.env,
      CI: "",
      FLUPCODE_EPISODE_SIGNALS_DIR: signals,
      FLUPCODE_HARNESS_DB: database,
      XDG_CONFIG_HOME: join(root, "config"),
      OPENCODE_TEST_HOME: join(root, "home"),
      ...env,
    },
  })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

test("select samples eligible episodes deterministically, writes the sheet and leaves the database untouched", () => {
  const before = readFileSync(database)
  const first = run(["select", "--db", database, "--out", join(root, "run-a")])
  expect(first.stderr).toBe("")
  expect(first.code).toBe(0)
  const second = run(["select", "--db", database, "--out", join(root, "run-b")])
  expect(second.code).toBe(0)
  // Read-only: the database file is byte-identical and no journal was left behind.
  expect(readFileSync(database).equals(before)).toBe(true)
  expect(readdirSync(root).filter((name) => name.startsWith("harness.sqlite-"))).toEqual([])

  const a = JSON.parse(readFileSync(join(root, "run-a", "run.json"), "utf8")) as EvalRun
  const b = JSON.parse(readFileSync(join(root, "run-b", "run.json"), "utf8")) as EvalRun
  expect(a.population).toEqual({ closed: 14, eligible: 12, projects: 3 })
  expect(a.episodes).toHaveLength(12)
  expect(a.episodes.map((episode) => episode.episodeID)).toEqual(b.episodes.map((episode) => episode.episodeID))
  expect(a.episodes.every((episode) => episode.evidence.evidenceSlices === 1)).toBe(true)
  expect(a.withModel).toBe(false)
  const fixed = a.episodes.find((episode) => episode.episodeID === "episode:session:ses_0")!
  expect(fixed.proposals).toMatchObject([{ source: "heuristic", modelVersion: "heuristic/fix-verify" }])
  expect(fixed.skipped).toEqual([{ source: "model", reason: "not-run" }])
  expect(readFileSync(join(root, "run-a", "review.html"), "utf8")).toContain(a.runID)
  const template = JSON.parse(readFileSync(join(root, "run-a", "answers.template.json"), "utf8"))
  expect(Object.keys(template.answers)).toContain("episode:session:ses_0#heuristic")

  const smaller = run(["select", "--db", database, "--limit", "5", "--seed", "other", "--out", join(root, "run-c")])
  expect(smaller.code).toBe(0)
  expect((JSON.parse(readFileSync(join(root, "run-c", "run.json"), "utf8")) as EvalRun).episodes).toHaveLength(5)
})

test("the model path without --yes prints the plan and writes nothing", () => {
  const out = join(root, "planned")
  const result = run(["select", "--db", database, "--with-model", "--model", "test/small", "--engine", "http://127.0.0.1:9", "--out", out])
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("Plan: 12 episodes → 12 classifications and at most 12 drafts")
  expect(result.stdout).toContain("--yes")
  expect(existsSync(out)).toBe(false)
})

test("the model path refuses to run under CI, even with --yes", () => {
  const out = join(root, "ci")
  const result = run(["select", "--db", database, "--with-model", "--yes", "--model", "test/small", "--out", out], { CI: "true" })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("never runs in CI")
  expect(existsSync(out)).toBe(false)
})

test("the model path without a model says so and writes nothing", () => {
  const out = join(root, "no-model")
  const result = run(["select", "--db", database, "--with-model", "--yes", "--out", out])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("No model")
  expect(existsSync(out)).toBe(false)
})

test("report reads the answers, prints the decision and writes report.md next to the run", () => {
  const dir = join(root, "run")
  expect(run(["select", "--db", database, "--out", dir]).code).toBe(0)
  const template = JSON.parse(readFileSync(join(dir, "answers.template.json"), "utf8"))
  const answersFile = join(root, "answers.json")
  writeFileSync(
    answersFile,
    JSON.stringify({
      ...template,
      answers: Object.fromEntries(
        Object.keys(template.answers).map((key) => [
          key,
          { correct: true, useful: true, safe: true, specific: true, wellScoped: true, verdict: "approve" },
        ]),
      ),
    }),
  )
  const result = run(["report", "--answers", answersFile])
  expect(result.stderr).toBe("")
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("Suggested decision:")
  expect(existsSync(join(dir, "report.md"))).toBe(true)
  expect(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).episodes).toBe(12)
})
