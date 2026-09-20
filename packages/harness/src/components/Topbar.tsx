import type { Component } from "solid-js"

type TopbarProps = {
  serverInput: string
  healthLoading: boolean
  healthHealthy: boolean | undefined
  healthError: boolean
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onToggleSidebar: () => void
  onRefreshServer: () => void
  onServerInput: (value: string) => void
}

export const Topbar: Component<TopbarProps> = (props) => {
  const status = () => {
    if (props.healthLoading) return "Conectando"
    if (props.healthHealthy) return "Conectado"
    if (props.healthError) return "Sin conexión"
    return "Sin conexión"
  }

  return (
    <header class="oh-topbar">
      <div class="oh-topbar-left">
        <button class="oh-nav-arrow" type="button" title="Alternar barra lateral" onClick={props.onToggleSidebar}>
          ▤
        </button>
        <button class="oh-nav-arrow" type="button" title="Atrás" disabled={!props.canGoBack} onClick={props.onBack}>
          ←
        </button>
        <button
          class="oh-nav-arrow"
          type="button"
          title="Adelante"
          disabled={!props.canGoForward}
          onClick={props.onForward}
        >
          →
        </button>
        <span class="oh-logo">OpenHarness</span>
      </div>
      <div class="oh-topbar-right">
        <input
          class="oh-server-input"
          value={props.serverInput}
          spellcheck={false}
          aria-label="Server URL"
          onInput={(event) => props.onServerInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") props.onRefreshServer()
          }}
        />
        <span
          class="oh-status"
          classList={{
            "oh-status-on": props.healthHealthy === true,
            "oh-status-off": props.healthError,
          }}
        >
          {status()}
        </span>
      </div>
    </header>
  )
}
