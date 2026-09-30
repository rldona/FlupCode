import { For, Show, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { createResource } from "../resource"
import { formatDateTime } from "../dates"
import { adaptiveSurfaces, createHarnessClient } from "../client"
import type {
  DecisionExplanation,
  DecisionLabel,
  DecisionLabelOutcome,
  StoredDecision,
  ValueGateState,
  ValueGateStatus,
} from "../types"
import { PanelFailure } from "./PanelBoundary"

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
 * What the model call cost, or nothing when it was not measured (AH-C02). A baseline answer and a
 * call that failed carry no cost at all, which is different from a call that cost zero.
 */
export function costText(costUsd: number | undefined, inputTokens: number | undefined): string | undefined {
  const parts = [
    typeof costUsd === "number" ? `$${costUsd.toFixed(4)}` : undefined,
    typeof inputTokens === "number" ? t("{count} input tokens", { count: String(inputTokens) }) : undefined,
  ].filter((part) => part !== undefined)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

/** A label as the row's suffix: a tick, a cross, or a question mark for a judged-unknowable one. */
export const labelMark = (label: DecisionLabel | undefined) =>
  label === undefined ? undefined : label.outcome === "correct" ? "✓" : label.outcome === "incorrect" ? "✗" : "?"

/** A label outcome in words, for the dialog. */
export const outcomeText = (outcome: DecisionLabelOutcome) =>
  outcome === "correct" ? t("Correct") : outcome === "incorrect" ? t("Incorrect") : t("Not judgeable")

/** The kind as stored: a kind this build does not know is shown by its raw value, not as "unknown". */
export const kindText = (decision: Pick<StoredDecision, "kind" | "raw">) => decision.raw?.kind ?? decision.kind

/** A gate state in words (AH-C05); a paused gate says why rather than only that it is paused. */
export const gateStateText = (state: ValueGateState) =>
  state === "warming-up"
    ? t("Warming up")
    : state === "asking"
      ? t("Asking the model")
      : state === "exploring"
        ? t("Exploring only: its value does not cover its cost")
        : t("The predictive model does not improve this decision; paused")

/** A gate as one line: its state, then the samples, disagreement, uplift and p95 it was judged on. */
export function gateSummary(gate: ValueGateStatus): string {
  const uplift = Math.round(gate.uplift * 100)
  return [
    gateStateText(gate.state),
    t("{samples} samples · disagreement {disagreement} · uplift {uplift}", {
      samples: String(gate.samples),
      disagreement: `${Math.round(gate.disagreementRate * 100)}%`,
      uplift: `${uplift > 0 ? "+" : ""}${uplift} pp`,
    }),
    ...(gate.p95LatencyMs !== undefined ? [`p95 ${latencyText(gate.p95LatencyMs)}`] : []),
  ].join(" · ")
}

/**
 * The explanation for the decision that is open. A resource keeps its last value while the next one
 * loads, so without the id check the previous decision's answer sat under the new decision's id.
 */
export function explanationFor(entry: { id: string; detail: DecisionExplanation } | undefined, id: string | undefined) {
  return entry && entry.id === id ? entry.detail : undefined
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
  // The value gate (AH-C05) is its own surface: an older server that does not announce it is not asked.
  const [gates, gateActions] = createResource(
    () => (props.open && adaptiveSurfaces(props.capabilities).voi ? props.serverUrl : undefined),
    (serverUrl) => createHarnessClient(serverUrl).adaptive.voi.get(),
  )
  const [openID, setOpenID] = createSignal<string>()
  const [explanation, explanationActions] = createResource(openID, async (id) => ({
    id,
    detail: await createHarnessClient(props.serverUrl).adaptive.decisions.explain(id),
  }))

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
            <button
              class="fc-button"
              type="button"
              disabled={decisions.loading}
              onClick={() => {
                void actions.refetch()
                void gateActions.refetch()
              }}
            >
              {t("Refresh")}
            </button>
          </div>
        </div>

        <div class="fc-context-screen">
          <Show
            when={available()}
            fallback={<div class="fc-routines-notice">{t("This server does not have the decision audit.")}</div>}
          >
            <Show when={(gates()?.kinds.length ?? 0) > 0}>
              <section class="fc-usage-block">
                <h2>{t("Predictive model value")}</h2>
                <For each={gates()!.kinds}>
                  {(gate) => (
                    <div class="fc-usage-row fc-context-row">
                      <span class="fc-diff-status" dir="ltr">
                        {gate.kind}
                      </span>
                      <span class="fc-usage-key" dir="auto">
                        {gate.modelID}
                        {gate.modelVersion ? ` · ${gate.modelVersion}` : ""}
                      </span>
                      <span class="fc-context-excerpt">{gateSummary(gate)}</span>
                    </div>
                  )}
                </For>
              </section>
            </Show>
            <Show when={!decisions.loading && decisions.failure()}>
              {(error) => (
                <PanelFailure
                  inline
                  title={t("{name} could not be read", { name: t("The decision audit") })}
                  error={error()}
                  onRetry={() => void actions.refetch()}
                />
              )}
            </Show>
            <Show
              when={(decisions()?.length ?? 0) > 0}
              fallback={
                <Show when={!decisions.failure() || decisions.loading}>
                  <p class="fc-usage-note">
                    {decisions.loading ? t("Reading…") : t("No decisions recorded yet.")}
                  </p>
                </Show>
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
                <Show
                  when={explanationFor(explanation(), openID())}
                  fallback={
                    <Show
                      when={!explanation.loading && explanation.failure()}
                      fallback={<p class="fc-usage-note">{t("Reading…")}</p>}
                    >
                      {(error) => (
                        <PanelFailure
                          inline
                          title={t("{name} could not be read", { name: t("This decision") })}
                          error={error()}
                          onRetry={() => void explanationActions.refetch()}
                        />
                      )}
                    </Show>
                  }
                >
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
      {kindText(props.decision)}
    </span>
    <span class="fc-usage-key" dir="auto">
      {props.decision.provider}
      {props.decision.modelVersion ? ` · ${props.decision.modelVersion}` : ""}
    </span>
    <span class="fc-context-excerpt">
      {formatDateTime(props.decision.createdAt)} · {latencyText(props.decision.latencyMs)}
      {props.decision.degraded ? ` · ${t("Degraded")}` : ""}
      {props.decision.arm === "control" ? ` · ${t("Held out")}` : ""}
      {labelMark(props.decision.label) ? ` · ${labelMark(props.decision.label)}` : ""}
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
    <Show when={props.detail.label}>
      {(label) => (
        <div class="fc-usage-row">
          <span class="fc-usage-key">{t("Real outcome")}</span>
          <span class="fc-context-excerpt">
            {labelMark(label())} {outcomeText(label().outcome)}
            {label().baselineOutcome
              ? ` · ${t("baseline: {outcome}", { outcome: outcomeText(label().baselineOutcome!) })}`
              : ""}
            {` · ${label().source}`}
          </span>
        </div>
      )}
    </Show>
    <div class="fc-usage-row">
      <span class="fc-usage-key">{t("Provider")}</span>
      <span class="fc-context-excerpt" dir="auto">
        {props.detail.provider}
        {props.detail.modelVersion ? ` · ${props.detail.modelVersion}` : ""}
      </span>
    </div>
    <Show when={costText(props.detail.costUsd, props.detail.inputTokens)}>
      {(cost) => (
        <div class="fc-usage-row">
          <span class="fc-usage-key">{t("Model cost")}</span>
          <span class="fc-context-excerpt">
            {props.detail.providerID ? `${props.detail.providerID} · ` : ""}
            {cost()}
          </span>
        </div>
      )}
    </Show>
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
