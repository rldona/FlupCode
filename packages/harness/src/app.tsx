import { Show, type Component } from "solid-js"
import { AppContext, type AppStores } from "./app-context"
import { createConnection } from "./features/connection/store"
import { createSettings } from "./features/settings/store"
import { createSessions } from "./features/sessions/store"
import { createEngineEvents } from "./features/sessions/events"
import { createRuns } from "./features/runs/store"
import { createCatalog } from "./features/catalog/store"
import { createWorkspace } from "./features/workspace/store"
import { createComposer } from "./features/composer/store"
import { startShell } from "./features/shell/boot"
import { TopStrip } from "./features/shell/TopStrip"
import { Banners } from "./features/shell/Banners"
import { Screens } from "./features/shell/Screens"
import { Dialogs } from "./features/shell/Dialogs"
import { SessionColumn } from "./features/sessions/SessionColumn"
import { createRouter } from "./router"
import { tallyAttention } from "./attention"
import { t } from "./i18n"
import { Sidebar } from "./components/Sidebar"
import { PanelBoundary } from "./components/PanelBoundary"
import { RightAside } from "./components/RightAside"
import { WorkspacePanels } from "./components/WorkspacePanels"

/**
 * The app: its stores, one per feature, and the shell the features are drawn in.
 *
 * The stores are made in an order where each one only reads, while it is being made, what the ones
 * before it hold: a memo or a resource reads its sources as soon as it exists. What a store reads
 * later, in an effect or a handler, can come from any of them.
 */
export const App: Component = () => {
  const app = {} as AppStores
  app.connection = createConnection(app)
  app.router = createRouter(app)
  app.settings = createSettings(app)
  app.sessions = createSessions(app)
  app.events = createEngineEvents(app)
  app.runs = createRuns(app)
  app.catalog = createCatalog(app)
  app.workspace = createWorkspace(app)
  app.composer = createComposer(app)
  startShell(app)

  return (
    <AppContext.Provider value={app}>
      <div
        class="fc-app"
        classList={{
          "fc-mobile-remote": app.settings.mobileRemote(),
          // The desktop window has no title bar of its own, so the page draws the top strip and has to
          // leave room for the window controls: on the left on macOS, on the right on Windows, and
          // over whichever element the window's corner happens to land on.
          "fc-desktop": app.settings.desktopWindow(),
          "fc-desktop-win": app.settings.desktopWindow() && window.flupcode?.platform === "win32",
          "fc-sidebar-hidden": app.settings.collapsed(),
        }}
      >
        <Show when={app.settings.desktopWindow()}>
          <TopStrip />
        </Show>
        <div class="fc-body">
          <Show when={!app.settings.mobileRemote()}>
            <Show when={app.settings.narrow() && !app.settings.collapsed()}>
              <div class="fc-sidebar-backdrop" onClick={() => app.settings.setCollapsed(true)} />
            </Show>
            <PanelBoundary name={t("The sidebar")}>
              <Sidebar
                showBrand={!app.settings.desktopWindow()}
                collapsed={app.settings.collapsed()}
                width={app.settings.sidebarWidth()}
                displayName={app.settings.displayName()}
                view={app.sessions.view()}
                onViewChange={app.sessions.changeView}
                viewActivity={app.sessions.viewActivity()}
                sessions={app.sessions.viewSessions()}
                sessionsLoading={
                  app.sessions.sessions.loading || (app.connection.ready() && app.connection.enginePaths.loading)
                }
                selectedSession={app.sessions.selected()}
                runningSessions={Object.keys(app.sessions.runState()).filter((id) => app.sessions.runState()[id])}
                sessionAttention={app.sessions.sessionsAttention()}
                runsAttention={tallyAttention(Object.values(app.runs.runsAttention()))}
                routineAttention={app.runs.routinesAttention()}
                pinnedSessions={app.sessions.pinnedSessions()}
                sessionTags={app.sessions.sessionTags()}
                expandedProjects={app.sessions.expanded()}
                noFolderSessions={app.sessions.noFolderSessions()}
                onDisplayName={app.settings.updateDisplayName}
                onToggleSessionPin={app.sessions.togglePin}
                onEditTags={app.sessions.editTags}
                onToggleProject={app.sessions.toggleProject}
                onNewSession={app.sessions.newSession}
                onSelectSession={app.sessions.selectSession}
                onSplitSession={app.sessions.openSplit}
                splitSessions={app.sessions.splitActive() ? app.sessions.splitPanes() : []}
                onDeleteSession={app.sessions.deleteSession}
                onRenameSession={app.sessions.renameSession}
                onDeleteProject={app.sessions.deleteProject}
                onResize={app.settings.updateSidebarWidth}
                onCollapse={app.settings.toggleSidebar}
                onCopyPath={app.sessions.copyPath}
                onRefresh={app.sessions.refresh}
                onRoutines={(focus) => {
                  app.runs.setRoutineFocus(focus)
                  app.router.showScreen("routines")
                }}
                routines={app.runs.routines()}
                onSearch={() => app.router.setPaletteOpen(true)}
                activeScreen={app.router.screen()}
                onGo={(id) => {
                  // The nav's Routines is the list, not the routine a row last focused.
                  if (id === "routines") app.runs.setRoutineFocus(undefined)
                  app.router.go(id)
                }}
                desktop={app.settings.desktopWindow()}
                keybinds={app.settings.keybinds()}
              />
            </PanelBoundary>
          </Show>
          <main
            class="fc-main"
            classList={{
              "fc-main-chat-home": app.sessions.chatView() && !app.sessions.selected() && !app.settings.mobileRemote(),
            }}
          >
            <Show when={!app.settings.desktopWindow()}>
              <TopStrip />
            </Show>
            <Banners />
            {/* Tool screens live in the main column (HF-9): the sidebar stays visible. */}
            <Screens />
            <SessionColumn />
          </main>
          <Show when={!app.settings.mobileRemote() && app.sessions.codeChrome()}>
            <PanelBoundary name={t("The side panels")}>
              <WorkspacePanels
                panels={app.settings.panels()}
                serverUrl={app.connection.serverUrl()}
                harnessServerUrl={app.connection.harnessServerUrl()}
                bridge={app.connection.supports("bridge")}
                session={app.sessions.selectedSession()}
                revision={[app.sessions.messages(), app.workspace.vcsStatus()]}
                changedFiles={app.workspace.changedFiles()}
                onOpenChanges={app.workspace.openChanges}
                width={app.settings.workspaceWidth()}
                onResize={app.settings.updateWorkspaceWidth}
                onClose={app.settings.closePanel}
                onAddChip={app.composer.addChip}
              />
            </PanelBoundary>
            <Show when={app.settings.contextPanelShown()}>
              <PanelBoundary name={t("The details panel")}>
                <RightAside
                  subagents={app.sessions.visibleSubagents()}
                  onClearSubagents={app.sessions.clearSubagents}
                  onOpenSubagent={app.sessions.selectSession}
                  runningSubagents={Object.keys(app.sessions.runState()).filter((id) => app.sessions.runState()[id])}
                  blockedSubagents={app.sessions.blockedSessions()}
                  width={app.settings.contextWidth()}
                  onResize={app.settings.updateContextWidth}
                  onHide={app.settings.toggleContextPanel}
                  serverUrl={app.connection.serverUrl()}
                  sessionID={app.sessions.selected()}
                />
              </PanelBoundary>
            </Show>
          </Show>
        </div>
        <Dialogs />
      </div>
    </AppContext.Provider>
  )
}
