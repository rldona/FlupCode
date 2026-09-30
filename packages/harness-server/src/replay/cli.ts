/**
 * The replay commands (AH-B04).
 *
 *   bun run replay:export -- --session <id> [--name <id>] [--verify "<cmd>"] [--directory <dir>]
 *   bun run replay -- [--fixtures <dir|file>] [--variants <file.json>] [--repeat 3] [--yes]
 *
 * A variant with `engineConfig` runs on its own throwaway engine, started with `--engine-command`
 * (default: this checkout's opencode, as `.claude/launch.json` starts it) on a free port.
 *
 * `replay` spends real model money, so without `--yes` it only prints the plan, and it refuses to run
 * at all under CI.
 */

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { Engine } from "../engine"
import { browserTokenFile, readBrowserToken } from "../browser-token"
import { exportSession, loadFixtures, REPLAY_FIXTURES_DIR } from "./fixture"
import { renderMarkdown, runReplay } from "./runner"
import type { ReplayVariant } from "./runner"

const DEFAULT_ENGINE = process.env.FLUPCODE_ENGINE_URL ?? "http://127.0.0.1:4096"
const DEFAULT_HARNESS = `http://127.0.0.1:${process.env.FLUPCODE_HARNESS_PORT ?? 4097}`
// The engine as `.claude/launch.json` starts it, from this checkout, on the port the runner picks.
const DEFAULT_ENGINE_COMMAND = [
  "bun",
  "run",
  "--cwd",
  join(import.meta.dir, "../../../opencode"),
  "src/index.ts",
  "serve",
  "--hostname",
  "127.0.0.1",
  "--port",
  "{port}",
]

if (import.meta.main) {
  const command = process.argv[2]
  if (command === "export") await exportCommand(process.argv.slice(3))
  else if (command === "run") await runCommand(process.argv.slice(3))
  else {
    console.error("Usage: cli.ts export --session <id> | cli.ts run [--fixtures …] [--variants …] [--repeat n] [--yes]")
    process.exit(2)
  }
}

async function exportCommand(argv: string[]) {
  const args = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      name: { type: "string" },
      verify: { type: "string" },
      directory: { type: "string" },
      engine: { type: "string", default: DEFAULT_ENGINE },
      out: { type: "string", default: REPLAY_FIXTURES_DIR },
    },
  }).values
  if (!args.session) throw new Error("--session <id> names the session to export")
  const fixture = await exportSession({
    engine: new Engine(args.engine),
    sessionID: args.session,
    ...(args.name ? { id: args.name } : {}),
    ...(args.verify ? { verify: args.verify } : {}),
    ...(args.directory ? { directory: args.directory } : {}),
  })
  mkdirSync(args.out, { recursive: true })
  const file = join(args.out, `${fixture.id}.json`)
  await Bun.write(file, `${JSON.stringify(fixture, null, 2)}\n`)
  console.log(`Wrote ${file} (${fixture.prompts.length} prompts).`)
  console.log("Review it before sharing: the redaction is conservative, not a guarantee. It is git-ignored.")
}

async function runCommand(argv: string[]) {
  const args = parseArgs({
    args: argv,
    options: {
      fixtures: { type: "string", default: REPLAY_FIXTURES_DIR },
      variants: { type: "string" },
      model: { type: "string" },
      repeat: { type: "string", default: "3" },
      engine: { type: "string", default: DEFAULT_ENGINE },
      harness: { type: "string", default: DEFAULT_HARNESS },
      "no-harness": { type: "boolean", default: false },
      directory: { type: "string" },
      "in-place": { type: "boolean", default: false },
      "timeout-minutes": { type: "string", default: "30" },
      "engine-command": { type: "string" },
      out: { type: "string" },
      yes: { type: "boolean", default: false },
    },
  }).values
  if (process.env.CI) throw new Error("The replay runner calls a real model and never runs in CI")
  const fixtures = await loadFixtures(args.fixtures)
  const variants = await variantsFrom(args.variants, args.model)
  const repeat = Math.max(1, Number(args.repeat) || 3)
  const sessions = fixtures.length * variants.length * repeat
  const prompts = fixtures.reduce((sum, fixture) => sum + fixture.prompts.length, 0) * variants.length * repeat
  const engineCommand = args["engine-command"]?.split(/\s+/).filter(Boolean) ?? DEFAULT_ENGINE_COMMAND
  const spawned = variants.filter((variant) => variant.engineConfig)
  console.log(
    `Plan: ${fixtures.length} fixtures × ${variants.length} variants (${variants.map((variant) => variant.name).join(", ")}) × ${repeat} repetitions = ${sessions} sessions, ${prompts} prompts${spawned.length === variants.length ? ", each variant on its own engine" : ` against ${args.engine}`}.`,
  )
  if (spawned.length > 0)
    console.log(
      [
        `Own engine for ${spawned.map((variant) => variant.name).join(", ")}: \`${engineCommand.join(" ")}\` on a free port, stopped after each variant.`,
        ...spawned.map((variant) => `  ${variant.name}: OPENCODE_CONFIG_CONTENT=${JSON.stringify(variant.engineConfig)}`),
      ].join("\n"),
    )
  if (!args.yes) {
    console.log("Each prompt is a real, paid model turn. Re-run with --yes to start.")
    return
  }
  const token = process.env.FLUPCODE_BROWSER_TOKEN?.trim() || readBrowserToken(browserTokenFile())
  const report = await runReplay({
    fixtures,
    variants,
    repeat,
    engine: args.engine,
    ...(args["no-harness"] ? {} : { harness: { url: args.harness, ...(token ? { token } : {}) } }),
    isolation: args["in-place"] ? "in-place" : "worktree",
    spawn: {
      command: engineCommand,
      // Same environment as the local engine: no server password, no channel database.
      env: { OPENCODE_SERVER_PASSWORD: undefined, OPENCODE_DISABLE_CHANNEL_DB: "1" },
    },
    ...(args.directory ? { directory: args.directory } : {}),
    timeoutMs: (Number(args["timeout-minutes"]) || 30) * 60_000,
    log: (line) => console.log(line),
  })
  const out =
    args.out ?? join(REPLAY_FIXTURES_DIR, "reports", new Date(report.startedAt).toISOString().replace(/[:.]/g, "-"))
  mkdirSync(out, { recursive: true })
  await Bun.write(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  await Bun.write(join(out, "report.md"), renderMarkdown(report))
  console.log(`Wrote ${join(out, "report.json")} and report.md`)
}

/** A JSON file of variants, or the single `baseline`; `--model provider/model` pins its model. */
async function variantsFrom(file: string | undefined, model: string | undefined): Promise<ReplayVariant[]> {
  if (file) {
    const value: unknown = await Bun.file(file).json()
    if (!Array.isArray(value) || !value.every((entry) => typeof entry?.name === "string" && entry.name))
      throw new Error(`${file}: a variants file is a JSON array of objects with a name`)
    const names = value.map((entry: { name: string }) => entry.name)
    if (new Set(names).size !== names.length) throw new Error(`${file}: variant names must be unique`)
    return value as ReplayVariant[]
  }
  if (!model) return [{ name: "baseline" }]
  const [providerID, ...rest] = model.split("/")
  if (!providerID || rest.length === 0) throw new Error("--model is provider/model")
  return [{ name: model, model: { providerID, modelID: rest.join("/") } }]
}
