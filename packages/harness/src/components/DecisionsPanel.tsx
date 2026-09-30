import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type Component } from "solid-js"
import { t } from "../i18n"
import { degradedText, modelDisplayName } from "../adaptive-copy"
import { holdModalFocus } from "../modal-focus"
import { createResource } from "../resource"
import { formatDateTime } from "../dates"
import { adaptiveSurfaces, createHarnessClient, type DecisionPageFilter } from "../client"
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
  /**
   * A decision to bring into view (AH-E05): the banner's "View decision" and the session chip's
   * "Why?" open the screen on it. It is scrolled to and highlighted when it is on the loaded page, and
   * read by id and pinned above the list when it is not (older, or outside the current filter).
   */
  focusDecisionID?: string
  onClose: () => void
}

/** How many rows a page asks for, and how many more "Load more" shows (AH-E05). */
export const DECISION_PAGE_SIZE = 50

/**
 * The kinds a reader can filter by, each with the title it reads as (AH-E05). The raw kind stays in
 * the dialog's "Advanced" disclosure; a kind this build does not know is titled by its stored value.
 */
export const DECISION_KIND_TITLES: Record<string, string> = {
  completion: "Is the task done",
  skillRelevance: "Which skills fit",
  contextItem: "What context to keep",
  modelRoute: "Which model to use",
  agentRoute: "Which agent to use",
  toolRisk: "How risky a tool call is",
  failure: "Why a step failed",
  skillReflection: "What to learn from a session",
}

/** Whether the harness acted on the answer, as a filter (AH-E05). */
export type ActedFilter = "all" | "acted" | "recorded"

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

/** The kind as a reader says it (AH-E05); a kind without a title is shown by its stored value. */
export const kindTitle = (decision: Pick<StoredDecision, "kind" | "raw">) => {
  const title = DECISION_KIND_TITLES[kindText(decision)]
  return title ? t(title) : kindText(decision)
}

/**
 * Whether the harness acted on the answer (AH-E05). An observe-only (`shadow`) row was only recorded,
 * and so was a row in the holdout control arm: it was decided and audited, but deliberately not applied.
 */
export const decisionActed = (decision: Pick<StoredDecision, "shadow" | "arm">) =>
  !decision.shadow && decision.arm !== "control"

/** The acted state as the row's pill says it. */
export const actedText = (decision: Pick<StoredDecision, "shadow" | "arm">) =>
  decisionActed(decision) ? t("Acted") : t("Only recorded")

/**
 * A confidence as a band a reader can act on, with the number kept beside it (AH-E05): high from
 * 80%, medium from 50%, low under that. Nothing when the decision did not report a confidence.
 */
export function confidenceBandText(confidence: number | undefined): string | undefined {
  const percent = confidenceText(confidence)
  if (percent === undefined || confidence === undefined) return undefined
  if (confidence >= 0.8) return t("High ({percent})", { percent })
  if (confidence >= 0.5) return t("Medium ({percent})", { percent })
  return t("Low ({percent})", { percent })
}

/** Who answered, in words: the rule alone, a model, or the rule after a model did not win (AH-C02). */
export const sourceText = (decision: Pick<StoredDecision, "source" | "raw">) =>
  decision.source === "baseline"
    ? t("Built-in rules")
    : decision.source === "model"
      ? t("Model")
      : decision.source === "fallback"
        ? t("Rules after the model")
        : (decision.raw?.source ?? decision.source)

/** The query a filter asks the server for; `all` is no filter rather than a value the server reads. */
export function decisionQuery(filter: { sessionID?: string; kind: string; acted: ActedFilter }): DecisionPageFilter {
  return {
    ...(filter.sessionID ? { sessionID: filter.sessionID } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.acted === "all" ? {} : { acted: filter.acted === "acted" }),
  }
}

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
 * The adaptive layer makes decisions and this shows them: what was asked, what came back, what the baseline
 * would have said and how long the provider took. It is reading only — there is no route that makes
 * a decision — and it asks for nothing when the server did not announce the surface.
 */
export const DecisionsPanel: Component<DecisionsPanelProps> = (props) => {
  const available = () => adaptiveSurfaces(props.capabilities).decisions
  const [kind, setKind] = createSignal("")
  const [acted, setActed] = createSignal<ActedFilter>("all")
  const query = () => decisionQuery({ sessionID: props.sessionID, kind: kind(), acted: acted() })
  // The pages after the first and the cursor after them, and how many loaded rows are painted: an
  // older server ignores `limit` and answers the whole audit, so the panel still paints one page.
  const [more, setMore] = createSignal<{ rows: StoredDecision[]; cursor?: string }>()
  const [shown, setShown] = createSignal(DECISION_PAGE_SIZE)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [moreFailure, setMoreFailure] = createSignal<Error>()
  const [decisions, actions] = createResource(
    () => (props.open && available() ? query() : undefined),
    (filter) => {
      setMore(undefined)
      setShown(DECISION_PAGE_SIZE)
      setMoreFailure(undefined)
      return createHarnessClient(props.serverUrl).adaptive.decisions.page({ ...filter, limit: DECISION_PAGE_SIZE })
    },
  )
  const rows = createMemo(() => [...(decisions()?.data ?? []), ...(more()?.rows ?? [])])
  const visible = createMemo(() => rows().slice(0, shown()))
  const cursor = () => {
    const extra = more()
    return extra ? extra.cursor : decisions()?.nextCursor
  }
  const loadMore = async () => {
    if (shown() < rows().length) return setShown(shown() + DECISION_PAGE_SIZE)
    const before = cursor()
    if (!before) return
    const filter = query()
    setLoadingMore(true)
    const next = await createHarnessClient(props.serverUrl)
      .adaptive.decisions.page({ ...filter, before, limit: DECISION_PAGE_SIZE })
      .catch((cause: unknown) => {
        setMoreFailure(cause instanceof Error ? cause : new Error(String(cause)))
        return undefined
      })
    setLoadingMore(false)
    // A filter changed while the page was in flight: its rows belong to a list that is gone.
    if (!next || JSON.stringify(filter) !== JSON.stringify(query())) return
    setMoreFailure(undefined)
    setMore({ rows: [...(more()?.rows ?? []), ...next.data], cursor: next.nextCursor })
    setShown(shown() + DECISION_PAGE_SIZE)
  }

  // The focused decision, read by id so it can be shown even when it is not on the loaded page.
  const [focused] = createResource(
    () => (props.open && available() && props.focusDecisionID ? props.focusDecisionID : undefined),
    async (id) =>
      (await createHarnessClient(props.serverUrl).adaptive.decisions.page({ id, limit: 1 })).data.find(
        (decision) => decision.id === id,
      ) ?? null,
  )
  const pinned = () => {
    const id = props.focusDecisionID
    if (!id || rows().some((decision) => decision.id === id)) return undefined
    const decision = focused()
    return decision && decision.id === id ? decision : undefined
  }
  // A focused row further down the loaded rows is painted, rather than left behind "Load more".
  createEffect(
    on([() => props.focusDecisionID, rows], ([id, all]) => {
      const index = id ? all.findIndex((decision) => decision.id === id) : -1
      if (index >= shown()) setShown(Math.ceil((index + 1) / DECISION_PAGE_SIZE) * DECISION_PAGE_SIZE)
    }),
  )
  const [opened, setOpened] = createSignal<StoredDecision>()
  const openID = () => opened()?.id
  let list: HTMLDivElement | undefined
  const rowOf = (id: string) => list?.querySelector<HTMLElement>(`[data-decision-id="${CSS.escape(id)}"]`)
  const [scrolledTo, setScrolledTo] = createSignal<string>()
  createEffect(() => {
    const id = props.focusDecisionID
    if (!id || scrolledTo() === id) return
    if (!visible().some((decision) => decision.id === id) && pinned() === undefined) return
    requestAnimationFrame(() => {
      const row = rowOf(id)
      if (!row) return
      row.scrollIntoView({ block: "center" })
      // While the linked decision's dialog is open it keeps the focus; the row gets it back on close.
      if (!opened()) row.focus({ preventScroll: true })
      setScrolledTo(id)
    })
  })

  // The value gate (AH-C05) is its own surface: an older server that does not announce it is not asked.
  const [gates, gateActions] = createResource(
    () => (props.open && adaptiveSurfaces(props.capabilities).voi ? props.serverUrl : undefined),
    (serverUrl) => createHarnessClient(serverUrl).adaptive.voi.get(),
  )
  // A deep link (the banner's "View decision", AH-E03) also opens that decision's explanation, once
  // per link, whether or not the loaded page has it.
  const [autoOpened, setAutoOpened] = createSignal<string>()
  createEffect(() => {
    const decision = focused()
    if (!decision || decision.id !== props.focusDecisionID || autoOpened() === decision.id) return
    setAutoOpened(decision.id)
    setOpened(decision)
  })
  const [explanation, explanationActions] = createResource(openID, async (id) => ({
    id,
    detail: await createHarnessClient(props.serverUrl).adaptive.decisions.explain(id),
  }))
  const filtered = () => kind() !== "" || acted() !== "all"
  const row = (decision: StoredDecision) => (
    <DecisionRow
      decision={decision}
      focused={decision.id === props.focusDecisionID}
      onExplain={() => setOpened(decision)}
    />
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

        <div class="fc-context-screen" ref={list}>
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
                      <span class="fc-usage-key fc-context-strong" dir="auto">
                        {t(DECISION_KIND_TITLES[gate.kind] ?? gate.kind)}
                      </span>
                      <span class="fc-usage-key" dir="auto">
                        {modelDisplayName(gate.modelID)}
                        {gate.modelVersion ? ` · ${gate.modelVersion}` : ""}
                      </span>
                      <span class="fc-context-excerpt">{gateSummary(gate)}</span>
                    </div>
                  )}
                </For>
              </section>
            </Show>
            <Show when={props.focusDecisionID && !focused.loading && focused() === null}>
              <p class="fc-usage-note">{t("That decision is no longer in the audit.")}</p>
            </Show>
            <Show when={pinned()}>
              {(decision) => (
                <section class="fc-usage-block">
                  <h2>{t("Linked decision")}</h2>
                  {row(decision())}
                </section>
              )}
            </Show>
            <div class="fc-decisions-filters" role="group" aria-label={t("Filter decisions")}>
              <label class="fc-decisions-filter">
                <span>{t("Capability")}</span>
                <select class="fc-toolbar-select" value={kind()} onChange={(event) => setKind(event.currentTarget.value)}>
                  <option value="">{t("All capabilities")}</option>
                  <For each={Object.entries(DECISION_KIND_TITLES)}>
                    {([value, title]) => <option value={value}>{t(title)}</option>}
                  </For>
                </select>
              </label>
              <div class="fc-tabs" role="group" aria-label={t("Whether the harness acted")}>
                <For each={ACTED_OPTIONS}>
                  {(option) => (
                    <button
                      class="fc-tab"
                      classList={{ "fc-tab-active": acted() === option.value }}
                      type="button"
                      aria-pressed={acted() === option.value}
                      onClick={() => setActed(option.value)}
                    >
                      {t(option.label)}
                    </button>
                  )}
                </For>
              </div>
            </div>
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
              when={rows().length > 0}
              fallback={
                <Show when={!decisions.failure() || decisions.loading}>
                  <p class="fc-usage-note">
                    {decisions.loading
                      ? t("Reading…")
                      : filtered()
                        ? t("No decisions match these filters.")
                        : t("No decisions recorded yet.")}
                  </p>
                </Show>
              }
            >
              <section class="fc-usage-block">
                <h2>
                  {t("Recorded decisions")}
                  <span class="fc-context-aside">
                    {rows().length}
                    {cursor() ? "+" : ""}
                  </span>
                </h2>
                <For each={visible()}>{(decision) => row(decision)}</For>
                <Show when={moreFailure()}>
                  {(error) => (
                    <PanelFailure
                      inline
                      title={t("{name} could not be read", { name: t("More decisions") })}
                      error={error()}
                      onRetry={() => void loadMore()}
                    />
                  )}
                </Show>
                <Show when={shown() < rows().length || cursor() !== undefined}>
                  <div class="fc-decisions-more">
                    <button class="fc-button" type="button" disabled={loadingMore()} onClick={() => void loadMore()}>
                      {loadingMore() ? t("Reading…") : t("Load more")}
                    </button>
                  </div>
                </Show>
              </section>
            </Show>
          </Show>
        </div>

        <Show when={opened()}>
          {(decision) => (
            <div class="fc-modal-backdrop" onClick={() => setOpened(undefined)}>
              <div
                ref={(node) => {
                  const id = decision().id
                  onCleanup(holdModalFocus(node, () => rowOf(id)))
                }}
                class="fc-modal fc-form-modal"
                role="dialog"
                aria-modal="true"
                aria-label={t("Decision")}
                tabIndex={-1}
                onClick={(event) => event.stopPropagation()}
              >
                <div class="fc-modal-header">
                  <span class="fc-modal-heading" dir="auto">
                    {kindTitle(decision())}
                  </span>
                  <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={() => setOpened(undefined)}>
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
                  <details class="fc-decision-advanced">
                    <summary>{t("Advanced")}</summary>
                    <div class="fc-usage-row">
                      <span class="fc-usage-key">{t("ID")}</span>
                      <span class="fc-context-excerpt fc-decision-id" dir="ltr">
                        {decision().id}
                      </span>
                    </div>
                    <div class="fc-usage-row">
                      <span class="fc-usage-key">{t("Kind")}</span>
                      <span class="fc-context-excerpt" dir="ltr">
                        {kindText(decision())}
                      </span>
                    </div>
                  </details>
                </div>
              </div>
            </div>
          )}
        </Show>
      </section>
    </Show>
  )
}

const ACTED_OPTIONS: Array<{ value: ActedFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "acted", label: "Acted" },
  { value: "recorded", label: "Only recorded" },
]

const DecisionRow: Component<{ decision: StoredDecision; focused: boolean; onExplain: () => void }> = (props) => (
  <button
    class="fc-usage-row fc-context-row fc-decision-row"
    classList={{ "fc-decision-focused": props.focused }}
    type="button"
    data-decision-id={props.decision.id}
    aria-current={props.focused ? "true" : undefined}
    onClick={props.onExplain}
  >
    <span class="fc-usage-key fc-context-strong" dir="auto">
      {kindTitle(props.decision)}
    </span>
    <span class="fc-decision-pill" classList={{ "fc-decision-pill-acted": decisionActed(props.decision) }}>
      {actedText(props.decision)}
    </span>
    <span class="fc-context-excerpt">
      {formatDateTime(props.decision.createdAt)} · {latencyText(props.decision.latencyMs)} ·{" "}
      {sourceText(props.decision)} · {modelDisplayName(props.decision.provider)}
      {props.decision.modelVersion ? ` · ${props.decision.modelVersion}` : ""}
      {props.decision.degraded ? ` · ${degradedText(props.decision.degradedReason)}` : ""}
      {props.decision.arm === "control" ? ` · ${t("Held out")}` : ""}
      {labelMark(props.decision.label) ? ` · ${labelMark(props.decision.label)}` : ""}
    </span>
    <Show when={confidenceBandText(props.decision.confidence)}>
      {(confidence) => <span class="fc-decision-confidence">{confidence()}</span>}
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
        {modelDisplayName(props.detail.provider)}
        {props.detail.modelVersion ? ` · ${props.detail.modelVersion}` : ""}
      </span>
    </div>
    <Show when={costText(props.detail.costUsd, props.detail.inputTokens)}>
      {(cost) => (
        <div class="fc-usage-row">
          <span class="fc-usage-key">{t("Model cost")}</span>
          <span class="fc-context-excerpt">
            {props.detail.providerID ? `${modelDisplayName(props.detail.providerID)} · ` : ""}
            {cost()}
          </span>
        </div>
      )}
    </Show>
    <div class="fc-usage-row">
      <span class="fc-usage-key">{t("Latency")}</span>
      <span class="fc-context-excerpt">{latencyText(props.detail.latencyMs)}</span>
    </div>
    <Show when={confidenceBandText(props.detail.confidence)}>
      {(confidence) => (
        <div class="fc-usage-row">
          <span class="fc-usage-key">{t("Confidence")}</span>
          <span class="fc-context-excerpt">{confidence()}</span>
        </div>
      )}
    </Show>
    <Show when={props.detail.degraded}>
      <div class="fc-usage-row">
        <span class="fc-usage-key">{t("Fallback")}</span>
        <span class="fc-context-excerpt" dir="auto">
          {degradedText(props.detail.degradedReason)}
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
