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

const MODEL_COLORS = [
  "#6ea8fe",
  "#7aa2d6",
  "#4f7fc4",
  "#3b6fb0",
  "#8b5cf6",
  "#a78bfa",
  "#64748b",
  "#94a3b8",
]

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
  const models = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

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
