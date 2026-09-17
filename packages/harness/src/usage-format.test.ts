import { describe, expect, test } from "bun:test"
import { duration, money, scaleOf, share } from "./components/UsagePanel"

describe("money", () => {
  test("shows a small amount rather than rounding it to nothing", () => {
    // At two places this reads $0.00, which reads as free. It is not free: it is the number that
    // becomes real money the two-hundredth time a routine runs.
    expect(money(0.0034)).toBe("$0.0034")
    expect(money(0.009)).toBe("$0.0090")
  })

  test("is money once it is money", () => {
    expect(money(1.5)).toBe("$1.50")
    expect(money(12.345)).toBe("$12.35")
  })

  test("nothing is nothing, and says so in one character", () => {
    expect(money(0)).toBe("$0")
  })
})

describe("duration", () => {
  test("reads as a person would say it", () => {
    expect(duration(4_000)).toBe("4s")
    expect(duration(95_000)).toBe("1m 35s")
    expect(duration(3_725_000)).toBe("1h 02m")
  })

  test("pads, so a column of them lines up", () => {
    expect(duration(61_000)).toBe("1m 01s")
  })
})

describe("share", () => {
  test("is a percentage", () => {
    expect(share(1, 4)).toBe(25)
    expect(share(2, 3)).toBe(67)
  })

  test("nothing divided by nothing is nothing, not NaN", () => {
    // A report with no cost at all would otherwise render bars of width "NaN%".
    expect(share(0, 0)).toBe(0)
    expect(share(5, 0)).toBe(0)
  })
})

describe("scaleOf", () => {
  test("scales to the biggest day, even when every day costs pennies", () => {
    // `Math.max(1, …)` was the first version. With costs under a dollar the 1 wins, and every bar
    // in the chart is drawn at a few per cent of its box — which is what it looked like.
    const days = [
      { day: "1", cost: 0.05, tokens: 100 },
      { day: "2", cost: 0.2, tokens: 400 },
    ]
    expect(scaleOf(days)).toBe(0.2)
    expect(share(days[1]!.cost, scaleOf(days))).toBe(100)
    expect(share(days[0]!.cost, scaleOf(days))).toBe(25)
  })

  test("falls back to tokens for a day that cost nothing", () => {
    expect(scaleOf([{ cost: 0, tokens: 900 }])).toBe(900)
  })

  test("never returns zero, so nothing is divided by it", () => {
    expect(scaleOf([])).toBe(1)
    expect(scaleOf([{ cost: 0, tokens: 0 }])).toBe(1)
  })
})
