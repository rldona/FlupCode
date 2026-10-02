import { ConfigPanel } from "../../components/ConfigPanel"
import { useApp } from "../../app-context"

/** The engine's configuration (advanced). */
export default function ConfigRoute() {
  const app = useApp()
  return (
    <ConfigPanel
      open={app.router.configOpen()}
      client={app.connection.client()}
      onSaved={() => {
        void app.catalog.refetchEngineConfig()
        void app.catalog.refetchGlobalConfig()
      }}
      onClose={() => app.router.setConfigOpen(false)}
      onBack={() => {
        app.router.setConfigOpen(false)
        app.router.setSettingsOpen(true)
      }}
    />
  )
}
