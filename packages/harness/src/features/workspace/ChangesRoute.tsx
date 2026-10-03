import { ChangesPanel } from "../../components/ChangesPanel"
import { useApp } from "../../app-context"

/** The changes screen: the diff, its commit, checkpoints and findings (H-06). */
export default function ChangesRoute() {
  const app = useApp()
  return (
    <ChangesPanel
      open={app.router.changesOpen()}
      directory={app.sessions.vcsDirectory()}
      branch={app.workspace.vcsInfo()?.branch}
      defaultBranch={app.workspace.vcsInfo()?.default_branch}
      changes={app.workspace.changes() ?? []}
      loading={app.workspace.changes.loading}
      failure={app.workspace.changes.failure()}
      refusal={app.runs.harnessRefusal()}
      onRetryHarness={() => void app.runs.refreshRoutines()}
      mode={app.workspace.diffMode()}
      canCommit={app.runs.routinesServerAvailable()}
      committing={app.workspace.committing()}
      onMode={app.workspace.setDiffMode}
      onRefresh={() => void app.workspace.refetchChanges()}
      onCommit={app.workspace.commitPicked}
      onDiscard={app.workspace.discardChanges}
      onGenerateMessage={app.workspace.generateCommitMessage}
      onBranch={app.workspace.startBranch}
      checkpoints={app.workspace.checkpoints() ?? []}
      checkpointBusy={app.workspace.checkpointBusy()}
      onCheckpointPlan={app.workspace.checkpointPlan}
      onCheckpointRestore={app.workspace.restoreCheckpoint}
      onCheckpointTake={app.workspace.takeCheckpoint}
      onCheckpointRemove={app.workspace.removeCheckpoint}
      findings={app.workspace.findings() ?? []}
      onResolveFinding={app.workspace.resolveFinding}
      onAddChip={app.composer.addChip}
    />
  )
}
