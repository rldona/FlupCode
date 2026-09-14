import { BrowserWindow, app, dialog, ipcMain } from "electron"
import { join } from "node:path"
import { setApplicationMenu } from "./menu"
import { initRemoteHost } from "./remote"
import { ensureServer, stopServer } from "./server"
import { initSpeech, speechAvailable, stopSpeech } from "./speech"
import { initAutoUpdate, checkForUpdates } from "./updater"
import { loadBounds, saveBounds } from "./window-state"

const DEV_URL = process.env.FLUPCODE_DEV_URL ?? "http://localhost:4444"

function createWindow() {
  const bounds = loadBounds()

  const window = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 720,
    minHeight: 480,
    title: "FlupCode",
    backgroundColor: "#0f0f0f",
    webPreferences: {
      preload: join(app.getAppPath(), "out", "preload", "index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The packaged app loads from file:// and talks to the local engine over HTTP.
      webSecurity: false,
      // The preload only exposes the native speech bridge when the helper is present.
      additionalArguments: speechAvailable() ? ["--flupcode-speech"] : [],
    },
  })

  window.on("close", () => saveBounds(window.getBounds()))

  const devUrl = process.env.FLUPCODE_DEV_URL
  if (devUrl || !app.isPackaged) {
    void window.loadURL(devUrl ?? DEV_URL)
    return
  }

  void window.loadFile(join(app.getAppPath(), "out", "renderer", "index.html"))
}

let remote: ReturnType<typeof initRemoteHost> | undefined

app.whenReady().then(async () => {
  setApplicationMenu({ onNewWindow: createWindow, onCheckUpdates: () => void checkForUpdates() })
  initAutoUpdate()
  initSpeech()
  remote = initRemoteHost()
  await ensureServer()
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

ipcMain.handle("flupcode:choose-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })
  if (result.canceled || result.filePaths.length === 0) return undefined
  return result.filePaths[0]
})

app.on("before-quit", () => {
  remote?.stop()
  stopSpeech()
  stopServer()
})
