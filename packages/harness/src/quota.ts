import { UNKNOWN, money } from "./cost"
import { formatDateTime } from "./dates"
import { getLocale, t } from "./i18n"
import type { QuotaWindow } from "./types"

/**
 * How a provider quota window reads (UL-07). Every figure names its unit and what it is; a value the
 * provider did not give is never shown as zero.
 */

export function windowName(window: Pick<QuotaWindow, "id" | "kind">) {
  if (window.id === "key-limit") return window.kind === "spendCap" ? t("Key spending cap") : t("Key limit")
  if (window.id === "month") return t("This month")
  if (window.id === "free-requests") return t("Free model requests today")
  if (window.kind === "balance") return t("Balance")
  return window.id
}

/** An amount in a window's unit: money with its currency, credits and requests by name. */
export function amount(value: number, unit: QuotaWindow["unit"]) {
  if (unit === "usd") return money(value)
  if (unit === "cny") return `¥${value.toFixed(2)}`
  if (unit === "requests") return t("{n} requests", { n: Math.round(value).toLocaleString(getLocale()) })
  return t("{n} credits", { n: value.toFixed(2) })
}

/** What the window holds now: used of its limit, what a balance has left, or what was used. */
export function windowValue(window: QuotaWindow) {
  if (window.limit !== null && window.used !== null)
    return t("{spent} of {limit}", { spent: amountNumber(window.used, window.unit), limit: amount(window.limit, window.unit) })
  if (window.remaining !== null) return t("{amount} left", { amount: amount(window.remaining, window.unit) })
  if (window.used !== null) return t("{amount} used", { amount: amount(window.used, window.unit) })
  return UNKNOWN
}

/** The share of the limit used, for a meter; `undefined` where there is no limit. */
export function usedShare(window: QuotaWindow) {
  if (window.limit === null || window.used === null || window.limit <= 0) return undefined
  return Math.min(100, Math.max(0, Math.round((window.used / window.limit) * 100)))
}

/** The pace and where it leads, or that there are not enough readings for one yet. */
export function forecastText(window: QuotaWindow) {
  const forecast = window.forecast
  if (!forecast) return t("Not enough readings for a forecast yet")
  if (forecast.perHour <= 0) return t("Not being used lately")
  const pace = t("{amount} an hour", { amount: amount(forecast.perHour, window.unit) })
  if (forecast.exhaustsAt !== null) return t("{pace}: runs out {when}", { pace, when: formatDateTime(forecast.exhaustsAt) })
  if (window.resetAt !== null && (window.limit !== null || window.remaining !== null))
    return t("{pace}: lasts until it resets", { pace })
  return pace
}

/**
 * The window a collapsed provider shows: its shortest, the one that resets first. A window that
 * never resets (a cap, a balance) only when there is no other.
 */
export function headlineWindow(windows: QuotaWindow[]) {
  return windows.toSorted((a, b) => (a.resetAt ?? Infinity) - (b.resetAt ?? Infinity))[0]
}

function amountNumber(value: number, unit: QuotaWindow["unit"]) {
  if (unit === "requests") return Math.round(value).toLocaleString(getLocale())
  if (unit === "usd") return money(value)
  if (unit === "cny") return `¥${value.toFixed(2)}`
  return value.toFixed(2)
}
