import { For, type Component } from "solid-js"
import type { ModelInfo } from "@opencode-ai/client"

type SettingsPanelProps = {
  open: boolean
  theme: string
  displayName: string
  serverInput: string
  models: ModelInfo[]
  modelKey: string | undefined
  auto: boolean
  showTools: boolean
  onTheme: (value: string) => void
  onDisplayName: (value: string) => void
  onServerInput: (value: string) => void
  onServerCommit: () => void
  onModelChange: (key: string) => void
  onToggleAuto: () => void
  onToggleTools: () => void
  onOpenMcp: () => void
  onOpenAbout: () => void
  onClose: () => void
}

export const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  if (!props.open) return null

  return (
    <div class="oh-modal-backdrop" onClick={props.onClose}>
      <div class="oh-modal oh-modal-wide" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div class="oh-modal-header">
          <span>Personalizar</span>
          <button class="oh-icon-button" type="button" aria-label="Cerrar" onClick={props.onClose}>
            ×
          </button>
        </div>

        <div class="oh-settings">
          <section class="oh-settings-section">
            <h3 class="oh-settings-title">Apariencia</h3>
            <label class="oh-settings-row">
              <span>Tema</span>
              <select
                class="oh-toolbar-select"
                value={props.theme}
                onChange={(event) => props.onTheme(event.currentTarget.value)}
              >
                <option value="system">Sistema</option>
                <option value="light">Claro</option>
                <option value="dark">Oscuro</option>
              </select>
            </label>
          </section>

          <section class="oh-settings-section">
            <h3 class="oh-settings-title">Perfil</h3>
            <label class="oh-settings-row">
              <span>Nombre</span>
              <input
                class="oh-question-custom"
                value={props.displayName}
                placeholder="Tu nombre"
                onInput={(event) => props.onDisplayName(event.currentTarget.value)}
              />
            </label>
          </section>

          <section class="oh-settings-section">
            <h3 class="oh-settings-title">Modelo</h3>
            <div class="oh-settings-row">
              <span>Auto</span>
              <button
                class="oh-chip oh-chip-button"
                classList={{ "oh-chip-active": props.auto }}
                type="button"
                onClick={props.onToggleAuto}
              >
                {props.auto ? "Activado" : "Desactivado"}
              </button>
            </div>
            <label class="oh-settings-row">
              <span>Por defecto</span>
              <select
                class="oh-toolbar-select"
                value={props.modelKey ?? ""}
                disabled={props.auto}
                onChange={(event) => props.onModelChange(event.currentTarget.value)}
              >
                <option value="" disabled>
                  Modelo por defecto
                </option>
                <For each={props.models}>
                  {(model) => <option value={`${model.providerID}/${model.modelID}`}>{model.name}</option>}
                </For>
              </select>
            </label>
          </section>

          <section class="oh-settings-section">
            <h3 class="oh-settings-title">Conversación</h3>
            <div class="oh-settings-row">
              <span>Mostrar pasos de herramientas</span>
              <button
                class="oh-chip oh-chip-button"
                classList={{ "oh-chip-active": props.showTools }}
                type="button"
                onClick={props.onToggleTools}
              >
                {props.showTools ? "Sí" : "No"}
              </button>
            </div>
          </section>

          <section class="oh-settings-section">
            <h3 class="oh-settings-title">Servidor</h3>
            <div class="oh-settings-row">
              <input
                class="oh-question-custom"
                value={props.serverInput}
                spellcheck={false}
                onInput={(event) => props.onServerInput(event.currentTarget.value)}
              />
              <button class="oh-button" type="button" onClick={props.onServerCommit}>
                Guardar
              </button>
            </div>
          </section>

          <section class="oh-settings-section">
            <h3 class="oh-settings-title">Integraciones</h3>
            <div class="oh-settings-row">
              <button class="oh-button" type="button" onClick={props.onOpenMcp}>
                Servidores MCP
              </button>
              <button class="oh-button" type="button" onClick={props.onOpenAbout}>
                Acerca de OpenHarness
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
