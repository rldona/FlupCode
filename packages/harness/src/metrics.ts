import type { ModelInfo, SessionInfo, SessionMessageAssistant, SessionMessageInfo } from "./engine-types"

export type UsageRange = "all" | "30d" | "7d"

export type UsageMetrics = {
  sessions: number
  tokens: number
  activeDays: number
  currentStreak: number
  longestStreak: number
  peakHour: string
  favoriteModel: string
  models: Array<{ name: string; count: number }>
  modelUsage: Array<{ name: string; input: number; output: number; total: number; share: number }>
  weeks: Array<{ label: string; total: number; segments: Array<{ name: string; tokens: number }> }>
}

const MODEL_COLORS = ["#6ea8fe", "#7aa2d6", "#4f7fc4", "#3b6fb0", "#8b5cf6", "#a78bfa", "#64748b", "#94a3b8"]

export function modelColor(index: number) {
  return MODEL_COLORS[index % MODEL_COLORS.length]!
}

function sessionTokens(session: SessionInfo) {
  return session.tokens.input + session.tokens.output + session.tokens.reasoning
}

const dayKey = (timestamp: number) => {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

const dayNumber = (timestamp: number) => {
  const date = new Date(timestamp)
  return Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 86400000)
}

export function rangeCutoff(range: UsageRange) {
  if (range === "all") return 0
  return Date.now() - (range === "7d" ? 7 : 30) * 86400000
}

export function filterByRange(sessions: SessionInfo[], range: UsageRange) {
  const cutoff = rangeCutoff(range)
  return sessions.filter((session) => session.time.created >= cutoff)
}

export function computeMetrics(filtered: SessionInfo[]): UsageMetrics {
  const tokens = filtered.reduce(
    (sum, session) =>
      sum +
      session.tokens.input +
      session.tokens.output +
      session.tokens.reasoning +
      session.tokens.cache.read +
      session.tokens.cache.write,
    0,
  )

  const dayNumbers = [
    ...new Set(filtered.map((session) => dayNumber(session.time.updated || session.time.created))),
  ].sort((a, b) => a - b)

  let longestStreak = 0
  let run = 0
  let previous: number | undefined
  for (const day of dayNumbers) {
    run = previous !== undefined && day === previous + 1 ? run + 1 : 1
    longestStreak = Math.max(longestStreak, run)
    previous = day
  }

  const days = new Set(dayNumbers)
  const today = dayNumber(Date.now())
  const cursor = days.has(today) ? today : days.has(today - 1) ? today - 1 : undefined
  let currentStreak = 0
  let pointer = cursor
  while (pointer !== undefined && days.has(pointer)) {
    currentStreak++
    pointer--
  }

  const hours = new Array<number>(24).fill(0)
  for (const session of filtered) {
    const hour = new Date(session.time.created).getHours()
    hours[hour] = (hours[hour] ?? 0) + 1
  }
  const peak = hours.indexOf(Math.max(...hours))

  const counts = new Map<string, number>()
  for (const session of filtered) {
    const name = session.model?.id
    if (!name) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const models = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)

  const usageMap = new Map<string, { input: number; output: number; total: number }>()
  for (const session of filtered) {
    const name = session.model?.id
    if (!name) continue
    const current = usageMap.get(name) ?? { input: 0, output: 0, total: 0 }
    current.input += session.tokens.input
    current.output += session.tokens.output
    current.total += sessionTokens(session)
    usageMap.set(name, current)
  }
  const grandTotal = [...usageMap.values()].reduce((sum, item) => sum + item.total, 0)
  const modelUsage = [...usageMap.entries()]
    .map(([name, value]) => ({ name, ...value, share: grandTotal > 0 ? value.total / grandTotal : 0 }))
    .sort((a, b) => b.total - a.total)

  const week = 7 * 86400000
  const end = Date.now()
  const earliest = filtered.length
    ? Math.min(...filtered.map((session) => session.time.updated || session.time.created))
    : end
  const weeksCount = Math.max(4, Math.min(16, Math.ceil((end - earliest) / week) || 4))
  const start = end - weeksCount * week
  const buckets = Array.from({ length: weeksCount }, (_, index) => {
    const bucketStart = start + index * week
    return {
      label: new Date(bucketStart).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      total: 0,
      map: new Map<string, number>(),
    }
  })
  for (const session of filtered) {
    const at = session.time.updated || session.time.created
    const index = Math.min(weeksCount - 1, Math.max(0, Math.floor((at - start) / week)))
    const bucket = buckets[index]!
    const tokens = sessionTokens(session)
    bucket.total += tokens
    const name = session.model?.id ?? "unknown"
    bucket.map.set(name, (bucket.map.get(name) ?? 0) + tokens)
  }
  const modelOrder = modelUsage.map((item) => item.name)
  const weeks = buckets.map((bucket) => ({
    label: bucket.label,
    total: bucket.total,
    segments: modelOrder
      .map((name) => ({ name, tokens: bucket.map.get(name) ?? 0 }))
      .filter((segment) => segment.tokens > 0),
  }))

  return {
    sessions: filtered.length,
    tokens,
    activeDays: dayNumbers.length,
    currentStreak,
    longestStreak,
    peakHour: filtered.length > 0 ? `${peak}:00` : "—",
    favoriteModel: models[0]?.name ?? "—",
    models,
    modelUsage,
    weeks,
  }
}

/**
 * What an assistant step cost, priced like the legacy engine: per million tokens, with the largest
 * context tier the step went over, and reasoning at the output rate.
 */
export function stepCost(tokens: NonNullable<SessionMessageAssistant["tokens"]>, prices: ModelInfo["cost"] = []) {
  const context = tokens.input + tokens.cache.read + tokens.cache.write
  const price =
    prices.filter((entry) => entry.tier && context > entry.tier.size).sort((a, b) => b.tier!.size - a.tier!.size)[0] ??
    prices.find((entry) => !entry.tier)
  if (!price) return 0
  return (
    (tokens.input * price.input +
      (tokens.output + tokens.reasoning) * price.output +
      tokens.cache.read * price.cache.read +
      tokens.cache.write * price.cache.write) /
    1_000_000
  )
}

/**
 * What a session has spent. The engine only adds legacy history to the session's cost; v2 steps carry
 * their tokens with a cost of 0, so those are priced here from their model.
 */
export function sessionCost(session: SessionInfo | undefined, messages: SessionMessageInfo[], models: ModelInfo[]) {
  return messages.reduce((sum, message) => {
    const step = message as SessionMessageAssistant
    if (message.type !== "assistant" || !step.tokens) return sum
    if (step.cost) return sum + step.cost
    const model = models.find((entry) => entry.providerID === step.model?.providerID && entry.id === step.model?.id)
    return sum + stepCost(step.tokens, model?.cost)
  }, session?.cost ?? 0)
}

export type ContextFigures = {
  used: number
  limit: number
  cost: number
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
 * The context window in use and the session's spend. The step that is still running carries no
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
  models: ModelInfo[],
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
  const cost = sessionCost(session, messages, models)
  if (measured) {
    const tokens = measured.tokens!
    const at = compactionAt(model, compaction)
    return {
      used: tokens.input + tokens.cache.read,
      limit,
      cost,
      tokens: { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning },
      ...(at !== undefined ? { compaction: { at, count: overflowCount(tokens) } } : {}),
    }
  }
  if (boundary >= 0)
    return { used: standingTokens(messages) + sentTokens(messages.slice(boundary)), limit, cost, estimated: true }
  return {
    used: (session?.tokens.input ?? 0) + (session?.tokens.cache.read ?? 0),
    limit,
    cost,
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
  day: number
  count: number
}

export function activityByDay(sessions: SessionInfo[], days: number): ActivityDay[] {
  const counts = new Map<number, number>()
  for (const session of sessions) {
    const day = dayNumber(session.time.updated || session.time.created)
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  const today = dayNumber(Date.now())
  const start = today - (days - 1)
  const result: ActivityDay[] = []
  for (let day = start; day <= today; day++) result.push({ day, count: counts.get(day) ?? 0 })
  return result
}

const COMPARISONS = [
  { name: "Dune", tokens: 226_000 },
  { name: "Don Quixote", tokens: 380_000 },
  { name: "One Hundred Years of Solitude", tokens: 160_000 },
  { name: "1984", tokens: 90_000 },
  { name: "The Lord of the Rings", tokens: 576_000 },
]

export function comparison(tokens: number): { ratio: number; name: string } | undefined {
  if (tokens <= 0) return
  const reference = COMPARISONS[tokens % COMPARISONS.length]
  if (!reference) return
  return { ratio: Math.max(1, Math.round(tokens / reference.tokens)), name: reference.name }
}

export { dayKey }
