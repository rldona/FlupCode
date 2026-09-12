import { BrowserWindow, app } from "electron"
import { join } from "node:path"

const DEV_URL = process.env.OPENHARNESS_DEV_URL ?? "http://localhost:4444"

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    title: "OpenHarness",
    backgroundColor: "#0f0f0f",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devUrl = process.env.OPENHARNESS_DEV_URL
  if (devUrl || !app.isPackaged) {
    void window.loadURL(devUrl ?? DEV_URL)
    return
  }

  void window.loadFile(join(app.getAppPath(), "out", "renderer", "index.html"))
}

app.whenReady().then(() => {
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
