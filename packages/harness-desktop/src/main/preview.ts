import { BrowserWindow, WebContentsView, ipcMain, type IpcMainInvokeEvent } from "electron"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { addressOf, isLoopbackHost, previewVerdict } from "./preview-origin"
import { listDevServers, titleOf } from "./preview-ports"

/**
 * The preview (BU-06): the project's dev server in a `WebContentsView` next to the app's panels.
 *
 * It is not the reader's browser and says so: its own partition (`persist:flupcode-preview`, so
 * cookies of a dev login survive a restart and nothing is shared with the app or with Chrome), no
 * preload, sandboxed, no permissions, no downloads, no windows of its own. It goes to pages on this
 * machine by itself; any other origin only after the harness server's browser policy allowed it
 * (`allow`), and a page that links or redirects elsewhere is stopped and reported to the app, which
 * asks the policy (`preview-origin.ts`). Coming back to a page on this machine forgets those origins.
 *
 * Two sides drive it:
 * - the app's page, over IPC: where the panel is, the address bar, back and forward, a picture for
 *   annotating, and the servers listening on this machine for the empty state;
 * - the harness server, over a WebSocket this process opens with the UI's token, which is how the
 *   agent and a verify task reach it under the server's policy and audit: its state, navigating, a
 *   capture, and a fixed list of CDP methods sent through `webContents.debugger`.
 *
 * One view for the app: the window whose panel shows it last holds it.
 */
export function initPreview(input: {
  harnessUrl: string
  token: () => string | undefined
  fromAppPage: (event: IpcMainInvokeEvent) => boolean
  /** FlupCode's own ports, never listed as a server of the project. */
  ownPorts: () => Set<number>
}) {
  const allowed = new Set<string>()
  const preview = { view: undefined as WebContentsView | undefined, owner: undefined as BrowserWindow | undefined }
  const link = { socket: undefined as WebSocket | undefined, stopped: false, retry: 1000 }

  const view = () => preview.view ?? create()

  const create = () => {
    const created = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        safeDialogs: true,
      },
    })
    created.setBackgroundColor("#ffffff")
    // Until a panel places it, it has a size of its own, so the server can capture it unseen.
    created.setBounds({ x: 0, y: 0, ...UNSEEN })
    const contents = created.webContents
    const session = contents.session
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.setPermissionCheckHandler(() => false)
    session.on("will-download", (event) => event.preventDefault())
    contents.setWindowOpenHandler((details) => {
      // No windows: a link meant for one opens here, under the same rule as any other.
      if (previewVerdict(details.url, allowed) === "allow") void contents.loadURL(details.url).catch(() => undefined)
      else blocked(details.url)
      return { action: "deny" }
    })
    contents.on("will-navigate", (event) => {
      if (previewVerdict(event.url, allowed) === "allow") return
      event.preventDefault()
      blocked(event.url)
    })
    contents.on("will-redirect", (event) => {
      if (!event.isMainFrame || previewVerdict(event.url, allowed) === "allow") return
      event.preventDefault()
      blocked(event.url)
    })
    contents.on("did-navigate", (_event, url) => {
      // Back on this machine: the sites allowed for the trip away are asked again next time.
      if (URL.canParse(url) && isLoopbackHost(new URL(url).hostname)) allowed.clear()
      tell({ event: "navigated" })
      changed()
    })
    contents.on("did-navigate-in-page", changed)
    contents.on("page-title-updated", changed)
    contents.on("did-start-loading", changed)
    contents.on("did-stop-loading", changed)
    contents.on("render-process-gone", changed)
    preview.view = created
    return created
  }

  const state = () => {
    const contents = preview.view?.webContents
    if (!contents || contents.isDestroyed())
      return { url: "", title: "", loading: false, canGoBack: false, canGoForward: false }
    const url = contents.getURL()
    return {
      url,
      // A page with no title of its own is called by its address; that is not a title.
      title: contents.getTitle() === url ? "" : contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    }
  }

  const changed = () => {
    const current = state()
    tell({ event: "state", state: current })
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("flupcode:preview-changed", current))
  }

  const blocked = (url: string) =>
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("flupcode:preview-blocked", url))

  /** Goes to `url` when the rule allows it, and waits for the page; anything else is refused here. */
  const go = async (url: string) => {
    if (previewVerdict(url, allowed) !== "allow")
      throw new PreviewError("navigation_blocked", "The preview was not allowed to open that site")
    await view()
      .webContents.loadURL(url)
      .catch((cause: unknown) => {
        // A navigation the page replaced on its way (a redirect inside the app) is not a failure.
        if (cause instanceof Error && /ERR_ABORTED/.test(cause.message)) return
        throw new PreviewError("action_failed", cause instanceof Error ? cause.message : String(cause))
      })
    return state()
  }

  const settle = (move: () => void) =>
    new Promise<ReturnType<typeof state>>((resolve) => {
      const contents = view().webContents
      const done = () => {
        clearTimeout(timer)
        resolve(state())
      }
      const timer = setTimeout(() => {
        contents.off("did-stop-loading", done)
        resolve(state())
      }, 15_000)
      contents.once("did-stop-loading", done)
      move()
    })

  const capture = async () => {
    const image = await view().webContents.capturePage(undefined, { stayHidden: true })
    return image.toPNG()
  }

  const cdp = async (method: string, params: Record<string, unknown>) => {
    if (!CDP_METHODS.has(method)) throw new PreviewError("action_failed", `The preview does not send ${method}`)
    const debug = view().webContents.debugger
    if (!debug.isAttached()) debug.attach("1.3")
    return debug.sendCommand(method, params)
  }

  /** One command from the harness server. */
  const command = async (method: string, params: Record<string, unknown>) => {
    if (method === "state") return state()
    if (method === "navigate") return go(String(params.url ?? ""))
    if (method === "back") return settle(() => view().webContents.navigationHistory.goBack())
    if (method === "forward") return settle(() => view().webContents.navigationHistory.goForward())
    if (method === "reload") return settle(() => view().webContents.reload())
    if (method === "allow") {
      const origin = String(params.origin ?? "")
      if (!URL.canParse(origin) || !/^https?:$/.test(new URL(origin).protocol))
        throw new PreviewError("action_failed", "Not a web origin")
      allowed.add(new URL(origin).origin)
      return true
    }
    if (method === "capture") return { png: (await capture()).toString("base64") }
    if (method === "cdp") return cdp(String(params.method ?? ""), (params.params ?? {}) as Record<string, unknown>)
    throw new PreviewError("action_failed", `Unknown command ${method}`)
  }

  const tell = (message: unknown) => {
    if (link.socket?.readyState === WebSocket.OPEN) link.socket.send(JSON.stringify(message))
  }

  /** Holds the connection to the harness server open for as long as the app runs. */
  const connect = () => {
    if (link.stopped) return
    const token = input.token()
    if (!token) return void setTimeout(connect, link.retry)
    const socket = new WebSocket(`${input.harnessUrl.replace(/^http/, "ws").replace(/\/$/, "")}/harness/preview/host`, [
      PROTOCOL,
      `token.${token}`,
    ])
    link.socket = socket
    socket.onopen = () => {
      link.retry = 1000
      tell({ event: "state", state: state() })
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: Record<string, unknown> }
      if (typeof message.id !== "number") return
      void command(String(message.method ?? ""), message.params ?? {}).then(
        (result) => socket.send(JSON.stringify({ id: message.id, result })),
        (cause: unknown) =>
          socket.send(
            JSON.stringify({
              id: message.id,
              error: {
                code: cause instanceof PreviewError ? cause.code : "action_failed",
                message: cause instanceof Error ? cause.message : String(cause),
              },
            }),
          ),
      )
    }
    socket.onclose = () => {
      if (link.socket === socket) link.socket = undefined
      if (link.stopped) return
      // The harness restarts under its supervisor (HE-03); the preview follows it back.
      setTimeout(connect, link.retry)
      link.retry = Math.min(link.retry * 2, 30_000)
    }
    socket.onerror = () => undefined
  }

  const place = (window: BrowserWindow, bounds: { x: number; y: number; width: number; height: number }) => {
    const shown = view()
    if (preview.owner !== window) {
      if (preview.owner && !preview.owner.isDestroyed()) preview.owner.contentView.removeChildView(shown)
      window.contentView.addChildView(shown)
      preview.owner = window
      window.once("closed", () => {
        if (preview.owner === window) preview.owner = undefined
      })
    }
    // The panel measures itself in the page's pixels; the window may be zoomed.
    const zoom = window.webContents.getZoomFactor()
    shown.setBounds({
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.max(1, Math.round(bounds.width * zoom)),
      height: Math.max(1, Math.round(bounds.height * zoom)),
    })
    shown.setVisible(true)
  }

  ipcMain.handle("flupcode:preview-show", (event, bounds: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!input.fromAppPage(event) || !window || !isBounds(bounds)) return false
    place(window, bounds)
    return true
  })
  ipcMain.handle("flupcode:preview-hide", (event) => {
    if (!input.fromAppPage(event)) return
    // Hidden where it is: a page that is loading keeps loading, ready for the panel to come back.
    preview.view?.setVisible(false)
  })
  ipcMain.handle("flupcode:preview-state", (event) => (input.fromAppPage(event) ? state() : undefined))
  // What the address bar says, read as an address: `:5173` and `localhost:3000` are pages here.
  ipcMain.handle("flupcode:preview-open", (event, text: unknown) => {
    if (!input.fromAppPage(event) || typeof text !== "string") return { verdict: "refuse", url: "" }
    const url = addressOf(text)
    const verdict = previewVerdict(url, allowed)
    // The app asks the server for anything off this machine; main opens only what the rule allows.
    if (verdict === "allow") void go(url).catch(() => changed())
    return { verdict, url }
  })
  ipcMain.handle("flupcode:preview-history", (event, move: unknown) => {
    if (!input.fromAppPage(event)) return
    const contents = view().webContents
    if (move === "back") contents.navigationHistory.goBack()
    if (move === "forward") contents.navigationHistory.goForward()
    if (move === "reload") contents.reload()
    if (move === "stop") contents.stop()
    if (move === "close") void contents.loadURL("about:blank").catch(() => undefined)
  })
  ipcMain.handle("flupcode:preview-capture", async (event) => {
    if (!input.fromAppPage(event) || !preview.view) return undefined
    return `data:image/png;base64,${(await capture()).toString("base64")}`
  })
  ipcMain.handle("flupcode:preview-servers", (event, directory: unknown) => {
    if (!input.fromAppPage(event)) return []
    return listDevServers({
      platform: process.platform,
      run: (command, args) =>
        new Promise((resolve) =>
          execFile(command, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) =>
            resolve(error && !stdout ? undefined : stdout),
          ),
        ),
      readText: (path) => readFile(path, "utf8").catch(() => undefined),
      probe,
      exclude: input.ownPorts(),
      ...(typeof directory === "string" && directory ? { directory } : {}),
    })
  })

  connect()

  return {
    stop() {
      link.stopped = true
      link.socket?.close()
      const contents = preview.view?.webContents
      if (contents && !contents.isDestroyed()) contents.close()
    },
  }
}

const PARTITION = "persist:flupcode-preview"
const PROTOCOL = "flupcode-preview"
const UNSEEN = { width: 1280, height: 800 }

/**
 * What the harness server may send through the debugger: reading the accessibility tree and an
 * element's box, focusing it, input events, the viewport's size, the history. Nothing that runs
 * script in the page or reads its storage.
 */
const CDP_METHODS = new Set([
  "Accessibility.getFullAXTree",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.getContentQuads",
  "DOM.focus",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
])

class PreviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const isBounds = (value: unknown): value is { x: number; y: number; width: number; height: number } => {
  const record = value as Record<string, unknown> | null
  return (
    !!record &&
    ["x", "y", "width", "height"].every((key) => typeof record[key] === "number" && Number.isFinite(record[key]))
  )
}

/** Whether a port answers HTTP, and the title of what it serves: one request to this machine. */
async function probe(port: number) {
  const response = await fetch(`http://localhost:${port}/`, {
    signal: AbortSignal.timeout(1500),
    redirect: "manual",
  }).catch(() => undefined)
  if (!response) return undefined
  if (!(response.headers.get("content-type") ?? "").includes("html")) {
    await response.body?.cancel().catch(() => undefined)
    return {}
  }
  const reader = response.body?.getReader()
  const chunk = reader ? await reader.read().catch(() => undefined) : undefined
  await reader?.cancel().catch(() => undefined)
  const title = chunk?.value ? titleOf(new TextDecoder().decode(chunk.value.slice(0, 64 * 1024))) : undefined
  return title ? { title } : {}
}
