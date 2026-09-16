import type { Routine, RoutineSchedule } from "./types"

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object"

export const normalizeRoutineSchedule = (value: unknown, fallbackInterval: number): RoutineSchedule => {
  if (!isRecord(value) || typeof value.type !== "string") return { type: "interval", intervalMinutes: fallbackInterval }
  if (value.type === "manual" || value.type === "hourly") return { type: value.type }
  if (value.type === "daily" || value.type === "weekdays") {
    return { type: value.type, time: typeof value.time === "string" ? value.time : "09:00" }
  }
  if (value.type === "weekly") {
    return {
      type: "weekly",
      day: typeof value.day === "number" && value.day >= 0 && value.day <= 6 ? value.day : 1,
      time: typeof value.time === "string" ? value.time : "09:00",
    }
  }
  if (value.type === "interval") {
    return {
      type: "interval",
      intervalMinutes:
        typeof value.intervalMinutes === "number" && Number.isFinite(value.intervalMinutes) && value.intervalMinutes > 0
          ? Math.max(1, Math.round(value.intervalMinutes))
          : fallbackInterval,
    }
  }
  return { type: "interval", intervalMinutes: fallbackInterval }
}

const timeParts = (time: string) => {
  const hours = Number(time.split(":")[0])
  const minutes = Number(time.split(":")[1])
  return {
    hours: Number.isFinite(hours) ? Math.max(0, Math.min(23, hours)) : 9,
    minutes: Number.isFinite(minutes) ? Math.max(0, Math.min(59, minutes)) : 0,
  }
}

const atLocalTime = (date: Date, time: string) => {
  const next = new Date(date)
  const parts = timeParts(time)
  next.setHours(parts.hours, parts.minutes, 0, 0)
  return next.getTime()
}

const nextDaily = (schedule: Extract<RoutineSchedule, { type: "daily" }>, anchor: number) => {
  const candidate = atLocalTime(new Date(anchor), schedule.time)
  if (candidate > anchor) return candidate
  const next = new Date(candidate)
  next.setDate(next.getDate() + 1)
  return next.getTime()
}

const nextWeekdays = (schedule: Extract<RoutineSchedule, { type: "weekdays" }>, anchor: number) => {
  const date = new Date(anchor)
  for (let offset = 0; offset < 8; offset += 1) {
    const candidateDate = new Date(date)
    candidateDate.setDate(date.getDate() + offset)
    const candidate = atLocalTime(candidateDate, schedule.time)
    if (candidate > anchor && candidateDate.getDay() > 0 && candidateDate.getDay() < 6) return candidate
  }
  return undefined
}

const nextWeekly = (schedule: Extract<RoutineSchedule, { type: "weekly" }>, anchor: number) => {
  const date = new Date(anchor)
  for (let offset = 0; offset < 8; offset += 1) {
    const candidateDate = new Date(date)
    candidateDate.setDate(date.getDate() + offset)
    const candidate = atLocalTime(candidateDate, schedule.time)
    if (candidate > anchor && candidateDate.getDay() === schedule.day) return candidate
  }
  return undefined
}

export const routineNextRunAt = (routine: Routine, now = Date.now()) => {
  if (!routine.enabled || routine.schedule.type === "manual") return undefined
  const anchor = routine.lastRunAt ?? routine.createdAt
  if (routine.schedule.type === "hourly") return anchor + 60 * 60 * 1000
  if (routine.schedule.type === "interval") return anchor + routine.schedule.intervalMinutes * 60 * 1000
  if (routine.schedule.type === "daily") return nextDaily(routine.schedule, routine.lastRunAt ? anchor : Math.min(anchor, now))
  if (routine.schedule.type === "weekdays") return nextWeekdays(routine.schedule, routine.lastRunAt ? anchor : Math.min(anchor, now))
  return nextWeekly(routine.schedule, routine.lastRunAt ? anchor : Math.min(anchor, now))
}

export const routineIsDue = (routine: Routine, now = Date.now()) => {
  const next = routineNextRunAt(routine, now)
  return next !== undefined && next <= now
}
