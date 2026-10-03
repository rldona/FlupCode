import { contextBridge, ipcRenderer } from "electron"
import type { RemoteHostBridge, RemoteHostState, SpeechBridge, SpeechEvent } from "@flupcode/remote"
import type { ChildState } from "@flupcode/remote/supervisor"

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

// The engine and the harness the app started, as their supervisor sees them (HE-03).
const children = {
  state: () => ipcRenderer.invoke("flupcode:children") as Promise<ChildState[]>,
  restart: (name: string) => ipcRenderer.invoke("flupcode:restart-child", name) as Promise<void>,
  copyDiagnostics: () => ipcRenderer.invoke("flupcode:copy-diagnostics") as Promise<boolean>,
  onChange: (listener: (states: ChildState[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, states: ChildState[]) => listener(states)
    ipcRenderer.on("flupcode:children-changed", handler)
    return () => ipcRenderer.removeListener("flupcode:children-changed", handler)
  },
}

// The preview (BU-06): a page of the project's dev server in a view main places over the panel.
type PreviewState = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }
const preview = {
  show: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("flupcode:preview-show", bounds) as Promise<boolean>,
  hide: () => ipcRenderer.invoke("flupcode:preview-hide") as Promise<void>,
  state: () => ipcRenderer.invoke("flupcode:preview-state") as Promise<PreviewState | undefined>,
  // The address bar's text: "allow" opens it, "ask" is a site the app asks the server about.
  open: (text: string) =>
    ipcRenderer.invoke("flupcode:preview-open", text) as Promise<{ verdict: "allow" | "ask" | "refuse"; url: string }>,
  history: (move: "back" | "forward" | "reload" | "stop" | "close") =>
    ipcRenderer.invoke("flupcode:preview-history", move) as Promise<void>,
  capture: () => ipcRenderer.invoke("flupcode:preview-capture") as Promise<string | undefined>,
  servers: (directory?: string) => ipcRenderer.invoke("flupcode:preview-servers", directory),
  onChange: (listener: (state: PreviewState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: PreviewState) => listener(state)
    ipcRenderer.on("flupcode:preview-changed", handler)
    return () => ipcRenderer.removeListener("flupcode:preview-changed", handler)
  },
  // A page tried to go somewhere off this machine that was not allowed: the app asks the server.
  onBlocked: (listener: (url: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) => listener(url)
    ipcRenderer.on("flupcode:preview-blocked", handler)
    return () => ipcRenderer.removeListener("flupcode:preview-blocked", handler)
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

// `base64(user:pass)` for the engine the main process started (see harness/src/transport.ts) and the
// loopback token the harness browser routes compare (see harness/src/remote.ts). Asked over IPC, not
// read from the command line, which any local process can list (TI-10).
const credentials = ipcRenderer.sendSync("flupcode:credentials") as { engineAuth?: string; browserToken?: string }
const engineAuth = credentials.engineAuth
const browserToken = credentials.browserToken

contextBridge.exposeInMainWorld("flupcode", {
  chooseFolder: () => ipcRenderer.invoke("flupcode:choose-folder") as Promise<string | undefined>,
  // The window has no title bar, so the page has to leave room for the controls — and they are on
  // opposite sides on macOS and Windows. On Linux the window keeps its own frame, and the page
  // leaves the strip alone.
  platform: process.platform,
  ownsTitleBar: process.platform === "darwin" || process.platform === "win32",
  setTitleBar: (overlay: { color: string; symbolColor: string }) =>
    ipcRenderer.invoke("flupcode:title-bar", overlay) as Promise<void>,
  // Open a local file in the system's app, or in a named editor (VS Code): a generated document is
  // most useful in the editor it was written for (H-14). Main only runs editors it knows (TI-17).
  openPath: (path: string, app?: string) =>
    ipcRenderer.invoke("flupcode:open-path", path, app) as Promise<boolean>,
  // A link in the transcript opens the reader's real browser, never the sandboxed renderer.
  openExternal: (url: string) => ipcRenderer.invoke("flupcode:open-external", url) as Promise<boolean>,
  remote,
  children,
  preview,
  ...(speech ? { speech } : {}),
  ...(engineAuth ? { engineAuth } : {}),
  ...(browserToken ? { browserToken } : {}),
})
