import { chipForRef } from "../../context-chip"
import { CommandPalette } from "../../components/CommandPalette"
import { useApp } from "../../app-context"
import { DESTINATIONS, offered } from "../../navigation"

/** The `/name`s that open a destination: the palette lists the destination itself instead. */
const DESTINATION_COMMANDS = new Set(DESTINATIONS.flatMap((entry) => (entry.command ? [entry.command] : [])))

/** The command palette. */
export default function PaletteRoute() {
  const app = useApp()
  return (
    <CommandPalette
      open={app.router.paletteOpen()}
      places={offered(app.settings.desktopWindow())}
      commands={app.composer.commandOptions().filter((command) => command.source !== "builtin" || !DESTINATION_COMMANDS.has(command.name))}
      sessions={app.sessions.sessionList() ?? []}
      projects={app.sessions.projects()}
      artifacts={app.workspace.artifactList()}
      routines={app.runs.routines()}
      runs={app.runs.runs()}
      workflows={app.runs.workflows() ?? []}
      onClose={() => app.router.setPaletteOpen(false)}
      onCommand={app.composer.runCommand}
      onPlace={app.router.go}
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
      onFile={(path) => {
        // A file picked here is pointed at, like one picked from the `@` menu (UX-05).
        const chip = chipForRef(`@${path}`)
        if (chip) return app.composer.addChip(chip)
        app.composer.setPrompt((value) => (value ? `${value} @${path} ` : `@${path} `))
      }}
      searchFiles={app.composer.searchFiles}
      searchSessions={app.sessions.searchSessions}
    />
  )
}
