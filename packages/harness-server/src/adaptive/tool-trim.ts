/**
 * The recoverable tool-output trim (AH-D02, audit §10.4 "avoid sending context").
 *
 * The pure half: whether an output is trimmed, the text that replaces it, and the slice of it an
 * `evidence_read` call returns. Nothing here touches the store; `tool-trim-routes.ts` stores the
 * whole output first and only then hands back what this module renders, so a replacement always
 * names a ref that reads back.
 *
 * Everything is deterministic and local: no model is asked, and the head, tail and structure line
 * are cut from the output the model would otherwise have received whole.
 */

import type { ToolTrimConfig } from "./config"

/** The recovery tool itself. Its output is never trimmed, whatever the config says. */
export const EVIDENCE_READ_TOOL = "evidence_read"

/** A ref is the first 16 hex digits of the stored output's sha256 address. */
export const TOOL_EVIDENCE_REF_PATTERN = /^[0-9a-f]{16}$/

export type TrimSkip = "disabled" | "exempt" | "below-threshold" | "too-large"

/** Why an output of `bytes` from `tool` is left whole, or `undefined` when it is trimmed. */
export function trimSkip(config: ToolTrimConfig, tool: string, bytes: number): TrimSkip | undefined {
  if (!config.enabled) return "disabled"
  if (tool === EVIDENCE_READ_TOOL || config.exempt.includes(tool)) return "exempt"
  if (bytes <= config.thresholdBytes) return "below-threshold"
  if (bytes > config.maxStoredBytes) return "too-large"
  return undefined
}

/**
 * What the model receives instead of the output: where the whole of it is, how to read it back, a
 * structure line, the head and the tail. Line numbers are what the range syntax reads, so the head
 * and tail say which lines they are; an output whose first or last line alone overflows its budget
 * falls back to byte offsets and says so.
 */
export function trimmedOutput(content: string, ref: string, config: Pick<ToolTrimConfig, "headBytes" | "tailBytes" | "readBytes">): string {
  const text = linesOf(content)
  const bytes = Buffer.byteLength(content, "utf8")
  const head = headOf(text, config.headBytes)
  const tail = tailOf(text, config.tailBytes, head.lines)
  const omitted =
    head.lines > 0 && tail.lines > 0
      ? `--- lines ${head.lines + 1}-${text.lines.length - tail.lines} omitted ---`
      : "--- middle omitted ---"
  return [
    `[flupcode: tool output trimmed: ${bytes} bytes, ${text.lines.length} lines. The full output is kept as evidence:${ref}]`,
    `Structure: ${structureOf(content, text)}`,
    `To read any part of it, call evidence_read with ref "${ref}" and range "START-END" (1-based line numbers, inclusive, e.g. "40-120"), or "bytes:START-END" for byte offsets; each call returns at most ${config.readBytes} bytes.`,
    "",
    `--- head (${head.label}) ---`,
    head.text,
    omitted,
    `--- tail (${tail.label}) ---`,
    tail.text,
    `[end of trimmed output; evidence:${ref}]`,
  ].join("\n")
}

/**
 * The slice of a stored output one `evidence_read` returns, with a header naming what it is and, when
 * more follows, the range to ask for next. An unreadable range is an answer the model can correct,
 * not an error.
 *
 * `range` is `""`/`"all"` (from the start), `"N"` or `"N-"` (from line N), `"N-M"` (lines N to M,
 * inclusive), or `"bytes:A-B"`/`"bytes:A-"` (byte offsets, B exclusive). A slice never exceeds
 * `readBytes`.
 */
export function evidenceRange(content: string, ref: string, range: string, readBytes: number): string {
  const spec = range.trim().toLowerCase()
  const bytes = /^bytes:(\d+)-(\d*)$/.exec(spec)
  if (bytes) return byteRange(content, ref, Number(bytes[1]), bytes[2] ? Number(bytes[2]) : undefined, readBytes)
  if (spec === "" || spec === "all") return lineRange(content, ref, 1, undefined, readBytes)
  const lines = /^(\d+)(?:-(\d*))?$/.exec(spec)
  if (lines) return lineRange(content, ref, Number(lines[1]), lines[2] ? Number(lines[2]) : undefined, readBytes)
  return `[evidence:${ref}] Unreadable range "${range}". Use "START-END" (1-based lines, inclusive, e.g. "40-120") or "bytes:START-END".`
}

type Lines = { lines: string[]; offsets: number[] }

/** The output's lines, a trailing newline not counting as one more, with each line's byte offset. */
function linesOf(content: string): Lines {
  const split = content.split("\n")
  const lines = split.length > 1 && split[split.length - 1] === "" ? split.slice(0, -1) : split
  // A running total: an output can carry a hundred thousand lines, so nothing here may be quadratic.
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += Buffer.byteLength(line, "utf8") + 1
  }
  return { lines, offsets }
}

type Piece = { text: string; label: string; lines: number }

function headOf(text: Lines, budget: number): Piece {
  const count = fitting(text.lines, budget)
  if (count > 0) return { text: text.lines.slice(0, count).join("\n"), label: `lines 1-${count}`, lines: count }
  const cut = byteSlice(Buffer.from(text.lines[0] ?? "", "utf8"), 0, budget)
  return { text: cut.text, label: `bytes ${cut.from}-${cut.to}`, lines: 0 }
}

function tailOf(text: Lines, budget: number, taken: number): Piece {
  // Only the lines after the head are candidates, so the tail never repeats one.
  const count = fitting(text.lines.slice(taken).reverse(), budget)
  if (count > 0) {
    const first = text.lines.length - count + 1
    return { text: text.lines.slice(-count).join("\n"), label: `lines ${first}-${text.lines.length}`, lines: count }
  }
  const last = text.lines.length - 1
  const buffer = Buffer.from(text.lines[last] ?? "", "utf8")
  const cut = byteSlice(buffer, buffer.length - budget, buffer.length)
  const base = text.offsets[last] ?? 0
  return { text: cut.text, label: `bytes ${base + cut.from}-${base + cut.to}`, lines: 0 }
}

/** How many leading lines fit in `budget` bytes, newlines included. */
function fitting(lines: readonly string[], budget: number): number {
  let used = 0
  for (const [index, line] of lines.entries()) {
    used += Buffer.byteLength(line, "utf8") + 1
    if (used > budget) return index
  }
  return lines.length
}

const MENTIONS = /\b(?:error|errors|fail|failed|failure|exception|panic|warn|warning)\b/i
const KEYS_SHOWN = 12

/** One deterministic line about the shape: JSON's top level, else how many lines report trouble. */
function structureOf(content: string, text: Lines): string {
  const json = jsonShape(content)
  if (json) return json
  const flagged = text.lines.flatMap((line, index) => (MENTIONS.test(line) ? [index + 1] : []))
  if (flagged.length === 0) return "plain text; no line mentions an error, failure or warning."
  return `plain text; ${flagged.length} line(s) mention an error, failure or warning (first at line ${flagged[0]}, last at line ${flagged[flagged.length - 1]}).`
}

function jsonShape(content: string): string | undefined {
  const trimmed = content.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  const parsed = parseJson(trimmed)
  if (Array.isArray(parsed)) return `a JSON array of ${parsed.length} item(s).`
  if (typeof parsed !== "object" || parsed === null) return undefined
  const keys = Object.keys(parsed)
  const shown = keys.slice(0, KEYS_SHOWN).join(", ")
  return `a JSON object with ${keys.length} key(s): ${shown}${keys.length > KEYS_SHOWN ? ", ..." : ""}.`
}

function parseJson(text: string): unknown {
  // JSON.parse is the only way to ask whether text is JSON; a tool's output is arbitrary text.
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function lineRange(content: string, ref: string, start: number, end: number | undefined, readBytes: number): string {
  const text = linesOf(content)
  const total = text.lines.length
  if (start < 1 || start > total) return `[evidence:${ref}] Line ${start} is outside the output, which has lines 1-${total}.`
  const last = Math.min(end ?? total, total)
  if (last < start) return `[evidence:${ref}] The range ends before it starts; use "START-END" with START <= END.`
  const wanted = text.lines.slice(start - 1, last)
  const count = fitting(wanted, readBytes)
  if (count === 0) {
    // One line longer than a read: hand back its first bytes and continue by byte offsets.
    const from = text.offsets[start - 1] ?? 0
    return byteRange(content, ref, from, from + Buffer.byteLength(wanted[0] ?? "", "utf8"), readBytes)
  }
  const through = start + count - 1
  const more = through < last ? `\n[more: call evidence_read with range "${through + 1}-${last}"]` : ""
  return `[evidence:${ref} lines ${start}-${through} of ${total}]\n${wanted.slice(0, count).join("\n")}${more}`
}

function byteRange(content: string, ref: string, start: number, end: number | undefined, readBytes: number): string {
  const buffer = Buffer.from(content, "utf8")
  if (start >= buffer.length) return `[evidence:${ref}] Byte ${start} is outside the output, which has ${buffer.length} bytes.`
  const stop = Math.min(end ?? buffer.length, buffer.length)
  if (stop <= start) return `[evidence:${ref}] The range ends before it starts; use "bytes:START-END" with START < END.`
  const cut = byteSlice(buffer, start, Math.min(stop, start + readBytes))
  const more = cut.to < stop ? `\n[more: call evidence_read with range "bytes:${cut.to}-${stop}"]` : ""
  return `[evidence:${ref} bytes ${cut.from}-${cut.to} of ${buffer.length}]\n${cut.text}${more}`
}

/** Bytes `start` to `end`, both moved forward to a character boundary so no character is split. */
function byteSlice(buffer: Buffer, start: number, end: number) {
  const from = boundary(buffer, start)
  const to = Math.max(from, boundary(buffer, end))
  return { text: buffer.subarray(from, to).toString("utf8"), from, to }
}

function boundary(buffer: Buffer, offset: number): number {
  const clamped = Math.min(Math.max(offset, 0), buffer.length)
  const continuation = (at: number): boolean => at < buffer.length && (buffer[at]! & 0xc0) === 0x80
  const steps = [0, 1, 2, 3].find((step) => !continuation(clamped + step)) ?? 3
  return clamped + steps
}
