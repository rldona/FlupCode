import { BrowserWindow, app, dialog, ipcMain, net, protocol, shell } from "electron"
import contextMenu from "electron-context-menu"
import { execFile } from "node:child_process"
import { extname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setApplicationMenu } from "./menu"
import { editorCommand } from "./open-path"
import { isAppPage } from "./renderer-origin"
import { initPreview } from "./preview"
import { initRemoteHost } from "./remote"
import { rendererCsp } from "./renderer-csp"
import {
  childStates,
  copyDiagnostics,
  engineCredentials,
  ensureHarnessServer,
  ensureServer,
  harnessBrowserToken,
  HARNESS_SERVER_URL,
  importOpenCodeV1History,
  ownPorts,
  restartChild,
  stopServer,
  undoOpenCodeV1Import,
} from "./server"
import { initSpeech, speechAvailable, stopSpeech } from "./speech"
import { initAutoUpdate, checkForUpdates } from "./updater"
import { loadWindowStates, saveWindowState } from "./window-state"
import { cascade, DEFAULT_BOUNDS } from "./window-bounds"

const DEV_URL = process.env.FLUPCODE_DEV_URL ?? "http://localhost:4444"

// Electron names the app after the package, so the menu bar and its Hide/Quit items read
// "@flupcode/desktop". The bundle is called FlupCode; the app calls itself that too.
app.setName("FlupCode")

/**
 * One copy per user (TI-17). A second would start its own engine and harness server and fight this
 * one for their ports and locks; instead it quits before starting anything, and this one comes forward.
 */
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()

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
    const response = await net.fetch(pathToFileURL(target).toString()).catch(() => undefined)
    if (!response) return new Response("Not found", { status: 404 })
    // On every file, not just the page: a worker is governed by the policy its own script arrives with.
    const headers = new Headers(response.headers)
    headers.set("content-security-policy", rendererCsp(remote?.relay() ?? ""))
    return new Response(response.body, { status: response.status, headers })
  })
}

/** An http(s) URL as a string, or undefined for anything the OS browser should not be handed. */
const externalHttpUrl = (value: string): string | undefined => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined
}

/** How many windows have been opened, which is also where each one's bounds are remembered. */
let windowsOpened = 0

function createWindow() {
  const index = windowsOpened++
  const states = loadWindowStates()
  // Its own remembered bounds, or the first window's stepped down so they do not stack exactly.
  const bounds = cascade(states[index] ?? states[0] ?? DEFAULT_BOUNDS, index)
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
      // The speech bridge is only exposed when the native helper is present. The credentials are
      // not passed here: a command line is readable by any local process, so the preload asks for
      // them over IPC instead (`flupcode:credentials`, TI-10).
      additionalArguments: [...(speechAvailable() ? ["--flupcode-speech"] : [])],
    },
  })

  window.on("close", () => saveWindowState(index, window.getBounds()))

  // Nothing opens inside the app: the renderer shows its own prompt for a link the reader clicks,
  // and anything the page starts on its own — a middle-click, a `target`, a redirect — is handed to
  // the reader's browser instead of an Electron window. A same-origin navigation is the app itself.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalHttpUrl(url)
    if (external) void shell.openExternal(external)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    const current = externalHttpUrl(window.webContents.getURL())
    const target = externalHttpUrl(url)
    if (current && target && new URL(current).origin === new URL(target).origin) return
    event.preventDefault()
    if (target) void shell.openExternal(target)
  })

  const devUrl = process.env.FLUPCODE_DEV_URL
  if (devUrl || !app.isPackaged) {
    void window.loadURL(devUrl ?? DEV_URL)
    return
  }

  void window.loadURL(`${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`)
}

let remote: ReturnType<typeof initRemoteHost> | undefined
let preview: ReturnType<typeof initPreview> | undefined

app.whenReady().then(async () => {
  if (!primaryInstance) return
  // Native right-click menu for chats and everywhere else: Copy/Cut/Paste plus
  // Copy Image (on by default) and Save Image As. Mirrors packages/desktop.
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })
  registerRendererProtocol()
  setApplicationMenu({
    onNewWindow: createWindow,
    onCheckUpdates: () => void checkForUpdates(),
    onImportV1History: () => void importOpenCodeV1History(),
    onUndoV1Import: () => void undoOpenCodeV1Import(),
    onCopyDiagnostics: () => void copyDiagnostics(),
  })
  initAutoUpdate()
  initSpeech()
  // The harness starts first: the actions plugin reads its token and its profiles from it as the
  // engine loads, and the engine's own startup decides the password both the remote host and the
  // window need. Starting the engine first would leave that plugin with nothing to register.
  await ensureHarnessServer()
  await ensureServer()
  remote = initRemoteHost()
  preview = initPreview({
    harnessUrl: HARNESS_SERVER_URL,
    token: harnessBrowserToken,
    fromAppPage,
    // In development the renderer is a dev server on this machine too; it is the app, not the project.
    ownPorts: () =>
      new Set([...ownPorts(), ...(process.env.FLUPCODE_DEV_URL || !app.isPackaged ? [Number(new URL(DEV_URL).port)] : [])]),
  })
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Launching the app again brings this copy forward: its last window, or a new one where none is open.
app.on("second-instance", () => {
  if (!app.isReady()) return
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return createWindow()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  // macOS does not hand focus to an app that is not active; launching it again is asking for it.
  app.focus({ steal: true })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

// Windows paints its own window buttons, so it has to be told the colours the page is using.
// Nothing else can: the palette and the light/dark choice live in the renderer's storage. Registered
// once for the whole process: a handler is global, so registering it per window throws on the second.
// What the renderer needs to reach the engine this app password-protected and to drive the harness
// browser's live view (WA-6), asked once by the preload. Only the app's own page gets them (TI-10).
ipcMain.on("flupcode:credentials", (event) => {
  const page = event.senderFrame?.url ?? ""
  const devUrl = process.env.FLUPCODE_DEV_URL || !app.isPackaged ? DEV_URL : undefined
  const credentials = engineCredentials()
  event.returnValue = isAppPage(page, devUrl)
    ? { ...(credentials ? { engineAuth: credentials } : {}), browserToken: harnessBrowserToken() }
    : {}
})

/**
 * The engine and the harness as their supervisor sees them (HE-03), for the window's banner, and the
 * two things it offers: start one it gave up on again, and copy the diagnostics. Only the app's own
 * page may ask.
 */
const fromAppPage = (event: Electron.IpcMainInvokeEvent) =>
  isAppPage(event.senderFrame?.url ?? "", process.env.FLUPCODE_DEV_URL || !app.isPackaged ? DEV_URL : undefined)
ipcMain.handle("flupcode:children", (event) => (fromAppPage(event) ? childStates() : []))
ipcMain.handle("flupcode:restart-child", (event, name: unknown) =>
  fromAppPage(event) ? restartChild(name) : undefined,
)
ipcMain.handle("flupcode:copy-diagnostics", (event) => (fromAppPage(event) ? copyDiagnostics() : false))

ipcMain.handle("flupcode:title-bar", (event, overlay: { color?: string; symbolColor?: string }) => {
  if (process.platform !== "win32") return
  const target = BrowserWindow.fromWebContents(event.sender)
  if (!target || typeof overlay?.color !== "string" || typeof overlay?.symbolColor !== "string") return
  target.setTitleBarOverlay({ color: overlay.color, symbolColor: overlay.symbolColor, height: 52 })
})

ipcMain.handle("flupcode:choose-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })
  if (result.canceled || result.filePaths.length === 0) return undefined
  return result.filePaths[0]
})

/**
 * Open a local file: in the system's default app, or in a named editor (H-14).
 *
 * The editor has to be one main knows (`editorCommand`): the page names it, but never the program
 * that runs (TI-17). A refusal or a failure is reported back to the renderer, not thrown into a void.
 */
ipcMain.handle("flupcode:open-path", async (_event, path: unknown, app?: unknown) => {
  if (typeof path !== "string" || !path) return false
  if (typeof app !== "string" || !app) {
    const problem = await shell.openPath(path)
    return problem === ""
  }
  const editor = editorCommand(process.platform, app, path)
  if (!editor) return false
  return await new Promise<boolean>((resolve) => execFile(editor.command, editor.args, (error) => resolve(!error)))
})

/**
 * Open an http(s) link in the reader's default browser.
 *
 * Only those two schemes reach the shell: anything else (`file:`, `javascript:`, a custom protocol)
 * is refused here rather than trusted from the renderer. A failure is reported, not thrown.
 */
ipcMain.handle("flupcode:open-external", async (_event, url: unknown) => {
  if (typeof url !== "string") return false
  const external = externalHttpUrl(url)
  if (!external) return false
  return shell.openExternal(external).then(
    () => true,
    () => false,
  )
})

app.on("before-quit", () => {
  remote?.stop()
  preview?.stop()
  stopSpeech()
  stopServer()
})
