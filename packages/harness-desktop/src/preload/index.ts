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

contextBridge.exposeInMainWorld("flupcode", {
  chooseFolder: () => ipcRenderer.invoke("flupcode:choose-folder") as Promise<string | undefined>,
  remote,
  ...(speech ? { speech } : {}),
})
