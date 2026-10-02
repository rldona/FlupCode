import type { QuotaWindow } from "./adapters"

/** One stored reading of a window (`quota_sample`), oldest first when given as a series. */
export type QuotaSample = Pick<QuotaWindow, "used" | "limit" | "remaining" | "resetAt"> & { at: number }

/** Less time than this between the first and last sample is too little to tell a pace from noise. */
export const MIN_SPAN_MS = 15 * 60_000

/**
 * The pace a window is being used at and when it runs out at that pace (UL-07), from its samples.
 *
 * Only the samples of the current stretch count: the same period (`resetAt`) and nothing before the
 * last time the window went back (a top-up of a balance, a raised limit, a reset the provider did
 * early). `undefined` when that stretch is shorter than `MIN_SPAN_MS`, so a fresh window says it
 * has no forecast yet instead of one drawn from two close readings.
 *
 * `perHour` is in the window's unit. `exhaustsAt` is when what is left reaches zero at that pace;
 * `null` when it is not being used, when it has no limit to reach, or when the window resets first.
 */
export function forecastOf(samples: QuotaSample[]) {
  const latest = samples.at(-1)
  if (!latest) return undefined
  const consumed = (sample: QuotaSample) => (sample.used !== null ? sample.used : sample.remaining !== null ? -sample.remaining : null)
  const stretch = samples.filter((sample) => sample.resetAt === latest.resetAt && consumed(sample) !== null)
  const start = stretch.findLastIndex((sample, index) => index > 0 && consumed(sample)! < consumed(stretch[index - 1]!)!)
  const current = start === -1 ? stretch : stretch.slice(start)
  const first = current[0]
  const last = current.at(-1)
  if (!first || !last || last.at - first.at < MIN_SPAN_MS) return undefined
  const perHour = (consumed(last)! - consumed(first)!) / ((last.at - first.at) / 3_600_000)
  const left = last.remaining ?? (last.limit !== null && last.used !== null ? last.limit - last.used : null)
  const exhaustsAt = perHour > 0 && left !== null ? last.at + (Math.max(0, left) / perHour) * 3_600_000 : null
  return {
    perHour,
    exhaustsAt: exhaustsAt !== null && (last.resetAt === null || exhaustsAt < last.resetAt) ? Math.round(exhaustsAt) : null,
  }
}
