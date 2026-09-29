import { For, Show, createResource, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { formatDateTime } from "../dates"
import { adaptiveSurfaces, createHarnessClient } from "../client"
import type { DecisionExplanation, StoredDecision } from "../types"

type DecisionsPanelProps = {
  open: boolean
  serverUrl: string
  /** The session whose decisions to read; without one the whole audit is listed. */
  sessionID?: string
  capabilities: string[]
  onClose: () => void
}

/** An answer as one line: the shapes the decision kinds carry are small and flat. */
export function describeAnswer(answer: unknown): string {
  if (answer === undefined || answer === null) return "—"
  if (typeof answer !== "object") return String(answer)
  if (Array.isArray(answer)) return answer.map((entry) => describeAnswer(entry)).join(", ")
  return Object.entries(answer as Record<string, unknown>)
    .map(([key, value]) => `${key}: ${describeAnswer(value)}`)
    .join(" · ")
}

/** A confidence as a percentage, or nothing when the decision did not report one. */
export function confidenceText(confidence: number | undefined): string | undefined {
  return typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : undefined
}

/** A latency said in the unit a reader uses: milliseconds under a second, seconds above it. */
export function latencyText(latencyMs: number): string {
  return latencyMs < 1000 ? `${latencyMs} ms` : `${(latencyMs / 1000).toFixed(1)} s`
}

/**
 * The decision audit (FH-071).
 *
 * The shadow makes decisions and this shows them: what was asked, what came back, what the baseline
 * would have said and how long the provider took. It is reading only — there is no route that makes
 * a decision — and it asks for nothing when the server did not announce the surface.
 */
export const DecisionsPanel: Component<DecisionsPanelProps> = (props) => {
  const available = () => adaptiveSurfaces(props.capabilities).decisions
  const [decisions, actions] = createResource(
    () => (props.open && available() ? props.sessionID ?? "all" : undefined),
    (sessionID) =>
      createHarnessClient(props.serverUrl).adaptive.decisions.list(
        sessionID === "all" ? {} : { sessionID },
      ),
  )
  const [openID, setOpenID] = createSignal<string>()
  const [explanation] = createResource(
    () => (openID() ? openID() : undefined),
    (id) => createHarnessClient(props.serverUrl).adaptive.decisions.explain(id),
  )

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Decisions")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{t("Automation")}</div>
            <h1>{t("Decisions")}</h1>
            <p>{t("What the adaptive layer decided, and why.")}</p>
          </div>
          <div class="fc-routines-header-actions">
            <button class="fc-button" type="button" disabled={decisions.loading} onClick={() => void actions.refetch()}>
              {t("Refresh")}
            </button>
          </div>
        </div>

        <div class="fc-context-screen">
          <Show
            when={available()}
            fallback={<div class="fc-routines-notice">{t("This server does not have the decision audit.")}</div>}
          >
            <Show
              when={(decisions()?.length ?? 0) > 0}
              fallback={
                <p class="fc-usage-note">
                  {decisions.loading ? t("Reading…") : t("No decisions recorded yet.")}
                </p>
              }
            >
              <section class="fc-usage-block">
                <h2>
                  {t("Recorded decisions")}
                  <span class="fc-context-aside">{decisions()!.length}</span>
                </h2>
                <For each={decisions()}>
                  {(decision) => <DecisionRow decision={decision} onExplain={() => setOpenID(decision.id)} />}
                </For>
              </section>
            </Show>
          </Show>
        </div>

        <Show when={openID()}>
          <div class="fc-modal-backdrop" onClick={() => setOpenID(undefined)}>
            <div
              class="fc-modal fc-form-modal"
              role="dialog"
              aria-modal="true"
              aria-label={t("Decision")}
              onClick={(event) => event.stopPropagation()}
            >
              <div class="fc-modal-header">
                <span class="fc-modal-heading" dir="auto">
                  {openID()}
                </span>
                <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={() => setOpenID(undefined)}>
                  ×
                </button>
              </div>
              <div class="fc-modal-body">
                <Show when={explanation()} fallback={<p class="fc-usage-note">{t("Reading…")}</p>}>
                  {(detail) => <Explanation detail={detail()} />}
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </section>
    </Show>
  )
}

const DecisionRow: Component<{ decision: StoredDecision; onExplain: () => void }> = (props) => (
  <button class="fc-usage-row fc-context-row" type="button" onClick={props.onExplain}>
    <span class="fc-diff-status" dir="ltr">
      {props.decision.kind}
    </span>
    <span class="fc-usage-key" dir="auto">
      {props.decision.provider}
      {props.decision.modelVersion ? ` · ${props.decision.modelVersion}` : ""}
    </span>
    <span class="fc-context-excerpt">
      {formatDateTime(props.decision.createdAt)} · {latencyText(props.decision.latencyMs)}
      {props.decision.degraded ? ` · ${t("Degraded")}` : ""}
    </span>
    <Show when={confidenceText(props.decision.confidence)}>
      {(confidence) => <span class="fc-usage-cost">{confidence()}</span>}
    </Show>
  </button>
)

const Explanation: Component<{ detail: DecisionExplanation }> = (props) => (
  <>
    <div class="fc-usage-row">
      <span class="fc-usage-key">{t("Question")}</span>
      <span class="fc-context-excerpt" dir="auto">
        {props.detail.question}
      </span>
    </div>
    <div class="fc-usage-row">
      <span class="fc-usage-key">{t("Answer")}</span>
      <span class="fc-context-excerpt" dir="auto">
        {describeAnswer(props.detail.answer)}
      </span>
    </div>
    <div class="fc-usage-row">
      <span class="fc-usage-key">{t("Why")}</span>
      <span class="fc-context-excerpt" dir="auto">
        {props.detail.why}
      </span>
    </div>
    <div class="fc-usage-row">
      <span class="fc-usage-key">{t("Baseline")}</span>
      <span class="fc-context-excerpt" dir="auto">
        {describeAnswer(props.detail.baseline.answer)} · {props.detail.baseline.rule}
      </span>
    </div>
    <div class="fc-usage-row">
      <span class="fc-usage-key">{t("Provider")}</span>
      <span class="fc-context-excerpt" dir="auto">
        {props.detail.provider}
        {props.detail.modelVersion ? ` · ${props.detail.modelVersion}` : ""}
      </span>
    </div>
    <div class="fc-usage-row">
      <span class="fc-usage-key">{t("Latency")}</span>
      <span class="fc-context-excerpt">{latencyText(props.detail.latencyMs)}</span>
    </div>
    <Show when={confidenceText(props.detail.confidence)}>
      {(confidence) => (
        <div class="fc-usage-row">
          <span class="fc-usage-key">{t("Confidence")}</span>
          <span class="fc-context-excerpt">{confidence()}</span>
        </div>
      )}
    </Show>
    <Show when={props.detail.degraded}>
      <div class="fc-usage-row">
        <span class="fc-usage-key">{t("Degraded")}</span>
        <span class="fc-context-excerpt" dir="auto">
          {props.detail.degradedReason ?? t("Yes")}
        </span>
      </div>
    </Show>
    <Show when={props.detail.evidenceRefs.length > 0}>
      <div class="fc-usage-row">
        <span class="fc-usage-key">{t("Evidence")}</span>
        <span class="fc-context-excerpt" dir="auto">
          {props.detail.evidenceRefs.join(", ")}
        </span>
      </div>
    </Show>
  </>
)
