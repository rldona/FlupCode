/**
 * Diffs and the language of a path. Code itself is coloured by one highlighter, the transcript's Shiki
 * worker (`markdown/code-lines.ts`, UX-06); what is here only marks a diff's lines as added, removed or
 * context, which is not about the language at all.
 */

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

const EXT_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  md: "markdown",
  sql: "sql",
  xml: "xml",
}

export function languageFor(path: string | undefined) {
  const extension = path ? /\.([a-zA-Z0-9]+)$/.exec(path)?.[1]?.toLowerCase() : undefined
  return extension ? (EXT_LANG[extension] ?? "") : ""
}
