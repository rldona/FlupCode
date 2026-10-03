import { createHash, randomBytes, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Server, ServerWebSocket } from "bun"
import {
  GROUP_TITLE,
  PROTOCOL_VERSION,
  type BridgeRequest,
  type BridgeTab,
  type ExtensionMessage,
  type HarnessMessage,
} from "@flupcode/bridge-extension/protocol"
import {
  BrowserError,
  type BrowserDriver,
  type BrowserErrorCode,
  type BrowserSession,
  type BrowserTab,
  type BrowserTabList,
  type BrowserTabs,
  type TabAction,
} from "./browser-driver"
import { NavigationBlockedError, type EgressGuard } from "./browser-egress"
import { EDITABLE_ROLES, renderSnapshot, type AXNode, type SnapshotRef } from "./browser-snapshot"
import { flupcodeConfigDir, tokenMatches } from "./browser-token"
import { allowedHarnessHost } from "./cors"
import { redactSecrets } from "./redact"
import type { SqliteRoutineRepository } from "./repository"

/**
 * The person's own browser, through FlupCode Bridge (BU-04, audit §9.5 `bridge`).
 *
 * The extension (`packages/bridge-extension`) opens one WebSocket to this server and says `hello`.
 * Pairing is one click in the app: an unpaired browser waits here with a code it also shows in its
 * popup, the person clicks Pair, and the extension gets a token that opens this socket and nothing
 * else (the `bridge` scope: no HTTP route takes it, P7). Paired browsers are kept, as token hashes,
 * in `paired-browsers.json` beside the other tokens, like the paired tabs of HE-01.
 *
 * `BridgeDriver` is a `BrowserDriver` over that socket, for the agent's browser tools (BU-05): the
 * attach client asks `BrowserPolicy.decide` and writes the audit around every command, as it does
 * for the recipe runner's Chromium. The agent only reaches tabs in the browser's "FlupCode" tab
 * group: the extension refuses any other tab, and the attach client only targets tabs this driver
 * listed. The egress guard is this driver's own: a navigation is checked before it starts, and the
 * extension holds every document request of a tab it controls (redirects and frames too) until this
 * server answers.
 *
 * One browser is connected at a time, and it works for one session at a time. When the socket
 * closes, its session ends and the extension detaches the debugger everywhere.
 */
export function createBrowserBridge(input: {
  repository: SqliteRoutineRepository
  egress: EgressGuard
  hostname: string
  dataDir?: string
  file?: string
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const file = input.file ?? pairedBrowsersFile()
  const dataDir = input.dataDir ?? join(flupcodeConfigDir(), "browser")
  const browsers = readBrowsers(file)
  const peers = new Map<string, Peer>()
  const calls = new Map<number, { resolve: (value: unknown) => void; reject: (cause: unknown) => void }>()
  const tabs = new Map<number, TabState>()
  const blocked = new Map<number, { reason: string; url: string }>()
  const state = {
    connection: undefined as Peer | undefined,
    session: undefined as SessionState | undefined,
    nextCall: 1,
  }

  const save = () => writeBrowsers(file, browsers)
  const send = (peer: Peer, message: HarnessMessage) => peer.socket.send(JSON.stringify(message))
  const refuse = (peer: Peer, reason: Extract<HarnessMessage, { type: "refused" }>["reason"]) => {
    send(peer, { type: "refused", reason })
    peer.socket.close(1008, reason)
  }

  /** The browser goes: its session ends (the attach client then takes the tools away), and its calls fail. */
  const disconnect = (peer: Peer) => {
    if (state.connection !== peer) return
    state.connection = undefined
    if (state.session) state.session.view.stopped = true
    state.session = undefined
    tabs.clear()
    blocked.clear()
    calls.forEach((call) => call.reject(unavailable()))
    calls.clear()
  }

  const connect = (peer: Peer, entry: StoredBrowser) => {
    const previous = state.connection
    if (previous && previous !== peer) {
      disconnect(previous)
      refuse(previous, "replaced")
    }
    peer.paired = entry.id
    peer.code = undefined
    state.connection = peer
    send(peer, { type: "welcome", paired: true })
  }

  const hello = (peer: Peer, message: ExtensionMessage) => {
    if (message.type !== "hello" || message.version !== PROTOCOL_VERSION || typeof message.browser !== "string")
      return refuse(peer, "bad_hello")
    peer.browser = message.browser.slice(0, 60) || "Chromium"
    if (typeof message.token === "string") {
      const entry = browsers.find((browser) => tokenMatches(browser.token, digest(message.token!)))
      if (!entry) return refuse(peer, "not_paired")
      entry.lastSeen = now()
      save()
      return connect(peer, entry)
    }
    // A handful of browsers may wait at once; the oldest makes room.
    const waiting = [...peers.values()].filter((other) => other.code)
    waiting.slice(0, Math.max(0, waiting.length - (PENDING_KEPT - 1))).forEach((other) => other.socket.close(1008))
    peer.code = pairingCode()
    send(peer, { type: "welcome", paired: false, code: peer.code })
  }

  const receive = async (peer: Peer, message: ExtensionMessage) => {
    peer.lastSeen = now()
    if (!peer.browser) return hello(peer, message)
    if (message.type === "ping") return send(peer, { type: "pong" })
    // Only the connected browser drives anything; a browser waiting to pair is only listened to for pings.
    if (state.connection !== peer) return
    if (message.type === "result" || message.type === "error") {
      const call = calls.get(message.id)
      calls.delete(message.id)
      if (message.type === "result") return call?.resolve(message.result)
      return call?.reject(refusalOf(message.code, message.message))
    }
    if (message.type === "egress") {
      const verdict = await input.egress.assertNavigable(message.url).then(
        () => undefined,
        (cause: unknown) => (cause instanceof NavigationBlockedError ? cause.reason : "That address is not allowed"),
      )
      if (verdict) blocked.set(message.tabId, { reason: verdict, url: message.url })
      return send(peer, { type: "egress", request: message.request, allowed: verdict === undefined })
    }
    if (message.type === "navigated") {
      const tab = tabs.get(message.tabId)
      if (tab) {
        tab.generation += 1
        tab.refs = new Map()
      }
      return
    }
    // The person took the browser back: the session ends, and the agent loses its tools with it.
    if (message.type === "takeback" && state.session) {
      state.session.view.stopped = true
      state.session = undefined
    }
  }

  const call = <T>(method: BridgeRequest["method"], params: Record<string, unknown> = {}, timeoutMs = 40_000) => {
    const peer = state.connection
    if (!peer) return Promise.reject(unavailable())
    const id = state.nextCall++
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const timer = setTimeout(() => {
      calls.delete(id)
      reject(new BrowserError("action_failed", 504, `Your browser did not answer ${method} in time`))
    }, timeoutMs)
    calls.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value as T)
      },
      reject: (cause) => {
        clearTimeout(timer)
        reject(cause)
      },
    })
    send(peer, { type: "request", id, method, params })
    return promise
  }

  const cdp = <T>(tabId: number, method: string, params: Record<string, unknown> = {}) =>
    call<T>("cdp", { tabId, method, params })

  const requireSession = (id: string) => {
    const session = state.session
    if (!session || session.view.id !== id || !state.connection)
      throw new BrowserError("no_session", 404, "No browser session is open")
    session.view.lastUsedAt = now()
    return session
  }

  const tabOf = (tabId: number) => {
    const known = tabs.get(tabId)
    if (known) return known
    const tab: TabState = { id: `tab_${randomUUID()}`, tabId, generation: 0, refs: new Map() }
    tabs.set(tabId, tab)
    return tab
  }

  /** A tab by the id the agent named; the extension still checks that it is in the group. */
  const requireTab = (session: SessionState, id: string) => {
    const tab = [...tabs.values()].find((entry) => entry.id === id)
    if (!tab)
      throw new BrowserError(
        "tab_unavailable",
        404,
        "This tab is closed or is not one of this browser's tabs. Call browser.tabs.list({}) and use a tabID from it.",
      )
    session.focused = tab.tabId
    return tab
  }

  /** What the agent is told about a tab, redacted like every view, and remembered as the session's page. */
  const describe = (session: SessionState, tab: BridgeTab): BrowserTab => {
    const known = tabOf(tab.tabId)
    const view: BrowserTab = {
      id: known.id,
      url: redactSecrets(tab.url, [...session.secrets]),
      title: redactSecrets(tab.title, [...session.secrets]),
      loading: tab.loading,
      canGoBack: tab.canGoBack ?? false,
      canGoForward: tab.canGoForward ?? false,
      generation: known.generation,
    }
    if (session.focused === tab.tabId) {
      session.view.url = view.url
      session.view.title = view.title
    }
    return view
  }

  const listed = async () => (await call<{ tabs: BridgeTab[] }>("tabs.list")).tabs

  const current = async (session: SessionState, tab: TabState) => {
    const found = (await listed()).find((entry) => entry.tabId === tab.tabId)
    if (!found) throw refusalOf("out_of_scope", "That tab left the FlupCode tab group, so the agent cannot reach it")
    return describe(session, found)
  }

  const wait = async (session: SessionState, tab: TabState, settleMs?: number) =>
    describe(session, await call<BridgeTab>("tabs.wait", { tabId: tab.tabId, ...(settleMs ? { settleMs } : {}) }))

  const navigate = async (tab: TabState, url: string) => {
    if (url !== "about:blank") await input.egress.assertNavigable(url)
    blocked.delete(tab.tabId)
    const result = await cdp<{ errorText?: string }>(tab.tabId, "Page.navigate", { url })
    tab.generation += 1
    tab.refs = new Map()
    if (!result.errorText) return
    const refused = blocked.get(tab.tabId)
    if (refused) throw new NavigationBlockedError(refused.reason, refused.url)
    throw new BrowserError("action_failed", 422, result.errorText)
  }

  const history = async (tab: TabState, step: -1 | 1) => {
    const entries = await cdp<{ currentIndex: number; entries: Array<{ id: number }> }>(tab.tabId, "Page.getNavigationHistory")
    const entry = entries.entries[entries.currentIndex + step]
    if (!entry) throw new BrowserError("action_failed", 422, step < 0 ? "There is no page to go back to" : "There is no page to go forward to")
    await cdp(tab.tabId, "Page.navigateToHistoryEntry", { entryId: entry.id })
  }

  const refOf = (tab: TabState, ref: string) => {
    const known = tab.refs.get(ref.replace(/^@/, ""))
    if (!known)
      throw new BrowserError(
        "stale_ref",
        409,
        `${ref} is not a ref of this tab's latest snapshot: refs expire with the next snapshot and on navigation. Call browser.snapshot and use a ref from it.`,
      )
    return known
  }

  const gone = (ref: string) => () => {
    throw new BrowserError("stale_ref", 409, `${ref} is no longer on the page. Call browser.snapshot again.`)
  }

  /** Where to click an element: the middle of its first box, scrolled into view. */
  const pointOf = async (tab: TabState, ref: string) => {
    const node = refOf(tab, ref)
    await cdp(tab.tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId }).catch(gone(ref))
    const quads = await cdp<{ quads: number[][] }>(tab.tabId, "DOM.getContentQuads", {
      backendNodeId: node.backendNodeId,
    }).catch(gone(ref))
    const quad = quads.quads[0]
    if (!quad) throw new BrowserError("action_failed", 422, `${ref} has nothing visible to click`)
    return { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 }
  }

  const press = async (tab: TabState, key: string) => {
    const parts = key.split("+")
    const name = parts.at(-1) ?? ""
    const modifiers = parts.slice(0, -1).reduce((sum, part) => sum | (MODIFIERS[part] ?? 0), 0)
    const known = KEYS[name] ?? (name.length === 1 ? { code: 0, text: name } : undefined)
    if (!known) throw new BrowserError("action_failed", 422, `Unknown key ${key}`)
    const text = modifiers & ~8 ? undefined : known.text
    const base = { key: name, windowsVirtualKeyCode: known.code || name.toUpperCase().charCodeAt(0), modifiers }
    await cdp(tab.tabId, "Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text } : {}) })
    await cdp(tab.tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" })
  }

  /** One input in a tab, by CDP input events through the extension. */
  const inTab = async (session: SessionState, tab: TabState, action: TabAction) => {
    if (action.kind === "navigate") {
      await navigate(tab, action.url)
      return wait(session, tab)
    }
    if (action.kind === "back" || action.kind === "forward") {
      await history(tab, action.kind === "back" ? -1 : 1)
      return wait(session, tab, 100)
    }
    if (action.kind === "reload") {
      await cdp(tab.tabId, "Page.reload")
      return wait(session, tab, 100)
    }
    if (action.kind === "click") {
      const point = await pointOf(tab, action.ref)
      const button = action.button ?? "left"
      const clickCount = action.count ?? 1
      await cdp(tab.tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
      await cdp(tab.tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button, clickCount })
      await cdp(tab.tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button, clickCount })
      return wait(session, tab, 300)
    }
    if (action.kind === "type") {
      const node = refOf(tab, action.ref)
      if (!EDITABLE_ROLES.has(node.role))
        throw new BrowserError("not_editable", 422, `${action.ref} is a ${node.role}, not a field to type into`)
      await cdp(tab.tabId, "DOM.focus", { backendNodeId: node.backendNodeId }).catch(gone(action.ref))
      // Replaces what the field held, as the engine's `fill` promises.
      const selectAll = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, commands: ["selectAll"] }
      await cdp(tab.tabId, "Input.dispatchKeyEvent", { ...selectAll, type: "rawKeyDown" })
      await cdp(tab.tabId, "Input.dispatchKeyEvent", { ...selectAll, type: "keyUp" })
      if (action.text) await cdp(tab.tabId, "Input.insertText", { text: action.text })
      if (!action.text) await press(tab, "Delete")
      return current(session, tab)
    }
    if (action.kind === "key") {
      await press(tab, action.key)
      return wait(session, tab, 300)
    }
    const metrics = await cdp<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(
      tab.tabId,
      "Page.getLayoutMetrics",
    )
    await cdp(tab.tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: metrics.cssLayoutViewport.clientWidth / 2,
      y: metrics.cssLayoutViewport.clientHeight / 2,
      deltaX: action.deltaX ?? 0,
      deltaY: action.deltaY,
    })
    return current(session, tab)
  }

  const capture = async (session: SessionState, tab: TabState, store: boolean) => {
    const shot = await cdp<{ data: string }>(tab.tabId, "Page.captureScreenshot", { format: "png" })
    const bytes = new Uint8Array(Buffer.from(shot.data, "base64"))
    const described = await current(session, tab)
    if (!store) return { bytes, tab: described }
    const relative = join("frames", session.view.id, `${randomUUID()}.png`)
    mkdirSync(dirname(join(dataDir, relative)), { recursive: true })
    writeFileSync(join(dataDir, relative), bytes)
    const artifact = input.repository.addArtifact({
      kind: "screenshot",
      title: described.title || "Browser screenshot",
      mime: "image/png",
      producer: "harness",
      path: relative,
      directory: dataDir,
      ...(session.sessionID ? { sessionID: session.sessionID } : {}),
    })
    return { bytes, tab: described, artifactId: artifact.id, path: join(dataDir, relative) }
  }

  const listTabs = async (session: SessionState): Promise<BrowserTabList> => {
    const found = await listed()
    const views = found.map((tab) => describe(session, tab))
    const focused = found.find((tab) => tab.tabId === session.focused) ?? found.find((tab) => tab.active) ?? found[0]
    return { tabs: views, focusedTabID: focused ? tabOf(focused.tabId).id : null }
  }

  const bridgeTabs: BrowserTabs = {
    list: async (id) => listTabs(requireSession(id)),
    open: async (id, url) => {
      const session = requireSession(id)
      const opened = tabOf((await call<BridgeTab>("tabs.open")).tabId)
      session.focused = opened.tabId
      if (url && url !== "about:blank") return inTab(session, opened, { kind: "navigate", url })
      return current(session, opened)
    },
    focus: async (id, tabID) => {
      const session = requireSession(id)
      return describe(session, await call<BridgeTab>("tabs.focus", { tabId: requireTab(session, tabID).tabId }))
    },
    close: async (id, tabID) => {
      const session = requireSession(id)
      const tab = requireTab(session, tabID)
      await call("tabs.close", { tabId: tab.tabId })
      tabs.delete(tab.tabId)
      session.focused = undefined
      return listTabs(session)
    },
    snapshot: async (id, tabID, options) => {
      const session = requireSession(id)
      const tab = requireTab(session, tabID)
      const tree = await cdp<{ nodes: AXNode[] }>(tab.tabId, "Accessibility.getFullAXTree")
      const rendered = renderSnapshot(tree.nodes, {
        limit: MAX_SNAPSHOT,
        redact: (text) => redactSecrets(text, [...session.secrets]),
        ...(options?.find ? { find: options.find } : {}),
      })
      tab.refs = rendered.refs
      return { tab: await current(session, tab), content: rendered.content, truncated: rendered.truncated }
    },
    act: async (id, tabID, action) => {
      const session = requireSession(id)
      return inTab(session, requireTab(session, tabID), action)
    },
    screenshot: async (id, tabID) => {
      const session = requireSession(id)
      const shot = await capture(session, requireTab(session, tabID), true)
      return { tab: shot.tab, artifactId: shot.artifactId!, path: shot.path!, bytes: shot.bytes.byteLength }
    },
  }

  const recipeRefused = () =>
    Promise.reject(
      new BrowserError("action_failed", 422, "Your browser runs the agent's browser tools, not web actions"),
    )

  const driver: BrowserDriver & { tabs: BrowserTabs } = {
    // Web actions keep the recipe runner's own browser: none of their steps run here.
    capabilities: { actions: new Set() },
    async open(request) {
      if (!state.connection) throw unavailable()
      if (state.session && state.session.view.id !== request.id)
        throw new BrowserError("browser_busy", 409, "Your browser is already working for another session")
      if (state.session) return state.session.view
      const at = now()
      state.session = {
        view: {
          id: request.id,
          project: request.project,
          headed: true,
          createdAt: at,
          lastUsedAt: at,
          idleTimeoutMs: 0,
          url: "",
          title: "",
          paused: false,
          stopped: false,
        },
        secrets: new Set(),
        focused: undefined,
        ...(request.sessionID ? { sessionID: request.sessionID } : {}),
      }
      return state.session.view
    },
    get: (id) => (state.connection && state.session?.view.id === id ? state.session.view : undefined),
    act: recipeRefused,
    snapshot: recipeRefused,
    async screenshot(id, options) {
      const session = requireSession(id)
      const focused = session.focused === undefined ? undefined : tabs.get(session.focused)
      if (!focused) throw new BrowserError("tab_unavailable", 404, "The agent has no tab open in your browser")
      const shot = await capture(session, focused, options?.store !== false)
      return { bytes: shot.bytes, ...(shot.artifactId ? { artifactId: shot.artifactId } : {}) }
    },
    async close(id) {
      if (state.session?.view.id !== id) return false
      state.session = undefined
      // The tabs stay where they are; the debugger lets go of them.
      await call("release").catch(() => undefined)
      return true
    },
    protect(id, request) {
      if (state.session?.view.id === id && request.value) state.session.secrets.add(request.value)
    },
    beginRun: () => undefined,
    endRun: async () => undefined,
    waitIfPaused: async () => undefined,
    tabs: bridgeTabs,
  }

  // A silent socket is a gone browser: the extension pings every 20 seconds while it is connected.
  const sweep = setInterval(() => {
    const at = now()
    peers.forEach((peer) => {
      if (at - peer.lastSeen > SILENT_MS || (peer.code && at - peer.openedAt > PENDING_MS)) peer.socket.close(1001)
    })
  }, 15_000)

  return {
    driver,

    /** The extension's socket: from a loopback host, from FlupCode Bridge itself, and nothing else. */
    socket(request: Request, server: Server<SocketData>) {
      if (!allowedHarnessHost(request.headers.get("host") ?? undefined, input.hostname))
        return new Response("Forbidden", { status: 403 })
      if (!BRIDGE_EXTENSION_ORIGINS.has(request.headers.get("origin") ?? ""))
        return new Response("Forbidden", { status: 403 })
      return server.upgrade(request, { data: { id: randomUUID() } })
        ? undefined
        : new Response("Expected a WebSocket", { status: 400 })
    },

    websocket: {
      open(socket: ServerWebSocket<SocketData>) {
        const at = now()
        peers.set(socket.data.id, { id: socket.data.id, socket, browser: "", openedAt: at, lastSeen: at })
        // The extension says hello at once; a socket that does not is not the extension.
        setTimeout(() => {
          const peer = peers.get(socket.data.id)
          if (peer && !peer.browser) socket.close(1008)
        }, HELLO_MS)
      },
      message(socket: ServerWebSocket<SocketData>, data: string | Buffer) {
        const peer = peers.get(socket.data.id)
        const message = parseMessage(String(data))
        if (!peer || !message) return socket.close(1003)
        void receive(peer, message)
      },
      close(socket: ServerWebSocket<SocketData>) {
        const peer = peers.get(socket.data.id)
        peers.delete(socket.data.id)
        if (peer) disconnect(peer)
      },
    },

    /** What the app shows: the browser connected now, the ones waiting to pair, the ones paired. */
    status() {
      const connection = state.connection
      return {
        connected: connection ? { id: connection.paired!, browser: connection.browser } : null,
        waiting: [...peers.values()].flatMap((peer) =>
          peer.code ? [{ id: peer.id, browser: peer.browser, code: peer.code }] : [],
        ),
        paired: browsers.map((browser) => ({
          id: browser.id,
          browser: browser.browser,
          created: browser.created,
          lastSeen: browser.lastSeen,
        })),
        sessionID: state.session?.view.id ?? null,
        group: GROUP_TITLE,
      }
    },

    /** The one click in the app: the waiting browser gets its token and is connected. */
    pair(id: string) {
      const peer = peers.get(id)
      if (!peer?.code) return undefined
      const token = randomBytes(32).toString("base64url")
      const at = now()
      const entry: StoredBrowser = { id: randomUUID(), browser: peer.browser, token: digest(token), created: at, lastSeen: at }
      browsers.push(entry)
      save()
      send(peer, { type: "paired", token })
      connect(peer, entry)
      return { id: entry.id, browser: entry.browser, created: entry.created, lastSeen: entry.lastSeen }
    },

    /** Forgets a paired browser; connected, it is told so and let go. */
    forget(id: string) {
      const index = browsers.findIndex((browser) => browser.id === id)
      if (index < 0) return false
      browsers.splice(index, 1)
      save()
      const peer = state.connection
      if (peer?.paired === id) {
        disconnect(peer)
        refuse(peer, "not_paired")
      }
      return true
    },

    stop() {
      clearInterval(sweep)
      peers.forEach((peer) => {
        disconnect(peer)
        peer.socket.close(1001)
      })
    },
  }
}

export type BrowserBridge = ReturnType<typeof createBrowserBridge>

/**
 * The extensions allowed to open the socket, by id. FlupCode Bridge's id comes from the public `key`
 * in its manifest (`browser-bridge.test.ts` checks they agree). A store build gets the store's id,
 * which is added here when it exists (packages/bridge-extension/README.md).
 */
export const BRIDGE_EXTENSION_IDS = ["hchmfbnibhoapbmbdjpkifleoobpbkme"] as const

const BRIDGE_EXTENSION_ORIGINS: ReadonlySet<string> = new Set(BRIDGE_EXTENSION_IDS.map((id) => `chrome-extension://${id}`))

export function pairedBrowsersFile(dir: string = flupcodeConfigDir()) {
  return join(dir, "paired-browsers.json")
}

type SocketData = { id: string }

type Peer = {
  id: string
  socket: ServerWebSocket<SocketData>
  /** Set by `hello`; empty until then. */
  browser: string
  openedAt: number
  lastSeen: number
  /** The code shown while it waits to pair. */
  code?: string
  /** The paired browser this connection is. */
  paired?: string
}

type StoredBrowser = { id: string; browser: string; token: string; created: number; lastSeen: number }

type SessionState = {
  view: BrowserSession
  secrets: Set<string>
  /** The Chrome tab the agent acted on last: the session's page. */
  focused: number | undefined
  sessionID?: string
}

/** A tab of the group as the engine knows it, by its own id, with the refs of its latest snapshot. */
type TabState = { id: string; tabId: number; generation: number; refs: Map<string, SnapshotRef> }

const MAX_SNAPSHOT = 60_000
const HELLO_MS = 5_000
const SILENT_MS = 60_000
const PENDING_MS = 10 * 60_000
const PENDING_KEPT = 3
// No 0/O, 1/I/L: the code is compared by eye between the app and the popup.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

const KEYS: Record<string, { code: number; text?: string }> = {
  Enter: { code: 13, text: "\r" },
  Tab: { code: 9 },
  Escape: { code: 27 },
  Backspace: { code: 8 },
  Delete: { code: 46 },
  ArrowLeft: { code: 37 },
  ArrowUp: { code: 38 },
  ArrowRight: { code: 39 },
  ArrowDown: { code: 40 },
  Home: { code: 36 },
  End: { code: 35 },
  PageUp: { code: 33 },
  PageDown: { code: 34 },
  Space: { code: 32, text: " " },
}

const REFUSALS: ReadonlySet<BrowserErrorCode> = new Set(["out_of_scope", "navigation_blocked", "tab_unavailable"])

/** The extension's refusal as a driver error: out of scope is a 403, like every scope refusal. */
function refusalOf(code: string, message: string) {
  if (code === "navigation_blocked") return new NavigationBlockedError(message)
  const known = REFUSALS.has(code as BrowserErrorCode) ? (code as BrowserErrorCode) : "action_failed"
  return new BrowserError(known, known === "out_of_scope" ? 403 : 422, message)
}

const unavailable = () =>
  new BrowserError(
    "browser_unavailable",
    409,
    "Your browser is not connected to FlupCode. Open it and check that FlupCode Bridge is on.",
  )

const digest = (token: string) => createHash("sha256").update(token).digest("hex")

const pairingCode = () => {
  const code = Array.from(randomBytes(8), (byte) => ALPHABET[byte % ALPHABET.length]).join("")
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

function parseMessage(text: string): ExtensionMessage | undefined {
  const value = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  })()
  return value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
    ? (value as ExtensionMessage)
    : undefined
}

/** A file that cannot be read pairs nothing: every browser pairs again, and the server still starts. */
function readBrowsers(file: string): StoredBrowser[] {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { browsers?: StoredBrowser[] }
    return Array.isArray(parsed.browsers) ? parsed.browsers : []
  } catch {
    return []
  }
}

function writeBrowsers(file: string, browsers: StoredBrowser[]) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  // Written aside and moved, so a crash never leaves half a file that would unpair every browser.
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ browsers }, null, 2), { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}
