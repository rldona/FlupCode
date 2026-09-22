import { For, type Component, Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { AgentInfo, ModelInfo } from "../engine-types"
import type {
  ConsoleOrg,
  ConsoleState,
  IntegrationAttempt,
  IntegrationAttemptStatus,
  IntegrationInfo,
  McpResource,
  McpServer,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
  ProviderDirectoryInfo,
} from "../engine-types"
import type { AgentFile, CommandFile, McpConfig } from "../types"
import { engineTargetVersion, type EngineProfile } from "../client"
import { t, type Locale } from "../i18n"
import { KeyCapture } from "./KeyCapture"
import { AgentsPanel } from "./AgentsPanel"
import { ProvidersEditor } from "./ProvidersPanel"
import { CommandsPanel, type CommandDraft } from "./CommandsPanel"
import { McpEditor } from "./McpManager"
import { PermissionsPanel } from "./PermissionsPanel"
import { KEYBIND_ACTIONS, type KeybindAction, type Keybinds } from "../keybinds"
import { resetUsage, restoreUsage, usageResetAt } from "../usage-reset"
import { TEXT_SIZES, appTextSize, chatTextSize, setAppTextSize, setChatTextSize } from "../text-size"
import { isDeprecated } from "../model-catalog"

type SettingsPanelProps = {
  open: boolean
  theme: string
  colorTheme: string
  locale: Locale
  displayName: string
  serverInput: string
  serverStatus: string
  engineProfile: EngineProfile | undefined
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
  onAddMcp: (name: string, config: McpConfig) => void
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
  onToggleTools: () => void
  onToggleReasoning: () => void
  onToggleSessionTabs: () => void
  onToggleReplySuggestions: () => void
  onSuggestionModel: (key: string) => void
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
  providerAuth: Record<string, ProviderAuthMethod[]>
  providerConnected: string[]
  providerIntegrations: IntegrationInfo[]
  providerUnlinked: string[]
  providersBusy: boolean
  onSaveProvider: (providerID: string, key: string) => void
  onRemoveProvider: (providerID: string) => void
  onProviderOAuth: (providerID: string, methodID?: string) => Promise<IntegrationAttempt>
  onProviderOAuthStatus: (attemptID: string) => Promise<IntegrationAttemptStatus>
  onProviderOAuthCancel: (attemptID: string) => Promise<void>
  onProviderOAuthDone: () => void
  /** Legacy provider OAuth, for engines whose v2 integration registry has no OAuth method. */
  onProviderOAuthLegacy: (
    providerID: string,
    method: number,
    inputs?: Record<string, string>,
  ) => Promise<ProviderAuthAuthorization>
  onProviderOAuthLegacyCallback: (providerID: string, method: number, code?: string) => Promise<void>
  onLinkConfiguredProviders: () => void
  /** The Console org behind providers, when the engine has one (CO-1). */
  consoleActive?: ConsoleState
  consoleOrgs?: ConsoleOrg[]
  onSwitchConsole?: (org: ConsoleOrg) => void
  onOpenSkills: () => void
  onOpenRemote: () => void
  onOpenConfig: () => void
  onOpenAbout: () => void
  onClose: () => void
}

/** What each bindable action is called, reusing the command names already translated. */
const KEYBIND_LABELS: Record<KeybindAction, string> = {
  palette: "Command palette",
  newSession: "New session",
  toggleSidebar: "Toggle sidebar",
  toggleContextPanel: "Toggle context panel",
  settings: "Settings",
  compact: "Compact the current session",
  split: "Split view",
}

export type SettingsSection =
  | "appearance"
  | "profile"
  | "model"
  | "providers"
  | "conversation"
  | "notifications"
  | "shortcuts"
  | "permissions"
  | "commands"
  | "agents"
  | "mcp"
  | "server"
  | "advanced"

type SettingsGroup = {
  label: string
  items: Array<{ id: SettingsSection; label: string }>
}

/** The sections, grouped the way the rail shows them. */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "General",
    items: [
      { id: "appearance", label: "Appearance" },
      { id: "profile", label: "Profile" },
    ],
  },
  {
    label: "Models",
    items: [
      { id: "model", label: "Model" },
      { id: "providers", label: "Providers" },
    ],
  },
  {
    label: "Interface",
    items: [
      { id: "conversation", label: "Conversation" },
      { id: "notifications", label: "Notifications" },
      { id: "shortcuts", label: "Shortcuts" },
    ],
  },
  {
    label: "Automation",
    items: [
      { id: "permissions", label: "Permissions" },
      { id: "commands", label: "Commands" },
      { id: "agents", label: "Agents" },
      { id: "mcp", label: "MCP servers" },
    ],
  },
  {
    label: "System",
    items: [
      { id: "server", label: "Server" },
      { id: "advanced", label: "Advanced" },
    ],
  },
]

/** The sections, in the order the rail shows them. */
export const SETTINGS_SECTIONS = SETTINGS_GROUPS.flatMap((group) => group.items)

function groupModels(models: ModelInfo[]) {
  const map = new Map<string, ModelInfo[]>()
  for (const model of models) {
    const list = map.get(model.providerID) ?? []
    list.push(model)
    map.set(model.providerID, list)
  }
  return [...map.entries()].map(([providerID, items]) => ({ providerID, items }))
}

/** A clear on/off switch: the knob's side and colour say the state, not a word to read. */
const Toggle: Component<{ checked: boolean; label: string; onToggle: () => void }> = (props) => (
  <button
    class="fc-switch"
    role="switch"
    type="button"
    aria-checked={props.checked}
    aria-label={props.label}
    onClick={props.onToggle}
  >
    <span class="fc-switch-knob" aria-hidden="true" />
  </button>
)

export const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  // The section lives in app (CU-1): resource keys and the sidebar read it, so tab clicks
  // must be visible outside this panel.
  const section = () => props.section ?? "appearance"
  const setSection = (next: SettingsSection) => props.onSectionChange(next)
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
  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop fc-modal-backdrop-settings" onClick={props.onClose}>
        <div
          class="fc-modal fc-modal-wide fc-modal-settings"
          role="dialog"
          aria-modal="true"
          aria-label={t("Customize")}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-settings-layout">
            <header class="fc-settings-header">
              <span class="fc-settings-header-title">{t("Settings")}</span>
              <button class="fc-icon-button fc-settings-close" type="button" aria-label={t("Close")} onClick={props.onClose}>
                ×
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
                  <label class="fc-settings-row">
                    <span>{t("Default")}</span>
                    <select
                      class="fc-toolbar-select"
                      value={props.modelKey ?? ""}
                      disabled={props.running}
                      onChange={(event) => {
                        const next = event.currentTarget.value
                        // A native select moves on its own: put it back before asking, or cancelling
                        // the warning would leave it showing a model the session is not using.
                        event.currentTarget.value = props.modelKey ?? ""
                        props.onModelChange(next)
                      }}
                    >
                      <option value="" disabled selected={!props.modelKey}>
                        {t("Default model")}
                      </option>
                      <For each={groupModels(props.models)}>
                        {(group) => (
                          <optgroup label={group.providerID}>
                            <For each={group.items}>
                              {(model) => (
                                <option
                                  value={`${model.providerID}/${model.id}`}
                                  selected={props.modelKey === `${model.providerID}/${model.id}`}
                                >
                                  {isDeprecated(model) ? `${model.name} (${t("Deprecated")})` : model.name}
                                </option>
                              )}
                            </For>
                          </optgroup>
                        )}
                      </For>
                    </select>
                  </label>
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
                    <label class="fc-settings-row">
                      <span>{t("Suggestion model")}</span>
                      <select
                        class="fc-toolbar-select"
                        value={props.suggestionModel}
                        disabled={props.running}
                        onChange={(event) => props.onSuggestionModel(event.currentTarget.value)}
                      >
                        <option value="" selected={!props.suggestionModel}>
                          {t("Automatic (small model)")}
                        </option>
                        <For each={groupModels(props.models)}>
                          {(group) => (
                            <optgroup label={group.providerID}>
                              <For each={group.items}>
                                {(model) => (
                                  <option
                                    value={`${model.providerID}/${model.id}`}
                                    selected={props.suggestionModel === `${model.providerID}/${model.id}`}
                                  >
                                    {isDeprecated(model) ? `${model.name} (${t("Deprecated")})` : model.name}
                                  </option>
                                )}
                              </For>
                            </optgroup>
                          )}
                        </For>
                      </select>
                    </label>
                    <Show when={props.running}>
                      <div class="fc-settings-hint">{t("Locked while a session is running.")}</div>
                    </Show>
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
                              ×
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
                    auth={props.providerAuth}
                    connected={props.providerConnected}
                    integrations={props.providerIntegrations}
                    unlinked={props.providerUnlinked}
                    busy={props.providersBusy}
                    onSave={props.onSaveProvider}
                    onRemove={props.onRemoveProvider}
                    onOAuth={props.onProviderOAuth}
                    onOAuthStatus={props.onProviderOAuthStatus}
                    onOAuthCancel={props.onProviderOAuthCancel}
                    onOAuthDone={props.onProviderOAuthDone}
                    onOAuthLegacy={props.onProviderOAuthLegacy}
                    onOAuthLegacyCallback={props.onProviderOAuthLegacyCallback}
                    onLinkConfigured={props.onLinkConfiguredProviders}
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
                      {props.engineVersion === "local" ? t("Source build") : (props.engineVersion ?? t("Unknown"))}
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
                  <Show when={props.engineProfile === "stock"}>
                    <div class="fc-settings-hint">
                      {t(
                        "This engine is the stock OpenCode CLI, so FlupCode's extras (permission modes, memory) are unavailable.",
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
                          ◐
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
                <section class="fc-settings-section">
                  <h3 class="fc-settings-title">{t("Editors")}</h3>
                  <p class="fc-settings-note">
                    {t("Agents live under their own section now; skills keep their screen, where the files they came from are shown.")}
                  </p>
                  <div class="fc-settings-grid">
                    <button class="fc-button" type="button" onClick={() => setSection("agents")}>
                      {t("Agents")}
                    </button>
                    <button class="fc-button" type="button" onClick={props.onOpenSkills}>
                      {t("Skills")}
                    </button>
                  </div>
                </section>

                <section class="fc-settings-section">
                  <h3 class="fc-settings-title">{t("Integrations")}</h3>
                  <div class="fc-settings-grid">
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
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}
