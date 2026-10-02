import { ConfigFilesPanel } from "../../components/ConfigFilesPanel"
import { canOpenLocalFiles, openInEditor } from "../../remote"
import { useApp } from "../../app-context"

/** The configuration files and their export (CU-1). */
export default function ConfigFilesRoute() {
  const app = useApp()
  return (
    <ConfigFilesPanel
      open={app.router.configFilesOpen()}
      harnessServerUrl={app.connection.harnessServerUrl()}
      directory={app.sessions.vcsDirectory()}
      serverAvailable={app.connection.configFilesAvailable()}
      canOpenFiles={canOpenLocalFiles()}
      configRepo={app.catalog.engineConfig()?.flupcode?.configRepo}
      onSetConfigRepo={app.catalog.saveConfigRepo}
      onOpenInEditor={(path) => void openInEditor(path)}
      onReload={app.catalog.reloadEngineDefinitions}
      onClose={() => app.router.setConfigFilesOpen(false)}
      onBack={() => {
        app.router.setConfigFilesOpen(false)
        app.router.setSettingsOpen(true)
      }}
    />
  )
}
