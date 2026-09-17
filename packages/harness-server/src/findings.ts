/**
 * Findings, anchored to a line (H-32).
 *
 * A review that ends as a wall of prose is a review nobody acts on: the reader has to carry each
 * point back to the file themselves. The audit asks for structured findings turned into line
 * comments on the diff, and the diff viewer already numbers both sides for exactly that.
 *
 * The agent is asked to end its answer with a fenced `json` block. Parsing is deliberately forgiving
 * about **shape** — models name the same field `file`/`path`, `title`/`summary`/`issue` — and
 * deliberately strict about **anchoring**: a finding with no file cannot become a comment on a line,
 * so it is not pretended into one. What could not be anchored is counted and said, rather than
 * dropped in silence.
 */

export type Severity = "high" | "medium" | "low"

export type FindingInput = {
  file: string
  line?: number
  severity: Severity
  title: string
  detail?: string
}

export type ParsedFindings = {
  findings: FindingInput[]
  /** Entries that named no file. Counted, because a review that loses points is worse than none. */
  unanchored: number
}

const FILE_KEYS = ["file", "path", "filePath", "filename"]
const TITLE_KEYS = ["title", "summary", "issue", "problem", "message", "what"]
const DETAIL_KEYS = ["detail", "details", "why", "explanation", "how", "evidence", "description"]
const LINE_KEYS = ["line", "lineNumber", "startLine", "start_line"]

const pick = (entry: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

const pickLine = (entry: Record<string, unknown>) => {
  for (const key of LINE_KEYS) {
    const value = entry[key]
    const line = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
    // A line number is a positive integer. Zero and "unknown" mean the finding is about the file.
    if (Number.isInteger(line) && line > 0) return line
  }
  return undefined
}

export function normaliseSeverity(value: unknown): Severity {
  const text = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (["high", "critical", "blocker", "error", "major", "alto", "crítico"].includes(text)) return "high"
  if (["low", "minor", "nit", "info", "suggestion", "bajo"].includes(text)) return "low"
  // Anything unrecognised is middling rather than alarming: guessing "high" would cry wolf.
  return "medium"
}

/** Every fenced block in the text, newest last, plus the whole text as a candidate. */
function candidates(text: string) {
  const blocks: string[] = []
  const fence = /```(?:json|jsonc)?\s*\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fence.exec(text)) !== null) if (match[1]) blocks.push(match[1])
  const trimmed = text.trim()
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) blocks.push(trimmed)
  // Last first: an answer that explains and then lists ends with the list.
  return blocks.reverse()
}

const asArray = (value: unknown) => {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object") {
    const holder = value as Record<string, unknown>
    for (const key of ["findings", "issues", "results", "items"]) {
      if (Array.isArray(holder[key])) return holder[key] as unknown[]
    }
  }
  return undefined
}

/**
 * Reads findings out of what an agent answered.
 *
 * Nothing to find is not a failure — most tasks are not reviews, and this runs after every one of
 * them. An answer with no parseable block simply has no findings, and costs a regular expression.
 */
export function parseFindings(text: string | undefined): ParsedFindings {
  if (!text) return { findings: [], unanchored: 0 }
  for (const block of candidates(text)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      continue
    }
    const entries = asArray(parsed)
    if (!entries) continue
    const findings: FindingInput[] = []
    let unanchored = 0
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue
      const entry = raw as Record<string, unknown>
      const file = pick(entry, FILE_KEYS)
      const title = pick(entry, TITLE_KEYS)
      if (!title) continue
      if (!file) {
        unanchored++
        continue
      }
      findings.push({
        // A model will happily answer "./src/a.ts" or "/src/a.ts" for the same file.
        file: file.replace(/^\.?\//, ""),
        ...(pickLine(entry) !== undefined ? { line: pickLine(entry) } : {}),
        severity: normaliseSeverity(entry.severity ?? entry.level ?? entry.priority),
        title,
        ...(pick(entry, DETAIL_KEYS) ? { detail: pick(entry, DETAIL_KEYS) } : {}),
      })
    }
    // A block that parsed but held nothing usable is not the block; keep looking.
    if (findings.length > 0 || unanchored > 0) return { findings, unanchored }
  }
  return { findings: [], unanchored: 0 }
}

/** What a reviewing task is told to end with, so there is something to parse. */
export const FINDINGS_INSTRUCTION = `End your answer with a fenced json block: an array of findings,
each with "file", "line", "severity" (high, medium or low), "title" and "detail". Use the path as it
appears in the diff. Leave "line" out when the finding is about the file rather than one line. If
there is nothing wrong, say so and end with an empty array.`
