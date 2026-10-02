import { MemoryPanel } from "../../components/MemoryPanel"
import { useApp } from "../../app-context"

/** The project's notes (H-37). */
export default function MemoryRoute() {
  const app = useApp()
  return (
    <MemoryPanel
      open={app.router.memoryOpen()}
      serverUrl={app.connection.serverUrl()}
      notes={app.workspace.projectNotes()}
      onAddNote={app.workspace.addProjectNote}
      onRemoveNote={app.workspace.removeProjectNote}
      onClose={() => app.router.setMemoryOpen(false)}
    />
  )
}
