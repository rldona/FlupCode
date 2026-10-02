import { FilesPanel } from "../../components/FilesPanel"
import { useApp } from "../../app-context"

/** The file tree and viewer (H-19). */
export default function FilesRoute() {
  const app = useApp()
  return (
    <FilesPanel
      open={app.router.filesOpen()}
      directory={app.sessions.vcsDirectory()}
      list={app.workspace.listFiles}
      search={app.workspace.searchFileEntries}
      read={app.workspace.readFileText}
      onClose={() => app.router.leaveScreen()}
    />
  )
}
