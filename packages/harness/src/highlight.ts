const KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "def",
  "defer",
  "delete",
  "do",
  "elif",
  "else",
  "enum",
  "except",
  "export",
  "extends",
  "finally",
  "fn",
  "for",
  "from",
  "func",
  "function",
  "if",
  "impl",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "lambda",
  "let",
  "match",
  "mut",
  "new",
  "of",
  "package",
  "pass",
  "private",
  "protected",
  "pub",
  "public",
  "raise",
  "range",
  "return",
  "select",
  "static",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "trait",
  "try",
  "type",
  "typeof",
  "use",
  "var",
  "void",
  "while",
  "with",
  "yield",
])

const CONSTANTS = new Set(["true", "false", "null", "undefined", "None", "True", "False", "nil", "NaN"])

const HASH_COMMENT = new Set(["bash", "sh", "shell", "zsh", "python", "py", "yaml", "yml", "ruby", "rb", "toml", "ini", "conf", "makefile", "dockerfile", "r", "perl", "pl"])
const DASH_COMMENT = new Set(["sql", "lua", "haskell", "hs", "elm"])

export function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export type DiffLine = { type: "add" | "del" | "same"; text: string }

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text): DiffLine => ({ type: "del", text })),
      ...b.map((text): DiffLine => ({ type: "add", text })),
    ]
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ type: "same", text: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      result.push({ type: "del", text: a[i]! })
      i++
    } else {
      result.push({ type: "add", text: b[j]! })
      j++
    }
  }
  while (i < a.length) result.push({ type: "del", text: a[i++]! })
  while (j < b.length) result.push({ type: "add", text: b[j++]! })
  return result
}

function commentPattern(lang: string) {
  if (DASH_COMMENT.has(lang)) return "--[^\\n]*"
  if (HASH_COMMENT.has(lang)) return "#[^\\n]*"
  return "//[^\\n]*|/\\*[\\s\\S]*?\\*/"
}

export type SideBySideRow = {
  left?: { no?: number; text: string; kind: "same" | "del" }
  right?: { no?: number; text: string; kind: "same" | "add" }
}

export function sideBySideDiff(oldText: string, newText: string): SideBySideRow[] {
  const lines = diffLines(oldText, newText)
  const rows: SideBySideRow[] = []
  let oldNo = 1
  let newNo = 1
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.type === "same") {
      rows.push({
        left: { no: oldNo, text: line.text, kind: "same" },
        right: { no: newNo, text: line.text, kind: "same" },
      })
      oldNo++
      newNo++
      index++
      continue
    }
    const dels: string[] = []
    const adds: string[] = []
    while (index < lines.length && lines[index]!.type !== "same") {
      if (lines[index]!.type === "del") dels.push(lines[index]!.text)
      else adds.push(lines[index]!.text)
      index++
    }
    const count = Math.max(dels.length, adds.length)
    for (let offset = 0; offset < count; offset++) {
      rows.push({
        left: offset < dels.length ? { no: oldNo + offset, text: dels[offset]!, kind: "del" } : undefined,
        right: offset < adds.length ? { no: newNo + offset, text: adds[offset]!, kind: "add" } : undefined,
      })
    }
    oldNo += dels.length
    newNo += adds.length
  }
  return rows
}

export function highlightDiff(code: string) {
  return code
    .split("\n")
    .map((line) => {
      const escaped = escapeHtml(line)
      if (line.startsWith("+++") || line.startsWith("---")) return `<span class="fc-diff-meta">${escaped}</span>`
      if (line.startsWith("@@")) return `<span class="fc-diff-hunk">${escaped}</span>`
      if (line.startsWith("+")) return `<span class="fc-diff-add">${escaped}</span>`
      if (line.startsWith("-")) return `<span class="fc-diff-del">${escaped}</span>`
      return escaped
    })
    .join("\n")
}

export type PatchRow = { type: "meta" | "same" | "add" | "del"; no?: number; text: string }

/**
 * Splits a unified diff into renderable rows and tracks the line number each row maps to. Hunks
 * advance the old number on deletions and the new number everywhere else, which is how editors
 * label the two sides on a single column.
 */
export function parsePatch(patch: string): PatchRow[] {
  const rows: PatchRow[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  if (!patch) return rows
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldNo = Number(match[1])
        newNo = Number(match[2])
        inHunk = true
      }
      rows.push({ type: "meta", text: line })
      continue
    }
    if (!inHunk || line.startsWith("+++") || line.startsWith("---") || line.startsWith("\\")) {
      rows.push({ type: "meta", text: line })
      continue
    }
    if (line.startsWith("+")) {
      rows.push({ type: "add", no: newNo, text: line.slice(1) })
      newNo++
      continue
    }
    if (line.startsWith("-")) {
      rows.push({ type: "del", no: oldNo, text: line.slice(1) })
      oldNo++
      continue
    }
    rows.push({ type: "same", no: newNo, text: line.startsWith(" ") ? line.slice(1) : line })
    oldNo++
    newNo++
  }
  return rows
}

export function highlight(code: string, lang = "") {
  const language = lang.toLowerCase()
  if (language === "diff" || language === "patch") return highlightDiff(code)
  if (!language) return escapeHtml(code)

  const pattern = new RegExp(
    [
      `(${commentPattern(language)})`,
      `("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)`,
      `(\\b\\d[\\d_]*(?:\\.\\d+)?\\b)`,
      `(\\b[A-Za-z_][A-Za-z0-9_]*\\b)`,
    ].join("|"),
    "g",
  )

  let result = ""
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(code)) !== null) {
    result += escapeHtml(code.slice(last, match.index))
    const [value, comment, string, number, word] = match
    if (comment) result += `<span class="fc-tok-comment">${escapeHtml(value)}</span>`
    else if (string) result += `<span class="fc-tok-string">${escapeHtml(value)}</span>`
    else if (number) result += `<span class="fc-tok-number">${escapeHtml(value)}</span>`
    else if (word && CONSTANTS.has(word)) result += `<span class="fc-tok-const">${escapeHtml(value)}</span>`
    else if (word && KEYWORDS.has(word)) result += `<span class="fc-tok-keyword">${escapeHtml(value)}</span>`
    else result += escapeHtml(value)
    last = match.index + value.length
  }
  result += escapeHtml(code.slice(last))
  return result
}
