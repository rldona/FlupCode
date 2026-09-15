import { For, type Component, Show, createSignal, onCleanup } from "solid-js"
import type { ModelInfo } from "../engine-types"
import type { EngineProfile } from "../client"
import { t, type Locale } from "../i18n"
import { KeyCapture } from "./KeyCapture"
import { resetUsage, restoreUsage, usageResetAt } from "../usage-reset"
import { TEXT_SIZES, appTextSize, chatTextSize, setAppTextSize, setChatTextSize } from "../text-size"

type SettingsPanelProps = {
  open: boolean
  theme: string
  locale: Locale
  displayName: string
  serverInput: string
  serverStatus: string
  engineProfile: EngineProfile | undefined
  models: ModelInfo[]
  modelKey: string | undefined
  showTools: boolean
  replySuggestions: boolean
  /** "provider/model" for suggestions, or "" for the automatic small model. */
  suggestionModel: string
  notifications: boolean
  paletteKey: string
  onTheme: (value: string) => void
  onLocale: (value: Locale) => void
  onDisplayName: (value: string) => void
  onServerInput: (value: string) => void
  onServerCommit: () => void
  onModelChange: (key: string) => void
  onToggleTools: () => void
  onToggleReplySuggestions: () => void
  onSuggestionModel: (key: string) => void
  onToggleNotifications: () => void
  onPaletteKey: (value: string) => void
  onOpenMcp: () => void
  onOpenRemote: () => void
  onOpenConfig: () => void
  onOpenAbout: () => void
  onClose: () => void
}

function groupModels(models: ModelInfo[]) {
  const map = new Map<string, ModelInfo[]>()
  for (const model of models) {
    const list = map.get(model.providerID) ?? []
    list.push(model)
    map.set(model.providerID, list)
  }
  return [...map.entries()].map(([providerID, items]) => ({ providerID, items }))
}

export const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  // Resetting asks for a second click within a few seconds.
  const [confirmReset, setConfirmReset] = createSignal(false)
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(confirmTimer))
  const reset = () => {
    if (!confirmReset()) {
      setConfirmReset(true)
      clearTimeout(confirmTimer)
      confirmTimer = setTimeout(() => setConfirmReset(false), 4000)
      return
    }
    clearTimeout(confirmTimer)
    setConfirmReset(false)
    resetUsage()
  }
  return (
    <Show when={props.open}>
    <div class="fc-modal-backdrop" onClick={props.onClose}>
      <div class="fc-modal fc-modal-wide" role="dialog" aria-modal="true" aria-label={t("Customize")} onClick={(event) => event.stopPropagation()}>
        <div class="fc-modal-header">
          <span>{t("Customize")}</span>
          <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
            ×
          </button>
        </div>

        <div class="fc-settings">
          <section class="fc-settings-section">
            <h3 class="fc-settings-title">{t("Appearance")}</h3>
            <label class="fc-settings-row">
              <span>{t("Theme")}</span>
              <select
                class="fc-toolbar-select"
                value={props.theme}
                onChange={(event) => props.onTheme(event.currentTarget.value)}
              >
                <option value="system">{t("System")}</option>
                <option value="light">{t("Light")}</option>
                <option value="dark">{t("Dark")}</option>
              </select>
            </label>
            <label class="fc-settings-row">
              <span>{t("Language")}</span>
              <select
                class="fc-toolbar-select"
                value={props.locale}
                onChange={(event) => props.onLocale(event.currentTarget.value as Locale)}
              >
                <option value="en">{t("English")}</option>
                <option value="es">{t("Spanish")}</option>
              </select>
            </label>
            <label class="fc-settings-row">
              <span>{t("App text size")}</span>
              <select
                class="fc-toolbar-select"
                value={appTextSize()}
                onChange={(event) => setAppTextSize(event.currentTarget.value)}
              >
                <For each={TEXT_SIZES}>{(size) => <option value={size.id}>{t(size.label)}</option>}</For>
              </select>
            </label>
            <label class="fc-settings-row">
              <span>{t("Chat text size")}</span>
              <select
                class="fc-toolbar-select"
                value={chatTextSize()}
                onChange={(event) => setChatTextSize(event.currentTarget.value)}
              >
                <For each={TEXT_SIZES}>{(size) => <option value={size.id}>{t(size.label)}</option>}</For>
              </select>
            </label>
          </section>

          <section class="fc-settings-section">
            <h3 class="fc-settings-title">{t("Profile")}</h3>
            <label class="fc-settings-row">
              <span>{t("Name")}</span>
              <input
                class="fc-question-custom"
                value={props.displayName}
                placeholder={t("Your name")}
                onInput={(event) => props.onDisplayName(event.currentTarget.value)}
              />
            </label>
          </section>

          <section class="fc-settings-section">
            <h3 class="fc-settings-title">{t("Model")}</h3>
            <label class="fc-settings-row">
              <span>{t("Default")}</span>
              <select
                class="fc-toolbar-select"
                value={props.modelKey ?? ""}
                onChange={(event) => props.onModelChange(event.currentTarget.value)}
              >
                <option value="" disabled>
                  {t("Default model")}
                </option>
                <For each={groupModels(props.models)}>
                  {(group) => (
                    <optgroup label={group.providerID}>
                      <For each={group.items}>
                        {(model) => <option value={`${model.providerID}/${model.id}`}>{model.name}</option>}
                      </For>
                    </optgroup>
                  )}
                </For>
              </select>
            </label>
          </section>

          <section class="fc-settings-section">
            <h3 class="fc-settings-title">{t("Conversation")}</h3>
            <div class="fc-settings-row">
              <span>{t("Show tool steps")}</span>
              <button
                class="fc-chip fc-chip-button"
                classList={{ "fc-chip-active": props.showTools }}
                type="button"
                onClick={props.onToggleTools}
              >
                {props.showTools ? t("Yes") : t("No")}
              </button>
            </div>
            <div class="fc-settings-row">
              <span class="fc-settings-usage">
                <span>{t("Suggest replies")}</span>
                <span class="fc-settings-hint">{t("After each answer a model suggests your next message; Tab accepts it.")}</span>
              </span>
              <button
                class="fc-chip fc-chip-button"
                classList={{ "fc-chip-active": props.replySuggestions }}
                type="button"
                onClick={props.onToggleReplySuggestions}
              >
                {props.replySuggestions ? t("Yes") : t("No")}
              </button>
            </div>
            <Show when={props.replySuggestions}>
              <label class="fc-settings-row">
                <span>{t("Suggestion model")}</span>
                <select
                  class="fc-toolbar-select"
                  value={props.suggestionModel}
                  onChange={(event) => props.onSuggestionModel(event.currentTarget.value)}
                >
                  <option value="">{t("Automatic (small model)")}</option>
                  <For each={groupModels(props.models)}>
                    {(group) => (
                      <optgroup label={group.providerID}>
                        <For each={group.items}>
                          {(model) => <option value={`${model.providerID}/${model.id}`}>{model.name}</option>}
                        </For>
                      </optgroup>
                    )}
                  </For>
                </select>
              </label>
            </Show>
          </section>

          <section class="fc-settings-section">
            <h3 class="fc-settings-title">{t("Usage")}</h3>
            <div class="fc-settings-row">
              <span class="fc-settings-usage">
                <span>{t("Summary counters")}</span>
                <span class="fc-settings-hint">
                  {usageResetAt()
                    ? t("Counting sessions since {date}", { date: new Date(usageResetAt()).toLocaleString() })
                    : t("Counting every session")}
                </span>
              </span>
              <span class="fc-settings-actions">
                <Show when={usageResetAt()}>
                  <button class="fc-button" type="button" onClick={restoreUsage}>
                    {t("Count all again")}
                  </button>
                </Show>
                <button
                  class="fc-button"
                  classList={{ "fc-button-danger": confirmReset() }}
                  type="button"
                  onClick={reset}
                >
                  {confirmReset() ? t("Click again to reset") : t("Reset counters")}
                </button>
              </span>
            </div>
          </section>

          <section class="fc-settings-section">
            <h3 class="fc-settings-title">{t("Notifications")}</h3>
            <div class="fc-settings-row">
              <span>{t("Enable notifications")}</span>
              <button
                class="fc-chip fc-chip-button"
                classList={{ "fc-chip-active": props.notifications }}
                type="button"
                onClick={props.onToggleNotifications}
              >
                {props.notifications ? t("On") : t("Off")}
              </button>
            </div>
          </section>

          <section class="fc-settings-section">
            <h3 class="fc-settings-title">{t("Shortcuts")}</h3>
            <label class="fc-settings-row">
              <span>{t("Command palette")}</span>
              <KeyCapture value={props.paletteKey} onChange={props.onPaletteKey} />
            </label>
          </section>

          <section class="fc-settings-section">
            <h3 class="fc-settings-title">{t("Server")}</h3>
            <div class="fc-settings-row">
              <span>{t("Status")}</span>
              <span class="fc-settings-status">{props.serverStatus}</span>
            </div>
            <Show when={props.engineProfile === "stock"}>
              <div class="fc-settings-hint">
                {t(
                  "This engine is the stock OpenCode CLI, so FlupCode's extras (GitHub Copilot sign-in, permission modes, memory) are unavailable.",
                )}
              </div>
            </Show>
            <div class="fc-settings-row">
              <input
                class="fc-question-custom"
                value={props.serverInput}
                spellcheck={false}
                onInput={(event) => props.onServerInput(event.currentTarget.value)}
              />
              <button class="fc-button" type="button" onClick={props.onServerCommit}>
                {t("Save")}
              </button>
            </div>
          </section>

          <section class="fc-settings-section">
            <h3 class="fc-settings-title">{t("Integrations")}</h3>
            <div class="fc-settings-grid">
              <button class="fc-button" type="button" onClick={props.onOpenMcp}>
                {t("MCP servers")}
              </button>
              <button class="fc-button" type="button" onClick={props.onOpenRemote}>
                {t("Remote control")}
              </button>
              <button class="fc-button" type="button" onClick={props.onOpenConfig}>
                {t("Config (advanced)")}
              </button>
              <button class="fc-button" type="button" onClick={props.onOpenAbout}>
                {t("About FlupCode")}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
    </Show>
  )
}
