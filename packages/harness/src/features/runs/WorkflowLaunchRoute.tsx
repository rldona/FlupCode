import { WorkflowLaunchDialog } from "../../components/WorkflowLaunchDialog"
import { useApp } from "../../app-context"

/** The workflow launcher (H-28). */
export default function WorkflowLaunchRoute() {
  const app = useApp()
  return (
    <WorkflowLaunchDialog
      open={!!app.runs.launching()}
      workflow={app.runs.launching()?.workflow}
      packs={app.composer.packs()}
      initialArgs={app.runs.launching()?.args}
      onLaunch={(launch) => {
        const workflow = app.runs.launching()?.workflow
        app.runs.setLaunching(undefined)
        if (workflow) void app.runs.runWorkflow(workflow.name, launch)
      }}
      onClose={() => app.runs.setLaunching(undefined)}
    />
  )
}
