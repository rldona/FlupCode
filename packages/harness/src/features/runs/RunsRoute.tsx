import { pairingCard } from "./pairing"
import { Show } from "solid-js"
import { RunsPanel } from "../../components/RunsPanel"
import { RemoteRuns } from "../../components/RemoteRuns"
import { useApp } from "../../app-context"

/**
 * The runs screen: what the server is running and what it ran (H-12). A phone controlling a computer
 * gets its own, with what the remote scope allows (HE-02).
 */
export default function RunsRoute() {
  const app = useApp()
  return (
    <Show when={!app.settings.mobileRemote()} fallback={<PhoneRuns />}>
      <DeskRuns />
    </Show>
  )
}

function PhoneRuns() {
  const app = useApp()
  return (
    <Show when={app.router.runsOpen()}>
      <RemoteRuns
        runs={app.runs.runs()}
        attention={app.runs.runsAttention()}
        serverAvailable={app.runs.routinesServerAvailable()}
        focus={app.runs.runFocus()?.runID}
        onApprove={app.runs.approveRun}
        onStop={app.runs.stopRun}
        onOpenSession={(id) => {
          app.router.leaveScreen()
          app.sessions.openMobileSession(id)
        }}
        onBack={() => {
          app.runs.setRunFocus(undefined)
          app.router.leaveScreen()
        }}
      />
    </Show>
  )
}

function DeskRuns() {
  const app = useApp()
  return (
    <RunsPanel
      open={app.router.runsOpen()}
      runs={app.runs.runs()}
      attention={app.runs.runsAttention()}
      routineNames={Object.fromEntries(app.runs.routines().map((routine) => [routine.id, routine.name]))}
      serverAvailable={app.runs.routinesServerAvailable()}
      pairing={pairingCard(app)}
      onStop={app.runs.stopRun}
      onRemove={app.runs.removeRun}
      onClear={app.runs.clearRuns}
      onStopAll={app.runs.stopAllRuns}
      onApprove={app.runs.approveRun}
      onMergeWorktrees={app.runs.mergeWorktrees}
      onCleanupWorktrees={app.runs.cleanupWorktrees}
      activity={app.runs.taskActivity() ?? {}}
      touched={app.runs.touched() ?? {}}
      tools={app.runs.taskTools() ?? {}}
      artifacts={app.runs.runArtifacts() ?? {}}
      usage={app.runs.runUsage() ?? {}}
      models={app.catalog.modelList()}
      onRetry={app.runs.retryTask}
      onSteer={app.runs.steerTask}
      onCancelTask={app.runs.cancelTask}
      onResume={app.runs.resumeRun}
      onResumePlan={app.runs.resumePlan}
      onBestOfN={() => app.router.setBestOfNOpen(true)}
      requests={app.runs.runRequests() ?? {}}
      unattended={app.runs.projectUnattended() ?? {}}
      onReplyPermission={(request, reply, message) =>
        void app.sessions.replyPermission(request, reply, message).then(() => app.runs.refetchRunRequests())
      }
      onReplyQuestion={(request, answers) =>
        void app.sessions.replyQuestion(request, answers).then(() => app.runs.refetchRunRequests())
      }
      onRejectQuestion={(request) =>
        void app.sessions.rejectQuestion(request).then(() => app.runs.refetchRunRequests())
      }
      onUnattended={app.runs.changeProjectUnattended}
      onOpenSession={(id) => {
        app.router.leaveScreen()
        app.sessions.selectSession(id)
      }}
      onOpenChanges={(directory) => {
        app.sessions.setTargetDirectory(directory)
        app.router.showScreen("changes")
      }}
      focus={app.runs.runFocus()}
      onFocused={() => app.runs.setRunFocus(undefined)}
    />
  )
}
