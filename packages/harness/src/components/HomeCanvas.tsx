import { For, Show, createSignal, type Component } from "solid-js"
import { formatTokens, type ActivityDay, type UsageMetrics, type UsageRange } from "../metrics"
import { t } from "../i18n"
import { ActivityHeatmap } from "./ActivityHeatmap"

type HomeCanvasProps = {
  displayName: string
  range: UsageRange
  metrics: UsageMetrics
  messages: number | undefined
  activity: ActivityDay[]
  comparison: { ratio: number; name: string } | undefined
  error: string | undefined
  onRangeChange: (range: UsageRange) => void
  onAction: (prompt: string) => void
}

const RANGES: Array<{ id: UsageRange; label: string }> = [
  { id: "all", label: "All" },
  { id: "30d", label: "30d" },
  { id: "7d", label: "7d" },
]

export const HomeCanvas: Component<HomeCanvasProps> = (props) => {
  const [tab, setTab] = createSignal<"summary" | "models">("summary")
  const greeting = () =>
    props.displayName.trim()
      ? t("What's next, {name}?", { name: props.displayName.trim() })
      : t("What's next?")

  const comparisonText = () => {
    const value = props.comparison
    if (!value) return ""
    return t("You used ~{ratio}× more tokens than {name}.", { ratio: value.ratio, name: value.name })
  }

  const stats = () => [
    { label: t("Sessions"), value: String(props.metrics.sessions) },
    { label: t("Messages"), value: props.messages === undefined ? "…" : String(props.messages) },
    { label: t("Total tokens"), value: formatTokens(props.metrics.tokens) },
    { label: t("Active days"), value: String(props.metrics.activeDays) },
    { label: t("Current streak"), value: `${props.metrics.currentStreak}d` },
    { label: t("Longest streak"), value: `${props.metrics.longestStreak}d` },
    { label: t("Peak hour"), value: props.metrics.peakHour },
    { label: t("Favorite model"), value: props.metrics.favoriteModel },
  ]

  const actions = () => [
    {
      icon: "⌕",
      tone: "blue",
      title: t("Explore and understand code"),
      prompt: t("Explore this repository and explain its architecture and main modules."),
    },
    {
      icon: "✎",
      tone: "violet",
      title: t("Create a new function, app or tool"),
      prompt: t("Create a new feature from scratch. Ask me for details first."),
    },
    {
      icon: "↻",
      tone: "green",
      title: t("Review code and suggest changes"),
      prompt: t("Review the recent changes and suggest improvements."),
    },
    {
      icon: "⚑",
      tone: "orange",
      title: t("Fix problems and bugs"),
      prompt: t("Find and fix problems and bugs in this project."),
    },
  ]

  return (
    <section class="fc-canvas">
      <h1 class="fc-greeting">{greeting()}</h1>
      <p class="fc-subtitle">{t("Your FlupCode activity at a glance.")}</p>

      <Show when={props.error}>
        <div class="fc-error">{props.error}</div>
      </Show>

      <div class="fc-actions">
        <For each={actions()}>
          {(action) => (
            <button class="fc-action" type="button" onClick={() => props.onAction(action.prompt)}>
              <span class="fc-action-icon" data-tone={action.tone}>
                {action.icon}
              </span>
              <span class="fc-action-title">{action.title}</span>
            </button>
          )}
        </For>
      </div>

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
              when={props.metrics.models.length > 0}
              fallback={
                <div class="fc-empty-state">
                  <span class="fc-empty-title">{t("No model data")}</span>
                </div>
              }
            >
              <ul class="fc-model-stats">
                <For each={props.metrics.models}>
                  {(model) => (
                    <li class="fc-model-stat">
                      <span class="fc-model-stat-name">{model.name}</span>
                      <span class="fc-model-stat-count">
                        {t("{count} sessions", { count: model.count })}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
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
          <ActivityHeatmap days={props.activity} comparison={comparisonText()} />
        </Show>
      </div>
    </section>
  )
}
