import type { RoutineRetry, RoutineSchedule } from "./types"

export const normalizeRoutineSchedule = (value: unknown): RoutineSchedule => {
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
    return { type: "manual" }
  }
  const schedule = value as Record<string, unknown>
  // Kept as written: an unknown zone is refused with its reason by `scheduleProblem`, not dropped.
  const zone = typeof schedule.timezone === "string" && schedule.timezone.trim() ? { timezone: schedule.timezone.trim() } : {}
  if (schedule.type === "manual" || schedule.type === "hourly") return { type: schedule.type, ...zone }
  if (schedule.type === "daily" || schedule.type === "weekdays") {
    return { type: schedule.type, time: typeof schedule.time === "string" ? schedule.time : "09:00", ...zone }
  }
  if (schedule.type === "weekly") {
    return {
      type: "weekly",
      day: typeof schedule.day === "number" && schedule.day >= 0 && schedule.day <= 6 ? Math.round(schedule.day) : 1,
      time: typeof schedule.time === "string" ? schedule.time : "09:00",
      ...zone,
    }
  }
  if (schedule.type === "interval") {
    return {
      type: "interval",
      intervalMinutes:
        typeof schedule.intervalMinutes === "number" && Number.isFinite(schedule.intervalMinutes) && schedule.intervalMinutes > 0
          ? Math.max(1, Math.round(schedule.intervalMinutes))
          : 60,
      ...zone,
    }
  }
  if (schedule.type === "cron") {
    return {
      type: "cron",
      expression: typeof schedule.expression === "string" ? schedule.expression.trim().replace(/\s+/g, " ") : "",
      ...zone,
    }
  }
  return { type: "manual" }
}

/** A routine's retry (RP-07), or nothing when it asks for none. Bounded so a typo cannot loop for a day. */
export const normalizeRoutineRetry = (value: unknown): RoutineRetry | undefined => {
  if (!value || typeof value !== "object") return undefined
  const retry = value as Record<string, unknown>
  const count = typeof retry.count === "number" && Number.isFinite(retry.count) ? Math.round(retry.count) : 0
  if (count < 1) return undefined
  const backoff = typeof retry.backoffMinutes === "number" && Number.isFinite(retry.backoffMinutes) ? retry.backoffMinutes : 5
  return { count: Math.min(count, 5), backoffMinutes: Math.min(Math.max(0, Math.round(backoff)), 24 * 60) }
}
