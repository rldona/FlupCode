import { pairingCard } from "./pairing"
import { createHarnessClient } from "../../client"
import { runAttention } from "../../attention"
import { RoutinesPanel } from "../../components/RoutinesPanel"
import { useApp } from "../../app-context"

/** The routines screen. */
export default function RoutinesRoute() {
  const app = useApp()
  return (
    <RoutinesPanel
      open={app.router.routinesOpen()}
      focus={app.runs.routineFocus()}
      onFocused={() => app.runs.setRoutineFocus(undefined)}
      routines={app.runs.routines()}
      routineAttention={app.runs.routinesAttention()}
      runAttention={(run) => app.runs.runsAttention()[run.id] ?? app.runs.runAttentionOf(run)}
      busy={app.runs.routineBusy()}
      busyRoutineID={app.runs.routineBusyID()}
      serverAvailable={app.runs.routinesServerAvailable()}
      serverLoading={app.runs.routinesServerLoading()}
      pairing={pairingCard(app)}
      projects={app.runs.routineProjects()}
      models={app.catalog.modelList()}
      agents={app.catalog.agents()?.data ?? []}
      actions={app.runs.actionProfiles()}
      artifacts={app.workspace.artifactList()}
      loadWorkflows={(directory) => createHarnessClient(app.connection.harnessServerUrl()).workflows.list(directory)}
      onAdd={app.runs.addRoutine}
      onUpdate={app.runs.updateRoutine}
      onToggle={app.runs.toggleRoutine}
      onRemove={app.runs.removeRoutine}
      onRun={app.runs.runRoutine}
      onStop={app.runs.stopRoutine}
      onOpenSession={(id) => {
        app.router.leaveScreen()
        app.sessions.selectSession(id)
      }}
      onClose={() => app.router.leaveScreen()}
    />
  )
}
