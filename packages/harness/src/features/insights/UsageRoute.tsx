import { UsagePanel } from "../../components/UsagePanel"
import { sessionTitle } from "../../session-title"
import { useApp } from "../../app-context"

/** The usage screen (UL-06). */
export default function UsageRoute() {
  const app = useApp()
  return (
    <UsagePanel
      open={app.router.usageOpen()}
      serverUrl={app.connection.harnessServerUrl()}
      serverAvailable={app.runs.routinesServerAvailable()}
      directory={app.sessions.vcsDirectory()}
      refusal={app.runs.harnessRefusal()}
      onRetryRefusal={() => void app.runs.refreshRoutines()}
      runs={app.runs.runs()}
      routineName={(id) => app.runs.routines().find((routine) => routine.id === id)?.name}
      routines={app.runs.routines()}
      sessionTitle={(id) => app.sessions.sessionList()?.find((session) => session.id === id)?.title}
      onOpenRuns={() => app.router.showScreen("runs")}
      onOpenSession={app.sessions.selectSession}
    />
  )
}
