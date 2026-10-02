import { Show } from "solid-js"
import { sessionTitle } from "../../session-title"
import { t } from "../../i18n"
import { Topbar } from "../../components/Topbar"
import { SessionActions, SessionTitle } from "../../components/SessionToolbar"
import { remote } from "../../remote"
import { useApp } from "../../app-context"

/**
 * The top strip: the navigation, the session, and what the engine is doing.
 *
 * A component rather than a value, because it is placed in one of two places and only one of
 * them exists at a time. In the desktop app it is a row of its own across the window, which is
 * where the window controls are; in a browser the window already has a bar of its own above the
 * page, so the strip stays over the session, where it has always been.
 */
export function TopStrip() {
  const app = useApp()
  return (
    <Show
      when={!app.settings.mobileRemote()}
      fallback={
        <Show when={app.sessions.mobileScreen() === "session"}>
          <header class="fc-mobile-header">
            <button
              class="fc-icon-button fc-mobile-back"
              type="button"
              aria-label={t("Back")}
              onClick={() =>
                window.history.state?.flupcode === "session" ? window.history.back() : app.sessions.leaveMobileSession()
              }
            >
              ←
            </button>
            <span class="fc-mobile-heading">
              <span class="fc-mobile-title">
                {sessionTitle(app.sessions.selectedSession()) ||
                  (app.sessions.chatView() ? t("New chat") : t("New session"))}
              </span>
              <Show
                when={
                  app.sessions.codeChrome() &&
                  (app.sessions.targetDirectory() ?? app.sessions.selectedSession()?.location?.directory)
                    ?.split("/")
                    .filter(Boolean)
                    .at(-1)
                }
              >
                {(project) => <span class="fc-mobile-subtitle">{project()}</span>}
              </Show>
            </span>
            <button
              class={`fc-remote-dot fc-remote-dot-${remote.status() === "connected" ? "online" : "connecting"} fc-mobile-host`}
              type="button"
              aria-label={t("Remote: {name}", { name: remote.activeHost()?.name ?? "" })}
              onClick={() => app.router.setRemoteOpen(true)}
            />
          </header>
        </Show>
      }
    >
      <Topbar
        showTabs={app.settings.desktopWindow() || app.settings.collapsed()}
        showEngineStatus={app.settings.desktopWindow()}
        showAgentBrowser={app.settings.desktopWindow()}
        streamState={app.sessions.streamState()}
        blockedElsewhere={app.sessions.blockedElsewhere()}
        onOpenBlocked={app.sessions.selectSession}
        healthLoading={app.connection.health.loading}
        healthHealthy={app.connection.health()?.healthy === true}
        healthError={!app.connection.health.loading && app.connection.health()?.healthy === false}
        canGoBack={app.sessions.canGoBack()}
        canGoForward={app.sessions.canGoForward()}
        onBack={app.sessions.goBack}
        onForward={app.sessions.goForward}
        onToggleSidebar={app.settings.toggleSidebar}
        view={app.sessions.view()}
        onViewChange={app.sessions.changeView}
        viewActivity={app.sessions.viewActivity()}
        codeChrome={app.sessions.codeChrome() && !app.router.toolScreen()}
        sidebarCollapsed={app.settings.collapsed()}
        contextPanel={
          app.sessions.selectedSession() && app.sessions.codeChrome() && !app.router.toolScreen()
            ? { open: !app.settings.contextHidden(), onToggle: app.settings.toggleContextPanel }
            : undefined
        }
        onTogglePanel={app.settings.togglePanel}
        openPanels={app.settings.panels()}
        remote={
          remote.activeHost()
            ? {
                name: remote.activeHost()!.name,
                connected: remote.status() === "connected",
                onOpen: () => app.router.setRemoteOpen(true),
              }
            : undefined
        }
        hostRemote={app.connection.hostRemotePill()}
        sessionTitle={
          <Show when={!app.sessions.splitActive() && !app.router.toolScreen() && app.sessions.selectedSession()}>
            {(session) => (
              <SessionTitle
                session={session()}
                lineage={app.sessions.lineage()}
                onOpenLineage={app.sessions.selectSession}
              />
            )}
          </Show>
        }
        sessionActions={
          <Show when={!app.sessions.splitActive() && !app.router.toolScreen() && app.sessions.selectedSession()}>
            {(session) => (
              <SessionActions
                session={session()}
                projects={app.sessions.projects()}
                reverting={!!session().revert}
                onFork={app.sessions.forkSession}
                onCompact={app.sessions.compactSession}
                onRename={app.sessions.renameSession}
                onExport={() => app.router.setExportOpen(true)}
                onMove={app.sessions.moveSession}
                onDelete={app.sessions.deleteSession}
                onUndo={app.sessions.undo}
                onRedo={app.sessions.redo}
                onCommitRevert={app.sessions.commitRevert}
              />
            )}
          </Show>
        }
      />
    </Show>
  )
}
