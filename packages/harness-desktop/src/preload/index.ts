import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("flupcode", {
  chooseFolder: () => ipcRenderer.invoke("flupcode:choose-folder") as Promise<string | undefined>,
})
