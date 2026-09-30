import { createSignal } from "solid-js"
import { t } from "./i18n"
import type { AdaptiveModel } from "./types"

/**
 * The predictive-model registry as the harness server last served it (AH-C01), for every surface
 * outside Settings that names a model or provider: the Decisions screen, the session chip, the
 * context plan. The app fills it from the settings view; until then, and on an older server, it is
 * empty and ids are shown as they are.
 */
export const [adaptiveModels, setAdaptiveModels] = createSignal<readonly AdaptiveModel[]>([])

/**
 * The name a reader is shown for a model or provider id: the registry's, translated when the app
 * knows the words. An id the registry does not hold — an old row from a removed provider, the
 * baseline, a provider only the config file names — is shown as it is: it is data, not copy.
 */
export function modelDisplayName(id: string, models: readonly AdaptiveModel[] = adaptiveModels()): string {
  return t(models.find((model) => model.id === id)?.name ?? id)
}

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
