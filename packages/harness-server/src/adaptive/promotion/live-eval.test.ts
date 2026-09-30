/**
 * The live evaluation (AH-G02) on synthetic data only: the CLI never writes the database it reads,
 * `start` changes no setting, sessions split by the arm they recorded, and the criteria reach every
 * decision the table allows.
 */

import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "../../repository"
import { resolveAdaptiveConfig } from "../config"
import { HOLDOUT_CAPABILITIES } from "../holdout"
import type { Arm } from "../holdout"
import { main, startFile } from "./cli"
import { configSnapshot, evaluate, loadDataset } from "./live-eval"
import type { Dataset, DecisionUnit, ProposalUnit, SessionUnit } from "./live-eval"

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
    const files = readdirSync(fixture.dir).toSorted()

    const lines: string[] = []
    const args = ["--db", fixture.path, "--config", fixture.config, "--events", fixture.events]
    expect(await main(["status", ...args], (line) => lines.push(line), T0 + 3 * DAY)).toBe(0)
    const text = lines.join("\n")
    expect(text).toContain("Tool-output trim — enabled")
    expect(text).toContain("sessions: control 10, treatment 10; episodes: control 10, treatment 10")
    expect(text).toContain("sessions: control 10, treatment 10 of 698 per arm (1%)")
    expect(text).toContain("skillRelevance: 20/20 labelled, 20 judged")
    expect(text).not.toMatch(/Δ|95% CI/)

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
    expect(readdirSync(fixture.dir).toSorted()).toEqual(files)
  })

  test("without a start or --since it refuses, and a missing database is an error", async () => {
    const fixture = syntheticDatabase()
    const lines: string[] = []
    expect(await main(["status", "--db", fixture.path, "--config", fixture.config], (line) => lines.push(line), T0)).toBe(1)
    expect(lines[0]).toContain("No start recorded")
    expect(await main(["report", "--db", join(fixture.dir, "missing.sqlite")], () => {}, T0)).toBe(1)
    expect(existsSync(join(fixture.dir, "missing.sqlite"))).toBe(false)
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
  decisions: input.decisions ?? [],
  proposals: input.proposals ?? [],
  coverage: [],
})
const decisionOf = (report: ReturnType<typeof evaluate>, id: string, instance?: string) =>
  report.capabilities.find((result) => result.id === id && (instance === undefined || result.instance?.startsWith(instance)))!

/** 1,400 sessions × 2,000 resamples per metric take about a second per report on a laptop. */
const HEAVY_MS = 30_000

describe("the criteria applied to a synthetic evaluation", () => {
  const next = random(7)
  // 700 sessions per arm, uncached input around 1,000 in control and 30% lower in treatment.
  const arms = (treatment: (index: number) => Partial<SessionUnit>) => [
    ...Array.from({ length: 700 }, (_, index) => session(index, "control", { uncachedInput: 500 + next() * 1000 })),
    ...Array.from({ length: 700 }, (_, index) =>
      session(index, "treatment", { uncachedInput: 350 + next() * 700, ...treatment(index) }),
    ),
  ]

  test("a clear, safe token cut promotes the trim; an unchanged metric keeps observing", () => {
    const report = evaluate({ dataset: dataset({ sessions: arms(() => ({})) }), snapshot, now: T0 })
    const trim = decisionOf(report, "toolTrim")
    expect(trim.decision).toBe("promote")
    const primary = trim.checks.find((check) => check.role === "primary")!
    expect(primary.estimate!).toBeLessThan(-0.25)
    expect(primary.high!).toBeLessThan(-0.15)
    // USD per session is identical in both arms: no saving, and no evidence against one either.
    expect(decisionOf(report, "selection").decision).toBe("keep observing")
  }, HEAVY_MS)

  test("a completion drop past the guardrail retires; past the safety stop it retires as a stop", () => {
    const guardrail = evaluate({ dataset: dataset({ sessions: arms((index) => ({ completion: index >= 14 })) }), snapshot, now: T0 })
    expect(decisionOf(guardrail, "toolTrim").decision).toBe("retire")
    expect(decisionOf(guardrail, "toolTrim").reasons[0]).toStartWith("guardrail failed: Task completion")

    const stop = evaluate({ dataset: dataset({ days: 3, sessions: arms((index) => ({ completion: index >= 70 })) }), snapshot, now: T0 })
    expect(decisionOf(stop, "toolTrim").decision).toBe("retire")
    expect(decisionOf(stop, "toolTrim").reasons[0]).toStartWith("safety stop: Task completion")
    expect(decisionOf(stop, "toolTrim").withheld).toBe(false)
  }, HEAVY_MS)

  test("before the window closes the same data is insufficient, and its estimates are withheld", () => {
    const report = evaluate({ dataset: dataset({ days: 10, sessions: arms(() => ({})) }), snapshot, now: T0 })
    const trim = decisionOf(report, "toolTrim")
    expect(trim.decision).toBe("insufficient data")
    expect(trim.reasons).toEqual(["the 14-day window has not closed"])
    expect(trim.checks.some((check) => check.role === "primary")).toBe(false)
  }, HEAVY_MS)

  test("one rejected tool pair stops per-step selection at once", () => {
    const sessions = [session(0, "control"), session(0, "treatment", { pairingErrors: 1 })]
    const report = evaluate({ dataset: dataset({ days: 1, sessions }), snapshot, now: T0 })
    expect(decisionOf(report, "selection").decision).toBe("retire")
    expect(decisionOf(report, "selection").reasons[0]).toStartWith("safety stop: Requests rejected")
  })

  test("fewer re-reads per compaction promote the anchors", () => {
    const sessions = [
      ...Array.from({ length: 260 }, (_, index) => session(index, "control", { compactions: 1, rereads: 3 + Math.floor(next() * 3), summaryTokens: 500 })),
      ...Array.from({ length: 260 }, (_, index) => session(index, "treatment", { compactions: 1, rereads: Math.floor(next() * 3), summaryTokens: 520 })),
    ]
    expect(decisionOf(evaluate({ dataset: dataset({ sessions }), snapshot, now: T0 }), "anchors").decision).toBe("promote")
  }, HEAVY_MS)

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
    const decisions = [
      ...Array.from({ length: 60 }, (_, index) => loop("control", index, index < 3)),
      ...Array.from({ length: 60 }, (_, index) => loop("treatment", index, index < 40)),
    ]
    const sessions = [...Array.from({ length: 60 }, (_, index) => session(index, "control")), ...Array.from({ length: 60 }, (_, index) => session(index, "treatment"))]
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
      ...Array.from({ length: 300 }, (_, index) => answered("small-llm", index, index % 10 < 7)),
      ...Array.from({ length: 300 }, (_, index) => answered("jev", index, index % 10 < 3)),
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
