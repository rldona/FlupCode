import { For, Show, createSignal, type Component } from "solid-js"
import { formatTokens, type UsageMetrics, type UsageRange } from "../metrics"

type HomeCanvasProps = {
  displayName: string
  range: UsageRange
  metrics: UsageMetrics
  messages: number | undefined
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
    <section class="oh-canvas">
      <h1 class="oh-greeting">{greeting()}</h1>
      <p class="oh-subtitle">Resumen de tu actividad en OpenHarness.</p>

      <Show when={props.error}>
        <div class="oh-error">{props.error}</div>
      </Show>

      <div class="oh-card">
        <div class="oh-card-header">
          <div class="oh-tabs">
            <button
              class="oh-tab"
              classList={{ "oh-tab-active": tab() === "summary" }}
              type="button"
              onClick={() => setTab("summary")}
            >
              Resumen
            </button>
            <button
              class="oh-tab"
              classList={{ "oh-tab-active": tab() === "models" }}
              type="button"
              onClick={() => setTab("models")}
            >
              Modelos
            </button>
          </div>
          <div class="oh-range">
            <For each={RANGES}>
              {(item) => (
                <button
                  class="oh-range-button"
                  classList={{ "oh-range-button-active": props.range === item.id }}
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
              fallback={<div class="oh-empty-state"><span class="oh-empty-title">Sin datos de modelos</span></div>}
            >
              <ul class="oh-model-stats">
                <For each={props.metrics.models}>
                  {(model) => (
                    <li class="oh-model-stat">
                      <span class="oh-model-stat-name">{model.name}</span>
                      <span class="oh-model-stat-count">{model.count} sesiones</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          }
        >
          <div class="oh-stat-grid">
            <For each={stats()}>
              {(stat) => (
                <div class="oh-stat">
                  <span class="oh-stat-value">{stat.value}</span>
                  <span class="oh-stat-label">{stat.label}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </section>
  )
}
