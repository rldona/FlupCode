import { contextBridge, ipcRenderer } from "electron"
import type { RemoteHostBridge, RemoteHostState, SpeechBridge, SpeechEvent } from "@flupcode/remote"

const remote: RemoteHostBridge = {
  state: () => ipcRenderer.invoke("flupcode:remote-state"),
  setEnabled: (enabled) => ipcRenderer.invoke("flupcode:remote-enable", enabled),
  setRelay: (relay) => ipcRenderer.invoke("flupcode:remote-relay", relay),
  createPairing: () => ipcRenderer.invoke("flupcode:remote-pair"),
  cancelPairing: () => ipcRenderer.invoke("flupcode:remote-cancel-pair"),
  revokeDevice: (id) => ipcRenderer.invoke("flupcode:remote-revoke", id),
  onChange: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: RemoteHostState) => listener(state)
    ipcRenderer.on("flupcode:remote-changed", handler)
    return () => ipcRenderer.removeListener("flupcode:remote-changed", handler)
  },
}

// Only present when the main process found the native helper, so the renderer can enable dictation.
const speech: SpeechBridge | undefined = process.argv.includes("--flupcode-speech")
  ? {
      start: (lang) => ipcRenderer.invoke("flupcode:speech-start", lang),
      stop: () => ipcRenderer.invoke("flupcode:speech-stop"),
      cancel: () => ipcRenderer.invoke("flupcode:speech-cancel"),
      onEvent: (listener) => {
        const handler = (_event: Electron.IpcRendererEvent, event: SpeechEvent) => listener(event)
        ipcRenderer.on("flupcode:speech-event", handler)
        return () => ipcRenderer.removeListener("flupcode:speech-event", handler)
      },
    }
  : undefined

// `base64(user:pass)` for the engine the main process started; see harness/src/transport.ts.
const engineAuth = process.argv
  .find((argument) => argument.startsWith("--flupcode-engine-auth="))
  ?.slice("--flupcode-engine-auth=".length)

// The loopback token the harness browser routes compare; see harness/src/remote.ts.
const browserToken = process.argv
  .find((argument) => argument.startsWith("--flupcode-browser-token="))
  ?.slice("--flupcode-browser-token=".length)

contextBridge.exposeInMainWorld("flupcode", {
  chooseFolder: () => ipcRenderer.invoke("flupcode:choose-folder") as Promise<string | undefined>,
  // The window has no title bar, so the page has to leave room for the controls — and they are on
  // opposite sides on macOS and Windows. On Linux the window keeps its own frame, and the page
  // leaves the strip alone.
  platform: process.platform,
  ownsTitleBar: process.platform === "darwin" || process.platform === "win32",
  setTitleBar: (overlay: { color: string; symbolColor: string }) =>
    ipcRenderer.invoke("flupcode:title-bar", overlay) as Promise<void>,
  // Open a local file in the system's app, or in a named one (VS Code): a generated document is most
  // useful in the editor it was written for (H-14).
  openPath: (path: string, app?: string) =>
    ipcRenderer.invoke("flupcode:open-path", path, app) as Promise<boolean>,
  remote,
  ...(speech ? { speech } : {}),
  ...(engineAuth ? { engineAuth } : {}),
  ...(browserToken ? { browserToken } : {}),
})
