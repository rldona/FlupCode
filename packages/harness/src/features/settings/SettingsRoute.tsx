import { STORAGE_KEYS, writeStorage } from "../../storage"
import { getLocale, setLocale } from "../../i18n"
import { SettingsPanel } from "../../components/SettingsPanel"
import { useApp } from "../../app-context"

/** Settings. */
export default function SettingsRoute() {
  const app = useApp()
  return (
    <SettingsPanel
      open={app.router.settingsOpen()}
      theme={app.settings.theme()}
      colorTheme={app.settings.colorTheme()}
      locale={getLocale()}
      displayName={app.settings.displayName()}
      serverInput={app.connection.serverInput()}
      serverStatus={app.connection.serverStatus()}
      engineVersion={app.connection.health()?.version}
      engineVersionMismatch={app.connection.engineVersionMismatch()}
      running={app.sessions.generating()}
      models={app.catalog.modelList()}
      modelKey={app.composer.modelKey()}
      showTools={app.settings.showTools()}
      showReasoning={app.settings.showReasoning()}
      sessionTabs={app.settings.sessionTabsEnabled()}
      replySuggestions={app.composer.suggestionsOn()}
      onToggleReplySuggestions={app.composer.toggleSuggestions}
      suggestionModel={app.composer.suggestionModel()}
      onSuggestionModel={(key) => {
        app.composer.setSuggestionModel(key)
        writeStorage(STORAGE_KEYS.suggestionModel, key)
        // Another model offers other levels; keeping the old one would send a level it does not have.
        app.composer.setSuggestionEffort("")
        writeStorage(STORAGE_KEYS.suggestionEffort, "")
      }}
      suggestionVariants={app.composer.suggestionVariants()}
      suggestionVariant={app.composer.suggestionVariant()}
      onSuggestionVariantChange={(variant) => {
        app.composer.setSuggestionEffort(variant)
        writeStorage(STORAGE_KEYS.suggestionEffort, variant)
      }}
      notifications={app.settings.notifications()}
      keybinds={app.settings.keybinds()}
      savedPermissions={app.catalog.savedPermissions()?.data ?? []}
      onRevokePermission={app.catalog.revokePermission}
      browserGrants={app.catalog.browserGrants.state === "errored" ? undefined : app.catalog.browserGrants()}
      onRevokeBrowserGrant={app.catalog.revokeBrowserGrant}
      permissionPolicy={app.catalog.permissionPolicy()}
      permissionServerAvailable={app.connection.ready()}
      onSavePermissionPolicy={app.catalog.savePermissionPolicy}
      commandFiles={app.catalog.commandFiles() ?? []}
      commandAgents={(app.catalog.agents()?.data ?? []).map((agent) => agent.id)}
      onSaveCommand={app.catalog.saveCommand}
      onDeleteCommand={app.catalog.deleteCommand}
      mcpServers={app.catalog.mcp()?.data ?? []}
      mcpConfigs={app.catalog.mcpConfigs()?.data ?? {}}
      mcpResources={app.catalog.mcpResources() ?? []}
      agentFiles={app.catalog.agentFiles() ?? []}
      mcpBusy={false}
      onAddMcp={app.catalog.addMcp}
      onRemoveMcp={app.catalog.removeMcp}
      onConnectMcp={app.catalog.connectMcp}
      onDisconnectMcp={app.catalog.disconnectMcp}
      onOAuthMcp={app.catalog.oauthMcp}
      onTheme={app.settings.updateTheme}
      onColorTheme={app.settings.updateColorTheme}
      onLocale={setLocale}
      onDisplayName={app.settings.updateDisplayName}
      onServerInput={app.connection.setServerInput}
      onServerCommit={app.connection.commitServer}
      onServerReload={app.connection.reloadEngine}
      serverReloading={app.connection.serverReloading()}
      onModelChange={app.composer.changeModel}
      modelVariants={app.composer.variants()}
      modelVariant={app.composer.variantKey()}
      onModelVariantChange={app.composer.changeVariant}
      onToggleTools={app.settings.toggleTools}
      onToggleReasoning={app.settings.toggleReasoning}
      onToggleSessionTabs={app.settings.toggleSessionTabs}
      onToggleNotifications={app.settings.toggleNotifications}
      onKeybind={app.settings.changeKeybind}
      section={app.router.settingsSection() ?? "appearance"}
      onSectionChange={app.router.setSettingsSection}
      agentsList={app.catalog.folderAgents() ?? []}
      agentTools={app.catalog.engineTools() ?? []}
      favorites={app.settings.favorites()}
      onToggleFavorite={app.settings.toggleFavoriteModel}
      agentsLoading={app.catalog.agentFiles.loading}
      agentsHasProject={!!app.sessions.vcsDirectory()}
      onSaveAgent={app.catalog.saveAgent}
      onDeleteAgent={app.catalog.deleteAgent}
      providersList={app.catalog.providerDirectory()?.all ?? []}
      providerConnected={app.catalog.providerDirectory()?.connected ?? []}
      providerIntegrations={app.catalog.integrations()?.data ?? []}
      providersBusy={app.sessions.busy()}
      onSaveProvider={app.catalog.saveProvider}
      onRemoveProvider={app.catalog.removeProvider}
      existingProviderIDs={app.catalog.providerDirectory()?.all.map((p) => p.id) ?? []}
      disabledProviders={app.catalog.globalConfig()?.disabled_providers ?? []}
      configuredProviders={app.catalog.globalConfig()?.provider ?? {}}
      onSaveCustomProvider={app.catalog.saveCustomProvider}
      onRemoveCustomProvider={app.catalog.removeCustomProvider}
      onProviderOAuth={app.catalog.startOAuth}
      onProviderOAuthStatus={app.catalog.oAuthStatus}
      onProviderOAuthCancel={app.catalog.cancelOAuth}
      onProviderOAuthDone={app.catalog.finishOAuth}
      consoleActive={app.catalog.consoleActive()}
      consoleOrgs={app.catalog.consoleOrgs() ?? []}
      onSwitchConsole={app.catalog.switchConsoleOrg}
      onOpenSkills={() => {
        app.router.setSettingsOpen(false)
        app.router.showScreen("skills")
      }}
      onOpenRemote={() => {
        app.router.setSettingsOpen(false)
        app.router.setRemoteOpen(true)
      }}
      onOpenConfig={() => {
        app.router.setSettingsOpen(false)
        app.router.setConfigOpen(true)
      }}
      onOpenConfigFiles={() => {
        app.router.setSettingsOpen(false)
        app.router.setConfigFilesOpen(true)
      }}
      onOpenAbout={() => {
        app.router.setSettingsOpen(false)
        app.router.setAboutOpen(true)
      }}
      adaptive={{
        view: app.catalog.adaptiveSettings(),
        loading: app.catalog.adaptiveSettings.loading,
        failure: app.catalog.adaptiveSettings.failure(),
        capabilities: app.connection.harnessCapabilities(),
        saving: app.catalog.adaptiveSaving(),
        warnings: app.catalog.adaptiveWarnings(),
        error: app.catalog.adaptiveError(),
        voi: app.catalog.adaptiveVoi.failure() ? undefined : app.catalog.adaptiveVoi(),
      }}
      onAdaptivePatch={app.catalog.patchAdaptive}
      onAdaptiveAcknowledgeRuntime={app.catalog.acknowledgeRuntime}
      onAdaptiveModelKey={app.catalog.changeModelKey}
      onClose={() => app.router.setSettingsOpen(false)}
    />
  )
}
