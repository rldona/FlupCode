import { Show } from "solid-js"
import { ContextPanel } from "../../components/ContextPanel"
import { t } from "../../i18n"
import { PanelBoundary } from "../../components/PanelBoundary"
import { useApp } from "../../app-context"

/** What the model was given (H-17). */
export default function ContextRoute() {
  const app = useApp()
  return (
    <Show when={app.router.contextOpen()}>
      {/* The adaptive screens read the harness server on their own. Each gets a boundary mounted
          only while it is open, so a failure stays on that screen and opening it again retries. */}
      <PanelBoundary name={t("The context screen")}>
        <ContextPanel
          open={app.router.contextOpen()}
          directory={app.sessions.vcsDirectory()}
          report={app.workspace.contextReport()}
          loading={app.workspace.contextReport.loading}
          serverAvailable={app.runs.routinesServerAvailable()}
          skills={app.catalog.skills()?.data ?? []}
          agents={app.catalog.agents()?.data ?? []}
          agent={app.composer.agent()}
          tools={app.catalog.engineTools() ?? []}
          mcp={app.catalog.mcp()?.data ?? []}
          tokens={app.workspace.contextTokens()}
          compactions={app.workspace.compactions()}
          prompts={app.workspace.capturedPrompts()}
          promptsLoading={app.workspace.capturedPrompts.loading}
          toolUses={app.workspace.toolUses()?.tools}
          toolCalls={app.workspace.toolUses()?.calls}
          onRead={app.workspace.readInstruction}
          serverUrl={app.connection.harnessServerUrl()}
          sessionID={app.sessions.selected()}
          projectID={app.sessions.vcsDirectory()}
          capabilities={app.connection.harnessCapabilities()}
        />
      </PanelBoundary>
    </Show>
  )
}
