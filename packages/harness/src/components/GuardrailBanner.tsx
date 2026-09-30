import { Show, type Component } from "solid-js"
import { t } from "../i18n"
import type { GuardrailStatus } from "../types"

/** The advisory the app holds, stamped with the session it was read for. */
export type GuardrailReading = { sessionID: string; status: GuardrailStatus }

type GuardrailBannerProps = {
  status?: GuardrailStatus
  onViewDecision: (decisionID: string) => void
  onStopTurn: () => void
  onDismiss: () => void
}

/**
 * The advisory nudge of FH-062 (ADR-0023): a loop or a run of identical errors is called out while
 * it is live, so a person can look before the engine's own guard stops the turn. It is a nudge, not
 * a gate — nothing is paused on its own — and the reader may open the decision, stop the turn
 * themselves or dismiss it.
 *
 * The live region is always mounted and only its text changes: a region inserted together with its
 * content is not announced by every screen reader. It carries the sentence alone, so the buttons are
 * not read out as part of the announcement.
 */
export const GuardrailBanner: Component<GuardrailBannerProps> = (props) => (
  <>
    <p class="fc-sr-only" role="status" aria-live="polite">
      {props.status ? guardrailAnnouncement(props.status) : ""}
    </p>
    <Show when={props.status}>
      {(status) => (
        <aside class="fc-guardrail-banner" aria-label={t("Possible loop")}>
          <div class="fc-guardrail-banner-text">
            <span class="fc-guardrail-banner-title">{t("Possible loop")}</span>
            <p class="fc-guardrail-banner-body">{guardrailSentence(status())}</p>
            <p class="fc-guardrail-banner-note">{t("Only a warning — nothing has been paused.")}</p>
          </div>
          <button class="fc-button" type="button" onClick={() => props.onViewDecision(status().decisionID)}>
            {t("View decision")}
          </button>
          <button class="fc-button" type="button" onClick={props.onStopTurn}>
            {t("Stop turn")}
          </button>
          <button class="fc-guardrail-banner-close" type="button" aria-label={t("Dismiss")} onClick={props.onDismiss}>
            ×
          </button>
        </aside>
      )}
    </Show>
  </>
)

/** The sentence a banner says, as an i18n template: the caller fills `count` and `tool`. */
export function guardrailCause(status: GuardrailStatus): string {
  return status.reason === "loop"
    ? "{count} identical calls to {tool} in a row"
    : "{count} identical errors from {tool} in a row"
}

/** What the live region reads out: the title and the cause, as one sentence. */
export function guardrailAnnouncement(status: GuardrailStatus): string {
  return `${t("Possible loop")}: ${guardrailSentence(status)}`
}

/**
 * The advisory to show for the open session, if any. A reading taken for another session is never
 * shown, so a slow answer for session A that lands after switching to B paints nothing in B; a
 * dismissed decision stays hidden until a new loop brings a new id.
 */
export function guardrailFor(reading: GuardrailReading | undefined, sessionID: string | undefined, dismissed?: string) {
  if (!reading || !sessionID || reading.sessionID !== sessionID) return undefined
  if (reading.status.decisionID === dismissed) return undefined
  return reading.status
}

function guardrailSentence(status: GuardrailStatus) {
  return t(guardrailCause(status), {
    count: status.reason === "loop" ? status.repeatedCalls : status.repeatedErrors,
    tool: status.tool ?? t("a tool"),
  })
}
