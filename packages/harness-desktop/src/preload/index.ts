import { contextBridge, ipcRenderer } from "electron"
import type { RemoteHostBridge, RemoteHostState } from "@flupcode/remote"

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

contextBridge.exposeInMainWorld("flupcode", {
  chooseFolder: () => ipcRenderer.invoke("flupcode:choose-folder") as Promise<string | undefined>,
  remote,
})
