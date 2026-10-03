import { pairingCard } from "./pairing"
import { Show } from "solid-js"
import { RunsPanel } from "../../components/RunsPanel"
import { RemoteRuns } from "../../components/RemoteRuns"
import { useApp } from "../../app-context"
import type { RunCheckpointActions } from "../../components/RunCheckpoints"
import { t } from "../../i18n"
import { toast } from "../../toast"
import { createHarnessClient } from "../../client"

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
  const checkpoints = runCheckpoints(app)
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
      rawArtifact={(id) => createHarnessClient(app.connection.harnessServerUrl()).artifacts.raw(id)}
      usage={app.runs.runUsage() ?? {}}
      models={app.catalog.modelList()}
      onRetry={app.runs.retryTask}
      onSteer={app.runs.steerTask}
      onCancelTask={app.runs.cancelTask}
      onResume={app.runs.resumeRun}
      onResumePlan={app.runs.resumePlan}
      checkpoints={checkpoints}
      onFocusRun={(runID) => app.runs.setRunFocus({ runID })}
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

/**
 * A run's checkpoints (CL-3): restoring one takes the folder and the task's conversation back
 * together, and forking from one starts a new run there, which is brought into view. Here rather
 * than in the store, so it loads with the screen that uses it.
 */
function runCheckpoints(app: ReturnType<typeof useApp>): RunCheckpointActions {
  const client = () => createHarnessClient(app.connection.harnessServerUrl())
  const failed = (cause: unknown) => toast(cause instanceof Error ? cause.message : String(cause), "error")
  return {
    list: (runID) => client().checkpoints.ofRun(runID),
    plan: (id) => client().checkpoints.plan(id),
    restore: (id) =>
      client()
        .checkpoints.restore(id)
        .then((done) =>
          toast(t("Checkpoint restored"), "success", {
            description: t("Restored: {written} rewritten, {removed} deleted", {
              written: done?.plan.files.write.length ?? 0,
              removed: done?.plan.files.remove.length ?? 0,
            }),
          }),
        )
        .catch(failed),
    forkPlan: (id) => client().checkpoints.forkPlan(id),
    fork: (id) =>
      client()
        .checkpoints.fork(id)
        .then((run) => {
          toast(t("Run forked"), "success")
          if (run) app.runs.setRunFocus({ runID: run.id })
        })
        .catch(failed),
  }
}
