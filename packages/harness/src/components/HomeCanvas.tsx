import { For, Show, createSignal, type Component } from "solid-js"
import { formatTokens, type ActivityDay, type UsageMetrics, type UsageRange } from "../metrics"
import { ActivityHeatmap } from "./ActivityHeatmap"

type HomeCanvasProps = {
  displayName: string
  range: UsageRange
  metrics: UsageMetrics
  messages: number | undefined
  activity: ActivityDay[]
  comparison: string
  error: string | undefined
  onRangeChange: (range: UsageRange) => void
}

const RANGES: Array<{ id: UsageRange; label: string }> = [
  { id: "all", label: "Todo" },
  { id: "30d", label: "30d" },
  { id: "7d", label: "7d" },
]

export const HomeCanvas: Component<HomeCanvasProps> = (props) => {
  const [tab, setTab] = createSignal<"summary" | "models">("summary")
  const greeting = () => (props.displayName.trim() ? `¿Qué sigue, ${props.displayName.trim()}?` : "¿Qué sigue?")

  const stats = () => [
    { label: "Sesiones", value: String(props.metrics.sessions) },
    { label: "Mensajes", value: props.messages === undefined ? "…" : String(props.messages) },
    { label: "Tokens totales", value: formatTokens(props.metrics.tokens) },
    { label: "Días activos", value: String(props.metrics.activeDays) },
    { label: "Racha actual", value: `${props.metrics.currentStreak}d` },
    { label: "Racha más larga", value: `${props.metrics.longestStreak}d` },
    { label: "Hora pico", value: props.metrics.peakHour },
    { label: "Modelo favorito", value: props.metrics.favoriteModel },
  ]

  return (
    <section class="fc-canvas">
      <h1 class="fc-greeting">{greeting()}</h1>
      <p class="fc-subtitle">Resumen de tu actividad en FlupCode.</p>

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
              Resumen
            </button>
            <button
              class="fc-tab"
              classList={{ "fc-tab-active": tab() === "models" }}
              type="button"
              onClick={() => setTab("models")}
            >
              Modelos
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
                  {item.label}
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
              fallback={<div class="fc-empty-state"><span class="fc-empty-title">Sin datos de modelos</span></div>}
            >
              <ul class="fc-model-stats">
                <For each={props.metrics.models}>
                  {(model) => (
                    <li class="fc-model-stat">
                      <span class="fc-model-stat-name">{model.name}</span>
                      <span class="fc-model-stat-count">{model.count} sesiones</span>
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
          <ActivityHeatmap days={props.activity} comparison={props.comparison} />
        </Show>
      </div>
    </section>
  )
}
