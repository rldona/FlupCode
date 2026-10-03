import { For, type Component, Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { AgentInfo, ModelInfo, ModelVariant } from "../engine-types"
import type {
  ConsoleOrg,
  ConsoleState,
  IntegrationAttempt,
  IntegrationAttemptStatus,
  IntegrationInfo,
  McpResource,
  McpServer,
  ProviderDirectoryInfo,
} from "../engine-types"
import type { AgentFile, BrowserGrant, CommandFile, McpConfig, McpScope } from "../types"
import type { ConfiguredProvider, CustomProviderResult } from "../custom-provider"
import { engineTargetVersion } from "../client"
import { t, type Locale } from "../i18n"
import { effortLabel } from "../effort"
import { KeyCapture } from "./KeyCapture"
import { Toggle } from "./Toggle"
import { AgentsPanel } from "./AgentsPanel"
import { ModelMenu } from "./DockMenus"
import { ModelPicker } from "./ModelPicker"
import { ProvidersEditor } from "./ProvidersPanel"
import { CommandsPanel, type CommandDraft } from "./CommandsPanel"
import { McpEditor } from "./McpManager"
import { PermissionsPanel } from "./PermissionsPanel"
import { BrowserGrants } from "./PermissionDock"
import { KEYBIND_ACTIONS, type KeybindAction, type Keybinds } from "../keybinds"
import { TEXT_SIZES, appTextSize, chatTextSize, setAppTextSize, setChatTextSize } from "../text-size"
import { AdaptiveSettingsPanel, type AdaptiveSettingsState, type ModelKeyChange } from "./AdaptiveSettingsPanel"
import { Modal } from "./Modal"
import { DESTINATIONS, SETTINGS_GROUPS, type DestinationId, type SettingsSection } from "../navigation"
import { Icon } from "./Icon"

export type { SettingsSection }

type SettingsPanelProps = {
  open: boolean
  theme: string
  colorTheme: string
  locale: Locale
  displayName: string
  serverInput: string
  serverStatus: string
  engineVersion: string | undefined
  engineVersionMismatch: boolean
  /** A turn is running: switching the model now would break it, so the model controls are locked. */
  running: boolean
  models: ModelInfo[]
  modelKey: string | undefined
  showTools: boolean
  showReasoning: boolean
  sessionTabs: boolean
  replySuggestions: boolean
  /** "provider/model" for suggestions, or "" for the automatic small model. */
  suggestionModel: string
  notifications: boolean
  /** The editable shortcuts (H-24). */
  keybinds: Keybinds
  /** Permissions the reader granted with "Allow always"; the engine applies them to every session. */
  savedPermissions: Array<{ id: string; action: string; resource: string }>
  onRevokePermission: (id: string) => void
  /** The sites the agent may act on without asking (BU-01); absent when the server has no browser. */
  browserGrants?: BrowserGrant[]
  onRevokeBrowserGrant: (id: string) => void
  /** The engine's `permission` policy, as it is on disk (H-25). */
  permissionPolicy: unknown
  permissionServerAvailable: boolean
  onSavePermissionPolicy: (policy: Record<string, unknown>) => void
  /** The editable commands (H-25): the files behind the engine's slash commands. */
  commandFiles: CommandFile[]
  /** Agent names for a command's `agent` field. */
  commandAgents: string[]
  onSaveCommand: (draft: CommandDraft) => void
  onDeleteCommand: (path: string) => void
  /** The configured MCP servers and their config, so one can be edited here (H-25). */
  mcpServers: McpServer[]
  mcpConfigs: Record<string, McpConfig>
  /** What the servers expose and who may use them (H-34). */
  mcpResources?: McpResource[]
  agentFiles?: AgentFile[]
  mcpBusy: boolean
  onAddMcp: (name: string, config: McpConfig, scope: McpScope) => void
  onRemoveMcp: (name: string) => void
  onConnectMcp: (name: string) => void
  onDisconnectMcp: (name: string) => void
  onOAuthMcp: (name: string) => void
  onTheme: (value: string) => void
  onColorTheme: (value: string) => void
  onLocale: (value: Locale) => void
  onDisplayName: (value: string) => void
  onServerInput: (value: string) => void
  onServerCommit: () => void
  /** Drops the engine's cached instances so it re-reads its configuration (agents, skills). */
  onServerReload: () => void
  serverReloading: boolean
  onModelChange: (key: string) => void
  /** The effort levels the selected model offers, and the stored one, for the default-effort select. */
  modelVariants: ModelVariant[]
  modelVariant: string | undefined
  onModelVariantChange: (variant: string) => void
  onToggleTools: () => void
  onToggleReasoning: () => void
  onToggleSessionTabs: () => void
  onToggleReplySuggestions: () => void
  onSuggestionModel: (key: string) => void
  /** The effort levels the chosen suggestion model offers, and the stored one. */
  suggestionVariants: ModelVariant[]
  suggestionVariant: string
  onSuggestionVariantChange: (variant: string) => void
  onToggleNotifications: () => void
  onKeybind: (action: KeybindAction, binding: string) => void
  /** The visible section, owned by app so keys and callers can read it (CU-1). */
  section?: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  /** What the agents section edits: files on disk plus what the engine reports (CU-1). */
  agentsList: AgentInfo[]
  agentTools: string[]
  /** The model favorites the picker stars, shared with the dock. */
  favorites: string[]
  onToggleFavorite: (key: string) => void
  agentsLoading: boolean
  agentsHasProject: boolean
  onSaveAgent: (draft: {
    name: string
    scope: "global" | "project"
    fields: Record<string, unknown>
    prompt: string
    path?: string
  }) => Promise<unknown>
  onDeleteAgent: (path: string) => Promise<unknown>
  /** Providers for the providers section (CU-3): directory, methods and links. */
  providersList: ProviderDirectoryInfo[]
  providerConnected: string[]
  providerIntegrations: IntegrationInfo[]
  providersBusy: boolean
  onSaveProvider: (providerID: string, key: string) => void
  onRemoveProvider: (providerID: string) => void
  existingProviderIDs: string[]
  disabledProviders: string[]
  configuredProviders: Record<string, ConfiguredProvider>
  onSaveCustomProvider: (result: CustomProviderResult) => Promise<void> | void
  onRemoveCustomProvider: (providerID: string) => Promise<void> | void
  onProviderOAuth: (providerID: string, methodID?: string) => Promise<IntegrationAttempt>
  onProviderOAuthStatus: (attemptID: string) => Promise<IntegrationAttemptStatus>
  onProviderOAuthCancel: (attemptID: string) => Promise<void>
  onProviderOAuthDone: () => void
  /** The Console org behind providers, when the engine has one (CO-1). */
  consoleActive?: ConsoleState
  consoleOrgs?: ConsoleOrg[]
  onSwitchConsole?: (org: ConsoleOrg) => void
  /** Opens a dialog Settings › Advanced links to (Config, Config files), over Settings' place. */
  onOpen: (id: DestinationId) => void
  /** The adaptive settings (FH-070): the view, the health capabilities and the write handler. */
  adaptive: AdaptiveSettingsState
  onAdaptivePatch: (patch: Record<string, unknown>, confirm: boolean) => void
  onAdaptiveAcknowledgeRuntime: () => void
  onAdaptiveModelKey: (change: ModelKeyChange) => void
  onClose: () => void
}

/** What each bindable action is called, reusing the command names already translated. */
const KEYBIND_LABELS: Record<KeybindAction, string> = {
  palette: "Search",
  newSession: "New session",
  toggleSidebar: "Toggle sidebar",
  toggleContextPanel: "Toggle details panel",
  settings: "Settings",
  compact: "Compact the current session",
  split: "Split view",
}

export const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  // The section lives in app (CU-1): resource keys and the sidebar read it, so tab clicks
  // must be visible outside this panel.
  const section = () => props.section ?? "appearance"
  const setSection = (next: SettingsSection) => props.onSectionChange(next)
  // Resetting asks for a second click within a few seconds.
  // Reloading drops the turns in flight, so it asks for a second click within a few seconds too.
  const [confirmReload, setConfirmReload] = createSignal(false)
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(reloadTimer))
  const reload = () => {
    if (!confirmReload()) {
      setConfirmReload(true)
      clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => setConfirmReload(false), 4000)
      return
    }
    clearTimeout(reloadTimer)
    setConfirmReload(false)
    props.onServerReload()
  }
  // The full catalog is a modal of its own, opened from a model row's "More models"; which row
  // opened it decides where the pick lands.
  const [pickerTarget, setPickerTarget] = createSignal<"model" | "suggestion">()
  const labelFor = (key: string | undefined, fallback: string) => {
    if (!key) return fallback
    // The provider goes with the name: the same model name lives under several providers.
    const model = props.models.find((entry) => `${entry.providerID}/${entry.id}` === key)
    if (model) return `${model.name} · ${model.providerID}`
    // The key is "provider/id", so a ref the catalog no longer serves still names its provider.
    const [providerID, ...rest] = key.split("/")
    const id = rest.join("/")
    return providerID && id ? `${id} · ${providerID}` : key
  }
  const modelLabel = () => labelFor(props.modelKey, t("Default model"))
  const suggestionLabel = () => labelFor(props.suggestionModel || undefined, t("Automatic (small model)"))
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      backdropClass="fc-modal-backdrop fc-modal-backdrop-settings"
      class="fc-modal fc-modal-wide fc-modal-settings"
      label={t("Settings")}
    >
      <div class="fc-settings-layout">
        <header class="fc-settings-header">
          <span class="fc-settings-header-title">{t("Settings")}</span>
          <button class="fc-icon-button fc-settings-close" type="button" aria-label={t("Close")} onClick={props.onClose}>
            <Icon name="close" />
          </button>
        </header>

        <nav class="fc-settings-nav" role="tablist" aria-label={t("Settings sections")}>
          <For each={SETTINGS_GROUPS}>
            {(group) => (
              <div class="fc-settings-group" role="presentation">
                <div class="fc-settings-group-label" aria-hidden="true">
                  {t(group.label)}
                </div>
                <For each={group.items}>
                  {(item) => (
                    <button
                      class="fc-settings-nav-item"
                      classList={{ "fc-settings-nav-active": section() === item.id }}
                      role="tab"
                      type="button"
                      aria-selected={section() === item.id}
                      onClick={() => setSection(item.id)}
                    >
                      {t(item.label)}
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </nav>

        <div class="fc-settings" role="tabpanel">
          <Show when={section() === "appearance"}>
            <section class="fc-settings-section">
              <h3 class="fc-settings-title">{t("Appearance")}</h3>
              <label class="fc-settings-row">
                <span>{t("Mode")}</span>
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
                <span>{t("Theme")}</span>
                <select
                  class="fc-toolbar-select"
                  value={props.colorTheme}
                  onChange={(event) => props.onColorTheme(event.currentTarget.value)}
                >
                  <option value="sublime-dark">{t("Default")}</option>
                  <option value="classic">{t("Classic")}</option>
                  <option value="github">{t("GitHub")}</option>
                  <option value="vercel">{t("Vercel")}</option>
                  <option value="copilot">{t("Copilot")}</option>
                  <option value="code">{t("Code")}</option>
                  <option value="sublime">{t("Sublime Light")}</option>
                  <option value="flupcode">{t("Purple")}</option>
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
              <div class="fc-settings-row">
                <span class="fc-settings-usage">
                  <span>{t("Open sessions as tabs")}</span>
                  <span class="fc-settings-hint">
                    {t("The sessions you open in this window stay in a strip above the conversation.")}
                  </span>
                </span>
                <Toggle
                  checked={props.sessionTabs}
                  label={t("Open sessions as tabs")}
                  onToggle={props.onToggleSessionTabs}
                />
              </div>
            </section>
          </Show>

          <Show when={section() === "profile"}>
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
          </Show>

          <Show when={section() === "model"}>
            <section class="fc-settings-section">
              <h3 class="fc-settings-title">{t("Model")}</h3>
              <div class="fc-settings-row">
                <span>{t("Default")}</span>
                <div class="fc-settings-controls">
                  <ModelMenu
                    label={modelLabel()}
                    models={props.models}
                    selectedKey={props.modelKey}
                    favorites={props.favorites}
                    placement="down"
                    disabled={props.running}
                    onSelect={(providerID, id) => props.onModelChange(`${providerID}/${id}`)}
                    onMore={() => setPickerTarget("model")}
                  />
                  <select
                    class="fc-toolbar-select"
                    aria-label={t("Effort")}
                    value={props.modelVariant ?? ""}
                    disabled={props.running || props.modelVariants.length === 0}
                    onChange={(event) => props.onModelVariantChange(event.currentTarget.value)}
                  >
                    <option value="">{t("Default")}</option>
                    <For each={props.modelVariants}>
                      {(variant) => <option value={variant.id}>{effortLabel(variant.id)}</option>}
                    </For>
                  </select>
                </div>
              </div>
              <Show when={props.running}>
                <div class="fc-settings-hint">{t("Locked while a session is running.")}</div>
              </Show>
            </section>
          </Show>

          <Show when={section() === "conversation"}>
            <section class="fc-settings-section">
              <h3 class="fc-settings-title">{t("Conversation")}</h3>
              <div class="fc-settings-row">
                <span>{t("Show tool steps")}</span>
                <Toggle checked={props.showTools} label={t("Show tool steps")} onToggle={props.onToggleTools} />
              </div>
              <div class="fc-settings-row">
                <span class="fc-settings-usage">
                  <span>{t("Show thinking")}</span>
                  <span class="fc-settings-hint">
                    {t("What the model thought before answering, as a block you can open.")}
                  </span>
                </span>
                <Toggle
                  checked={props.showReasoning}
                  label={t("Show thinking")}
                  onToggle={props.onToggleReasoning}
                />
              </div>
              <div class="fc-settings-row">
                <span class="fc-settings-usage">
                  <span>{t("Suggest replies")}</span>
                  <span class="fc-settings-hint">
                    {t("After each answer a model suggests your next message; Tab accepts it.")}
                  </span>
                </span>
                <Toggle
                  checked={props.replySuggestions}
                  label={t("Suggest replies")}
                  onToggle={props.onToggleReplySuggestions}
                />
              </div>
              <Show when={props.replySuggestions}>
                <div class="fc-settings-row">
                  <span>{t("Suggestion model")}</span>
                  <div class="fc-settings-controls">
                    <ModelMenu
                      label={suggestionLabel()}
                      models={props.models}
                      selectedKey={props.suggestionModel || undefined}
                      favorites={props.favorites}
                      placement="down"
                      disabled={props.running}
                      autoLabel={t("Automatic (small model)")}
                      onAuto={() => props.onSuggestionModel("")}
                      onSelect={(providerID, id) => props.onSuggestionModel(`${providerID}/${id}`)}
                      onMore={() => setPickerTarget("suggestion")}
                    />
                    <select
                      class="fc-toolbar-select"
                      aria-label={t("Effort")}
                      value={props.suggestionVariant}
                      disabled={props.running || props.suggestionVariants.length === 0}
                      onChange={(event) => props.onSuggestionVariantChange(event.currentTarget.value)}
                    >
                      <option value="">{t("Default")}</option>
                      <For each={props.suggestionVariants}>
                        {(variant) => <option value={variant.id}>{effortLabel(variant.id)}</option>}
                      </For>
                    </select>
                  </div>
                </div>
                <Show when={props.running}>
                  <div class="fc-settings-hint">{t("Locked while a session is running.")}</div>
                </Show>
              </Show>
            </section>
          </Show>

          <Show when={section() === "notifications"}>
            <section class="fc-settings-section">
              <h3 class="fc-settings-title">{t("Notifications")}</h3>
              <div class="fc-settings-row">
                <span>{t("Enable notifications")}</span>
                <Toggle
                  checked={props.notifications}
                  label={t("Enable notifications")}
                  onToggle={props.onToggleNotifications}
                />
              </div>
            </section>
          </Show>

          <Show when={section() === "shortcuts"}>
            <section class="fc-settings-section">
              <h3 class="fc-settings-title">{t("Shortcuts")}</h3>
              <p class="fc-settings-note">
                {t("Click a key and press the new one. A key belongs to one action: giving it away clears the other.")}
              </p>
              <For each={KEYBIND_ACTIONS}>
                {(action) => (
                  <label class="fc-settings-row">
                    <span>{t(KEYBIND_LABELS[action])}</span>
                    <span class="fc-keybind-row">
                      <KeyCapture
                        value={props.keybinds[action]}
                        onChange={(binding) => props.onKeybind(action, binding)}
                      />
                      <Show when={props.keybinds[action]}>
                        <button
                          class="fc-icon-button"
                          type="button"
                          title={t("Clear")}
                          aria-label={t("Clear")}
                          onClick={() => props.onKeybind(action, "")}
                        >
                          <Icon name="close" />
                        </button>
                      </Show>
                    </span>
                  </label>
                )}
              </For>
            </section>
          </Show>

          <Show when={section() === "permissions"}>
            <section class="fc-settings-section">
              <h3 class="fc-settings-title">{t("Permissions")}</h3>
              <PermissionsPanel
                policy={props.permissionPolicy}
                savedPermissions={props.savedPermissions}
                onRevokePermission={props.onRevokePermission}
                onSave={props.onSavePermissionPolicy}
                serverAvailable={props.permissionServerAvailable}
              />
              <Show when={props.browserGrants}>
                {(grants) => (
                  <div class="fc-settings-section">
                    <h3 class="fc-settings-title">{t("Browser access")}</h3>
                    <p class="fc-settings-hint">
                      {t("Sites the agent may act on without asking. Payment, banking and sign-in sites are never allowed.")}
                    </p>
                    <BrowserGrants grants={grants()} onRevoke={props.onRevokeBrowserGrant} />
                  </div>
                )}
              </Show>
            </section>
          </Show>

          <Show when={section() === "commands"}>
            <section class="fc-settings-section">
              <h3 class="fc-settings-title">{t("Commands")}</h3>
              <p class="fc-settings-note">
                {t("A command is a slash command. What is written here shows up in the palette.")}
              </p>
              <CommandsPanel
                files={props.commandFiles}
                agents={props.commandAgents}
                serverAvailable={true}
                onSave={props.onSaveCommand}
                onDelete={props.onDeleteCommand}
              />
            </section>
          </Show>

          <Show when={section() === "providers"}>
            <section class="fc-settings-section">
              <h3 class="fc-settings-title">{t("Providers")}</h3>
              <ProvidersEditor
                providers={props.providersList}
                connected={props.providerConnected}
                integrations={props.providerIntegrations}
                busy={props.providersBusy}
                onSave={props.onSaveProvider}
                onRemove={props.onRemoveProvider}
                existingProviderIDs={props.existingProviderIDs}
                disabledProviders={props.disabledProviders}
                configuredProviders={props.configuredProviders}
                onSaveCustomProvider={props.onSaveCustomProvider}
                onRemoveCustomProvider={props.onRemoveCustomProvider}
                onOAuth={props.onProviderOAuth}
                onOAuthStatus={props.onProviderOAuthStatus}
                onOAuthCancel={props.onProviderOAuthCancel}
                onOAuthDone={props.onProviderOAuthDone}
                consoleActive={props.consoleActive}
                consoleOrgs={props.consoleOrgs}
                onSwitchConsole={props.onSwitchConsole}
              />
            </section>
          </Show>

          <Show when={section() === "agents"}>
            <section class="fc-settings-section">
              <AgentsPanel
                open
                files={props.agentFiles ?? []}
                agents={props.agentsList}
                tools={props.agentTools}
                mcp={props.mcpServers}
                models={props.models}
                favorites={props.favorites}
                onToggleFavorite={props.onToggleFavorite}
                loading={props.agentsLoading}
                serverAvailable={props.permissionServerAvailable}
                hasProject={props.agentsHasProject}
                onSave={props.onSaveAgent}
                onDelete={props.onDeleteAgent}
              />
            </section>
          </Show>

          <Show when={section() === "mcp"}>
            <section class="fc-settings-section">
              <h3 class="fc-settings-title">{t("MCP servers")}</h3>
              <McpEditor
                servers={props.mcpServers}
                configs={props.mcpConfigs}
                resources={props.mcpResources}
                agents={props.agentFiles}
                busy={props.mcpBusy}
                onAdd={props.onAddMcp}
                onRemove={props.onRemoveMcp}
                onConnect={props.onConnectMcp}
                onDisconnect={props.onDisconnectMcp}
                onOAuth={props.onOAuthMcp}
              />
            </section>
          </Show>

          <Show when={section() === "adaptive"}>
            <AdaptiveSettingsPanel
              view={props.adaptive.view}
              loading={props.adaptive.loading}
              failure={props.adaptive.failure}
              capabilities={props.adaptive.capabilities}
              saving={props.adaptive.saving}
              warnings={props.adaptive.warnings}
              error={props.adaptive.error}
              voi={props.adaptive.voi}
              onPatch={props.onAdaptivePatch}
              onAcknowledgeRuntime={props.onAdaptiveAcknowledgeRuntime}
              onModelKey={props.onAdaptiveModelKey}
            />
          </Show>

          <Show when={section() === "server"}>
            <section class="fc-settings-section">
              <h3 class="fc-settings-title">{t("Server")}</h3>
              <div class="fc-settings-row">
                <span>{t("Status")}</span>
                <span class="fc-settings-status">{props.serverStatus}</span>
              </div>
              <div class="fc-settings-row">
                <span>{t("Engine")}</span>
                <span class="fc-settings-status">
                  {props.engineVersion ? `OpenCode ${props.engineVersion}` : t("Unknown")}
                </span>
              </div>
              <Show when={props.engineVersionMismatch}>
                <div class="fc-settings-hint">
                  {t(
                    "This engine ({version}) does not match the version this FlupCode build was generated against ({target}). Update the engine or FlupCode.",
                    { version: props.engineVersion ?? "", target: engineTargetVersion ?? "" },
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
              <div class="fc-settings-row">
                <span>{t("Configuration")}</span>
                <button
                  class="fc-button"
                  classList={{ "fc-button-danger": confirmReload() }}
                  type="button"
                  disabled={props.serverReloading}
                  onClick={reload}
                >
                  <Show when={props.serverReloading}>
                    <span class="fc-spinner" aria-hidden="true">
                      <Icon name="loader" />
                    </span>{" "}
                  </Show>
                  {props.serverReloading
                    ? t("Reloading…")
                    : confirmReload()
                      ? t("Click again to reload")
                      : t("Reload engine")}
                </button>
              </div>
              <div class="fc-settings-hint">
                {t(
                  "Reloading rereads the engine's configuration, so new or edited agents and skills take effect. It drops the turns in flight.",
                )}
              </div>
            </section>
          </Show>

          <Show when={section() === "advanced"}>
            {/* Settings holds configuration only (UX-01): the dialogs that edit the engine's own files. */}
            <section class="fc-settings-section">
              <h3 class="fc-settings-title">{t("Advanced")}</h3>
              <div class="fc-settings-grid">
                <For each={DESTINATIONS.filter((entry) => entry.home === "advanced")}>
                  {(entry) => (
                    <button class="fc-button" type="button" onClick={() => props.onOpen(entry.id)}>
                      {t(entry.title)}
                    </button>
                  )}
                </For>
              </div>
            </section>
          </Show>
        </div>
      </div>
      <ModelPicker
        open={!!pickerTarget()}
        models={props.models}
        selectedKey={pickerTarget() === "suggestion" ? props.suggestionModel || undefined : props.modelKey}
        favorites={props.favorites}
        onSelect={(providerID, id) => {
          const target = pickerTarget()
          setPickerTarget(undefined)
          if (target === "suggestion") return props.onSuggestionModel(`${providerID}/${id}`)
          props.onModelChange(`${providerID}/${id}`)
        }}
        onToggleFavorite={props.onToggleFavorite}
        onClose={() => setPickerTarget(undefined)}
      />
    </Modal>
  )
}
