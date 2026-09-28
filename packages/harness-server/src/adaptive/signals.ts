/**
 * The evidence a session's episode can carry (FH-003).
 *
 * The engine plugin records richer signals than `tool-uses` does — a shell's command, exit code and
 * a bounded tail of its output, and the paths an edit touched — into `episode-signals/<sessionID>.json`.
 * The plugin stores text and nothing more: it has no imports, so it cannot read a test runner's
 * output. This side derives the episode's `files`, `commands` and `failures` from those signals,
 * reusing the same readers the verify gate uses (`../failures`), so a broken test landing here
 * anchors on the line that broke it with no second parser.
 *
 * A stored file is read defensively: an id that is not engine-shaped, unreadable JSON, a malformed
 * entry or a value past its limit degrades to the part that can be trusted, never to a reader that
 * throws.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { FAILURE_LIMIT, locate, parseFailures } from "../failures"
import type { EpisodeFailure } from "./episode"

/** How much of a shell's tail is kept, and how many paths a call may carry. */
export const SIGNAL_OUT_LIMIT = 4096
export const SIGNAL_PATH_LIMIT = 20
export const SIGNAL_COMMAND_LIMIT = 500

/** How many calls are kept: the same ring the plugin writes, so a reader never sees more than it. */
export const MOST_SIGNALS = 200

/** One path longer than this is not a path; the plugin never writes one, a hand-edit might. */
const SIGNAL_PATH_CHARS = 1000

/** How much evidence an episode keeps: enough to trace it, not a second index. */
export const EVIDENCE_FILE_LIMIT = 50
export const EVIDENCE_COMMAND_LIMIT = 50

export type EpisodeSignal = {
  tool: string
  start?: number
  ms?: number
  ok: boolean
  exit?: number
  command?: string
  paths: string[]
  out?: string
  truncated?: boolean
}

export type EpisodeSignals = { calls: EpisodeSignal[] }

export type EpisodeEvidence = {
  files: string[]
  commands: string[]
  failures: EpisodeFailure[]
}

/** Where the plugin writes, by the same rules it uses. */
export function episodeSignalsDirectory(): string {
  const explicit = process.env.FLUPCODE_EPISODE_SIGNALS_DIR
  if (explicit) return explicit
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "flupcode", "episode-signals")
}

/** The signals a session left, or an empty set: a broken or missing file reads as nothing, never as an error. */
export function episodeSignals(sessionID: string): EpisodeSignals {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return { calls: [] }
  try {
    const parsed = JSON.parse(readFileSync(join(episodeSignalsDirectory(), `${sessionID}.json`), "utf8")) as {
      calls?: unknown
    }
    return { calls: readSignals(parsed?.calls) }
  } catch {
    return { calls: [] }
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const bounded = (value: string, limit: number): string => value.slice(0, limit)

/** Only the entries that can be read back whole; an unknown field is ignored, a malformed one dropped. */
function readSignals(value: unknown): EpisodeSignal[] {
  if (!Array.isArray(value)) return []
  return value.slice(-MOST_SIGNALS).flatMap((entry): EpisodeSignal[] => {
    if (!isPlainObject(entry)) return []
    if (typeof entry.tool !== "string" || !entry.tool) return []
    const paths = Array.isArray(entry.paths)
      ? entry.paths
          .filter((path): path is string => typeof path === "string")
          .slice(0, SIGNAL_PATH_LIMIT)
          .map((path) => bounded(path, SIGNAL_PATH_CHARS))
      : []
    return [
      {
        tool: entry.tool,
        ...(typeof entry.start === "number" ? { start: entry.start } : {}),
        ...(typeof entry.ms === "number" ? { ms: entry.ms } : {}),
        // An older build wrote no `ok`; the call happened, so its absence is read as success.
        ok: entry.ok !== false,
        ...(typeof entry.exit === "number" ? { exit: entry.exit } : {}),
        ...(typeof entry.command === "string" ? { command: bounded(entry.command, SIGNAL_COMMAND_LIMIT) } : {}),
        paths,
        ...(typeof entry.out === "string" ? { out: bounded(entry.out, SIGNAL_OUT_LIMIT) } : {}),
        ...(entry.truncated === true ? { truncated: true } : {}),
      },
    ]
  })
}

/** The paths and commands a session left, deduplicated in appearance order and relative to the run. */
export function episodeEvidence(signals: EpisodeSignal[], directory: string): EpisodeEvidence {
  const commands = uniqueInOrder(
    signals.flatMap((signal) => (typeof signal.command === "string" && signal.command ? [signal.command] : [])),
    EVIDENCE_COMMAND_LIMIT,
  )
  const files = uniqueInOrder(
    signals.flatMap((signal) => signal.paths.map((path) => locate(path, directory))),
    EVIDENCE_FILE_LIMIT,
  )
  return { files, commands, failures: failuresFrom(signals, directory) }
}

/** What a shell that did not clearly succeed printed, as the failures the episode carries. */
function failuresFrom(signals: EpisodeSignal[], directory: string): EpisodeFailure[] {
  const seen = new Set<string>()
  const out: EpisodeFailure[] = []
  for (const signal of signals) {
    if (signal.tool !== "bash") continue
    if (!signal.out) continue
    // A clean exit says the command succeeded, whatever its output happens to look like: warnings
    // and passing suites print frames that a failure reader would otherwise claim.
    if (signal.exit === 0) continue
    for (const failure of parseFailures(signal.out, directory).failures) {
      const entry: EpisodeFailure = {
        summary: failure.message,
        file: failure.file,
        ...(failure.line !== undefined ? { line: failure.line } : {}),
      }
      const key = `${entry.file ?? ""}:${entry.line ?? 0}:${entry.summary}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entry)
      if (out.length >= FAILURE_LIMIT) return out
    }
  }
  return out
}

function uniqueInOrder(values: string[], limit: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= limit) break
  }
  return out
}
