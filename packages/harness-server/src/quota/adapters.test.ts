import { describe, expect, test } from "bun:test"
import { QUOTA_ADAPTERS, nextReset, quotaAdapter } from "./adapters"
import { DEEPSEEK_BALANCE, OPENROUTER_KEY } from "./fixtures"

// Wednesday 2026-10-07 15:30 UTC.
const now = Date.UTC(2026, 9, 7, 15, 30)

describe("quota adapters (UL-07)", () => {
  test("tier 1 only, each with the page that documents its answer", () => {
    expect(QUOTA_ADAPTERS.map((adapter) => [adapter.providerID, adapter.tier])).toEqual([
      ["openrouter", 1],
      ["deepseek", 1],
    ])
  })

  test("OpenRouter's /key: the key's limit as a calendar window, and the free-model requests of the day", () => {
    expect(quotaAdapter("openrouter")!.windows(OPENROUTER_KEY, now)).toEqual([
      {
        id: "key-limit",
        kind: "calendar",
        unit: "credits",
        used: 7.5,
        limit: 20,
        remaining: 12.5,
        resetAt: Date.UTC(2026, 10, 1),
      },
      {
        id: "free-requests",
        kind: "calendar",
        unit: "requests",
        used: 12,
        limit: 1000,
        remaining: 988,
        resetAt: Date.UTC(2026, 9, 8),
      },
    ])
  })

  test("a limit that never resets is a spending cap; a key with no limit still has this month's spend", () => {
    const cap = { data: { ...OPENROUTER_KEY.data, limit_reset: null, free_model_daily_requests: undefined } }
    expect(quotaAdapter("openrouter")!.windows(cap, now)).toEqual([
      { id: "key-limit", kind: "spendCap", unit: "credits", used: 7.5, limit: 20, remaining: 12.5, resetAt: null },
    ])
    const open = { data: { ...OPENROUTER_KEY.data, limit: null, limit_remaining: null, limit_reset: null, free_model_daily_requests: undefined } }
    expect(quotaAdapter("openrouter")!.windows(open, now)).toEqual([
      { id: "month", kind: "calendar", unit: "credits", used: 7.5, limit: null, remaining: null, resetAt: Date.UTC(2026, 10, 1) },
    ])
  })

  test("DeepSeek's balance: what remains in each currency, from its decimal strings", () => {
    expect(quotaAdapter("deepseek")!.windows(DEEPSEEK_BALANCE, now)).toEqual([
      { id: "balance-cny", kind: "balance", unit: "cny", used: null, limit: null, remaining: 110, resetAt: null },
    ])
  })

  test("an answer that is not the documented shape is an error, never an empty quota", () => {
    expect(() => quotaAdapter("openrouter")!.windows({ error: { message: "nope" } }, now)).toThrow()
    expect(() => quotaAdapter("deepseek")!.windows({}, now)).toThrow()
  })

  test("UTC periods end at the next midnight, the next Monday and the first of next month", () => {
    expect(nextReset("daily", now)).toBe(Date.UTC(2026, 9, 8))
    expect(nextReset("weekly", now)).toBe(Date.UTC(2026, 9, 12))
    // On a Monday, the week ends on the next one.
    expect(nextReset("weekly", Date.UTC(2026, 9, 12, 1))).toBe(Date.UTC(2026, 9, 19))
    expect(nextReset("monthly", Date.UTC(2026, 11, 31, 23))).toBe(Date.UTC(2027, 0, 1))
    expect(nextReset("yearly", now)).toBeNull()
  })
})
