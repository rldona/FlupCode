import { describe, expect, test } from "bun:test"
import { MIN_SPAN_MS, forecastOf, type QuotaSample } from "./forecast"

const hour = 3_600_000
const reset = 100 * hour
const limited = (at: number, used: number): QuotaSample => ({ at, used, limit: 20, remaining: 20 - used, resetAt: reset })
const balance = (at: number, remaining: number): QuotaSample => ({ at, used: null, limit: null, remaining, resetAt: null })

describe("quota forecast (UL-07)", () => {
  test("a steady pace runs out when what is left reaches zero", () => {
    // 1 credit an hour with 10 left at hour 10: out at hour 20, before the reset at hour 100.
    expect(forecastOf([limited(0, 0), limited(5 * hour, 5), limited(10 * hour, 10)])).toEqual({ perHour: 1, exhaustsAt: 20 * hour })
  })

  test("a window that resets before it runs out has a pace and no exhaustion", () => {
    expect(forecastOf([limited(0, 0), limited(10 * hour, 1)])).toEqual({ perHour: 0.1, exhaustsAt: null })
  })

  test("a balance runs out at the pace it goes down; a top-up starts the pace afresh", () => {
    expect(forecastOf([balance(0, 10), balance(2 * hour, 8)])).toEqual({ perHour: 1, exhaustsAt: 10 * hour })
    // Topped up at hour 2: only the readings since count.
    expect(forecastOf([balance(0, 10), balance(hour, 2), balance(2 * hour, 50), balance(4 * hour, 46)])).toEqual({
      perHour: 2,
      exhaustsAt: 27 * hour,
    })
  })

  test("a window not being used never runs out", () => {
    expect(forecastOf([limited(0, 4), limited(hour, 4)])).toEqual({ perHour: 0, exhaustsAt: null })
  })

  test("readings closer than the minimum span, or from an earlier period, give no forecast yet", () => {
    expect(forecastOf([])).toBeUndefined()
    expect(forecastOf([limited(0, 0)])).toBeUndefined()
    expect(forecastOf([limited(0, 0), limited(MIN_SPAN_MS - 1, 5)])).toBeUndefined()
    const previous = { ...limited(0, 15), resetAt: 0 }
    expect(forecastOf([previous, limited(hour, 1)])).toBeUndefined()
  })

  test("with no limit there is a pace and nothing to run out of", () => {
    const month = (at: number, used: number): QuotaSample => ({ at, used, limit: null, remaining: null, resetAt: reset })
    expect(forecastOf([month(0, 1), month(2 * hour, 3)])).toEqual({ perHour: 1, exhaustsAt: null })
  })
})
