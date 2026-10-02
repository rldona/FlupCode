import { describe, expect, test } from "bun:test"
import { basisLabel, costText, known, lensMoney, lensOf, lensTotals, money, tokenCount } from "./cost"
import { setLocale } from "./i18n"
import type { MoneyLine, UsageBucket } from "./types"

const tokens = (input: number) => ({ input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
const line = (over: Partial<MoneyLine>): MoneyLine => ({
  basis: "engine-list-price",
  billing: "metered",
  usd: 0.1,
  events: 1,
  ...over,
})
const bucket = (money: MoneyLine[], unpriced = 0): UsageBucket => ({
  events: money.reduce((sum, entry) => sum + entry.events, 0) + unpriced,
  tokens: tokens(100),
  money,
  unpriced: { events: unpriced, tokens: tokens(unpriced * 10) },
})

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

describe("the money lenses (audit §8.4)", () => {
  test("a subscription is notional whatever priced it; a provider's own figure is measured; the rest is estimated", () => {
    expect(lensOf(line({ billing: "subscription" }))).toBe("notional")
    expect(lensOf(line({ basis: "provider-reported", billing: "subscription" }))).toBe("notional")
    expect(lensOf(line({ basis: "provider-reported" }))).toBe("measured")
    expect(lensOf(line({}))).toBe("estimated")
    expect(lensOf(line({ basis: "flupcode-priced", billing: "local" }))).toBe("estimated")
    expect(lensOf(line({ billing: "unknown" }))).toBe("estimated")
  })

  test("lenses come in one order, empty ones left out, each with its own lines", () => {
    const totals = lensTotals(
      bucket([line({ billing: "subscription", usd: 0.3 }), line({ usd: 0.1 }), line({ billing: "unknown", usd: 0.2 })]),
    )
    expect(totals.map((entry) => entry.lens)).toEqual(["estimated", "notional"])
    expect(totals[0]!.usd).toBeCloseTo(0.3)
    expect(totals[0]!.lines).toHaveLength(2)
    expect(totals[1]!.usd).toBeCloseTo(0.3)
    expect(lensTotals(undefined)).toEqual([])
  })

  test("each lens is written its own way: ~ for an estimate, a word for notional, plain for measured", () => {
    setLocale("en")
    expect(lensMoney("estimated", 0.42)).toBe("~$0.42")
    expect(lensMoney("notional", 0.3)).toBe("$0.30 notional")
    expect(lensMoney("measured", 1.5)).toBe("$1.50")
  })
})

describe("basis labels", () => {
  test("say the lens, whose price it is and how it was paid for", () => {
    setLocale("en")
    expect(basisLabel(line({}))).toBe("Estimated · Engine list price · pay per use")
    expect(basisLabel(line({ billing: "subscription" }))).toBe("Notional · Engine list price · subscription")
    expect(basisLabel(line({ basis: "provider-reported" }))).toBe("Measured · Reported by the provider · pay per use")
    expect(basisLabel(line({ basis: "flupcode-priced", billing: "local" }))).toBe(
      "Estimated · FlupCode price · local model",
    )
    expect(basisLabel(line({ billing: "unknown" }))).toBe("Estimated · Engine list price · billing unknown")
  })

  test("are translated", () => {
    setLocale("es")
    expect(basisLabel(line({ billing: "subscription" }))).toBe("Nocional · Precio de lista del motor · suscripción")
    expect(lensMoney("notional", 0.3)).toBe("$0.30 nocional")
    setLocale("en")
  })
})

describe("costText", () => {
  test("names every part and never adds lenses together", () => {
    setLocale("en")
    expect(costText(bucket([line({ usd: 0.42 }), line({ billing: "subscription", usd: 0.3 })], 3))).toBe(
      "~$0.42 · $0.30 notional · 3 unpriced",
    )
  })

  test("unpriced alone is unpriced, never $0", () => {
    setLocale("en")
    const text = costText(bucket([], 2))
    expect(text).toBe("2 unpriced")
    expect(text).not.toContain("$0")
  })

  test("nothing known is a dash, not $0", () => {
    expect(costText(undefined)).toBe("—")
    expect(costText(bucket([]))).toBe("—")
    expect(known(bucket([]))).toBe(false)
  })
})

test("tokenCount counts the cache, as the ledger does", () => {
  expect(tokenCount({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 })).toBe(15)
})
