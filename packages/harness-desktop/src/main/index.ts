import { BrowserWindow, app, dialog, ipcMain, net, protocol } from "electron"
import { isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setApplicationMenu } from "./menu"
import { initRemoteHost } from "./remote"
import { engineCredentials, ensureServer, stopServer } from "./server"
import { initSpeech, speechAvailable, stopSpeech } from "./speech"
import { initAutoUpdate, checkForUpdates } from "./updater"
import { loadBounds, saveBounds } from "./window-state"

const DEV_URL = process.env.FLUPCODE_DEV_URL ?? "http://localhost:4444"

/**
 * The packaged renderer is served from `oc://renderer` rather than `file://`, which is what lets the
 * window keep the same-origin policy on: a `file://` document has the opaque origin the engine's CORS
 * rules reject, which is why this used to run with `webSecurity` off — and with it, every page the
 * renderer or its browser panel loaded could read any other. The engine already allows this origin.
 */
const RENDERER_SCHEME = "oc"
const RENDERER_HOST = "renderer"

protocol.registerSchemesAsPrivileged([
  { scheme: RENDERER_SCHEME, privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } },
])

function rendererRoot() {
  return join(app.getAppPath(), "out", "renderer")
}

function registerRendererProtocol() {
  if (protocol.isProtocolHandled(RENDERER_SCHEME)) return
  protocol.handle(RENDERER_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== RENDERER_HOST) return new Response("Not found", { status: 404 })
    const root = rendererRoot()
    const file = resolve(root, `.${decodeURIComponent(url.pathname)}`)
    const inside = relative(root, file)
    if (inside.startsWith("..") || isAbsolute(inside)) return new Response("Not found", { status: 404 })
    return net.fetch(pathToFileURL(file).toString()).catch(() => new Response("Not found", { status: 404 }))
  })
}

function createWindow() {
  const bounds = loadBounds()
  const credentials = engineCredentials()

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
      preload: join(app.getAppPath(), "out", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The preload reads both of these: the speech bridge is only exposed when the native helper is
      // present, and the credentials let the renderer reach the engine this app password-protected.
      additionalArguments: [
        ...(speechAvailable() ? ["--flupcode-speech"] : []),
        ...(credentials ? [`--flupcode-engine-auth=${credentials}`] : []),
      ],
    },
  })

  window.on("close", () => saveBounds(window.getBounds()))

  const devUrl = process.env.FLUPCODE_DEV_URL
  if (devUrl || !app.isPackaged) {
    void window.loadURL(devUrl ?? DEV_URL)
    return
  }

  void window.loadURL(`${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`)
}

let remote: ReturnType<typeof initRemoteHost> | undefined

app.whenReady().then(async () => {
  registerRendererProtocol()
  setApplicationMenu({ onNewWindow: createWindow, onCheckUpdates: () => void checkForUpdates() })
  initAutoUpdate()
  initSpeech()
  // The engine starts first: it is what decides the password, which both the remote host and the
  // window need in order to reach it.
  await ensureServer()
  remote = initRemoteHost()
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
