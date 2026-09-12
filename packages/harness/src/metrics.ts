import type { SessionInfo } from "@opencode-ai/client"

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

  return {
    sessions: filtered.length,
    tokens,
    activeDays: dayNumbers.length,
    currentStreak,
    longestStreak,
    peakHour: filtered.length > 0 ? `${peak}:00` : "—",
    favoriteModel: models[0]?.name ?? "—",
    models,
  }
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
  { name: "El Quijote", tokens: 380_000 },
  { name: "Cien años de soledad", tokens: 160_000 },
  { name: "1984", tokens: 90_000 },
  { name: "El Señor de los Anillos", tokens: 576_000 },
]

export function comparison(tokens: number) {
  if (tokens <= 0) return ""
  const reference = COMPARISONS[tokens % COMPARISONS.length]
  if (!reference) return ""
  const ratio = Math.max(1, Math.round(tokens / reference.tokens))
  return `Usaste ~${ratio}× más tokens que ${reference.name}.`
}

export { dayKey }
