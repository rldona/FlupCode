import type { ModelInfo, SessionInfo, SessionMessageAssistant, SessionMessageInfo } from "./engine-types"
import type { SessionStats } from "./engine/contract"

export type ContextFigures = {
  used: number
  limit: number
  tokens?: { input: number; output: number; reasoning: number }
  /**
   * The figure sizes the text the engine will send next instead of a finished step. It is set
   * between a compaction and the first step after it, the only stretch where no step has measured
   * the compacted session yet. The views say so rather than pass it off as measured.
   */
  estimated?: boolean
  /**
   * What the engine counts and where it folds the session: `count` is over the same step the rest of
   * the figures come from, `at` is where the engine stops sending it. Absent when the engine will
   * not compact this session, and when the figure is an estimate rather than a step of its own.
   */
  compaction?: { at: number; count: number }
}

/** The engine's own numbers (`session/overflow.ts`, `provider/transform.ts`), read rather than
 *  guessed: the meter warns about the compaction a session is actually about to get. */
const COMPACTION_BUFFER = 20_000
const OUTPUT_TOKEN_MAX = 32_000

export type CompactionConfig = { auto?: boolean; reserved?: number }

/**
 * The count at which the engine decides the session is full: the window less what it keeps for the
 * answer. Undefined when it will not compact — a model whose window it does not know, or automatic
 * compaction turned off — which is what tells the meter it has nothing to warn about.
 *
 * The two branches are the engine's own: a model that reports an input limit leaves `reserved` off
 * it, and one that does not has the answer's room taken off the window instead, whatever the
 * configured reserve says.
 */
export function compactionAt(model: ModelInfo | undefined, compaction?: CompactionConfig): number | undefined {
  // A model the catalog describes without limits is one whose window is unknown, not one of zero.
  const context = model?.limit?.context ?? 0
  if (context === 0) return undefined
  if (compaction?.auto === false) return undefined
  const output = Math.min(model!.limit.output ?? 0, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
  const reserved = compaction?.reserved ?? Math.min(COMPACTION_BUFFER, output)
  const input = model!.limit.input
  return input ? Math.max(0, input - reserved) : Math.max(0, context - output)
}

/** How the engine counts a step against that point. The provider's own total is not in the message
 *  the client sees, so this is the sum the engine falls back to. */
const overflowCount = (tokens: NonNullable<SessionMessageAssistant["tokens"]>) =>
  tokens.input + tokens.output + tokens.cache.read + tokens.cache.write

/**
 * Whether the session is close enough to be folded for the meter to say so. The engine's rule is
 * exact (`count >= at`); this is only how early the screen starts warning, so the reader has a turn
 * to ask for a summary before the engine takes one.
 */
export function compactionNear(compaction: { at: number; count: number } | undefined) {
  return !!compaction && compaction.count >= compaction.at * 0.9
}

const hasTokens = (tokens: SessionMessageAssistant["tokens"]) =>
  !!tokens && tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write > 0

/**
 * The engine's own compaction: the summary message, the v2 shape, or the bare prompt that asks for
 * it when the summary is still to come. Its tokens size the request that wrote the summary — the
 * history it was asked to fold away — so it is never the reading of the session it left behind.
 */
const isCompaction = (message: SessionMessageInfo) =>
  message.type === "compaction" ||
  !!(message as { compaction?: unknown }).compaction ||
  (message.type === "assistant" && (message as { summary?: boolean }).summary === true)

/**
 * The context window in use. What the session spent is the usage ledger's (UL-06), not this. The step that is still running carries no
 * tokens yet, so the latest step that reported them is used instead: the figure stays put while the
 * model thinks instead of dropping to zero, and grows as new steps finish.
 *
 * A compaction leaves the window small but sets no step to read it from: the summary that answers it
 * is a message like any other, and taking its tokens would hold up the size of the history the
 * reader just watched go away. Until a step reports the compacted session, the context is the text
 * the engine kept — the summary and whatever followed it — sized here instead. It is approximate,
 * and the step the next prompt runs replaces it with the engine's own number.
 */
export function contextFigures(
  session: SessionInfo | undefined,
  messages: SessionMessageInfo[],
  model: ModelInfo | undefined,
  compaction?: CompactionConfig,
): ContextFigures {
  const limit = model?.limit?.context ?? 0
  const boundary = messages.findLastIndex(isCompaction)
  // Only after the last compaction: a step before it measured a history that is no longer sent, and
  // the summary itself is at the boundary, so the slice leaves both out.
  const measured = messages
    .slice(boundary + 1)
    .findLast(
      (message): message is SessionMessageAssistant => message.type === "assistant" && hasTokens(message.tokens),
    )
  if (measured) {
    const tokens = measured.tokens!
    const at = compactionAt(model, compaction)
    return {
      used: tokens.input + tokens.cache.read,
      limit,
      tokens: { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning },
      ...(at !== undefined ? { compaction: { at, count: overflowCount(tokens) } } : {}),
    }
  }
  if (boundary >= 0)
    return {
      used: standingTokens(messages) + sentTokens(messages.slice(boundary)),
      limit,
      estimated: true,
    }
  return {
    used: (session?.tokens.input ?? 0) + (session?.tokens.cache.read ?? 0),
    limit,
  }
}

/**
 * The prompt the engine puts around the messages — the system prompt, the tool schemas, the project
 * instructions — which is in no message of its own, so the transcript cannot size it. The session's
 * first step is the cheapest reading of it: its whole prompt was the messages before it, so what it
 * carries beyond their text is what every later prompt pays again too. Zero when nothing measured a
 * step yet, or when no message came first — then there is no telling the prompt from the rest.
 */
function standingTokens(messages: SessionMessageInfo[]) {
  let chars = 0
  for (const message of messages) {
    if (message.type !== "assistant" || !hasTokens(message.tokens)) {
      chars += messageChars(message)
      continue
    }
    const tokens = message.tokens!
    const text = Math.ceil(chars / 4)
    return text > 0 ? Math.max(0, tokens.input + tokens.cache.read - text) : 0
  }
  return 0
}

/** What the text of these messages costs to send, at the four characters per token the composer
 *  already assumes. */
function sentTokens(messages: SessionMessageInfo[]) {
  return Math.ceil(messages.reduce((chars, message) => chars + messageChars(message), 0) / 4)
}

/** The text a message carries that the engine would send back: a prompt, an answer, a tool call, or
 *  the summary and kept tail of a v2 compaction, which carries them as strings of its own. */
function messageChars(message: SessionMessageInfo) {
  const prompt = (message as { text?: string }).text ?? ""
  const compaction = message as { summary?: unknown; recent?: unknown }
  const kept =
    (typeof compaction.summary === "string" ? compaction.summary.length : 0) +
    (typeof compaction.recent === "string" ? compaction.recent.length : 0)
  const parts =
    (message as { content?: Array<{ type?: string; text?: string; state?: ToolPartState }> }).content ?? []
  return (
    prompt.length +
    kept +
    parts.reduce((sum, part) => {
      if (part.type === "text") return sum + (part.text?.length ?? 0)
      if (part.type !== "tool" || !part.state) return sum
      const input = part.state.input === undefined ? "" : JSON.stringify(part.state.input)
      const output = part.state.output ?? part.state.content?.map((item) => item.text ?? "").join("") ?? ""
      const error = typeof part.state.error === "string" ? part.state.error : (part.state.error?.message ?? "")
      return sum + input.length + output.length + error.length
    }, 0)
  )
}

type ToolPartState = {
  input?: unknown
  output?: string
  error?: string | { message?: string }
  content?: Array<{ text?: string }>
}

export function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export type ActivityDay = {
  /** Days since the epoch, at local midnight: what the heatmap lines its weeks up by. */
  day: number
  count: number
}

/**
 * The last `days` local days, oldest first, each with the model calls the engine counted on it. The
 * engine lists only the days that had any, by local date (`YYYY-MM-DD` in the timezone it was asked
 * for); a day it does not list had none.
 */
export function activityDays(activity: SessionStats["activity"], days: number, now: number): ActivityDay[] {
  const steps = new Map(activity.map((entry) => [entry.date, entry.steps]))
  const today = new Date(now)
  return Array.from({ length: days }, (_, index) => {
    const at = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - index))
    const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`
    // Local midnight in UTC terms, so a day across a clock change still lands on its own number.
    return { day: Math.round(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / 86_400_000), count: steps.get(date) ?? 0 }
  })
}
