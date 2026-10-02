/**
 * Provider quota adapters (UL-07, audit §8.4 "Cuotas"): how each provider's documented quota answer
 * becomes typed windows with numeric values.
 *
 * The answer itself is read inside the engine by FlupCode's quota plugin (`flupcode-quota.js` in
 * `packages/remote/src/engine-plugins-v2.ts`), with the key the engine keeps: the key never reaches
 * this server. So an adapter here is the provider's id and how to read its answer; the plugin holds
 * the endpoint it is sent to. Both lists name the same providers.
 *
 * Tier 1 only: endpoints the provider documents for its own API keys. OpenCode Go and Zen document no
 * quota endpoint (usage is in their console), and z.ai's quota endpoint is not documented, so neither
 * is here; private endpoints (tier 2) are not built.
 */

/** What the quota plugin answered for one integration. */
export type QuotaRead =
  | { status: "unsupported" }
  | { status: "unconfigured" }
  | { status: "read"; account: string; httpStatus: number; body: unknown }
  | { status: "failed"; account: string; message: string }

/**
 * One quota window. `calendar` resets at a fixed time (`resetAt`), `spendCap` is a limit that never
 * resets, `balance` is prepaid money with no limit, only what remains. Values are numbers in `unit`,
 * `null` where the provider does not say.
 */
export type QuotaWindow = {
  id: string
  kind: "calendar" | "spendCap" | "balance"
  unit: "credits" | "requests" | "usd" | "cny"
  used: number | null
  limit: number | null
  remaining: number | null
  resetAt: number | null
}

export type QuotaAdapter = {
  providerID: string
  tier: 1
  /** The provider's page that documents the endpoint and its answer. */
  docs: string
  /** The windows in an answer; throws when the answer is not the documented shape. */
  windows: (body: unknown, now: number) => QuotaWindow[]
}

export const QUOTA_ADAPTERS: QuotaAdapter[] = [
  {
    // GET https://openrouter.ai/api/v1/key: the key's limit, what remains of it and when it resets, the
    // credits it used this UTC day, week (from Monday) and month, and the free-model requests of the day.
    providerID: "openrouter",
    tier: 1,
    docs: "https://openrouter.ai/docs/api-reference/limits",
    windows: (body, now) => {
      const data = objectOr((body as { data?: unknown } | null)?.data, "OpenRouter answered without data")
      const limit = numberOr(data.limit)
      const remaining = numberOr(data.limit_remaining)
      const period = typeof data.limit_reset === "string" ? data.limit_reset : null
      const windows: QuotaWindow[] = []
      if (limit !== null)
        windows.push({
          id: "key-limit",
          kind: period ? "calendar" : "spendCap",
          unit: "credits",
          used: remaining !== null ? Math.max(0, limit - remaining) : periodUsage(data, period),
          limit,
          remaining,
          resetAt: period ? nextReset(period, now) : null,
        })
      // A key without a limit still reports what it spent this month: no cap to run out of, but a pace.
      if (limit === null && numberOr(data.usage_monthly) !== null)
        windows.push({
          id: "month",
          kind: "calendar",
          unit: "credits",
          used: numberOr(data.usage_monthly),
          limit: null,
          remaining: null,
          resetAt: nextReset("monthly", now),
        })
      const free = data.free_model_daily_requests as { used?: unknown; limit?: unknown; remaining?: unknown } | undefined
      if (free && numberOr(free.limit) !== null)
        windows.push({
          id: "free-requests",
          kind: "calendar",
          unit: "requests",
          used: numberOr(free.used),
          limit: numberOr(free.limit),
          remaining: numberOr(free.remaining),
          resetAt: nextReset("daily", now),
        })
      return windows
    },
  },
  {
    // GET https://api.deepseek.com/user/balance: the balance in each currency, as decimal strings.
    providerID: "deepseek",
    tier: 1,
    docs: "https://api-docs.deepseek.com/api/get-user-balance",
    windows: (body) => {
      const infos = (body as { balance_infos?: unknown } | null)?.balance_infos
      if (!Array.isArray(infos)) throw new Error("DeepSeek answered without balance_infos")
      return infos.flatMap((info: { currency?: unknown; total_balance?: unknown }) => {
        const unit = info.currency === "USD" ? "usd" : info.currency === "CNY" ? "cny" : undefined
        const remaining = numberOr(info.total_balance)
        if (!unit || remaining === null) return []
        return [{ id: `balance-${unit}`, kind: "balance" as const, unit, used: null, limit: null, remaining, resetAt: null }]
      })
    },
  },
]

export const quotaAdapter = (providerID: string) => QUOTA_ADAPTERS.find((adapter) => adapter.providerID === providerID)

/**
 * When a UTC calendar period ends: the next midnight, the next Monday, the first of next month.
 * OpenRouter counts its daily, weekly and monthly usage over UTC days, weeks from Monday and months.
 */
export function nextReset(period: string, now: number) {
  const today = new Date(now)
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  if (period === "daily") return midnight + 86_400_000
  if (period === "weekly") return midnight + (((8 - today.getUTCDay()) % 7) || 7) * 86_400_000
  if (period === "monthly") return Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1)
  return null
}

function periodUsage(data: Record<string, unknown>, period: string | null) {
  if (period === "daily") return numberOr(data.usage_daily)
  if (period === "weekly") return numberOr(data.usage_weekly)
  if (period === "monthly") return numberOr(data.usage_monthly)
  return numberOr(data.usage)
}

function objectOr(value: unknown, message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

/** A finite number, from a number or a decimal string (DeepSeek's balances); `null` otherwise. */
function numberOr(value: unknown) {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null
}
