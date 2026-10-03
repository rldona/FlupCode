import { RemotePanel } from "../../components/RemotePanel"
import { remote } from "../../remote"
import { useApp } from "../../app-context"

/** Remote control: this computer's pairing, or the computers this device controls. */
export default function RemoteRoute() {
  const app = useApp()
  return (
    <RemotePanel
      open={app.router.remoteOpen()}
      initialUrl={app.connection.serverUrl()}
      onClose={() => {
        app.router.setRemoteOpen(false)
        remote.dismissPairing()
      }}
    />
  )
}
