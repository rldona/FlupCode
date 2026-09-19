import { For, Show, createSignal, type Component } from "solid-js"
import { formatTokens, modelColor, type ActivityDay, type UsageMetrics, type UsageRange } from "../metrics"
import { t } from "../i18n"
import { sessionTitle } from "../session-title"
import type { SessionInfo } from "../engine-types"
import { ActivityHeatmap } from "./ActivityHeatmap"

type HomeCanvasProps = {
  displayName: string
  range: UsageRange
  metrics: UsageMetrics
  activity: ActivityDay[]
  /** The sessions working right now. Empty renders nothing; the list has no heading of its own. */
  activeSessions: SessionInfo[]
  onOpenSession: (sessionID: string) => void
  error: string | undefined
  onRangeChange: (range: UsageRange) => void
}

const RANGES: Array<{ id: UsageRange; label: string }> = [
  { id: "all", label: "All" },
  { id: "30d", label: "30d" },
  { id: "7d", label: "7d" },
]

const ModelUsage: Component<{ metrics: UsageMetrics }> = (props) => {
  const order = () => props.metrics.modelUsage.map((model) => model.name)
  const color = (name: string) => modelColor(Math.max(0, order().indexOf(name)))
  const max = () => Math.max(...props.metrics.weeks.map((week) => week.total), 1)
  const ticks = () => [max(), (max() * 2) / 3, max() / 3, 0]

  return (
    <div class="fc-model-usage">
      <div class="fc-chart">
        <div class="fc-chart-y">
          <For each={ticks()}>{(tick) => <span>{formatTokens(Math.round(tick))}</span>}</For>
        </div>
        <div class="fc-chart-plot">
          <For each={props.metrics.weeks}>
            {(week) => (
              <div class="fc-chart-col" title={`${week.label} · ${formatTokens(week.total)}`}>
                <For each={week.segments}>
                  {(segment) => (
                    <div
                      class="fc-chart-seg"
                      style={{ height: `${(segment.tokens / max()) * 100}%`, background: color(segment.name) }}
                    />
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
      <div class="fc-chart-x">
        <For each={props.metrics.weeks}>{(week, index) => <span>{index() % 2 === 0 ? week.label : ""}</span>}</For>
      </div>
      <ul class="fc-model-legend">
        <For each={props.metrics.modelUsage}>
          {(model) => (
            <li class="fc-model-legend-row">
              <span class="fc-legend-swatch" style={{ background: color(model.name) }} />
              <span class="fc-legend-name">{model.name}</span>
              <span class="fc-legend-tokens">
                {formatTokens(model.input)} in · {formatTokens(model.output)} out
              </span>
              <span class="fc-legend-share">{(model.share * 100).toFixed(1)}%</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}

export const HomeCanvas: Component<HomeCanvasProps> = (props) => {
  const [tab, setTab] = createSignal<"summary" | "models">("summary")
  const greeting = () =>
    props.displayName.trim() ? t("What's next, {name}?", { name: props.displayName.trim() }) : t("What's next?")

  const stats = () => [
    { label: t("Sessions"), value: String(props.metrics.sessions) },
    { label: t("Total tokens"), value: formatTokens(props.metrics.tokens) },
    { label: t("Active days"), value: String(props.metrics.activeDays) },
    { label: t("Current streak"), value: `${props.metrics.currentStreak}d` },
    { label: t("Longest streak"), value: `${props.metrics.longestStreak}d` },
    { label: t("Peak hour"), value: props.metrics.peakHour },
    { label: t("Favorite model"), value: props.metrics.favoriteModel },
  ]

  return (
    <section class="fc-canvas">
      <h1 class="fc-greeting">{greeting()}</h1>
      <p class="fc-subtitle">{t("Your FlupCode activity at a glance.")}</p>

      <Show when={props.error}>
        <div class="fc-error">{props.error}</div>
      </Show>

      <div class="fc-card">
        <div class="fc-card-header">
          <div class="fc-tabs">
            <button
              class="fc-tab"
              classList={{ "fc-tab-active": tab() === "summary" }}
              type="button"
              onClick={() => setTab("summary")}
            >
              {t("Summary")}
            </button>
            <button
              class="fc-tab"
              classList={{ "fc-tab-active": tab() === "models" }}
              type="button"
              onClick={() => setTab("models")}
            >
              {t("Models")}
            </button>
          </div>
          <div class="fc-range">
            <For each={RANGES}>
              {(item) => (
                <button
                  class="fc-range-button"
                  classList={{ "fc-range-button-active": props.range === item.id }}
                  type="button"
                  onClick={() => props.onRangeChange(item.id)}
                >
                  {t(item.label)}
                </button>
              )}
            </For>
          </div>
        </div>

        <Show
          when={tab() === "summary"}
          fallback={
            <Show
              when={props.metrics.modelUsage.length > 0}
              fallback={
                <div class="fc-empty-state">
                  <span class="fc-empty-title">{t("No model data")}</span>
                </div>
              }
            >
              <ModelUsage metrics={props.metrics} />
            </Show>
          }
        >
          <div class="fc-stat-grid">
            <For each={stats()}>
              {(stat) => (
                <div class="fc-stat">
                  <span class="fc-stat-value">{stat.value}</span>
                  <span class="fc-stat-label">{stat.label}</span>
                </div>
              )}
            </For>
          </div>
          <ActivityHeatmap days={props.activity} />
        </Show>
      </div>

      <Show when={props.activeSessions.length > 0}>
        <ul class="fc-active-sessions">
          <For each={props.activeSessions}>
            {(session) => (
              <li>
                <button class="fc-active-session" type="button" onClick={() => props.onOpenSession(session.id)}>
                  <span class="fc-session-dot fc-session-dot-running" aria-hidden="true" />
                  <span class="fc-session-title">{sessionTitle(session) || t("New session")}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
