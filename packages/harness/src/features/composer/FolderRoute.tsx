import { FolderDialog } from "../../components/FolderDialog"
import { useApp } from "../../app-context"

/** Choosing the folder a new session works in. */
export default function FolderRoute() {
  const app = useApp()
  return (
    <FolderDialog
      open={app.router.folderOpen()}
      initial={app.sessions.targetDirectory()}
      recents={app.sessions
        .projects()
        .map((project) => project.directory)
        .filter((directory) => directory !== app.connection.chatsDirectory())}
      home={async () => (await app.connection.client().paths()).home}
      list={(directory, path) => app.connection.client().file.list({ directory, path })}
      onOpen={(path) => {
        app.sessions.setTargetDirectory(path)
        app.router.setFolderOpen(false)
      }}
      onClose={() => app.router.setFolderOpen(false)}
    />
  )
}
