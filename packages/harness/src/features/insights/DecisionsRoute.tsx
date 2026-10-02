import { Show } from "solid-js"
import { t } from "../../i18n"
import { DecisionsPanel } from "../../components/DecisionsPanel"
import { PanelBoundary } from "../../components/PanelBoundary"
import { useApp } from "../../app-context"

/** The decision audit (AH-E05). */
export default function DecisionsRoute() {
  const app = useApp()
  return (
    <Show when={app.router.decisionsOpen()}>
      <PanelBoundary name={t("The decisions screen")}>
        <DecisionsPanel
          open={app.router.decisionsOpen()}
          serverUrl={app.connection.harnessServerUrl()}
          sessionID={app.sessions.selected()}
          capabilities={app.connection.harnessCapabilities()}
          focusDecisionID={app.router.decisionFocus()}
          onClose={() => app.router.leaveScreen()}
        />
      </PanelBoundary>
    </Show>
  )
}
