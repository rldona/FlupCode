/**
 * The live evaluation (AH-G02) on synthetic data only: the CLI never writes the database it reads,
 * `start` changes no setting, sessions split by the arm they recorded, and the criteria reach every
 * decision the table allows.
 */

import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "@flupcode/harness-server/repository"
import { resolveAdaptiveConfig } from "@flupcode/harness-server/adaptive/config"
import { HOLDOUT_CAPABILITIES } from "@flupcode/harness-server/adaptive/holdout"
import type { Arm } from "@flupcode/harness-server/adaptive/holdout"
import type { ReplayReport, ReplayRun, ReplayVariant } from "@flupcode/harness-server/replay/runner"
import { main, startFile } from "./cli"
import { configSnapshot, etaDays, evaluate, loadDataset } from "./live-eval"
import type { Dataset, DecisionUnit, PriorSession, ProposalUnit, SessionUnit } from "./live-eval"
import { replayEvidence } from "./replay-evidence"

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.parse("2026-10-01T00:00:00Z")
const dirs: string[] = []
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-live-eval-"))
  dirs.push(dir)
  return dir
}

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
const armsJSON = (arm: Arm) => JSON.stringify(Object.fromEntries(HOLDOUT_CAPABILITIES.map((capability) => [capability, arm])))

/** A harness database with the real schema and a handful of rows, written before the CLI opens it. */
function syntheticDatabase() {
  const dir = temp()
  const path = join(dir, "harness.sqlite")
  new SqliteRoutineRepository(path).close()
  const db = new Database(path)
  const turn = db.query(
    `INSERT INTO session_metrics (session_id, turn_id, turn, input_tokens, cost, tool_calls, tool_errors, tools_json,
       compactions, skills_json, started_at, ended_at, arms_json, rereads_after_compaction, summary_tokens)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, '[]', ?9, ?10, ?11, 0, 0)`,
  )
  const episode = db.query(
    `INSERT INTO session_episodes (id, session_id, project_id, objective, outcome, verifications_json, started_at, ended_at, created_at, updated_at)
     VALUES (?1, ?2, '/p', 'x', ?3, '[]', ?4, ?5, ?4, ?5)`,
  )
  const decision = db.query(
    `INSERT INTO adaptive_decision (id, session_id, kind, inputs_hash, answer_json, baseline_answer_json, baseline_rule,
       provider, source, arm, label, latency_ms, created_at, updated_at)
     VALUES (?1, ?2, 'skillRelevance', 'h', '{"load":["a"]}', '{"load":[]}', 'rule', 'baseline', 'baseline', ?3, ?4, 3, ?5, ?5)`,
  )
  db.transaction(() => {
    Array.from({ length: 20 }, (_, index) => {
      const sessionID = `ses_${index}`
      const arm: Arm = index % 2 === 0 ? "control" : "treatment"
      const at = T0 + DAY + index * 60_000
      turn.run(sessionID, `${sessionID}_t1`, 1, 1000 + index, 0.01, 3, '{"evidence_read":{"calls":1,"errors":0,"bytes":10}}', 0, at, at + 5_000, armsJSON(arm))
      turn.run(sessionID, `${sessionID}_t2`, 2, 500, 0.005, 1, "{}", 1, at + 10_000, at + 12_000, null)
      episode.run(`ep_${index}`, sessionID, index % 3 === 0 ? "failed" : "success", at, at + 20_000)
      decision.run(`skillRelevance:${sessionID}:${sessionID}_t1`, sessionID, arm, '{"outcome":"correct","source":"skill-loads"}', at)
    })
    // A session from before the holdout recorded arms, and one from before the window.
    turn.run("ses_old_arms", "t1", 1, 999, 0.01, 1, "{}", 0, T0 + 2 * DAY, T0 + 2 * DAY + 1_000, null)
    turn.run("ses_before", "t1", 1, 999, 0.01, 1, "{}", 0, T0 - DAY, T0 - DAY + 1_000, armsJSON("control"))
    db.query(`INSERT INTO tool_evidence (session_id, ref, hash, tool, created_at) VALUES ('ses_1', 'r1', 'h1', 'bash', ?1)`).run(T0 + DAY)
  })()
  db.close()
  const events = join(dir, "events")
  mkdirSync(events)
  writeFileSync(
    join(events, "ses_1.json"),
    JSON.stringify({ events: [{ kind: "session.error", seq: 1, at: T0 + DAY + 60_000 + 1_000, error: "APIError", message: "boom" }] }),
  )
  const config = join(dir, "adaptive.json")
  writeFileSync(config, JSON.stringify({ toolTrim: { enabled: true }, holdout: { fraction: 0.5 } }))
  return { dir, path, events, config }
}

describe("eval:live on a synthetic database", () => {
  test("start records the window and a config snapshot, changes nothing else, and will not move", async () => {
    const fixture = syntheticDatabase()
    const before = { db: digest(fixture.path), config: digest(fixture.config), files: readdirSync(fixture.dir).toSorted() }
    const lines: string[] = []
    expect(await main(["start", "--db", fixture.path, "--config", fixture.config], (line) => lines.push(line), T0)).toBe(0)
    const record = JSON.parse(readFileSync(startFile(fixture.path), "utf8"))
    expect(record).toMatchObject({ startedAt: T0, criteria: "ADR-0025", config: { holdoutFraction: 0.5 } })
    expect(record.config.capabilities.toolTrim).toBe(true)
    expect(lines.join("\n")).toContain("No setting was changed")
    expect(lines.some((line) => line.startsWith("[x] Tool-output trim"))).toBe(true)
    expect(lines.some((line) => line.startsWith("[ ] Per-step selection"))).toBe(true)
    expect(digest(fixture.path)).toBe(before.db)
    expect(digest(fixture.config)).toBe(before.config)
    expect(readdirSync(fixture.dir).toSorted()).toEqual([...before.files, "live-eval"].toSorted())

    const again: string[] = []
    expect(await main(["start", "--db", fixture.path, "--config", fixture.config], (line) => again.push(line), T0 + DAY)).toBe(1)
    expect(JSON.parse(readFileSync(startFile(fixture.path), "utf8")).startedAt).toBe(T0)
    expect(await main(["start", "--db", fixture.path, "--config", fixture.config, "--force"], () => {}, T0 + DAY)).toBe(0)
    expect(JSON.parse(readFileSync(startFile(fixture.path), "utf8")).startedAt).toBe(T0 + DAY)
  })

  test("status and report never write the database, and status shows no effect estimate", async () => {
    const fixture = syntheticDatabase()
    await main(["start", "--db", fixture.path, "--config", fixture.config], () => {}, T0)
    const before = digest(fixture.path)
    // The store runs in WAL (RP-02): a reader may leave the shared-memory index and an empty log
    // beside the file, which writes nothing.
    const listed = () => readdirSync(fixture.dir).filter((name) => !/\.sqlite-(shm|wal)$/.test(name)).toSorted()
    const files = listed()

    const lines: string[] = []
    const args = ["--db", fixture.path, "--config", fixture.config, "--events", fixture.events]
    expect(await main(["status", ...args], (line) => lines.push(line), T0 + 3 * DAY)).toBe(0)
    const text = lines.join("\n")
    expect(text).toContain("Tool-output trim — enabled")
    expect(text).toContain("sessions: control 10, treatment 10; episodes: control 10, treatment 10")
    // Ten sessions per arm in three days: 140 more take ~42 days, past the cap.
    expect(text).toContain(
      "sessions: control 10, treatment 10 of 150 per arm (6%) — at the current pace the minimum is reached in ~42 days, after the 42-day cap: expect insufficient data",
    )
    expect(text).toContain("paired replay fixtures (3 repetitions per variant): 0 of 22 (0%) — from the replay report")
    expect(text).toContain("primary decided by replay: `bun run replay -- --variants fixtures/replay/variants/tool-trim.json --repeat 3 --yes`")
    expect(text).toContain("skillRelevance: 20/20 labelled, 20 judged")
    expect(text).not.toMatch(/Δ|\d+% CI/)

    const out = join(temp(), "report")
    expect(await main(["report", ...args, "--out", out], () => {}, T0 + 3 * DAY)).toBe(0)
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"))
    expect(readFileSync(join(out, "report.md"), "utf8")).toContain("The decision is a person's (AH-G03)")
    // Three days and ten sessions per arm: nothing may be read yet, so only safety checks are shown.
    for (const capability of report.capabilities) {
      expect(capability.decision).toBe("insufficient data")
      expect(capability.withheld).toBe(true)
      expect(capability.checks.every((check: { role: string }) => check.role === "safety")).toBe(true)
    }
    expect(digest(fixture.path)).toBe(before)
    expect(listed()).toEqual(files)
    const wal = `${fixture.path}-wal`
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0)
  })

  test("without a start or --since it refuses, and a missing database is an error", async () => {
    const fixture = syntheticDatabase()
    const lines: string[] = []
    expect(await main(["status", "--db", fixture.path, "--config", fixture.config], (line) => lines.push(line), T0)).toBe(1)
    expect(lines[0]).toContain("No start recorded")
    expect(await main(["report", "--db", join(fixture.dir, "missing.sqlite")], () => {}, T0)).toBe(1)
    expect(existsSync(join(fixture.dir, "missing.sqlite"))).toBe(false)
  })

  test("--replay reads a report run after start, refuses an earlier one, and the window stops at the cap", async () => {
    const fixture = syntheticDatabase()
    await main(["start", "--db", fixture.path, "--config", fixture.config], () => {}, T0)
    const write = (startedAt: number) => {
      const file = join(temp(), "report.json")
      writeFileSync(file, JSON.stringify({ ...replayReport(TRIM_VARIANTS, trimRuns(25, 0.7)), startedAt }))
      return file
    }
    const args = ["--db", fixture.path, "--config", fixture.config, "--events", fixture.events]
    const refused: string[] = []
    expect(await main(["report", ...args, "--replay", write(T0 - DAY)], (line) => refused.push(line), T0 + 3 * DAY)).toBe(1)
    expect(refused[0]).toContain("ran before the evaluation started")

    const out = join(temp(), "report")
    const late: string[] = []
    expect(await main(["report", ...args, "--replay", write(T0 + DAY), "--out", out], (line) => late.push(line), T0 + 50 * DAY)).toBe(0)
    expect(late[0]).toContain("The window is capped at 42 days")
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"))
    expect(report.window).toMatchObject({ until: T0 + 42 * DAY, complete: true, capped: true })
    const trim = report.capabilities.find((result: { id: string }) => result.id === "toolTrim")
    expect(trim.replay).toMatchObject({ variant: "tool-trim", fixtures: 25 })
    expect(trim.samples.replayFixtures).toEqual({ overall: 25 })
    // Ten sessions per arm by the cap: final, not "wait longer".
    expect(trim.decision).toBe("insufficient data")
    expect(trim.reasons).toEqual(["below 150 sessions per arm", "the 6-week cap passed: final, the window is not extended"])
    expect(readFileSync(join(out, "report.md"), "utf8")).toContain("Primary decided by replay:")

    const twice: string[] = []
    expect(await main(["status", ...args, "--replay", write(T0 + DAY), "--replay", write(T0 + DAY)], (line) => twice.push(line), T0 + 3 * DAY)).toBe(1)
    expect(twice[0]).toContain("More than one replay report measures toolTrim")
  })

  test("sessions split by the arm their first turn recorded; one without an arm is left out", () => {
    const fixture = syntheticDatabase()
    const db = new Database(fixture.path, { readonly: true })
    const dataset = loadDataset(db, { since: T0, until: T0 + 15 * DAY }, fixture.events, T0 + 15 * DAY)
    db.close()
    expect(dataset.sessions.map((unit) => unit.sessionID)).not.toContain("ses_before")
    const report = evaluate({ dataset, snapshot: configSnapshot(resolveAdaptiveConfig({ env: {} })), now: T0 })
    const trim = report.capabilities.find((result) => result.id === "toolTrim")!
    expect(trim.arms).toEqual({ control: 10, treatment: 10, excluded: 1 })
    const ses1 = dataset.sessions.find((unit) => unit.sessionID === "ses_1")!
    expect(ses1).toMatchObject({ turns: 2, uncachedInput: 1501, toolCalls: 4, evidenceReads: 1, trimmed: 1, completion: true, compactions: 1 })
    // The provider error fell in the first turn, so one of two turns had an error.
    expect(ses1.errorTurns).toBe(1)
    expect(dataset.sessions.find((unit) => unit.sessionID === "ses_0")!.completion).toBe(false)
  })
})

// ---- the criteria applied, on in-memory datasets ---------------------------------------------------

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    const mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    const next = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

function session(index: number, arm: Arm, overrides: Partial<SessionUnit> = {}): SessionUnit {
  return {
    sessionID: `ses_${arm}_${index}`,
    arms: Object.fromEntries(HOLDOUT_CAPABILITIES.map((capability) => [capability, arm])),
    turns: 4,
    uncachedInput: 1000,
    usd: 0.1,
    toolCalls: 10,
    errorTurns: 0,
    turnMs: [1000, 2000],
    compactions: 0,
    rereads: 0,
    summaryTokens: 0,
    evidenceReads: 0,
    trimmed: 10,
    episodes: 1,
    completion: true,
    pairingErrors: 0,
    ...overrides,
  }
}

const snapshot = configSnapshot(resolveAdaptiveConfig({ block: { toolTrim: { enabled: true } }, env: {} }))
const window = (days: number) => ({ since: T0, until: T0 + days * DAY })
const dataset = (input: Partial<Dataset> & { days?: number }): Dataset => ({
  window: window(input.days ?? 15),
  sessions: input.sessions ?? [],
  prior: input.prior ?? [],
  decisions: input.decisions ?? [],
  proposals: input.proposals ?? [],
  coverage: [],
})
const decisionOf = (report: ReturnType<typeof evaluate>, id: string, instance?: string) =>
  report.capabilities.find((result) => result.id === id && (instance === undefined || result.instance?.startsWith(instance)))!

/** 1,400 sessions × 2,000 resamples per metric take about a second per report on a laptop. */
const HEAVY_MS = 30_000

/** A replay report: `variants`, three repetitions per fixture, written by `bun run replay`. */
function replayReport(variants: ReplayVariant[], runs: ReplayRun[]): ReplayReport {
  return {
    version: 1,
    startedAt: T0 + DAY,
    finishedAt: T0 + DAY,
    engine: "http://127.0.0.1:0",
    repeat: 3,
    seed: null,
    tolerance: 0.05,
    isolation: "worktree",
    variants,
    baseline: variants[0]!.name,
    runs,
    aggregates: [],
    comparisons: [],
  }
}

const TRIM_VARIANTS: ReplayVariant[] = [
  { name: "baseline", adaptive: { toolTrim: { enabled: false } } },
  { name: "tool-trim", adaptive: { toolTrim: { enabled: true } } },
]

/** `count` fixtures on which the treatment spends `factor` (± a little) of the baseline's uncached input. */
function trimRuns(count: number, factor: number): ReplayRun[] {
  return Array.from({ length: count }, (_, index) => index).flatMap((index) =>
    [1, 2, 3].flatMap((repetition) =>
      [
        ["baseline", 1],
        ["tool-trim", factor + (index % 3) * 0.02],
      ].map(([variant, scale]) => ({
        fixture: `fx-${index}`,
        variant: variant as string,
        repetition,
        status: "ok" as const,
        tokens: { input: 5000 * (index + 1) * (scale as number), cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        usd: 0.1,
        wallMs: 1000,
        source: "session_metrics" as const,
        turnErrors: 0,
        completed: true,
      })),
    ),
  )
}

const trimReplay = (factor: number) => ({ toolTrim: replayEvidence(replayReport(TRIM_VARIANTS, trimRuns(25, factor)), "trim.json")[0]!.evidence })

describe("the criteria applied to a synthetic evaluation", () => {
  const next = random(7)
  // 160 sessions per arm: the budget, with a little room.
  const arms = (treatment: (index: number) => Partial<SessionUnit>) => [
    ...Array.from({ length: 160 }, (_, index) => session(index, "control", { uncachedInput: 500 + next() * 1000 })),
    ...Array.from({ length: 160 }, (_, index) => session(index, "treatment", { uncachedInput: 350 + next() * 700, ...treatment(index) })),
  ]

  test("a clear replay cut with safe live guardrails promotes the trim; without the replay it waits", () => {
    const report = evaluate({ dataset: dataset({ sessions: arms(() => ({})) }), snapshot, replay: trimReplay(0.7), now: T0 })
    const trim = decisionOf(report, "toolTrim")
    expect(trim.decision).toBe("promote")
    const primary = trim.checks.find((check) => check.role === "primary")!
    expect(primary.key).toBe("uncachedInputPerSession:paired")
    expect(primary.estimate!).toBeLessThan(-0.25)
    expect(primary.high!).toBeLessThan(-0.15)
    expect(trim.replay).toMatchObject({ file: "trim.json", fixtures: 25 })

    const without = decisionOf(evaluate({ dataset: dataset({ sessions: arms(() => ({})) }), snapshot, now: T0 }), "toolTrim")
    expect(without.decision).toBe("insufficient data")
    expect(without.reasons).toEqual(["below 22 paired replay fixtures (3 repetitions per variant)"])
    // Selection and anchors have no replay here, so they wait too, whatever the live sample.
    expect(decisionOf(report, "selection").decision).toBe("insufficient data")
    expect(decisionOf(report, "anchors").decision).toBe("insufficient data")
  })

  test("a replay cut whose CI cannot reach the threshold retires", () => {
    const small = decisionOf(evaluate({ dataset: dataset({ sessions: arms(() => ({})) }), snapshot, replay: trimReplay(0.9), now: T0 }), "toolTrim")
    expect(small.decision).toBe("retire")
    expect(small.reasons[0]).toStartWith("cannot reach: Uncached input tokens per session")
  })

  test("a completion drop past the guardrail retires; past the safety stop it retires as a stop", () => {
    const guardrail = evaluate({ dataset: dataset({ sessions: arms((index) => ({ completion: index >= 4 })) }), snapshot, replay: trimReplay(0.7), now: T0 })
    expect(decisionOf(guardrail, "toolTrim").decision).toBe("retire")
    expect(decisionOf(guardrail, "toolTrim").reasons[0]).toStartWith("guardrail failed with evidence of harm: Task completion, Δ")

    const stop = evaluate({ dataset: dataset({ days: 3, sessions: arms((index) => ({ completion: index >= 16 })) }), snapshot, now: T0 })
    expect(decisionOf(stop, "toolTrim").decision).toBe("retire")
    expect(decisionOf(stop, "toolTrim").reasons[0]).toStartWith("safety stop: Task completion")
    expect(decisionOf(stop, "toolTrim").withheld).toBe(false)
  })

  test("before the window closes the same data is insufficient, and its estimates are withheld", () => {
    const report = evaluate({ dataset: dataset({ days: 10, sessions: arms(() => ({})) }), snapshot, replay: trimReplay(0.7), now: T0 })
    const trim = decisionOf(report, "toolTrim")
    expect(trim.decision).toBe("insufficient data")
    expect(trim.reasons).toEqual(["the 14-day window has not closed"])
    expect(trim.checks.some((check) => check.role === "primary")).toBe(false)
  })

  test("past the 6-week cap a short sample is final insufficient data", () => {
    const sessions = [...Array.from({ length: 40 }, (_, index) => session(index, "control")), ...Array.from({ length: 40 }, (_, index) => session(index, "treatment"))]
    const report = evaluate({ dataset: dataset({ days: 42, sessions }), snapshot, now: T0 })
    expect(report.window).toMatchObject({ complete: true, capped: true })
    const loops = decisionOf(report, "guardrails")
    expect(loops.decision).toBe("insufficient data")
    expect(loops.reasons).toContain("the 6-week cap passed: final, the window is not extended")
  })

  test("fewer tool calls per session promote skill suggestion on the log scale, and CUPED by project narrows the CI", () => {
    const rng = random(11)
    // Four projects whose sessions differ tenfold in tool calls; the treatment cuts calls by 30%.
    const scale = [5, 15, 50, 150]
    const make = (arm: Arm, index: number) => {
      const project = index % 4
      const noise = Math.exp((rng() - 0.5) * 1.2)
      return session(index, arm, { projectID: `p${project}`, toolCalls: Math.round(scale[project]! * noise * (arm === "treatment" ? 0.7 : 1)) })
    }
    const sessions = [...Array.from({ length: 160 }, (_, index) => make("control", index)), ...Array.from({ length: 160 }, (_, index) => make("treatment", index))]
    const prior: PriorSession[] = Array.from({ length: 40 }, (_, index) => ({
      projectID: `p${index % 4}`,
      uncachedInput: 1000,
      usd: 0.1,
      toolCalls: scale[index % 4]!,
    }))
    const judged = (arm: Arm, index: number): DecisionUnit => ({
      id: `skillRelevance:${arm}:${index}`,
      sessionID: `ses_${arm}_${index % 160}`,
      kind: "skillRelevance",
      arm,
      source: "baseline",
      latencyMs: 2,
      costUsd: 0,
      answer: { load: [] },
      baselineAnswer: { load: [] },
      outcome: index % 2 === 0 ? "correct" : "incorrect",
    })
    const decisions = [...Array.from({ length: 320 }, (_, index) => judged("control", index)), ...Array.from({ length: 320 }, (_, index) => judged("treatment", index))]
    const read = (withPrior: boolean) => {
      const result = decisionOf(evaluate({ dataset: dataset({ sessions, decisions, prior: withPrior ? prior : [] }), snapshot, now: T0 }), "relevance")
      return { result, check: result.checks.find((check) => check.key === "toolCallsPerSession:geometric")! }
    }
    const adjusted = read(true)
    const raw = read(false)
    expect(adjusted.result.decision).toBe("promote")
    expect(adjusted.check.estimate!).toBeGreaterThan(-0.4)
    expect(adjusted.check.estimate!).toBeLessThan(-0.2)
    expect(adjusted.check.high! - adjusted.check.low!).toBeLessThan((raw.check.high! - raw.check.low!) / 2)
  })

  test("one rejected tool pair stops per-step selection at once", () => {
    const sessions = [session(0, "control"), session(0, "treatment", { pairingErrors: 1 })]
    const report = evaluate({ dataset: dataset({ days: 1, sessions }), snapshot, now: T0 })
    expect(decisionOf(report, "selection").decision).toBe("retire")
    expect(decisionOf(report, "selection").reasons[0]).toStartWith("safety stop: Requests rejected")
  })

  test("fewer re-reads per compaction in the replay promote the anchors", () => {
    const variants = [
      { name: "baseline", adaptive: { compaction: { anchors: false } } },
      { name: "anchors", adaptive: { compaction: { anchors: true } } },
    ]
    const runs = Array.from({ length: 20 }, (_, index) => index).flatMap((index) =>
      [1, 2, 3].flatMap((repetition) =>
        [
          ["baseline", 4 + (index % 3), 500],
          ["anchors", 1 + (index % 2), 510],
        ].map(([variant, rereads, summaryTokens]) => ({
          fixture: `long-${index}`,
          variant: variant as string,
          repetition,
          status: "ok" as const,
          tokens: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
          usd: 0.1,
          wallMs: 1000,
          source: "session_metrics" as const,
          turnErrors: 0,
          completed: true,
          compaction: { compactions: 1, rereadsAfterCompaction: rereads as number, summaryTokens: summaryTokens as number },
        })),
      ),
    )
    const replay = { anchors: replayEvidence(replayReport(variants, runs), "anchors.json")[0]!.evidence }
    const sessions = [...Array.from({ length: 150 }, (_, index) => session(index, "control")), ...Array.from({ length: 150 }, (_, index) => session(index, "treatment"))]
    expect(decisionOf(evaluate({ dataset: dataset({ sessions }), snapshot, replay, now: T0 }), "anchors").decision).toBe("promote")
  })

  test("loop warnings promote when warned loops stop far more often and unwarned ones rarely stop", () => {
    const loop = (arm: Arm, index: number, stopped: boolean): DecisionUnit => ({
      id: `failure:${arm}:${index}`,
      sessionID: `ses_${arm}_${index}`,
      kind: "failure",
      arm,
      source: "baseline",
      latencyMs: 1,
      costUsd: 0,
      answer: { verdict: "intervene" },
      baselineAnswer: { verdict: "intervene" },
      // The label judges `intervene` correct when the loop persisted.
      outcome: stopped ? "incorrect" : "correct",
      baselineOutcome: stopped ? "incorrect" : "correct",
    })
    // 20 judged detections per arm: what ~150 sessions per arm plausibly yield.
    const decisions = [
      ...Array.from({ length: 20 }, (_, index) => loop("control", index, index < 1)),
      ...Array.from({ length: 20 }, (_, index) => loop("treatment", index, index < 14)),
    ]
    const sessions = [...Array.from({ length: 150 }, (_, index) => session(index, "control")), ...Array.from({ length: 150 }, (_, index) => session(index, "treatment"))]
    const report = evaluate({ dataset: dataset({ sessions, decisions }), snapshot, now: T0 })
    expect(decisionOf(report, "guardrails").decision).toBe("promote")
  })

  test("a model that wins its disagreements cheaply promotes; one that loses them retires", () => {
    const answered = (provider: string, index: number, modelRight: boolean): DecisionUnit => ({
      id: `completion:${provider}:${index}`,
      sessionID: `ses_${provider}_${index % 50}`,
      kind: "completion",
      source: "model",
      providerID: provider,
      providerVersion: "v1",
      latencyMs: 1000,
      costUsd: 0.001,
      answer: { verdict: "complete" },
      baselineAnswer: { verdict: "not_complete" },
      outcome: modelRight ? "correct" : "incorrect",
      baselineOutcome: modelRight ? "incorrect" : "correct",
    })
    const decisions = [
      ...Array.from({ length: 100 }, (_, index) => answered("small-llm", index, index % 10 < 7)),
      ...Array.from({ length: 100 }, (_, index) => answered("jev", index, index % 10 < 3)),
    ]
    const report = evaluate({ dataset: dataset({ decisions }), snapshot, now: T0 })
    expect(decisionOf(report, "model", "completion · small-llm").decision).toBe("promote")
    expect(decisionOf(report, "model", "completion · jev").decision).toBe("retire")
  })

  test("learning promotes only with the content attestation, and an incident stops it", () => {
    const proposal = (index: number, status: string, usedSessions: number): ProposalUnit => ({
      id: `p${index}`,
      status,
      skill: `skill-${index}`,
      createdAt: T0,
      updatedAt: T0,
      usedSessions,
      windowClosed: status === "promoted",
    })
    const proposals = [
      proposal(0, "promoted", 3),
      proposal(1, "promoted", 2),
      proposal(2, "promoted", 0),
      ...Array.from({ length: 7 }, (_, index) => proposal(index + 3, "rejected", 0)),
    ]
    const without = evaluate({ dataset: dataset({ days: 31, proposals }), snapshot, now: T0 })
    expect(decisionOf(without, "learning").decision).toBe("keep observing")
    expect(decisionOf(evaluate({ dataset: dataset({ days: 31, proposals }), snapshot, contentIncidents: 0, now: T0 }), "learning").decision).toBe(
      "promote",
    )
    expect(decisionOf(evaluate({ dataset: dataset({ days: 31, proposals }), snapshot, contentIncidents: 1, now: T0 }), "learning").decision).toBe(
      "retire",
    )
    expect(decisionOf(evaluate({ dataset: dataset({ days: 31, proposals: proposals.slice(0, 5) }), snapshot, now: T0 }), "learning").decision).toBe(
      "insufficient data",
    )
  })
})

describe("the ETA status prints", () => {
  test("extrapolates the pace since start to the minimum", () => {
    // 30 sessions in 6 days is 5 a day; 120 more take 24 days.
    expect(etaDays(30, 150, 6)).toBe(24)
    expect(etaDays(31, 150, 6)).toBe(24)
    expect(etaDays(150, 150, 6)).toBe(0)
    expect(etaDays(200, 150, 6)).toBe(0)
    expect(etaDays(0, 150, 6)).toBeUndefined()
    expect(etaDays(10, 150, 0)).toBeUndefined()
  })
})
