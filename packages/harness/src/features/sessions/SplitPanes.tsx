import { For, Show } from "solid-js"
import { adaptiveSurfaces } from "../../client"
import { promptHistory } from "../../prompt-history"
import { SessionPane } from "../../components/SessionPane"
import { useApp } from "../../app-context"

/**
 * Split view: sessions side by side, each pane with its own transcript and input. Only a reader who
 * splits needs it, so it loads the first time split view opens.
 */
export default function SplitPanes() {
  const app = useApp()
  return (
    <div class="fc-split">
      {/* Keyed by id: the session list refreshes while sessions run, and a pane must keep its state. */}
      <For each={app.sessions.splitPanes()}>
        {(id) => (
          <Show when={app.sessions.sessionList()?.find((session) => session.id === id)}>
            {(session) => (
              <SessionPane
                session={session()}
                serverUrl={app.connection.serverUrl()}
                focused={app.sessions.selected() === session().id}
                running={!!app.sessions.runState()[session().id]}
                chat={app.sessions.chatClass(session())}
                chatsDirectory={app.connection.chatsDirectory()}
                showTools={app.settings.showTools()}
                showReasoning={app.settings.showReasoning()}
                models={app.catalog.modelList()}
                defaultModel={app.composer.modelRef()}
                compaction={app.catalog.engineConfig()?.compaction}
                favorites={app.settings.favorites()}
                agents={app.catalog.agents()?.data ?? []}
                agent={app.composer.agent()}
                permissionModeId={app.composer.permissionModeId()}
                delivery={app.composer.delivery()}
                onDeliveryChange={app.composer.changeDelivery}
                projects={app.sessions.projects()}
                history={promptHistory()}
                modelName={app.composer.modelName}
                searchFiles={app.composer.searchFiles}
                collapsePaste={app.composer.collapsePaste}
                expandPastes={app.composer.expandPastes}
                readFiles={app.composer.readAttachments}
                onFocus={() => app.sessions.selectSession(session().id)}
                onClose={() => app.sessions.closeSplitPane(session().id)}
                onOpenModelPicker={() => app.router.setModelPickerOpen(true)}
                onAgentChange={app.composer.changeAgent}
                onPermissionModeChange={app.composer.changePermissionMode}
                harnessUrl={app.runs.routinesServerAvailable() ? app.connection.harnessServerUrl() : undefined}
                adaptive={
                  adaptiveSurfaces(app.connection.harnessCapabilities()).session
                    ? { serverUrl: app.connection.harnessServerUrl(), onWhy: app.router.showDecision }
                    : undefined
                }
              />
            )}
          </Show>
        )}
      </For>
    </div>
  )
}
