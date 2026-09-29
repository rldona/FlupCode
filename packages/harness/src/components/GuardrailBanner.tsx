import type { Component } from "solid-js"
import { t } from "../i18n"
import type { GuardrailStatus } from "../types"

type GuardrailBannerProps = {
  status: GuardrailStatus
  onViewDecisions: () => void
  onDismiss: () => void
}

/**
 * The advisory nudge of FH-062 (ADR-0023): a loop or a run of identical errors is called out while
 * it is live, so a person can look before the engine's own guard stops the turn. It is a nudge, not
 * a gate — nothing is paused and the turn keeps running — and the reader may read the decisions or
 * dismiss it. The live region wraps the text alone, so the buttons are not announced twice.
 */
export const GuardrailBanner: Component<GuardrailBannerProps> = (props) => (
  <aside class="fc-guardrail-banner">
    <div class="fc-guardrail-banner-text" role="status">
      <span class="fc-guardrail-banner-title">{t("Guardrail warning")}</span>
      <p class="fc-guardrail-banner-body">
        {t(guardrailCause(props.status), {
          count: props.status.reason === "loop" ? props.status.repeatedCalls : props.status.repeatedErrors,
          tool: props.status.tool ?? t("a tool"),
        })}
      </p>
      <p class="fc-guardrail-banner-note">{t("Only a warning — nothing has been paused.")}</p>
    </div>
    <button class="fc-button" type="button" onClick={props.onViewDecisions}>
      {t("View decisions")}
    </button>
    <button class="fc-guardrail-banner-close" type="button" aria-label={t("Dismiss")} onClick={props.onDismiss}>
      ×
    </button>
  </aside>
)

/** The sentence a banner says, as an i18n template: the caller fills `count` and `tool`. */
export function guardrailCause(status: GuardrailStatus): string {
  return status.reason === "loop"
    ? "{count} identical calls to {tool} in a row"
    : "{count} identical errors from {tool} in a row"
}
