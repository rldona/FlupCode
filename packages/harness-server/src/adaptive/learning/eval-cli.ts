/**
 * The reflection quality eval commands (AH-F05, PoC-4).
 *
 *   bun run reflect:eval -- select [--db <path>] [--seed poc-4] [--limit 20] [--scan 1000] [--out <dir>]
 *                                  [--with-model [--model provider/model] [--engine <url>] [--yes]]
 *   bun run reflect:eval -- report --answers <file> [--run <dir>]
 *
 * `select` opens the harness database **read-only** (never migrated, never written), picks the sample
 * and writes `run.json`, `review.html` and `answers.template.json` to a git-ignored folder under
 * `fixtures/reflection-eval/`. The heuristic candidates are local and free. The model path opens real,
 * paid engine sessions, so it needs `--with-model` and `--yes` both; without `--yes` it prints the plan
 * and writes nothing, and it refuses to run at all under CI. `report` reads the reviewer's answers and
 * prints the preregistered go/no-go (and writes `report.md` next to the run).
 */

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { decodeEpisode, defaultDatabasePath } from "../../repository"
import type { EpisodeRow } from "../../repository"
import { Engine } from "../../engine"
import { globalAdaptiveBlock, globalSmallModel } from "../../config-files"
import { parseModelKey } from "../../policy"
import { DEFAULT_LEARNING_CONFIG, resolveAdaptiveConfig } from "../config"
import type { SessionEpisode } from "../episode"
import { redactText } from "../redaction"
import { learningModel } from "./draft"
import { HEURISTIC_LIMITS, classifyEpisode, episodeTrace } from "./heuristics"
import { reflectionGate } from "./reflection-job"
import {
  EVAL_SAMPLE_SIZE,
  computeReport,
  evidenceSummary,
  heuristicProposal,
  parseAnswers,
  plannedModelCalls,
  proposalKey,
  renderReport,
  runModelPath,
  selectEpisodes,
} from "./eval"
import type { EvalEpisode, EvalProposal, EvalRun, EvalSkip } from "./eval"
import { renderReviewSheet } from "./eval-sheet"

/** Git-ignored: a run holds redacted but real project text and is never committed. */
export const EVAL_DIR = join(import.meta.dir, "../../../fixtures/reflection-eval")

if (import.meta.main) {
  const command = process.argv[2]
  if (command === "select") await selectCommand(process.argv.slice(3))
  else if (command === "report") await reportCommand(process.argv.slice(3))
  else {
    console.error("Usage: eval-cli.ts select [--db …] [--seed …] [--limit 20] [--with-model [--yes]] | eval-cli.ts report --answers <file>")
    process.exit(2)
  }
}

async function selectCommand(argv: string[]) {
  const args = parseArgs({
    args: argv,
    options: {
      db: { type: "string", default: process.env.FLUPCODE_HARNESS_DB ?? defaultDatabasePath() },
      seed: { type: "string", default: "poc-4" },
      limit: { type: "string", default: String(EVAL_SAMPLE_SIZE) },
      scan: { type: "string", default: "1000" },
      out: { type: "string" },
      "with-model": { type: "boolean", default: false },
      model: { type: "string" },
      engine: { type: "string", default: process.env.FLUPCODE_ENGINE_URL ?? "http://127.0.0.1:4096" },
      yes: { type: "boolean", default: false },
    },
  }).values
  // Checked before the database is opened: under CI the model path is refused outright.
  if (args["with-model"] && process.env.CI) {
    console.error("The model path calls a real model through the engine and never runs in CI.")
    process.exit(1)
  }

  const db = new Database(args.db, { readonly: true })
  const scan = Math.max(1, Math.floor(Number(args.scan)) || 1000)
  const closed = (
    db
      .query(
        `SELECT * FROM (
           SELECT * FROM session_episodes WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT ?1
         ) ORDER BY ended_at ASC, id ASC`,
      )
      .all(scan) as EpisodeRow[]
  ).map(decodeEpisode)
  // The evidence text is read without touching `last_read_at` (the repository's reader would write it).
  const evidenceQuery = db.query(
    `SELECT e.content AS content FROM episode_evidence l JOIN evidence e ON e.hash = l.hash
     WHERE l.episode_id = ?1 ORDER BY l.position ASC, l.rowid ASC`,
  )
  const evidenceOf = (episode: SessionEpisode) =>
    (evidenceQuery.all(episode.id) as Array<{ content: string }>).map((row) => row.content)

  const eligible = closed.filter((episode) => reflectionGate(episode, DEFAULT_LEARNING_CONFIG).reflect)
  const limit = Math.min(EVAL_SAMPLE_SIZE, Math.max(1, Math.floor(Number(args.limit)) || EVAL_SAMPLE_SIZE))
  const sample = selectEpisodes({ episodes: eligible, seed: args.seed, limit })
  const evidence = new Map(sample.map((episode) => [episode.id, evidenceOf(episode)]))
  db.close()

  const config = resolveAdaptiveConfig({ block: globalAdaptiveBlock(), env: process.env })
  const model = args["with-model"]
    ? (parseModelKey(args.model) ?? learningModel(config.learning, globalSmallModel))
    : undefined
  if (args["with-model"]) {
    const plan = plannedModelCalls(sample.length)
    console.log(
      `Plan: ${sample.length} episodes → ${plan.classifications} classifications and at most ${plan.maxDrafts} drafts (≤ ${plan.maxSessions} throwaway engine sessions) with ${model ? `${model.providerID}/${model.id}` : "no model"} via ${args.engine}.`,
    )
    if (!model) {
      console.error("No model: pass --model provider/model or set adaptive.learning.model / small_model.")
      process.exit(1)
    }
    if (!args.yes) {
      console.log("Each call is a real, paid model turn. Nothing was written. Re-run with --yes to start.")
      return
    }
  }

  const engine = model ? new Engine(args.engine) : undefined
  const createdAt = Date.now()
  const runID = new Date(createdAt).toISOString().replace(/[:.]/g, "-")
  const episodes: EvalEpisode[] = []
  for (const episode of sample) {
    const slices = evidence.get(episode.id) ?? []
    const history = closed
      .filter((other) => other.projectID === episode.projectID && (other.endedAt ?? 0) <= (episode.endedAt ?? 0) && other.id !== episode.id)
      .reverse()
      .slice(0, HEURISTIC_LIMITS.historyEpisodes)
    const candidate = classifyEpisode({ episode, trace: episodeTrace(episode), history })
    const heuristic: EvalProposal | EvalSkip = candidate
      ? heuristicProposal(candidate, slices)
      : { source: "heuristic", reason: "no-pattern" }
    // Sequential on purpose: one paid session at a time, and a failure stops nothing else.
    const modelResult: EvalProposal | EvalSkip = engine && model
      ? await runModelPath({ engine, model, config, episode, evidence: slices, timeoutMs: config.learning.draftTimeoutMs })
      : { source: "model", reason: "not-run" }
    if (engine) console.log(`${episodes.length + 1}/${sample.length} ${episode.id}: model ${"body" in modelResult ? "proposed" : modelResult.reason}`)
    const results = [heuristic, modelResult]
    episodes.push({
      episodeID: episode.id,
      projectID: episode.projectID,
      outcome: episode.outcome,
      objective: redactText(episode.objective),
      evidence: evidenceSummary(episode, slices.length),
      proposals: results.filter((result): result is EvalProposal => "body" in result),
      skipped: results.filter((result): result is EvalSkip => !("body" in result)),
    })
  }

  const run: EvalRun = {
    version: 1,
    runID,
    createdAt,
    seed: args.seed,
    withModel: model !== undefined,
    ...(model ? { model: `${model.providerID}/${model.id}` } : {}),
    population: {
      closed: closed.length,
      eligible: eligible.length,
      projects: new Set(eligible.map((episode) => episode.projectID)).size,
    },
    episodes,
  }
  const out = resolve(args.out ?? join(EVAL_DIR, runID))
  mkdirSync(out, { recursive: true })
  await Bun.write(join(out, "run.json"), `${JSON.stringify(run, null, 2)}\n`)
  await Bun.write(join(out, "review.html"), renderReviewSheet(run, out))
  await Bun.write(
    join(out, "answers.template.json"),
    `${JSON.stringify(
      {
        version: 1,
        runID,
        runDir: out,
        answers: Object.fromEntries(
          episodes.flatMap((episode) => episode.proposals.map((proposal) => [proposalKey(episode.episodeID, proposal.source), {}])),
        ),
      },
      null,
      2,
    )}\n`,
  )
  const proposals = episodes.reduce((sum, episode) => sum + episode.proposals.length, 0)
  console.log(
    `${closed.length} closed episodes read, ${eligible.length} eligible, ${episodes.length} sampled (seed "${args.seed}"), ${proposals} proposals. The database was opened read-only.`,
  )
  console.log(`Open ${join(out, "review.html")} in a browser, review, download the answers, then:`)
  console.log(`  bun run reflect:eval -- report --answers <answers.json>`)
  console.log("The run is redacted, not anonymised: it stays in this git-ignored folder, never in a commit.")
}

async function reportCommand(argv: string[]) {
  const args = parseArgs({ args: argv, options: { answers: { type: "string" }, run: { type: "string" } } }).values
  if (!args.answers) throw new Error("--answers <file> names the answers JSON the review sheet downloaded")
  const answers = parseAnswers(await Bun.file(args.answers).json())
  const dir = args.run ?? answers.runDir ?? dirname(resolve(args.answers))
  const run = (await Bun.file(join(dir, "run.json")).json()) as EvalRun
  const report = computeReport(run, answers)
  const text = renderReport(report)
  await Bun.write(join(dir, "report.md"), text)
  await Bun.write(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  console.log(text)
  console.log(`Wrote ${join(dir, "report.md")} and report.json. The decision is a suggestion: the go/no-go is yours.`)
}

