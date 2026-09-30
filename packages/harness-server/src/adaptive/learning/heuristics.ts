/**
 * The heuristic reflection classifier (AH-F01): a non-inert baseline that needs no model.
 *
 * The model path (`skillReflection` + the small-model draft) is inert without a classifier and a
 * drafting model, so a harness with learning on and no model configured never proposed anything. This
 * module reads a closed episode — its ordered tool trace, its failures and the earlier episodes of the
 * same project — and recognises two learnable patterns, writing the proposal text from a template:
 *
 * - `fix-verify`: a verification command (test, build, lint, typecheck…) failed, the files involved
 *   were edited, and then the **same** command passed. The lesson is the loop and where the fix went.
 * - `repeated-command`: the same build/test invocation (with the same flags), or the same multi-step
 *   recipe of runner commands, recurs across sessions of the same project.
 *
 * It is pure and bounded: the same inputs always produce the same candidate, and every list it walks
 * has a cap. Nothing here redacts, lints or stores — the manager runs a candidate through the same
 * redaction, lint and `proposed` staging as a drafted one, so a heuristic proposal still waits for a
 * person (ADR-0022). `episodeTrace` is the one reader: it reads the plugin's signal files, read-only.
 */

import { isAbsolute } from "node:path"
import { locate } from "../../failures"
import { SESSION_EPISODE_PREFIX } from "../episode"
import type { SessionEpisode } from "../episode"
import { episodeSignals } from "../signals"
import type { EpisodeSignal, EpisodeSignals } from "../signals"
import { DRAFT_LIMITS } from "./draft"

export const HEURISTIC_PATTERNS = ["fix-verify", "repeated-command"] as const
export type HeuristicPattern = (typeof HEURISTIC_PATTERNS)[number]

/** One step of an episode's ordered trace: the slice of a plugin signal the classifier reads. */
export type TraceStep = Pick<EpisodeSignal, "tool" | "ok" | "exit" | "command" | "paths" | "start">

export type HeuristicCandidate = {
  pattern: HeuristicPattern
  name: string
  description: string
  body: string
  /** The episode ids that support the pattern besides the one being reflected (`repeated-command`). */
  supportingEpisodes: string[]
  confidence: number
}

/** The caps that keep a classification bounded, and the support a repeated pattern needs. */
export const HEURISTIC_LIMITS = {
  traceSteps: 200,
  historyEpisodes: 50,
  /** Distinct sessions (the current one included) that must share a command before it is a pattern. */
  minSessions: 3,
  recipeSteps: 4,
  sequenceCommands: 20,
  commandChars: 200,
  fixedFiles: 5,
  failureLines: 3,
  failureChars: 160,
} as const

/** The provenance a heuristic proposal carries in `modelVersion`: no model wrote it. */
export const heuristicModelVersion = (pattern: HeuristicPattern): string => `heuristic/${pattern}`

/**
 * Classifies one closed episode. `fix-verify` wins over `repeated-command`: a repaired failure is the
 * more specific lesson. `history` may hold any episodes; only earlier, closed ones of the same project
 * from other sessions count, so the answer does not depend on what the caller happened to list.
 */
export function classifyEpisode(input: {
  episode: SessionEpisode
  trace: readonly TraceStep[]
  history: readonly SessionEpisode[]
}): HeuristicCandidate | undefined {
  return fixVerifyCandidate(input.episode, input.trace) ?? repeatedCandidate(input.episode, input.history)
}

/**
 * The ordered trace of one episode, from the plugin's signal files (read-only).
 *
 * A run episode names its sessions as `session:<id>` refs; an interactive one is its own session.
 * Only the calls inside the episode's window count, so a session's later episode does not replay the
 * earlier one; a call with no start can only be placed in a session's first episode.
 */
export function episodeTrace(
  episode: SessionEpisode,
  read: (sessionID: string) => EpisodeSignals = episodeSignals,
): TraceStep[] {
  const sessions = [
    ...new Set([
      episode.sessionID,
      ...episode.evidenceRefs.flatMap((ref) => (ref.startsWith("session:") ? [ref.slice("session:".length)] : [])),
    ]),
  ].filter(Boolean)
  const laterEpisode = episode.id.startsWith(SESSION_EPISODE_PREFIX) && /:\d+$/.test(episode.id.slice(SESSION_EPISODE_PREFIX.length))
  return sessions
    .flatMap((sessionID) => read(sessionID).calls)
    .filter((call) =>
      call.start === undefined
        ? !laterEpisode
        : call.start >= episode.startedAt && (episode.endedAt === undefined || call.start <= episode.endedAt),
    )
    .slice(-HEURISTIC_LIMITS.traceSteps)
}

// ---- fix → verify ------------------------------------------------------------------------------

const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"])

function fixVerifyCandidate(episode: SessionEpisode, trace: readonly TraceStep[]): HeuristicCandidate | undefined {
  const steps = trace.slice(-HEURISTIC_LIMITS.traceSteps).map((step) => ({
    step,
    command:
      step.tool === "bash" && step.command ? verificationCommand(step.command, episode.projectID) : undefined,
  }))
  const failureFiles = episode.failures.flatMap((failure) =>
    failure.file && failure.file !== "unknown" ? [failure.file] : [],
  )
  const match = steps
    .flatMap((green, index) => {
      if (!green.command || green.step.exit !== 0) return []
      // The last red run of the same command before this green one; the fix is what happened between.
      const red = steps.findLastIndex(
        (candidate, position) => position < index && candidate.command === green.command && failed(candidate.step),
      )
      if (red < 0) return []
      const fixed = unique(
        steps
          .slice(red + 1, index)
          .flatMap((candidate) => (EDIT_TOOLS.has(candidate.step.tool) ? candidate.step.paths : []))
          .flatMap((path) => {
            const inside = locate(path, episode.projectID)
            return isAbsolute(inside) ? [] : [inside]
          }),
      )
      // A green rerun with no edit in between is a retry or a flake, not a fix.
      if (fixed.length === 0) return []
      // When the failure names its files, the fix must touch one of them, a sibling or its source.
      if (failureFiles.length > 0 && !fixed.some((file) => failureFiles.some((failure) => related(file, failure)))) {
        return []
      }
      return [{ command: green.command, fixed, anchored: failureFiles.length > 0 }]
    })
    .at(0)
  if (!match) return undefined

  const name = skillName("fix", match.command)
  if (!name) return undefined
  const failures = episode.failures.slice(0, HEURISTIC_LIMITS.failureLines).map((failure) => {
    const where = failure.file ? ` (${failure.file}${failure.line !== undefined ? `:${failure.line}` : ""})` : ""
    return `- ${oneLine(failure.summary, HEURISTIC_LIMITS.failureChars)}${where}`
  })
  const files = match.fixed.slice(0, HEURISTIC_LIMITS.fixedFiles).map((file) => `   - \`${file}\``)
  return {
    pattern: "fix-verify",
    name,
    description: `Use when \`${oneLine(match.command, 100)}\` fails and needs a minimal, verified fix`,
    body: [
      "## When",
      `\`${match.command}\` fails in this project.`,
      ...(failures.length > 0 ? ["", "Last time it reported:", ...failures] : []),
      "",
      "## Steps",
      `1. Run \`${match.command}\` and read the first failure it reports.`,
      "2. Open the files the failure points at. Last time the fix touched:",
      ...files,
      "3. Make the smallest change that addresses that failure.",
      `4. Run \`${match.command}\` again and only move on once it passes.`,
      "",
      "## Provenance",
      `Heuristic reflection (failure, fix, green verification) on episode ${episode.id}.`,
    ].join("\n"),
    supportingEpisodes: [],
    confidence: match.anchored ? 0.8 : 0.7,
  }
}

const failed = (step: TraceStep): boolean => (step.exit !== undefined ? step.exit !== 0 : !step.ok)

/** Same file, a test and its source (`math.test.ts` ↔ `math.ts`), or a neighbour in its directory. */
function related(file: string, failure: string): boolean {
  if (file === failure) return true
  if (stem(file) === stem(failure)) return true
  return directory(file) === directory(failure)
}

const stem = (file: string): string =>
  (file.split("/").at(-1) ?? file).replace(/\.[^.]*$/, "").replace(/(?:[._-](?:test|spec))+$/, "").replace(/^test_/, "")

const directory = (file: string): string => file.split("/").slice(0, -1).join("/")

// ---- repeated command / recipe -----------------------------------------------------------------

function repeatedCandidate(episode: SessionEpisode, history: readonly SessionEpisode[]): HeuristicCandidate | undefined {
  const current = recipeSequence(episode)
  if (current.length === 0) return undefined
  const others = history
    .filter(
      (other) =>
        other.projectID === episode.projectID &&
        other.id !== episode.id &&
        other.sessionID !== episode.sessionID &&
        other.endedAt !== undefined &&
        (episode.endedAt === undefined || other.endedAt <= episode.endedAt),
    )
    .slice(0, HEURISTIC_LIMITS.historyEpisodes)
    .map((other) => ({ episode: other, sequence: recipeSequence(other) }))
  const support = (steps: readonly string[]) => {
    const matching = others.filter((other) => inOrder(other.sequence, steps))
    return { sessions: new Set(matching.map((other) => other.episode.sessionID)).size + 1, matching }
  }

  const recipe = bestRecipe(current, support)
  if (recipe) {
    const verification = recipe.steps.findLast((step) => isVerification(step)) ?? recipe.steps.at(-1)!
    const name = skillName("recipe", verification)
    if (!name) return undefined
    return {
      pattern: "repeated-command",
      name,
      description: `Use when verifying changes in this project: the ${recipe.steps.length}-step recipe seen in ${recipe.sessions} sessions`,
      body: [
        "## When",
        `Use this recipe to build and verify this project; it ran in this order in ${recipe.sessions} separate sessions.`,
        "",
        "## Steps",
        ...recipe.steps.map((step, index) => `${index + 1}. \`${step}\``),
        "",
        "## Notes",
        "Run the steps from the project root, in order. If a step fails, fix it before running the next one.",
        "",
        "## Provenance",
        `Heuristic reflection (repeated recipe across sessions) on episode ${episode.id}.`,
      ].join("\n"),
      supportingEpisodes: recipe.matching,
      confidence: Math.min(0.9, 0.5 + 0.1 * recipe.sessions),
    }
  }

  const single = current
    .filter((command) => isVerification(command) && specific(command))
    .map((command) => ({ command, ...support([command]) }))
    .filter((entry) => entry.sessions >= HEURISTIC_LIMITS.minSessions)
    .reduce<{ command: string; sessions: number; matching: typeof others } | undefined>(
      (best, entry) => (!best || entry.sessions > best.sessions ? entry : best),
      undefined,
    )
  if (!single) return undefined
  const name = skillName("run", single.command)
  if (!name) return undefined
  return {
    pattern: "repeated-command",
    name,
    description: `Use when building or verifying this project with \`${oneLine(single.command, 100)}\` (seen in ${single.sessions} sessions)`,
    body: [
      "## When",
      `This project is built or verified the same way in ${single.sessions} separate sessions.`,
      "",
      "## Steps",
      `1. Run \`${single.command}\` from the project root, with the same flags.`,
      "2. If it fails, fix the first reported failure and run it again before moving on.",
      "",
      "## Provenance",
      `Heuristic reflection (repeated command across sessions) on episode ${episode.id}.`,
    ].join("\n"),
    supportingEpisodes: single.matching.map((other) => other.episode.id),
    confidence: Math.min(0.9, 0.5 + 0.1 * single.sessions),
  }
}

/**
 * The longest run of adjacent runner commands in the current episode, with a verification in it, that
 * enough earlier sessions ran in the same order. Adjacent pairs seed it; each is extended while the
 * support holds, and the widest support (then the earliest start) wins.
 */
function bestRecipe(
  current: readonly string[],
  support: (steps: readonly string[]) => { sessions: number; matching: Array<{ episode: SessionEpisode }> },
): { steps: string[]; sessions: number; matching: string[] } | undefined {
  return current
    .slice(0, -1)
    .flatMap((_, start) => {
      const grown = current
        .slice(start, start + HEURISTIC_LIMITS.recipeSteps)
        .reduce<{ steps: string[]; stopped: boolean }>(
          (acc, step) => {
            if (acc.stopped) return acc
            const steps = [...acc.steps, step]
            if (steps.length < 2 || support(steps).sessions >= HEURISTIC_LIMITS.minSessions) return { steps, stopped: false }
            return { ...acc, stopped: true }
          },
          { steps: [], stopped: false },
        ).steps
      if (grown.length < 2 || !grown.some((step) => isVerification(step))) return []
      const found = support(grown)
      if (found.sessions < HEURISTIC_LIMITS.minSessions) return []
      return [{ steps: grown, sessions: found.sessions, matching: found.matching.map((other) => other.episode.id) }]
    })
    .reduce<{ steps: string[]; sessions: number; matching: string[] } | undefined>(
      (best, entry) =>
        !best ||
        entry.sessions > best.sessions ||
        (entry.sessions === best.sessions && entry.steps.length > best.steps.length)
          ? entry
          : best,
      undefined,
    )
}

/** The episode's runner commands, normalized and unique, in first-appearance order. */
const recipeSequence = (episode: SessionEpisode): string[] =>
  unique(
    episode.commands.flatMap((command) => {
      const normalized = normalizeCommand(command, episode.projectID)
      return normalized && runnerCommand(normalized) ? [normalized] : []
    }),
  ).slice(0, HEURISTIC_LIMITS.sequenceCommands)

/** Whether `steps` occur in `sequence` in the same order (not necessarily adjacent). */
const inOrder = (sequence: readonly string[], steps: readonly string[]): boolean =>
  steps.reduce((from, step) => {
    if (from < 0) return from
    const at = sequence.indexOf(step, from)
    return at < 0 ? -1 : at + 1
  }, 0) >= 0

// ---- commands ----------------------------------------------------------------------------------

/** Tools that build, test or check a project; a command must start with one to be a recipe step. */
const RUNNERS = new Set([
  "bun", "bunx", "npm", "npx", "pnpm", "yarn", "deno", "node", "make", "just", "cargo", "go", "python",
  "python3", "uv", "poetry", "pytest", "tox", "nox", "tsc", "tsgo", "vitest", "jest", "mocha", "eslint",
  "biome", "ruff", "mypy", "gradle", "./gradlew", "mvn", "./mvnw", "dotnet", "mix", "rspec", "bundle",
  "rake", "swift", "xcodebuild", "turbo", "nx", "playwright",
])

/** What a verification says about itself: a test, build, lint or type check. */
const VERIFY = /(?:^|[\s/:])(?:test|tests|spec|check|lint|typecheck|type-check|tsc|tsgo|build|vitest|jest|pytest|mocha|rspec|clippy|vet|eslint|biome|ruff|mypy|compile|e2e)(?=$|[\s:])/

/** Commands that are never a lesson worth teaching: privilege, downloads, piping to a shell, deletes. */
const UNSAFE = /\bsudo\b|\bcurl\b|\bwget\b|\|\s*(?:ba|z)?sh\b|\brm\s+-[a-z]*[rf]|--dangerously|\bgit\s+push\b|--force\b/

/** Output-only suffixes that do not change what ran: `2>&1`, `| tail -n 20`, `| head`. */
const DISPLAY_TAIL = /\s*(?:2>&1|\|\s*(?:tail|head|less|more|cat)\b[^|]*)\s*$/

/**
 * One command in a comparable form: the project path made relative, whitespace collapsed and output
 * suffixes dropped. An unsafe or oversized command is `undefined`, so it never becomes a lesson.
 */
export function normalizeCommand(command: string, projectID: string): string | undefined {
  const relative = isAbsolute(projectID)
    ? command.replaceAll(`${projectID}/`, "").replaceAll(projectID, ".")
    : command
  const collapsed = relative.replace(/\s+/g, " ").trim()
  const stripped = [0, 1, 2].reduce((text) => text.replace(DISPLAY_TAIL, "").trim(), collapsed)
  if (!stripped || stripped.length > HEURISTIC_LIMITS.commandChars || UNSAFE.test(stripped)) return undefined
  return stripped
}

/** The segments that run something: `cd x && bun test` is `bun test`, run inside `x`. */
const runSegments = (command: string): string[][] =>
  command
    .split(/&&|;|\|\|/)
    .map((segment) => segment.trim().split(" ").filter((token) => !/^[A-Z_][A-Z0-9_]*=/.test(token)))
    .filter((tokens) => tokens.length > 0 && !["cd", "export", "pushd", "popd"].includes(tokens[0]!))

const runnerCommand = (command: string): boolean =>
  runSegments(command).some((tokens) => RUNNERS.has(tokens[0]!))

export const isVerification = (command: string): boolean =>
  runSegments(command).some((tokens) => RUNNERS.has(tokens[0]!) && VERIFY.test(tokens.join(" ")))

/** A bare `bun test` or `npm test` is generic knowledge; a repeated lesson needs flags or a target. */
const specific = (command: string): boolean => command.split(" ").length >= 3

const verificationCommand = (command: string, projectID: string): string | undefined => {
  const normalized = normalizeCommand(command, projectID)
  return normalized && isVerification(normalized) ? normalized : undefined
}

// ---- text --------------------------------------------------------------------------------------

/** A skill name from a prefix and a command, within the name cap and the `NAME` alphabet. */
function skillName(prefix: string, command: string): string | undefined {
  const slug = command
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!slug) return undefined
  return `${prefix}-${slug}`.slice(0, DRAFT_LIMITS.maxNameChars).replace(/-+$/, "")
}

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max)

const unique = (values: readonly string[]): string[] => [...new Set(values)]
