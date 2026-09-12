import { BrowserWindow, app } from "electron"
import { join } from "node:path"
import { setApplicationMenu } from "./menu"
import { ensureServer, stopServer } from "./server"
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
      contextIsolation: true,
      nodeIntegration: false,
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

app.whenReady().then(async () => {
  setApplicationMenu({ onNewWindow: createWindow, onCheckUpdates: () => void checkForUpdates() })
  initAutoUpdate()
  await ensureServer()
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => stopServer())
