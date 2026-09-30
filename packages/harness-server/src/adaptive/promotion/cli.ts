/**
 * The live evaluation commands (AH-G02), from `packages/harness-server`:
 *
 *   bun run eval:live -- start  [--db <path>] [--config <file>] [--force]
 *   bun run eval:live -- status [--db <path>] [--config <file>] [--since <date>] [--until <date>]
 *   bun run eval:live -- report [--db <path>] [--config <file>] [--since <date>] [--until <date>]
 *                                [--out <dir>] [--content-incidents <n>] [--events <dir>]
 *   bun run eval:live -- table
 *
 * The harness database is opened **read-only** (never migrated, never written) and no model is asked.
 * `start` writes one small file, `<data dir>/live-eval/start.json` next to the database, and changes
 * no setting: it prints the switches a person would turn on, as a checklist. `report` writes
 * `report.md` and `report.json` to a git-ignored folder. `--config` points at a JSON file holding a
 * `flupcode.adaptive` block in place of the global config (tests and dry runs).
 */

import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { globalAdaptiveBlock } from "../../config-files"
import { defaultDatabasePath } from "../../repository"
import { resolveAdaptiveConfig } from "../config"
import { CRITERIA, EVALUATION, renderCriteriaTable } from "./criteria"
import { configSnapshot, evaluate, loadDataset, renderReport, status } from "./live-eval"
import type { ConfigSnapshot } from "./live-eval"

/** Git-ignored: a report holds aggregate numbers of the person's own sessions and is never committed. */
export const LIVE_EVAL_DIR = join(import.meta.dir, "../../../fixtures/live-eval")

export type StartRecord = { startedAt: number; database: string; criteria: string; config: ConfigSnapshot }

const OPTIONS = {
  db: { type: "string" },
  config: { type: "string" },
  since: { type: "string" },
  until: { type: "string" },
  out: { type: "string" },
  events: { type: "string" },
  "content-incidents": { type: "string" },
  force: { type: "boolean", default: false },
} as const

if (import.meta.main) {
  const code = await main(process.argv.slice(2), (line) => console.log(line))
  process.exit(code)
}

/** The whole CLI, returning an exit code; `print` receives every line so tests can read them. */
export async function main(argv: string[], print: (line: string) => void, now = Date.now()): Promise<number> {
  const command = argv[0]
  const args = parseArgs({ args: argv.slice(1), options: OPTIONS, allowPositionals: false }).values
  const database = resolve(args.db ?? process.env.FLUPCODE_HARNESS_DB ?? defaultDatabasePath())
  if (command === "table") {
    print(renderCriteriaTable())
    return 0
  }
  if (command === "start") return startCommand(database, args, print, now)
  if (command === "status" || command === "report") {
    if (!existsSync(database)) {
      print(`No harness database at ${database}.`)
      return 1
    }
    const start = readStart(database)
    const since = args.since ? parseDate(args.since) : start?.startedAt
    if (since === undefined) {
      print("No start recorded: run `bun run eval:live -- start` first, or pass --since <date>.")
      return 1
    }
    const until = args.until ? parseDate(args.until) : now
    if (Number.isNaN(since) || Number.isNaN(until) || until <= since) {
      print("--since and --until must be dates (ISO or epoch ms) with --since before --until.")
      return 1
    }
    const current = configSnapshot(readConfig(args.config))
    // The thresholds and the holdout share are the ones recorded at start: the preregistered ones.
    const snapshot = start ? { ...start.config, capabilities: current.capabilities } : current
    const incidents = args["content-incidents"] === undefined ? undefined : Number(args["content-incidents"])
    const db = new Database(database, { readonly: true })
    const dataset = loadDataset(db, { since, until }, args.events ?? process.env.FLUPCODE_EPISODE_EVENTS_DIR ?? join(dirname(database), "events"), now)
    db.close()
    const report = evaluate({
      dataset,
      snapshot,
      ...(incidents !== undefined && Number.isFinite(incidents) ? { contentIncidents: incidents } : {}),
      now,
    })
    if (command === "status") {
      printStatus(print, report, dataset, current, start)
      return 0
    }
    const out = resolve(args.out ?? LIVE_EVAL_DIR)
    mkdirSync(out, { recursive: true })
    await Bun.write(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n")
    await Bun.write(join(out, "report.md"), renderReport(report) + "\n")
    report.capabilities.forEach((result) =>
      print(`${result.instance ? `${result.title}: ${result.instance}` : result.title}: ${result.decision}`),
    )
    print(`Wrote ${join(out, "report.md")} and report.json.`)
    print(report.caveat)
    return 0
  }
  print("Usage: eval:live -- start | status | report [--since <date>] [--until <date>] | table")
  return 2
}

async function startCommand(
  database: string,
  args: { config?: string; force?: boolean },
  print: (line: string) => void,
  now: number,
): Promise<number> {
  const file = startFile(database)
  const previous = readStart(database)
  // Moving the start after looking would be a way of choosing the window: it takes --force.
  if (previous && !args.force) {
    print(`An evaluation already started at ${new Date(previous.startedAt).toISOString()} (${file}).`)
    print("Pass --force to start a new one; the old window is then abandoned, not merged.")
    return 1
  }
  const config = configSnapshot(readConfig(args.config))
  const record: StartRecord = {
    startedAt: now,
    database,
    criteria: "ADR-0025",
    config,
  }
  mkdirSync(dirname(file), { recursive: true })
  await Bun.write(file, JSON.stringify(record, null, 2) + "\n")
  print(`Evaluation started at ${new Date(now).toISOString()}; recorded in ${file}.`)
  print(`It ends at the later of ${new Date(now + EVALUATION.windowDays * 24 * 60 * 60 * 1000).toISOString()} and the minimum sample.`)
  print("No setting was changed. To evaluate, turn these on yourself:")
  checklist(config).forEach((line) => print(line))
  return 0
}

/** The switches the evaluation needs, with where each one is set. Nothing here writes them. */
export function checklist(config: ConfigSnapshot): string[] {
  const box = (on: boolean) => (on ? "[x]" : "[ ]")
  const patch = (json: string) => `PATCH /harness/adaptive/config {"patch":${json}} (artifacts bearer)`
  return [
    `${box(config.enabled)} Adaptive on: Settings → Adaptive → level Observe or Assist; or ${patch('{"enabled":true}')}`,
    `${box(config.holdoutFraction === EVALUATION.recommendedHoldoutFraction)} holdout.fraction = ${EVALUATION.recommendedHoldoutFraction} (now ${config.holdoutFraction}): not in the settings surface; edit "flupcode": { "adaptive": { "holdout": { "fraction": ${EVALUATION.recommendedHoldoutFraction} } } } in the global opencode config and restart FlupCode`,
    `${box(config.capabilities.toolTrim)} Tool-output trim: Settings → Adaptive → Advanced → "Shorten long tool outputs (recoverable)"; or ${patch('{"toolTrim":{"enabled":true}}')}`,
    `${box(config.capabilities.selection)} Per-step selection: no panel control (evaluation-gated); ${patch('{"selection":{"enabled":true}}')}`,
    `${box(config.capabilities.relevance)} Skill suggestion: Settings → Adaptive → Skill suggestion → Suggesting; or ${patch('{"relevance":{"enabled":true}}')}`,
    `${box(config.capabilities.guardrails)} Loop warnings: Settings → Adaptive → Loop warnings → Warning; or ${patch('{"guardrails":{"enabled":true}}')}`,
    `${box(config.capabilities.anchors)} Compaction anchors (on by default): Settings → Adaptive → Advanced → "Keep session anchors when compacting"; or ${patch('{"compaction":{"anchors":true}}')}`,
    `${box(config.capabilities.learning)} Learning: Settings → Adaptive → Learning → Proposing (asks to confirm: it sends redacted drafts to the small model's provider)`,
    `${box(config.capabilities.model)} Predictive model: set "adaptive.models.<kind>" (e.g. "small-llm") in the config file, allow that provider under Settings → Adaptive → "Sharing with <provider>" (egress.providers.<id>), and raise decisions.<kind>.timeoutMs`,
  ]
}

function printStatus(
  print: (line: string) => void,
  report: ReturnType<typeof evaluate>,
  dataset: ReturnType<typeof loadDataset>,
  current: ConfigSnapshot,
  start: StartRecord | undefined,
) {
  const date = (at: number) => new Date(at).toISOString()
  print(`Window: ${date(report.window.since)} → ${date(report.window.until)} (${report.window.days.toFixed(1)} of ${EVALUATION.windowDays} days)`)
  print(`Holdout share: ${current.holdoutFraction} now${start ? `, ${start.config.holdoutFraction} at start` : ""}`)
  if (start && start.config.holdoutFraction !== current.holdoutFraction)
    print("Warning: the holdout share changed since start; sessions keep the arm they were given.")
  print("Label coverage (decisions past their settle window):")
  dataset.coverage.forEach((row) =>
    print(`  ${row.kind}: ${row.labeled}/${row.eligible} labelled, ${row.judged} judged`),
  )
  status(report, dataset).forEach((row) => {
    print(`${row.title} — ${row.enabled ? "enabled" : "off"}${row.holdout ? ` (holdout "${row.holdout}")` : " (no holdout arm)"}`)
    if (row.sessions && row.episodes)
      print(
        `  sessions: control ${row.sessions.control}, treatment ${row.sessions.treatment}; episodes: control ${row.episodes.control}, treatment ${row.episodes.treatment}`,
      )
    row.progress.forEach((entry) => {
      const have = typeof entry.have === "number" ? `${entry.have}` : `control ${entry.have.control}, treatment ${entry.have.treatment}`
      const least = typeof entry.have === "number" ? entry.have : Math.min(entry.have.control, entry.have.treatment)
      print(`  ${entry.label}: ${have} of ${entry.need}${entry.perArm ? " per arm" : ""} (${Math.min(100, Math.floor((least / entry.need) * 100))}%)`)
    })
    row.safety.forEach((stop) => print(`  SAFETY STOP: ${stop}`))
  })
  print(`Effect estimates are not shown before the analysis (${CRITERIA.length} capabilities, one analysis; ADR-0025).`)
}

export function startFile(database: string) {
  return join(dirname(database), "live-eval", "start.json")
}

export function readStart(database: string): StartRecord | undefined {
  const file = startFile(database)
  if (!existsSync(file)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
  return typeof parsed === "object" && parsed !== null && "startedAt" in parsed ? (parsed as StartRecord) : undefined
}

function readConfig(file: string | undefined) {
  const block = file ? JSON.parse(readFileSync(file, "utf8")) : globalAdaptiveBlock()
  return resolveAdaptiveConfig({ block, env: process.env })
}

function parseDate(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : Date.parse(value)
}
