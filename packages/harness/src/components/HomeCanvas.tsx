import { Show, type Component } from "solid-js"

type HomeCanvasProps = {
  displayName: string
  sessionCount: number
  serverVersion: string | undefined
  selectedSession: string | undefined
  busy: boolean
  error: string | undefined
}

export const HomeCanvas: Component<HomeCanvasProps> = (props) => {
  const greeting = () => (props.displayName.trim() ? `¿Qué sigue, ${props.displayName.trim()}?` : "¿Qué sigue?")

  return (
    <section class="oh-canvas">
      <h1 class="oh-greeting">{greeting()}</h1>
      <p class="oh-subtitle">
        Shell inicial de OpenHarness. La paridad con la TUI y el diseño tipo Claude Code llegan en F2/F3.
      </p>

      <Show when={props.error}>
        <div class="oh-error">{props.error}</div>
      </Show>

      <div class="oh-card">
        <div class="oh-card-header">
          <span>Resumen</span>
          <span class="oh-card-meta">{props.sessionCount} sesiones</span>
        </div>
        <div class="oh-stat-grid">
          <div class="oh-stat">
            <span class="oh-stat-value">{props.selectedSession ? props.selectedSession.slice(0, 8) : "—"}</span>
            <span class="oh-stat-label">Sesión activa</span>
          </div>
          <div class="oh-stat">
            <span class="oh-stat-value">{props.serverVersion ?? "—"}</span>
            <span class="oh-stat-label">Servidor</span>
          </div>
          <div class="oh-stat">
            <span class="oh-stat-value">{props.busy ? "Activo" : "En reposo"}</span>
            <span class="oh-stat-label">Estado</span>
          </div>
        </div>
      </div>
    </section>
  )
}
