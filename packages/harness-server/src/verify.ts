import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Verification with evidence (H-22).
 *
 * A run that ends "success" today means the model stopped talking. This turns that into something
 * checkable: the project's own commands are run, their output is kept, and the verdict is whether
 * they exited zero. No model is involved — a verify task costs nothing but time, which is the whole
 * reason it can be run after every attempt.
 */

export type VerifyStep = { name: string; command: string }

export type VerifyStepResult = VerifyStep & {
  exitCode: number
  durationMs: number
  /** The tail of what it printed. A failing suite is read from the bottom. */
  output: string
  timedOut?: boolean
}

export type VerifyReport = { ok: boolean; steps: VerifyStepResult[] }

/** How much of each step's output is kept. Enough to read a failure, small enough to store. */
export const OUTPUT_LIMIT = 8000

/** A step that never ends must not hold the run forever. */
export const STEP_TIMEOUT_MS = 15 * 60 * 1000

/** The order they are worth running in: the cheapest check that can fail the run goes first. */
const KNOWN = ["typecheck", "lint", "test", "build"] as const

const RUNNERS: Array<{ lockfile: string; run: (script: string) => string }> = [
  { lockfile: "bun.lock", run: (script) => `bun run ${script}` },
  { lockfile: "bun.lockb", run: (script) => `bun run ${script}` },
  { lockfile: "pnpm-lock.yaml", run: (script) => `pnpm run ${script}` },
  { lockfile: "yarn.lock", run: (script) => `yarn ${script}` },
  { lockfile: "package-lock.json", run: (script) => `npm run ${script}` },
]

const tail = (text: string) =>
  text.length <= OUTPUT_LIMIT ? text : `…${text.slice(text.length - OUTPUT_LIMIT)}`

const readText = async (path: string) => {
  try {
    return await Bun.file(path).text()
  } catch {
    return undefined
  }
}

/**
 * What the project says it is verified with: `.flupcode/project.yaml`, under `verify`.
 *
 * ```yaml
 * verify:
 *   typecheck: bun run typecheck
 *   test: bun test
 * ```
 *
 * Declaring it wins over anything that could be detected: a repository that says how it is checked
 * has said so on purpose, and half-guessing the rest would run commands nobody asked for.
 */
export async function configuredSteps(directory: string): Promise<VerifyStep[] | undefined> {
  const text = await readText(join(directory, ".flupcode", "project.yaml"))
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(text)
  } catch {
    return undefined
  }
  const verify = (parsed as { verify?: unknown } | null)?.verify
  if (!verify || typeof verify !== "object" || Array.isArray(verify)) return undefined
  const steps = Object.entries(verify as Record<string, unknown>)
    .filter(([name, command]) => !!name.trim() && typeof command === "string" && !!command.trim())
    .map(([name, command]) => ({ name: name.trim(), command: (command as string).trim() }))
  return steps.length > 0 ? steps : undefined
}

/**
 * What the project looks like it is verified with: the scripts it already has.
 *
 * Only the four the audit names, and only the ones that exist — inventing `bun run lint` for a
 * project with no lint script would fail the gate on the harness's own guess.
 */
export async function detectedSteps(directory: string): Promise<VerifyStep[]> {
  const text = await readText(join(directory, "package.json"))
  if (text === undefined) return []
  let scripts: Record<string, unknown> = {}
  try {
    scripts = ((JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {}) as Record<string, unknown>
  } catch {
    return []
  }
  const runner = RUNNERS.find((entry) => existsSync(join(directory, entry.lockfile))) ?? RUNNERS[RUNNERS.length - 1]!
  return KNOWN.filter((name) => typeof scripts[name] === "string").map((name) => ({
    name,
    command: runner.run(name),
  }))
}

export async function verifySteps(directory: string): Promise<VerifyStep[]> {
  return (await configuredSteps(directory)) ?? (await detectedSteps(directory))
}

/**
 * Runs one step and keeps what it printed.
 *
 * Through a login shell on purpose: the server is started by the desktop app, which on macOS gets
 * the launch environment rather than the one a terminal would give it, so `bun` and `node` are
 * often not on its PATH at all.
 */
export async function runStep(step: VerifyStep, directory: string): Promise<VerifyStepResult> {
  const startedAt = Date.now()
  const child = Bun.spawn(["sh", "-lc", step.command], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
  })
  const timer = setTimeout(() => child.kill(), STEP_TIMEOUT_MS)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  const timedOut = Date.now() - startedAt >= STEP_TIMEOUT_MS
  return {
    ...step,
    exitCode,
    durationMs: Date.now() - startedAt,
    output: tail([stdout, stderr].filter(Boolean).join("\n").trim()),
    ...(timedOut ? { timedOut: true } : {}),
  }
}

/**
 * Runs every step, even after one fails.
 *
 * A report that stops at the first failure hides the other three, and the point of this task is to
 * hand back everything that is wrong at once — the retry that follows is worth more with all of it.
 */
export async function runVerify(
  directory: string,
  options: { steps?: VerifyStep[]; stopped?: () => boolean } = {},
): Promise<VerifyReport> {
  const steps = options.steps ?? (await verifySteps(directory))
  const stopped = options.stopped ?? (() => false)
  const results: VerifyStepResult[] = []
  for (const step of steps) {
    if (stopped()) break
    results.push(await runStep(step, directory))
  }
  return { ok: results.length > 0 && results.every((result) => result.exitCode === 0), steps: results }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/**
 * The evidence, as the task's output.
 *
 * H-14's artifact store is where this belongs and does not exist yet, so it is written where a task
 * already keeps what it produced — which also means the next task is handed it verbatim.
 */
export function evidenceText(report: VerifyReport): string {
  if (report.steps.length === 0) {
    return "No verification: the project declares no `verify` steps in .flupcode/project.yaml and has no test, typecheck, lint or build script."
  }
  const lines = [`Verification: ${report.ok ? "passed" : "failed"}`, ""]
  for (const step of report.steps) {
    const mark = step.exitCode === 0 ? "ok" : step.timedOut ? "timed out" : `exit ${step.exitCode}`
    lines.push(`- ${step.name} (${step.command}) — ${mark}, ${seconds(step.durationMs)}`)
  }
  for (const step of report.steps.filter((entry) => entry.exitCode !== 0)) {
    lines.push("", `### ${step.name}`, "```", step.output || "(no output)", "```")
  }
  return lines.join("\n")
}
