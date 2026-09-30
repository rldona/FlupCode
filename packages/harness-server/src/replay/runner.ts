/**
 * The replay runner (AH-B04): asks a fixture's prompts again under each config variant, in a
 * throwaway session per repetition, and reports what each one cost and whether it verified.
 *
 * Numbers come from `session_metrics` (AH-B01) through the harness when it answers for the session,
 * and from the engine's own transcript otherwise; the report says which. The engine exposes no
 * sampling seed, so the model is pinned explicitly on every prompt and the report records that no
 * seed was set: repetitions (three by default) are what absorb the LLM's variance.
 *
 * This spends real model money. Nothing here runs in CI: the tests drive it against a stub engine.
 */

import { Engine } from "../engine"
import type { TranscriptMessage } from "../engine"
import type { SessionMetricTurn } from "../adaptive/session-metrics"
import { fixtureDirectory, gitHead } from "./fixture"
import type { ReplayFixture, ReplayModel } from "./fixture"

export type ReplayVariant = {
  name: string
  /** Overrides the fixture's model for every prompt. */
  model?: ReplayModel
  agent?: string
  /** Another engine for this variant, e.g. one started with different flags. */
  engine?: string
  /**
   * A `flupcode.adaptive` patch applied through the harness settings surface before the variant and
   * restored after it. Only the fields that surface allows can be patched.
   */
  adaptive?: Record<string, unknown>
}

export type ReplayTokens = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }

export type ReplayRun = {
  fixture: string
  variant: string
  repetition: number
  model?: ReplayModel
  agent?: string
  status: "ok" | "error"
  error?: string
  tokens: ReplayTokens
  usd: number
  wallMs: number
  /** Where the numbers came from. */
  source: "session_metrics" | "engine" | "none"
  /** Assistant turns the engine marked as failed. */
  turnErrors: number
  verify?: { command: string; passed: boolean; exitCode: number | null; ms: number }
  /** Finished every prompt without an error and, when the fixture has one, verified green. */
  completed: boolean
  /** The commit the replay ran on, and whether it differs from the one the fixture recorded. */
  commit?: string
  commitMismatch?: boolean
}

export type ReplayStat = { mean: number; p50: number; min: number; max: number; spread: number }

export type ReplayAggregate = {
  fixture: string
  variant: string
  runs: number
  ok: number
  completionRate: number
  uncachedInput: ReplayStat
  cached: ReplayStat
  output: ReplayStat
  usd: ReplayStat
  wallMs: ReplayStat
  /** Every repetition's total tokens and USD within the tolerance of the mean. */
  reproducible: boolean
}

export type ReplayReport = {
  version: 1
  startedAt: number
  finishedAt: number
  engine: string
  harness?: string
  repeat: number
  /** The engine takes no sampling seed; `null` says none was set rather than pretending one was. */
  seed: null
  tolerance: number
  isolation: "worktree" | "in-place"
  runs: ReplayRun[]
  aggregates: ReplayAggregate[]
}

export type ReplayOptions = {
  fixtures: ReplayFixture[]
  variants: ReplayVariant[]
  repeat?: number
  engine: string
  /** The harness that holds `session_metrics` and the adaptive settings; optional. */
  harness?: { url: string; token?: string }
  /** `worktree` (default) replays each repetition in a fresh engine worktree of the project. */
  isolation?: "worktree" | "in-place"
  /** Overrides every fixture's folder. */
  directory?: string
  timeoutMs?: number
  verifyTimeoutMs?: number
  tolerance?: number
  /** Only tests shorten these. */
  pollMs?: number
  settleMs?: number
  metricsDelayMs?: number
  log?: (line: string) => void
}

export async function runReplay(options: ReplayOptions): Promise<ReplayReport> {
  const startedAt = Date.now()
  const repeat = Math.max(1, options.repeat ?? 3)
  const tolerance = options.tolerance ?? 0.05
  const isolation = options.isolation ?? "worktree"
  const log = options.log ?? (() => {})
  const runs: ReplayRun[] = []
  for (const variant of options.variants) {
    const engine = new Engine(variant.engine ?? options.engine)
    const restore = await applyAdaptive(options.harness, variant.adaptive)
    try {
      for (const fixture of options.fixtures) {
        for (const repetition of Array.from({ length: repeat }, (_, index) => index + 1)) {
          log(`${fixture.id} × ${variant.name} #${repetition}`)
          runs.push(await replayOnce({ options, engine, fixture, variant, repetition, isolation }))
        }
      }
    } finally {
      await restore()
    }
  }
  return {
    version: 1,
    startedAt,
    finishedAt: Date.now(),
    engine: options.engine,
    ...(options.harness ? { harness: options.harness.url } : {}),
    repeat,
    seed: null,
    tolerance,
    isolation,
    runs,
    aggregates: aggregate(runs, tolerance),
  }
}

async function replayOnce(input: {
  options: ReplayOptions
  engine: Engine
  fixture: ReplayFixture
  variant: ReplayVariant
  repetition: number
  isolation: "worktree" | "in-place"
}): Promise<ReplayRun> {
  const options = input.options
  const project = options.directory ?? fixtureDirectory(input.fixture)
  const model = input.variant.model ?? input.fixture.model
  const agent = input.variant.agent ?? input.fixture.agent
  const base = {
    fixture: input.fixture.id,
    variant: input.variant.name,
    repetition: input.repetition,
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
  }
  const worktree =
    input.isolation === "worktree"
      ? await input.engine
          .createWorktree({
            directory: project,
            name: `replay-${input.fixture.id}-${input.variant.name}-${input.repetition}`,
          })
          .catch((cause: unknown) => new Error(`Could not create a worktree for ${project}: ${messageOf(cause)}`))
      : undefined
  if (worktree instanceof Error) return failed(base, worktree.message)
  const directory = worktree?.directory ?? project
  const commit = gitHead(directory)
  const session = await input.engine
    .createSession({ directory, title: `Replay ${input.fixture.id} · ${input.variant.name} #${input.repetition}` })
    .catch((cause: unknown) => new Error(messageOf(cause)))
  try {
    if (session instanceof Error) return failed(base, session.message)
    // Wall time is the turns alone: creating the worktree and the session is not the work measured.
    const started = Date.now()
    const turn = await (async () => {
      for (const text of input.fixture.prompts) {
        await input.engine.prompt({
          sessionID: session.id,
          directory,
          text,
          ...(agent ? { agent } : {}),
          ...(model ? { model: { providerID: model.providerID, id: model.modelID, variant: model.variant } } : {}),
        })
        await input.engine.waitForIdle(session.id, {
          directory,
          timeoutMs: options.timeoutMs ?? 30 * 60_000,
          ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
          ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
        })
      }
    })().then(
      () => undefined,
      (cause: unknown) => messageOf(cause),
    )
    const wallMs = Date.now() - started
    const messages = await input.engine.messages(session.id, directory).catch(() => [])
    const usage = await measure(options, session.id, messages)
    const turnErrors = messages.filter((message) => message.info?.role === "assistant" && message.info.error).length
    const verify = input.fixture.verify
      ? await runVerify(input.fixture.verify, directory, options.verifyTimeoutMs ?? 10 * 60_000)
      : undefined
    return {
      ...base,
      status: turn ? "error" : "ok",
      ...(turn ? { error: turn } : {}),
      tokens: usage.tokens,
      usd: usage.usd,
      wallMs,
      source: usage.source,
      turnErrors,
      ...(verify ? { verify } : {}),
      completed: !turn && turnErrors === 0 && (verify ? verify.passed : true),
      ...(commit ? { commit } : {}),
      ...(commit && input.fixture.commit ? { commitMismatch: commit !== input.fixture.commit } : {}),
    }
  } finally {
    // Throwaway state: the session and the worktree go whatever happened, so replays do not pile up.
    if (!(session instanceof Error)) await input.engine.deleteSession(session.id, directory).catch(() => undefined)
    if (worktree) await input.engine.removeWorktree({ directory: worktree.directory, project }).catch(() => undefined)
  }
}

/** `session_metrics` when the harness has the session's turns, else the engine's assistant messages. */
async function measure(options: ReplayOptions, sessionID: string, messages: TranscriptMessage[]) {
  const turns = options.harness ? await readMetrics(options.harness, sessionID, options.metricsDelayMs ?? 1500) : []
  if (turns.length > 0)
    return {
      source: "session_metrics" as const,
      usd: turns.reduce((sum, turn) => sum + turn.cost, 0),
      tokens: turns.reduce(
        (sum, turn) => ({
          input: sum.input + turn.tokens.input,
          cacheRead: sum.cacheRead + turn.tokens.cacheRead,
          cacheWrite: sum.cacheWrite + turn.tokens.cacheWrite,
          output: sum.output + turn.tokens.output,
          reasoning: sum.reasoning + turn.tokens.reasoning,
        }),
        emptyTokens(),
      ),
    }
  const assistants = messages.filter((message) => message.info?.role === "assistant")
  if (assistants.length === 0) return { source: "none" as const, usd: 0, tokens: emptyTokens() }
  return {
    source: "engine" as const,
    usd: assistants.reduce((sum, message) => sum + (message.info?.cost ?? 0), 0),
    tokens: assistants.reduce((sum, message) => {
      const tokens = message.info?.tokens
      return {
        input: sum.input + (tokens?.input ?? 0),
        cacheRead: sum.cacheRead + (tokens?.cache?.read ?? 0),
        cacheWrite: sum.cacheWrite + (tokens?.cache?.write ?? 0),
        output: sum.output + (tokens?.output ?? 0),
        reasoning: sum.reasoning + (tokens?.reasoning ?? 0),
      }
    }, emptyTokens()),
  }
}

/** The metrics plugin posts fire-and-forget, so the last step may land a moment after the turn ends. */
async function readMetrics(harness: { url: string; token?: string }, sessionID: string, delayMs: number) {
  await Bun.sleep(delayMs)
  const response = await fetch(`${harness.url}/harness/adaptive/metrics?sessionID=${encodeURIComponent(sessionID)}`, {
    headers: harness.token ? { authorization: `Bearer ${harness.token}` } : {},
  }).catch(() => undefined)
  if (!response?.ok) return []
  const body = (await response.json().catch(() => undefined)) as { data?: SessionMetricTurn[] } | undefined
  return Array.isArray(body?.data) ? body.data : []
}

async function runVerify(command: string, cwd: string, timeoutMs: number) {
  const started = Date.now()
  const child = Bun.spawn(["sh", "-c", command], { cwd, stdout: "ignore", stderr: "ignore", timeout: timeoutMs })
  const exitCode = await child.exited
  return {
    command,
    passed: exitCode === 0 && !child.signalCode,
    exitCode: child.signalCode ? null : exitCode,
    ms: Date.now() - started,
  }
}

/**
 * Applies a variant's adaptive patch through the harness, and returns how to put the old values back.
 *
 * The previous values are read from the effective config for exactly the leaves the patch names, so
 * the restore writes back what was there and nothing else.
 */
async function applyAdaptive(harness: ReplayOptions["harness"], patch: Record<string, unknown> | undefined) {
  if (!patch) return async () => {}
  if (!harness) throw new Error("A variant with an adaptive patch needs the harness URL")
  const url = `${harness.url}/harness/adaptive/config`
  const headers = {
    "content-type": "application/json",
    ...(harness.token ? { authorization: `Bearer ${harness.token}` } : {}),
  }
  const current = await fetch(url, { headers }).then(async (response) => {
    if (!response.ok) throw new Error(`Reading the adaptive config failed: ${response.status}`)
    return ((await response.json()) as { data: { effective: Record<string, unknown> } }).data.effective
  })
  const previous = pick(current, patch)
  const write = async (body: Record<string, unknown>, confirm: boolean) => {
    const response = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ patch: body, confirm }) })
    if (!response.ok)
      throw new Error(`Patching the adaptive config failed: ${response.status} ${await response.text()}`)
  }
  await write(patch, false)
  // Restoring the user's own previous values is not a new decision, so it is confirmed.
  return () => write(previous, true)
}

/** The values `current` holds at every leaf path `shape` names. */
function pick(current: unknown, shape: Record<string, unknown>): Record<string, unknown> {
  const source = isPlainObject(current) ? current : {}
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [
      key,
      isPlainObject(value) ? pick(source[key], value) : (source[key] ?? null),
    ]),
  )
}

export function aggregate(runs: ReplayRun[], tolerance: number): ReplayAggregate[] {
  const groups = Map.groupBy(runs, (run) => `${run.fixture}\u0000${run.variant}`)
  return [...groups.values()].map((group) => {
    const ok = group.filter((run) => run.status === "ok")
    const measured = ok.length > 0 ? ok : group
    const totals = stat(measured.map((run) => totalTokens(run.tokens)))
    const usd = stat(measured.map((run) => run.usd))
    return {
      fixture: group[0]!.fixture,
      variant: group[0]!.variant,
      runs: group.length,
      ok: ok.length,
      completionRate: group.filter((run) => run.completed).length / group.length,
      uncachedInput: stat(measured.map((run) => run.tokens.input)),
      cached: stat(measured.map((run) => run.tokens.cacheRead)),
      output: stat(measured.map((run) => run.tokens.output)),
      usd,
      wallMs: stat(measured.map((run) => run.wallMs)),
      reproducible: ok.length === group.length && totals.spread <= tolerance && usd.spread <= tolerance,
    }
  })
}

/** Mean, median, range, and `spread`: the largest relative distance of a value from the mean. */
export function stat(values: number[]): ReplayStat {
  if (values.length === 0) return { mean: 0, p50: 0, min: 0, max: 0, spread: 0 }
  const sorted = values.toSorted((a, b) => a - b)
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const middle = Math.floor(sorted.length / 2)
  const p50 = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
  const spread = mean === 0 ? 0 : Math.max(...values.map((value) => Math.abs(value - mean))) / mean
  return { mean, p50, min: sorted[0]!, max: sorted.at(-1)!, spread }
}

export function renderMarkdown(report: ReplayReport) {
  const rows = report.aggregates.map((row) =>
    [
      row.fixture,
      row.variant,
      `${row.ok}/${row.runs}`,
      percent(row.completionRate),
      tokens(row.uncachedInput),
      tokens(row.cached),
      tokens(row.output),
      `$${row.usd.mean.toFixed(4)} (p50 $${row.usd.p50.toFixed(4)}, ±${percent(row.usd.spread)})`,
      `${(row.wallMs.mean / 1000).toFixed(1)}s (p50 ${(row.wallMs.p50 / 1000).toFixed(1)}s)`,
      row.reproducible ? "yes" : "no",
    ].join(" | "),
  )
  const failures = report.runs.filter((run) => run.status === "error" || run.commitMismatch)
  return [
    "# Replay report",
    "",
    `- Started: ${new Date(report.startedAt).toISOString()} · took ${((report.finishedAt - report.startedAt) / 1000).toFixed(0)}s`,
    `- Engine: ${report.engine}${report.harness ? ` · harness: ${report.harness}` : ""}`,
    `- Repetitions: ${report.repeat} · isolation: ${report.isolation}`,
    "- Seed: none (the engine exposes no sampling seed; the model is pinned on every prompt)",
    `- Reproducible means every repetition's total tokens and USD are within ±${percent(report.tolerance)} of the mean.`,
    "",
    "| Fixture | Variant | OK | Completed | Uncached input | Cached | Output | USD | Wall time | Reproducible |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
    "",
    ...(failures.length > 0
      ? [
          "## Notes",
          "",
          ...failures.map(
            (run) =>
              `- ${run.fixture} × ${run.variant} #${run.repetition}: ${
                run.error ?? `ran on ${run.commit?.slice(0, 12)}, not the fixture's commit`
              }`,
          ),
          "",
        ]
      : []),
  ].join("\n")
}

function failed(
  base: Pick<ReplayRun, "fixture" | "variant" | "repetition" | "model" | "agent">,
  error: string,
): ReplayRun {
  return {
    ...base,
    status: "error",
    error,
    tokens: emptyTokens(),
    usd: 0,
    wallMs: 0,
    source: "none",
    turnErrors: 0,
    completed: false,
  }
}

const emptyTokens = (): ReplayTokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 })
const totalTokens = (tokens: ReplayTokens) =>
  tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning
const tokens = (value: ReplayStat) =>
  `${Math.round(value.mean)} (p50 ${Math.round(value.p50)}, ±${percent(value.spread)})`
const percent = (value: number) => `${(value * 100).toFixed(1)}%`
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
