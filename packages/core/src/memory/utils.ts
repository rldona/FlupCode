import { createHash } from "node:crypto"
import type { Memory } from "@opencode-ai/schema/memory"

export const normalizeContent = (content: string) => content.trim().toLowerCase().replace(/\s+/g, " ")

export const fingerprint = (content: string) => createHash("sha256").update(normalizeContent(content)).digest("hex")

const FILE_PATTERN =
  /(?:^|[\s(`"'])((?:\.{0,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\.(?:sh|bash|zsh|ps1|ts|tsx|js|mjs|cjs|json|jsonc|toml|yaml|yml|md|sql|py|go|rs|java|rb|php|gradle|lock|env|ini|cfg|conf|tf|nix))(?=$|[\s)`"',.;:])/gm

const DIRECTORY_PATTERN = /(?:^|[\s(`"'])((?:\.{0,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\/)(?=$|[\s)`"',.;:])/gm

const COMMAND_PATTERN =
  /\b(?:npm|pnpm|yarn|bun|make|cargo|go|python3?|pip|uv|pytest|docker|kubectl|helm|git|gh|nix|just)\s+(?:run\s+)?[a-z0-9:_-]+/g

const URL_PATTERN = /https?:\/\/[^\s)`"',;]+/g

/** Finds the verifiable references a memory makes so they can be re-checked later. */
export function extractAnchors(content: string): Memory.ValidationAnchor[] {
  const anchors = new Map<string, Memory.ValidationAnchor>()
  const add = (kind: Memory.ValidationAnchor["kind"], value: string) => {
    const normalized = value.replace(/[.,;:]+$/, "")
    if (normalized.length === 0) return
    anchors.set(`${kind}:${normalized}`, { kind, value: normalized, ok: true })
  }
  for (const match of content.matchAll(FILE_PATTERN)) add("file", match[1])
  for (const match of content.matchAll(DIRECTORY_PATTERN)) add("directory", match[1])
  for (const match of content.matchAll(COMMAND_PATTERN)) add("command", match[0])
  for (const match of content.matchAll(URL_PATTERN)) add("url", match[0])
  return Array.from(anchors.values())
}

/** Higher rank wins when merging evidence from several discoveries. */
export const sourceRank = (source: Memory.Source): number => {
  switch (source) {
    case "explicit_user":
      return 6
    case "manual":
      return 5
    case "agent_tool":
      return 4
    case "agent_discovery":
      return 3
    case "repository_file":
      return 2
    case "tool_result":
      return 2
    case "conversation":
      return 1
    case "import":
      return 1
    default:
      return 0
  }
}

export const strongestSource = (a: Memory.Source, b: Memory.Source): Memory.Source =>
  sourceRank(a) >= sourceRank(b) ? a : b

export const unionTags = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): string[] =>
  Array.from(new Set([...a, ...b].map((tag) => tag.trim()).filter((tag) => tag.length > 0))).toSorted()

/** Merges a stored memory's lifecycle with an incoming discovery. */
export const mergeStatus = (existing: Memory.Status, incoming: Memory.Status): Memory.Status => {
  if (existing === "archived") return existing
  if (incoming === "active") return "active"
  if (existing === "active") return existing
  return incoming
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "you",
  "your",
  "our",
  "are",
  "was",
  "were",
  "will",
  "would",
  "can",
  "could",
  "should",
  "have",
  "has",
  "had",
  "from",
  "into",
  "when",
  "then",
  "than",
  "there",
  "here",
  "what",
  "which",
  "who",
  "how",
  "all",
  "any",
  "each",
  "its",
  "it's",
  "use",
  "using",
  "get",
  "got",
])

export const tokenize = (text: string): string[] =>
  Array.from(
    new Set(
      normalizeContent(text)
        .split(/[^a-z0-9áéíóúüñ_-]+/i)
        .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
    ),
  )

/** Cheap deterministic lexical overlap used before any semantic retrieval exists. */
export function lexicalScore(tokens: ReadonlyArray<string>, memory: Memory.Info): number {
  if (tokens.length === 0) return 0
  const title = normalizeContent(memory.title)
  const content = normalizeContent(memory.content)
  const tags = memory.tags.map(normalizeContent)
  let score = 0
  for (const token of tokens) {
    if (title.includes(token)) score += 3
    if (tags.some((tag) => tag.includes(token))) score += 3
    if (content.includes(token)) score += 1
  }
  return score
}

export const scopeWeight = (scope: Memory.Scope): number => {
  switch (scope) {
    case "session":
      return 2.5
    case "project":
      return 2
    case "agent":
      return 1.5
    case "global":
      return 1
    default:
      return 0
  }
}

const OPPOSITE_TOOLS = [
  ["npm", "pnpm"],
  ["npm", "yarn"],
  ["pnpm", "yarn"],
] as const
const NEGATIVE = /\b(never|don't|do not|must not|avoid|don't ever|should not)\b/i
const POSITIVE = /\b(always|must|should|prefer|require[sd]?)\b/i

/**
 * Conservative contradiction heuristic. Only same-scope memories that share a
 * topic tag and differ in tool or polarity are considered contradictory, so
 * unrelated memories are never suppressed.
 */
export function contradicts(a: Memory.Info, b: Memory.Info): boolean {
  if (a.id === b.id || a.scope !== b.scope) return false
  const at = new Set(a.tags.map(normalizeContent))
  const shared = b.tags.map(normalizeContent).filter((tag) => at.has(tag))
  if (shared.length === 0) return false
  const ac = normalizeContent(a.content)
  const bc = normalizeContent(b.content)
  if (OPPOSITE_TOOLS.some(([left, right]) => ac.includes(left) && bc.includes(right))) return true
  if (OPPOSITE_TOOLS.some(([left, right]) => ac.includes(right) && bc.includes(left))) return true
  return (
    (NEGATIVE.test(a.content) && POSITIVE.test(b.content)) || (POSITIVE.test(a.content) && NEGATIVE.test(b.content))
  )
}

export const scopeLabel = (scope: Memory.Scope): string => (scope === "global" ? "user" : scope)

const oneLine = (text: string, max = 240) => {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/** Renders the bounded block injected into one provider turn. */
export const renderMemoryBlock = (memories: ReadonlyArray<Memory.Info>): string =>
  [
    "<memory>",
    "Relevant memories from previous sessions. They may be outdated; verify before relying on them.",
    ...memories.map((memory) => `- [${scopeLabel(memory.scope)}] ${memory.title}: ${oneLine(memory.content)}`),
    "</memory>",
  ].join("\n")

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

const EXPLICIT_PATTERNS = [
  /\bremember(?: that)?\s+(.+)/gi,
  /\bdon'?t forget(?: that)?\s+(.+)/gi,
  /\bkeep in mind(?: that)?\s+(.+)/gi,
  /\brecuerda(?: que)?\s+(.+)/gi,
  /\bno olvides(?: que)?\s+(.+)/gi,
  /\bten en cuenta(?: que)?\s+(.+)/gi,
  /\bapunta(?: que)?\s+(.+)/gi,
]

/** Extracts explicit "remember ..." clauses from a user prompt. */
export function parseExplicit(text: string): string[] {
  const clauses: string[] = []
  const segments = text.split(/(?<=[.!?])\s+|\n+/)
  for (const segment of segments) {
    for (const pattern of EXPLICIT_PATTERNS) {
      for (const match of segment.matchAll(pattern)) {
        const clause = match[1]?.trim().replace(/[.;,]\s*$/, "")
        if (clause && clause.length >= 3) clauses.push(clause)
      }
    }
  }
  return Array.from(new Set(clauses))
}

export function resolveExplicitScope(clause: string): { scope: Memory.Scope; agent?: string } {
  const agent = clause.match(/\b(?:the\s+)?([a-z0-9_-]+)\s+agent\b/i)?.[1]
  if (agent) return { scope: "agent", agent }
  if (
    /\b(this|the)\s+(project|repo|repository|codebase|worktree|directory)\b|(^|\s)here\b|este\s+(proyecto|repo)|en\s+este\s+(proyecto|repo)/i.test(
      clause,
    )
  )
    return { scope: "project" }
  if (
    /\b(i|my|me)\b[^.]*\b(prefer|like|want|always|never|hate)\b|prefiero|siempre|nunca|no quiero|no me gusta/i.test(
      clause,
    )
  )
    return { scope: "global" }
  return { scope: "project" }
}

export function inferKind(clause: string): Memory.Kind {
  if (/\b(never|don't|do not|must not|avoid|no olvides|nunca|no)\b/i.test(clause)) return "constraint"
  if (/\bprefer|prefiero|like|gusta\b/i.test(clause)) return "preference"
  if (/\b(first|then|next|finally|run|execute|deploy|install|build)\b/i.test(clause)) return "procedure"
  if (/\b(decided|decision|because|chose|migrat)\b/i.test(clause)) return "decision"
  if (/\b(convention|always|style|format|lint)\b/i.test(clause)) return "convention"
  return "fact"
}

export function titleFromClause(clause: string): string {
  const firstSentence = clause
    .replace(/^that\s+/i, "")
    .split(/[.!?]\s/)[0]
    .trim()
  const title = firstSentence.length > 80 ? `${firstSentence.slice(0, 77)}…` : firstSentence
  return title.charAt(0).toUpperCase() + title.slice(1)
}

/** Turns explicit clauses into memory create inputs with inferred scope and kind. */
export function explicitCandidates(text: string): Array<{
  scope: Memory.Scope
  agent?: string
  kind: Memory.Kind
  title: string
  content: string
}> {
  return parseExplicit(text).map((clause) => {
    const resolved = resolveExplicitScope(clause)
    return {
      scope: resolved.scope,
      ...(resolved.agent ? { agent: resolved.agent } : {}),
      kind: inferKind(clause),
      title: titleFromClause(clause),
      content: clause,
    }
  })
}
