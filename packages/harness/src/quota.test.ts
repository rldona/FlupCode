import { afterEach, describe, expect, test } from "bun:test"
import { setLocale } from "./i18n"
import { forecastText, headlineWindow, usedShare, windowName, windowValue } from "./quota"
import type { QuotaWindow } from "./types"

const window = (over: Partial<QuotaWindow>): QuotaWindow => ({
  id: "key-limit",
  kind: "calendar",
  unit: "credits",
  used: 7.5,
  limit: 20,
  remaining: 12.5,
  resetAt: Date.UTC(2026, 10, 1),
  forecast: null,
  ...over,
})

afterEach(() => setLocale("en"))

describe("provider quota copy (UL-07)", () => {
  test("every value names its unit; nothing the provider did not say reads as zero", () => {
    expect(windowValue(window({}))).toBe("7.50 of 20.00 credits")
    expect(windowValue(window({ id: "free-requests", unit: "requests", used: 12, limit: 1000, remaining: 988 }))).toBe(
      "12 of 1,000 requests",
    )
    expect(windowValue(window({ id: "balance-usd", kind: "balance", unit: "usd", used: null, limit: null, remaining: 4.2 }))).toBe(
      "$4.20 left",
    )
    expect(windowValue(window({ id: "balance-cny", kind: "balance", unit: "cny", used: null, limit: null, remaining: 110 }))).toBe(
      "¥110.00 left",
    )
    expect(windowValue(window({ id: "month", limit: null, remaining: null }))).toBe("7.50 credits used")
    expect(windowValue(window({ used: null, limit: null, remaining: null }))).toBe("—")
  })

  test("a meter only where there is a limit", () => {
    expect(usedShare(window({}))).toBe(38)
    expect(usedShare(window({ limit: null }))).toBeUndefined()
  })

  test("the forecast says when it runs out, that it lasts, or that there is not enough to tell", () => {
    expect(forecastText(window({}))).toBe("Not enough readings for a forecast yet")
    expect(forecastText(window({ forecast: { perHour: 0, exhaustsAt: null } }))).toBe("Not being used lately")
    expect(forecastText(window({ forecast: { perHour: 0.5, exhaustsAt: null } }))).toBe(
      "0.50 credits an hour: lasts until it resets",
    )
    expect(forecastText(window({ forecast: { perHour: 3, exhaustsAt: Date.UTC(2026, 9, 7, 19) } }))).toStartWith(
      "3.00 credits an hour: runs out ",
    )
    // No limit to reach: a pace, and no claim about lasting.
    expect(forecastText(window({ id: "month", limit: null, remaining: null, forecast: { perHour: 1, exhaustsAt: null } }))).toBe(
      "1.00 credits an hour",
    )
  })

  test("collapsed, a provider shows the window that resets first", () => {
    const month = window({ id: "key-limit", resetAt: Date.UTC(2026, 10, 1) })
    const day = window({ id: "free-requests", unit: "requests", resetAt: Date.UTC(2026, 9, 8) })
    const balance = window({ id: "balance-usd", kind: "balance", resetAt: null })
    expect(headlineWindow([balance, month, day])).toBe(day)
    expect(headlineWindow([balance])).toBe(balance)
    expect(headlineWindow([])).toBeUndefined()
  })

  test("names read in Spanish too", () => {
    setLocale("es")
    expect(windowName(window({}))).toBe("Límite de la clave")
    expect(windowValue(window({}))).toBe("7.50 de 20.00 créditos")
  })
})
