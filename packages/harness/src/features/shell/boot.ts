import { onCleanup } from "solid-js"
import { STORAGE_KEYS, writeStorage } from "../../storage"
import { remote } from "../../remote"
import type { AppStores } from "../../app-context"

/**
 * What the app does once its stores exist: take up the remote connection, and follow the links it
 * was opened with — a pairing link, a dialog's link (UX-00), and the session a notification points at.
 */
export function startShell(app: AppStores) {
  const pairFromLink = () => {
    const pairing = remote.consumePairingLink()
    if (!pairing) return
    // The panel shows progress and, if pairing fails, why.
    app.router.setRemoteOpen(true)
    void pairing.then((paired) => {
      if (!paired) return
      app.router.setRemoteOpen(false)
      app.settings.setOnboarded(true)
      writeStorage(STORAGE_KEYS.onboarded, true)
    })
  }
  /** Opens the session a notification points at, switching computer when needed (ADR-0011). */
  const openFromNotification = (sessionID: string, hostId: string | undefined) => {
    if (hostId && hostId !== remote.activeHost()?.hostId && remote.hosts().some((host) => host.hostId === hostId))
      remote.connect(hostId)
    if (!app.settings.mobileRemote()) return app.sessions.selectSession(sessionID)
    if (app.sessions.selected() !== sessionID) app.sessions.openMobileSession(sessionID)
  }
  const onServiceWorkerMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; sessionID?: unknown; host?: unknown } | undefined
    if (data?.type !== "flupcode:open-session" || typeof data.sessionID !== "string") return
    openFromNotification(data.sessionID, typeof data.host === "string" ? data.host : undefined)
  }

  remote.resume()
  pairFromLink()
  app.router.openLinkedDialog()
  window.addEventListener("hashchange", pairFromLink)
  onCleanup(() => window.removeEventListener("hashchange", pairFromLink))
  const launch = new URLSearchParams(window.location.search)
  const launchSession = launch.get("session")
  if (launchSession) {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.hash)
    openFromNotification(launchSession, launch.get("host") ?? undefined)
  }
  navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage)
  onCleanup(() => navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage))
}
