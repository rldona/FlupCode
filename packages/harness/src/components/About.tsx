import { Show, createEffect, onCleanup, type Component } from "solid-js"
import pkg from "../../package.json"

type AboutProps = {
  open: boolean
  onClose: () => void
}

export const About: Component<AboutProps> = (props) => {
  createEffect(() => {
    if (!props.open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose()
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  return (
    <Show when={props.open}>
      <div class="oh-modal-backdrop" onClick={props.onClose}>
        <div class="oh-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
          <div class="oh-modal-header">
            <span>Acerca de OpenHarness</span>
            <button class="oh-icon-button" type="button" aria-label="Cerrar" onClick={props.onClose}>
              ×
            </button>
          </div>
          <p class="oh-modal-line">Versión {pkg.version}</p>
          <p class="oh-modal-note">
            OpenHarness es un fork independiente de OpenCode. No está afiliado ni respaldado por Anomaly
            (OpenCode) ni por Anthropic (Claude Code).
          </p>
          <div class="oh-modal-links">
            <a href="https://github.com/rldona/OpenHarness" target="_blank" rel="noreferrer">
              Repositorio
            </a>
            <a href="https://github.com/anomalyco/opencode" target="_blank" rel="noreferrer">
              Upstream OpenCode
            </a>
          </div>
          <p class="oh-modal-license">Licencia MIT. Copyright de OpenCode preservado.</p>
        </div>
      </div>
    </Show>
  )
}
