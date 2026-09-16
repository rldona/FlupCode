import type { Routine, RoutineSchedule } from "./types"

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

export const nextRunAt = (routine: Routine, now: number) => {
  if (!routine.enabled || routine.schedule.type === "manual") return undefined
  const anchor = routine.lastRunAt ?? routine.createdAt
  if (routine.schedule.type === "hourly") return anchor + 60 * 60 * 1000
  if (routine.schedule.type === "interval") return anchor + routine.schedule.intervalMinutes * 60 * 1000
  const scheduleAnchor = routine.lastRunAt ? anchor : Math.min(anchor, now)
  if (routine.schedule.type === "daily") return nextDaily(routine.schedule, scheduleAnchor)
  if (routine.schedule.type === "weekdays") return nextWeekdays(routine.schedule, scheduleAnchor)
  return nextWeekly(routine.schedule, scheduleAnchor)
}

export const isDue = (routine: Routine, now: number) => {
  const next = nextRunAt(routine, now)
  return next !== undefined && next <= now
}
