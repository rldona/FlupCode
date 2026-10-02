import { createHarnessClient } from "../../client"
import { messageID } from "../../ids"
import { ArtifactsPanel } from "../../components/ArtifactsPanel"
import { canOpenLocalFiles, openInEditor, openLocalPath } from "../../remote"
import { useApp } from "../../app-context"

/** The artifacts screen: what the runs left behind (H-14). */
export default function ArtifactsRoute() {
  const app = useApp()
  return (
    <ArtifactsPanel
      open={app.router.artifactsOpen()}
      artifacts={app.workspace.artifactList()}
      sessionFiles={app.workspace.artifacts()}
      serverAvailable={app.workspace.artifactsAvailable()}
      canOpenFiles={canOpenLocalFiles()}
      rawArtifact={(id) => createHarnessClient(app.connection.harnessServerUrl()).artifacts.raw(id)}
      onCopy={app.sessions.copyPath}
      onRemove={app.workspace.removeArtifact}
      onUpdate={app.workspace.updateArtifact}
      hasMore={app.workspace.artifactsNext() !== undefined}
      onLoadMore={() => void app.workspace.loadMoreArtifacts()}
      versions={(id) => createHarnessClient(app.connection.harnessServerUrl()).artifacts.versions(id)}
      version={(id) => createHarnessClient(app.connection.harnessServerUrl()).artifacts.get(id)}
      onOpenRun={(runID, taskID) => {
        app.runs.setRunFocus({ runID, ...(taskID ? { taskID } : {}) })
        app.router.showScreen("runs")
      }}
      onOpenMessage={(sessionID, messageID) => {
        // The transcript first, so it is on screen when it is asked to scroll.
        app.sessions.selectSession(sessionID)
        app.sessions.setRevealMessage(messageID)
      }}
      onOpenPath={(path) => void openLocalPath(path)}
      onOpenInEditor={(path) => void openInEditor(path)}
    />
  )
}
