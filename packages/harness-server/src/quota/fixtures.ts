/**
 * Provider answers in their documented shapes (UL-07), for the adapter, poller and engine tests and
 * the fake provider of the isolated stack. No real provider is ever called with a real key in a test.
 */

/** GET https://openrouter.ai/api/v1/key, as https://openrouter.ai/docs/api-reference/limits documents it. */
export const OPENROUTER_KEY = {
  data: {
    label: "sk-or-v1-0e6...1c96",
    limit: 20,
    limit_reset: "monthly",
    limit_remaining: 12.5,
    include_byok_in_limit: false,
    usage: 41.2,
    usage_daily: 0.8,
    usage_weekly: 3.1,
    usage_monthly: 7.5,
    byok_usage: 0,
    byok_usage_daily: 0,
    byok_usage_weekly: 0,
    byok_usage_monthly: 0,
    is_free_tier: false,
    free_model_daily_requests: { used: 12, limit: 1000, remaining: 988 },
  },
}

/** GET https://api.deepseek.com/user/balance, the example of https://api-docs.deepseek.com/api/get-user-balance. */
export const DEEPSEEK_BALANCE = {
  is_available: true,
  balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }],
}
