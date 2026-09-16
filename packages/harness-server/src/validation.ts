import type { RoutineSchedule } from "./types"

export const normalizeRoutineSchedule = (value: unknown): RoutineSchedule => {
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
    return { type: "manual" }
  }
  const schedule = value as Record<string, unknown>
  if (schedule.type === "manual" || schedule.type === "hourly") return { type: schedule.type }
  if (schedule.type === "daily" || schedule.type === "weekdays") {
    return { type: schedule.type, time: typeof schedule.time === "string" ? schedule.time : "09:00" }
  }
  if (schedule.type === "weekly") {
    return {
      type: "weekly",
      day: typeof schedule.day === "number" && schedule.day >= 0 && schedule.day <= 6 ? Math.round(schedule.day) : 1,
      time: typeof schedule.time === "string" ? schedule.time : "09:00",
    }
  }
  if (schedule.type === "interval") {
    return {
      type: "interval",
      intervalMinutes:
        typeof schedule.intervalMinutes === "number" && Number.isFinite(schedule.intervalMinutes) && schedule.intervalMinutes > 0
          ? Math.max(1, Math.round(schedule.intervalMinutes))
          : 60,
    }
  }
  return { type: "manual" }
}
