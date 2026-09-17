/**
 * What a failed check actually said (H-22, and the structured output H-21 asks of its gate).
 *
 * A verify task keeps the tail of what the commands printed. That is evidence, but it is not an
 * answer: the reader still has to find the four lines that matter inside eight kilobytes of log,
 * and the retry is handed the whole thing as its prompt. This turns that output into failures with
 * a file and a line — which is the same shape H-32 already draws on the diff, so a broken test
 * lands on the line that broke it with no new screen.
 *
 * **The three readers below were written against real output, captured on 17/09/2026 from the tools
 * this repository actually uses.** Not from memory of the formats:
 *
 * ```
 * tsc / tsgo   src/broken.ts(4,7): error TS2322: Type 'number' is not assignable to type 'string'.
 * bun test     error: expect(received).toBe(expected)
 *                    at <anonymous> (/abs/src/a.test.ts:3:17)
 *              (fail) adds [3.67ms]
 * oxlint       x eslint(no-debugger): `debugger` statement is not allowed
 *               ,-[src/lint.ts:2:3]
 * ```
 *
 * Everything else falls to a last reader for `path:line:col`, which is the shape ESLint's compact
 * formatter, ruff, mypy, go vet and most compilers share. It is deliberately the *last* one tried
 * and only when the others found nothing: it is a loose pattern, and a loose pattern that runs
 * first would turn a stack trace into four findings about the framework's own files.
 */

import { isAbsolute, relative, resolve, sep } from "node:path"

export type Failure = {
  /** Relative to the run's directory when the file is inside it, so it can anchor on a diff. */
  file: string
  line?: number
  column?: number
  message: string
  /** `TS2322`, `eslint(no-debugger)`, the test's name — whatever named it. */
  rule?: string
}

/**
 * How many are kept per step.
 *
 * A typecheck of a broken refactor prints hundreds, and they are nearly always the same mistake
 * seen from different files. The count of what was left out is reported, so the number is never
 * quietly wrong.
 */
export const FAILURE_LIMIT = 50

export type ParsedFailures = { failures: Failure[]; total: number }

const clean = (text: string) =>
  text
    // Anything that came through a terminal. `NO_COLOR=1` is set for these commands, but a step is
    // whatever the project declared and may run its own tool that ignores it.
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\r/g, "")

/** A path as it should be shown: inside the directory it is relative, outside it stays absolute. */
export function locate(file: string, directory: string) {
  const absolute = isAbsolute(file) ? file : resolve(directory, file)
  const inside = relative(directory, absolute)
  if (!inside || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) return absolute
  return inside
}

/** `src/a.ts(4,7): error TS2322: message` — tsc and tsgo, which print the same thing. */
function typescriptFailures(output: string, directory: string): Failure[] {
  const out: Failure[] = []
  for (const line of output.split("\n")) {
    const match = /^(.+?)\((\d+),(\d+)\):\s+(?:error|warning)\s+([A-Za-z]+\d+):\s+(.*)$/.exec(line)
    if (!match) continue
    out.push({
      file: locate(match[1]!, directory),
      line: Number(match[2]),
      column: Number(match[3]),
      message: match[5]!.trim(),
      rule: match[4],
    })
  }
  return out
}

/**
 * `(fail) <name>` — bun test.
 *
 * The name comes last, after the message and the stack, so the reader is built the same way round:
 * the message and the frame are remembered as they go past and claimed when the `(fail)` arrives.
 * The first frame after the error is the innermost one, which is the line the test broke on.
 */
function bunTestFailures(output: string, directory: string): Failure[] {
  const out: Failure[] = []
  let message: string | undefined
  let at: { file: string; line: number; column: number } | undefined
  for (const line of output.split("\n")) {
    const error = /^\s*error:\s*(.*)$/.exec(line)
    if (error) {
      message = error[1]!.trim()
      at = undefined
      continue
    }
    const frame = /^\s*at\s+(?:.*?\s+)?\(?(\/[^\s():]+):(\d+):(\d+)\)?\s*$/.exec(line)
    if (frame && !at) {
      at = { file: frame[1]!, line: Number(frame[2]), column: Number(frame[3]) }
      continue
    }
    const fail = /^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/.exec(line)
    if (!fail) continue
    const name = fail[1]!.trim()
    // A failure with no frame is still a failure. It is reported against the file the runner named
    // if one was seen, and dropped only when there is nothing to anchor it to at all.
    if (!at) {
      message = undefined
      continue
    }
    out.push({
      file: locate(at.file, directory),
      line: at.line,
      column: at.column,
      message: message || name,
      rule: name,
    })
    message = undefined
    at = undefined
  }
  return out
}

/**
 * ```
 *   × eslint(no-debugger): `debugger` statement is not allowed
 *    ╭─[src/lint.ts:2:3]
 * ```
 *
 * oxlint, and anything else built on miette — which is most of the Rust tooling.
 *
 * **Two shapes, and the second one only turned up when this was run for real.** Piped from a
 * terminal, oxlint prints the ASCII `x` and `,-[`; spawned by the server it prints the Unicode `×`
 * and `╭─[`, in 24-bit colour, with the escape codes *inside* the path. Reading the first shape
 * only would have meant a lint step producing nothing here and everything in a test.
 */
function mietteFailures(output: string, directory: string): Failure[] {
  const out: Failure[] = []
  const lines = output.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const head = /^\s*[x×!⚠]\s+(.*\S)\s*$/.exec(lines[index]!)
    if (!head) continue
    // The location is on the next line in every sample; two are allowed for a wrapped message.
    let where: RegExpExecArray | null = null
    for (let ahead = 1; ahead <= 2 && index + ahead < lines.length; ahead++) {
      where = /[,╭][-─]\[([^\]:]+):(\d+):(\d+)\]/.exec(lines[index + ahead]!)
      if (where) break
    }
    if (!where) continue
    const text = head[1]!
    const named = /^([a-z@][\w@/-]*\([^)]+\)):\s*(.*)$/.exec(text)
    out.push({
      file: locate(where[1]!, directory),
      line: Number(where[2]),
      column: Number(where[3]),
      message: (named ? named[2]! : text).trim(),
      ...(named ? { rule: named[1] } : {}),
    })
  }
  return out
}

/**
 * `path:line:col` anywhere on a line, with whatever follows as the message.
 *
 * The catch-all, tried only when nothing else matched. It requires a file extension so that a
 * timestamp or a version string cannot become a finding, and it ignores paths inside
 * `node_modules`: a stack trace through a framework says nothing the reader can act on.
 */
function genericFailures(output: string, directory: string): Failure[] {
  const out: Failure[] = []
  for (const line of output.split("\n")) {
    const match = /(?:^|[\s(>[])([\w./\\@-]+\.[A-Za-z]{1,5}):(\d+):(\d+)(?:\)|:)?\s*(.*)$/.exec(line)
    if (!match) continue
    const file = match[1]!
    if (file.includes("node_modules")) continue
    const message = match[4]!.replace(/^[-–—:]\s*/, "").replace(/[\])]+$/, "").trim()
    out.push({
      file: locate(file, directory),
      line: Number(match[2]),
      column: Number(match[3]),
      // A message has to say something. What follows a location in a drawn frame is the frame — an
      // earlier run of this produced findings whose entire text was "]" — so anything without a
      // letter in it is replaced by the location, which at least points somewhere.
      message: /\p{L}/u.test(message) ? message : `Reported by the check at ${file}:${match[2]}`,
    })
  }
  return out
}

const key = (failure: Failure) => `${failure.file}:${failure.line ?? 0}:${failure.message}`

/**
 * The failures in what one step printed.
 *
 * Every specific reader runs — a `test` script that typechecks first prints both shapes — and the
 * generic one only fills in when they all came back empty.
 */
export function parseFailures(output: string | undefined, directory: string): ParsedFailures {
  if (!output?.trim()) return { failures: [], total: 0 }
  const text = clean(output)
  const found = [
    ...typescriptFailures(text, directory),
    ...bunTestFailures(text, directory),
    ...mietteFailures(text, directory),
  ]
  const all = found.length > 0 ? found : genericFailures(text, directory)
  const seen = new Set<string>()
  const unique: Failure[] = []
  for (const failure of all) {
    if (seen.has(key(failure))) continue
    seen.add(key(failure))
    unique.push(failure)
  }
  return { failures: unique.slice(0, FAILURE_LIMIT), total: unique.length }
}

/** One failure on one line, the way both the evidence and a retry prompt want it. */
export const failureLine = (failure: Failure) =>
  `${failure.file}${failure.line ? `:${failure.line}` : ""} — ${failure.message}${
    failure.rule ? ` (${failure.rule})` : ""
  }`
