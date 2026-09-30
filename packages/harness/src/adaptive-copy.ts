import { t } from "./i18n"

/**
 * Why the built-in rules answered instead of the model, in the reader's words (AH-E06). The keys are
 * the server's `DEGRADED_REASONS` (`harness-server/src/adaptive/decision.ts`); one this build does not
 * know is shown as the server wrote it.
 */
export const DEGRADED_REASON_TEXT: Record<string, string> = {
  timeout: "the model took too long",
  network: "the model could not be reached",
  "rate-limited": "the provider limited the requests",
  unauthorized: "the provider refused the key",
  malformed: "the model's answer could not be read",
  "low-confidence": "the model was not confident enough",
  "budget-exhausted": "the monthly budget is spent",
  "breaker-open": "the model failed too often recently",
  "egress-denied": "sharing this data with the model is not allowed",
  "provider-disabled": "the predictive model is turned off",
  "voi-paused": "the model does not add enough value here",
}

/**
 * What a degraded decision or plan says: "Built-in rules were used (reason)" rather than the
 * internal word "degraded" (audit §7.4).
 */
export function degradedText(reason: string | undefined): string {
  if (!reason) return t("Built-in rules were used")
  const known = DEGRADED_REASON_TEXT[reason]
  return t("Built-in rules were used ({reason})", { reason: known ? t(known) : reason })
}
