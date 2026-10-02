import { createHarnessClient } from "../../client"
import { WorkflowsPanel } from "../../components/WorkflowsPanel"
import { useApp } from "../../app-context"

/** The workflows screen (H-21). */
export default function WorkflowsRoute() {
  const app = useApp()
  return (
    <WorkflowsPanel
      open={app.router.workflowsScreenOpen()}
      files={app.runs.workflows() ?? []}
      loading={app.runs.workflows.loading}
      serverAvailable={app.runs.workflowsAvailable()}
      directory={app.sessions.modelLocation()}
      onRead={app.runs.readWorkflowFile}
      onSave={app.runs.saveWorkflowFile}
      onDelete={app.runs.deleteWorkflowFile}
      onRun={(workflow) => app.runs.setLaunching({ workflow })}
      onListRuns={(name) =>
        createHarnessClient(app.connection.harnessServerUrl()).workflows.runs(name, app.sessions.modelLocation())
      }
      onOpenSession={(id) => {
        app.router.leaveScreen()
        app.sessions.selectSession(id)
      }}
    />
  )
}
