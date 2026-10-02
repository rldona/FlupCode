import { CommandPalette } from "../../components/CommandPalette"
import { useApp } from "../../app-context"

/** The command palette. */
export default function PaletteRoute() {
  const app = useApp()
  return (
    <CommandPalette
      open={app.router.paletteOpen()}
      commands={app.composer.commandOptions()}
      sessions={app.sessions.sessionList() ?? []}
      projects={app.sessions.projects()}
      artifacts={app.workspace.artifactList()}
      routines={app.runs.routines()}
      runs={app.runs.runs()}
      workflows={app.runs.workflows() ?? []}
      onClose={() => app.router.setPaletteOpen(false)}
      onCommand={app.composer.runCommand}
      onSession={app.sessions.selectSession}
      onProject={(directory) => {
        app.router.leaveScreen()
        app.sessions.changeComposerTarget(directory)
      }}
      onArtifact={() => app.router.showScreen("artifacts")}
      onRoutine={(id) => {
        app.runs.setRoutineFocus(id)
        app.router.showScreen("routines")
      }}
      onRun={() => app.router.showScreen("runs")}
      onWorkflow={(name) => {
        const workflow = app.runs.workflowNamed(name)
        if (workflow) app.runs.setLaunching({ workflow })
      }}
      onFile={(path) => app.composer.setPrompt((value) => (value ? `${value} @${path} ` : `@${path} `))}
      searchFiles={app.composer.searchFiles}
      searchSessions={app.sessions.searchSessions}
    />
  )
}
