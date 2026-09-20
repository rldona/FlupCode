import { BrowserWindow, app, dialog, ipcMain, net, protocol } from "electron"
import { extname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setApplicationMenu } from "./menu"
import { initRemoteHost } from "./remote"
import { engineCredentials, ensureHarnessServer, ensureServer, stopServer } from "./server"
import { initSpeech, speechAvailable, stopSpeech } from "./speech"
import { initAutoUpdate, checkForUpdates } from "./updater"
import { loadBounds, saveBounds } from "./window-state"

const DEV_URL = process.env.FLUPCODE_DEV_URL ?? "http://localhost:4444"

/** Where the page draws the window's top strip itself, controls and all. */
const OWNS_TITLE_BAR = process.platform === "darwin" || process.platform === "win32"

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
    // An address with no extension is a screen, not a file: the renderer is one page and reads the
    // path itself. A missing asset still 404s, so a broken build does not quietly serve the page.
    const target = extname(url.pathname) ? file : resolve(root, "index.html")
    return net.fetch(pathToFileURL(target).toString()).catch(() => new Response("Not found", { status: 404 }))
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
    // No title bar of its own: the app draws the top strip itself, 52px tall, and the window
    // controls float over it. macOS keeps its traffic lights, centred in that strip; Windows draws
    // its own buttons in an overlay whose colours have to be told apart from the page's.
    //
    // Not on Linux. There, hiding the title bar hides the window controls with it and leaves no
    // overlay to replace them: the window could not be closed except through the window manager.
    ...(OWNS_TITLE_BAR ? { titleBarStyle: "hidden" as const } : {}),
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 16, y: 20 } } : {}),
    ...(process.platform === "win32"
      ? { titleBarOverlay: { color: "#00000000", symbolColor: "#ffffff", height: 52 } }
      : {}),
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

  // Windows paints its own window buttons, so it has to be told the colours the page is using.
  // Nothing else can: the palette and the light/dark choice live in the renderer's storage.
  ipcMain.handle("flupcode:title-bar", (event, overlay: { color?: string; symbolColor?: string }) => {
    if (process.platform !== "win32") return
    const target = BrowserWindow.fromWebContents(event.sender)
    if (!target || typeof overlay?.color !== "string" || typeof overlay?.symbolColor !== "string") return
    target.setTitleBarOverlay({ color: overlay.color, symbolColor: overlay.symbolColor, height: 52 })
  })

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
  await ensureHarnessServer()
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
