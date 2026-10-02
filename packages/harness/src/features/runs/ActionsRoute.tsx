import { ActionsPanel } from "../../components/ActionsPanel"
import { useApp } from "../../app-context"

/** The web actions screen (WA-7). */
export default function ActionsRoute() {
  const app = useApp()
  return (
    <ActionsPanel
      open={app.router.actionsOpen()}
      directory={app.sessions.modelLocation()}
      project={app.sessions.vcsDirectory()}
      serverUrl={app.connection.harnessServerUrl()}
      serverAvailable={app.runs.routinesServerAvailable()}
      onClose={() => app.router.leaveScreen()}
    />
  )
}
