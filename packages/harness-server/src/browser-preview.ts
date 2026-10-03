import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  BrowserError,
  type BrowserAction,
  type BrowserDriver,
  type BrowserSession,
  type BrowserTab,
  type BrowserTabs,
  type TabAction,
} from "./browser-driver"
import { NavigationBlockedError, createEgressGuard, type EgressGuard } from "./browser-egress"
import { EDITABLE_ROLES, renderSnapshot, type AXNode, type SnapshotRef } from "./browser-snapshot"
import { originOf, type BrowserPolicy, type DecideInput } from "./browser-policy"
import { flupcodeConfigDir, tokenMatches } from "./browser-token"
import { redactSecrets } from "./redact"
import type { SqliteRoutineRepository } from "./repository"
import { previewTarget } from "./verify"
import { DEFAULT_STEP_TIMEOUT_MS } from "./actions"

/**
 * The desktop app's preview as a browser driver (BU-06, audit §9.5).
 *
 * The page lives in the desktop app: a `WebContentsView` with its own partition, next to the
 * project's panels, that the person and the agent both look at. What drives it lives here. The
 * desktop's main process opens a WebSocket to this server (`/harness/preview/host`, with the UI's
 * token) and answers a small set of commands on that view: its state, navigating, a capture, and the
 * few CDP methods its `webContents.debugger` is allowed to send (the accessibility tree, element
 * boxes, input). So the policy and the audit stay above the driver, in the server, like every other
 * driver (P7): the attach client asks `BrowserPolicy.decide` before each of the agent's commands, the
 * preview routes ask it before the person opens a site that is not on this machine, and a `verify`
 * task asks it before it captures the project's page.
 *
 * **Where it may go.** A page on this machine (loopback) opens as it is: the preview is for the
 * project's dev server. Any other web address has been allowed by the policy before the driver is
 * asked, and is still held to the egress guard (no private network, no metadata endpoint); the
 * driver then tells main the origin may load, and main refuses every origin it was not told about,
 * so a page cannot redirect or link the preview away (the view's own guard, `preview-origin.ts`).
 *
 * One page and one tab: no tabs of its own, no history beyond back and forward. A
 * session here is whoever drives it (the agent's session, a verify task), never the page itself:
 * closing one leaves the preview where the person can see it.
 */
export function createPreview(input: {
  repository: Pick<SqliteRoutineRepository, "addArtifact">
  dataDir?: string
  egress?: EgressGuard
  /** How long one command to the desktop may take: a navigation waits for the page to load. */
  callTimeoutMs?: number
  /** Which key selects a field's text: Command on macOS, Control elsewhere. */
  platform?: NodeJS.Platform
}) {
  const dataDir = input.dataDir ?? join(flupcodeConfigDir(), "browser")
  const egress = input.egress ?? createEgressGuard()
  const timeoutMs = input.callTimeoutMs ?? 30_000
  const selectAll = (input.platform ?? process.platform) === "darwin" ? 4 : 2
  const host = {
    socket: undefined as PreviewSocket | undefined,
    next: 0,
    pending: new Map<number, { resolve: (value: unknown) => void; reject: (cause: Error) => void }>(),
    state: undefined as PreviewState | undefined,
  }
  const page = { generation: 0, refs: new Map<string, SnapshotRef>() }
  // The engine names tabs `tab_<uuid>`; the preview's one tab keeps its name for as long as it lives.
  const tabID = `tab_${randomUUID()}`
  const sessions = new Map<string, PreviewSession>()

  const call = (method: string, params: Record<string, unknown> = {}) => {
    const socket = host.socket
    if (!socket) return Promise.reject(unavailable())
    const id = ++host.next
    const answer = Promise.withResolvers<unknown>()
    const timer = setTimeout(() => {
      host.pending.delete(id)
      answer.reject(new BrowserError("action_failed", 504, `The preview did not answer ${method} in time`))
    }, timeoutMs)
    host.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        answer.resolve(value)
      },
      reject: (cause) => {
        clearTimeout(timer)
        answer.reject(cause)
      },
    })
    socket.send(JSON.stringify({ id, method, params }))
    return answer.promise
  }

  const cdp = async <T>(method: string, params: Record<string, unknown> = {}) => (await call("cdp", { method, params })) as T

  const state = async () => {
    host.state = readState(await call("state"))
    return host.state
  }

  /** A page somebody asked for: loopback as it is, anything else through the egress guard first. */
  const show = async (url: string) => {
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol))
      throw new NavigationBlockedError("The preview only opens web pages", url)
    if (!isLoopbackUrl(url)) {
      await egress.assertNavigable(url)
      await call("allow", { origin: new URL(url).origin })
    }
    host.state = readState(await call("navigate", { url }))
    return host.state
  }

  const requireSession = (id: string) => {
    const session = sessions.get(id)
    if (!session) throw new BrowserError("no_session", 404, "No preview session is open")
    if (!host.socket) throw unavailable()
    session.view.lastUsedAt = Date.now()
    return session
  }

  const requireTab = (id: string, tab: string) => {
    const session = requireSession(id)
    if (tab !== tabID)
      throw new BrowserError(
        "tab_unavailable",
        404,
        `The preview has one tab, ${tabID}. Call browser.tabs.list({}) and use its tabID.`,
      )
    return session
  }

  const redact = (session: PreviewSession | undefined, text: string) =>
    session ? redactSecrets(text, [...session.secrets]) : text

  const describe = async (session?: PreviewSession): Promise<BrowserTab> => {
    const current = await state()
    return {
      id: tabID,
      url: redact(session, current.url),
      title: redact(session, current.title),
      loading: current.loading,
      canGoBack: current.canGoBack,
      canGoForward: current.canGoForward,
      generation: page.generation,
    }
  }

  const store = async (session: PreviewSession | undefined, label?: string) => {
    const captured = (await call("capture")) as { png?: unknown }
    if (typeof captured?.png !== "string") throw new BrowserError("action_failed", 502, "The preview sent no picture")
    const bytes = Buffer.from(captured.png, "base64")
    const current = host.state
    return file(bytes, {
      title: label?.trim() || redact(session, current?.title ?? "").trim() || "Preview screenshot",
      ...(session?.runID ? { runID: session.runID } : {}),
      ...(session?.taskID ? { taskID: session.taskID } : {}),
      ...(session?.sessionID ? { sessionID: session.sessionID } : {}),
    })
  }

  /** A PNG in the harness's own data folder, kept as a screenshot artifact (TI-11 serves it from there). */
  const file = (bytes: Uint8Array, meta: { title: string; runID?: string; taskID?: string; sessionID?: string }) => {
    const relative = join("preview", `${randomUUID()}.png`)
    mkdirSync(dirname(join(dataDir, relative)), { recursive: true })
    writeFileSync(join(dataDir, relative), bytes)
    const artifact = input.repository.addArtifact({
      kind: "screenshot",
      title: meta.title,
      mime: "image/png",
      producer: "harness",
      path: relative,
      directory: dataDir,
      ...(meta.runID ? { runID: meta.runID } : {}),
      ...(meta.taskID ? { taskID: meta.taskID } : {}),
      ...(meta.sessionID ? { sessionID: meta.sessionID } : {}),
    })
    return { bytes, artifactId: artifact.id, path: join(dataDir, relative) }
  }

  const refOf = (ref: string) => {
    const known = page.refs.get(ref.replace(/^@/, ""))
    if (!known)
      throw new BrowserError(
        "stale_ref",
        409,
        `${ref} is not a ref of the preview's latest snapshot: refs expire with the next snapshot and on navigation. Call browser.snapshot and use a ref from it.`,
      )
    return known
  }

  const pointOf = async (ref: string) => {
    const node = refOf(ref)
    const quads = await cdp<{ quads: number[][] }>("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId })
      .then(() => cdp<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: node.backendNodeId }))
      .catch(() => {
        throw new BrowserError("stale_ref", 409, `${ref} is no longer on the page. Call browser.snapshot again.`)
      })
    const quad = quads.quads[0]
    if (!quad) throw new BrowserError("action_failed", 422, `${ref} has nothing visible to click`)
    return centre(quad)
  }

  const key = async (combo: string) => {
    const parts = combo.split("+").filter(Boolean)
    const name = parts.at(-1) ?? ""
    const modifiers = parts
      .slice(0, -1)
      .reduce((mask, part) => mask | (part === "ControlOrMeta" ? selectAll : (MODIFIERS[part] ?? 0)), 0)
    const known = KEYS[name] ?? (name.length === 1 ? { key: name, text: name } : undefined)
    if (!known) throw new BrowserError("action_failed", 422, `The preview does not know the key ${name}`)
    // A character typed with Control or Command is a shortcut, not text.
    const text = modifiers & 6 ? undefined : known.text
    await cdp("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", modifiers, ...known, ...(text ? { text } : {}) })
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: known.key, ...(known.code ? { code: known.code } : {}) })
  }

  /** Replaces what the focused field held, as the engine's `fill` and a recipe's `fill` promise. */
  const replaceText = async (text: string) => {
    await cdp("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: selectAll,
      commands: ["selectAll"],
    })
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: selectAll })
    if (text) return void (await cdp("Input.insertText", { text }))
    return key("Delete")
  }

  const clickAt = async (point: { x: number; y: number }, button = "left", count = 1) => {
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button, clickCount: count })
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button, clickCount: count })
  }

  /**
   * The elements a CSS selector names, read from the document through the debugger (CL-4): a web
   * recipe names elements by selector, and nothing here runs script in the page to find them.
   */
  const select = async (selector: string) => {
    const document = await cdp<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 })
    const found = await cdp<{ nodeIds: number[] }>("DOM.querySelectorAll", { nodeId: document.root.nodeId, selector })
    return found.nodeIds.filter((id) => id > 0)
  }

  const boxOf = (nodeId: number) =>
    cdp<{ quads: number[][] }>("DOM.getContentQuads", { nodeId })
      .then((found) => found.quads[0])
      .catch(() => undefined)

  /** The first element the selector names, once there is one (and, unless `attached`, one with a box). */
  const waitForSelector = async (selector: string, timeoutMs: number, state: "attached" | "visible" = "visible") => {
    const deadline = Date.now() + timeoutMs
    while (true) {
      // A document replaced mid-query (a navigation) is asked again, not a failure.
      const node = (await select(selector).catch(() => []))[0]
      if (node !== undefined && (state === "attached" || (await boxOf(node)))) return node
      if (Date.now() >= deadline)
        throw new BrowserError("action_failed", 408, `Nothing ${state === "visible" ? "visible " : ""}matched ${selector} within ${timeoutMs} ms`)
      await Bun.sleep(SELECTOR_POLL_MS)
    }
  }

  /** A recipe step on the page, by selector: what a verify task's visual check does (CL-4). */
  const bySelector = async (action: Exclude<BrowserAction, { kind: "navigate" }>): Promise<string | undefined> => {
    const timeoutMs = action.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
    if (action.kind === "waitFor") return void (await waitForSelector(action.selector, timeoutMs, action.state))
    if (action.kind === "read") {
      const node = await waitForSelector(action.selector, timeoutMs, "attached")
      const html = await cdp<{ outerHTML: string }>("DOM.getOuterHTML", { nodeId: node })
      return textOf(html.outerHTML)
    }
    if (action.kind === "click") {
      const node = await waitForSelector(action.selector, timeoutMs)
      await cdp("DOM.scrollIntoViewIfNeeded", { nodeId: node }).catch(() => undefined)
      const quad = await boxOf(node)
      if (!quad) throw new BrowserError("action_failed", 422, `${action.selector} has nothing visible to click`)
      return void (await clickAt(centre(quad)))
    }
    if (action.kind === "type") {
      const node = await waitForSelector(action.selector, timeoutMs)
      await cdp("DOM.focus", { nodeId: node })
      return void (await replaceText(action.text))
    }
    throw new BrowserError("action_failed", 422, `The preview does not run the recipe step ${action.kind}`)
  }

  const inPage = async (action: TabAction) => {
    if (action.kind === "navigate") return void (await show(action.url))
    if (action.kind === "back" || action.kind === "forward" || action.kind === "reload")
      return void (host.state = readState(await call(action.kind)))
    if (action.kind === "click") return clickAt(await pointOf(action.ref), action.button, action.count)
    if (action.kind === "type") {
      const node = refOf(action.ref)
      if (!EDITABLE_ROLES.has(node.role))
        throw new BrowserError("not_editable", 422, `${action.ref} is a ${node.role}, not a field to type into`)
      await cdp("DOM.focus", { backendNodeId: node.backendNodeId }).catch(() => {
        throw new BrowserError("stale_ref", 409, `${action.ref} is no longer on the page. Call browser.snapshot again.`)
      })
      return replaceText(action.text)
    }
    if (action.kind === "key") return key(action.key)
    const metrics = await cdp<{ cssLayoutViewport?: { clientWidth: number; clientHeight: number } }>(
      "Page.getLayoutMetrics",
    )
    await cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: (metrics.cssLayoutViewport?.clientWidth ?? 800) / 2,
      y: (metrics.cssLayoutViewport?.clientHeight ?? 600) / 2,
      deltaX: action.deltaX ?? 0,
      deltaY: action.deltaY,
    })
  }

  const snapshotText = async (session: PreviewSession, find?: string) => {
    const tree = await cdp<{ nodes: AXNode[] }>("Accessibility.getFullAXTree")
    const rendered = renderSnapshot(tree.nodes, {
      limit: MAX_SNAPSHOT,
      redact: (text) => redact(session, text),
      ...(find ? { find } : {}),
    })
    page.refs = rendered.refs
    return rendered
  }

  const tabs: BrowserTabs = {
    list: async (id) => {
      const session = requireSession(id)
      return { tabs: [await describe(session)], focusedTabID: tabID }
    },
    // There are no other tabs: opening one is going somewhere in the preview.
    open: async (id, url) => {
      const session = requireSession(id)
      if (url && url !== "about:blank") await show(url)
      return describe(session)
    },
    focus: async (id, tab) => describe(requireTab(id, tab)),
    // The preview is the person's as much as the agent's: closing it is not the agent's to do.
    close: async (id, tab) => {
      const session = requireTab(id, tab)
      return { tabs: [await describe(session)], focusedTabID: tabID }
    },
    snapshot: async (id, tab, options) => {
      const session = requireTab(id, tab)
      const rendered = await snapshotText(session, options?.find)
      return { tab: await describe(session), content: rendered.content, truncated: rendered.truncated }
    },
    act: async (id, tab, action) => {
      const session = requireTab(id, tab)
      await inPage(action)
      return describe(session)
    },
    screenshot: async (id, tab) => {
      const session = requireTab(id, tab)
      const stored = await store(session)
      return { tab: await describe(session), artifactId: stored.artifactId, path: stored.path, bytes: stored.bytes.byteLength }
    },
  }

  const driver: BrowserDriver & { tabs: BrowserTabs } = {
    // By selector, for a verify task's visual check (CL-4); never `submit` or `upload`.
    capabilities: { actions: new Set(["navigate", "waitFor", "click", "type", "read"]) },
    async open(request) {
      if (!host.socket) throw unavailable()
      const current = host.state ?? (await state())
      const now = Date.now()
      const view: BrowserSession = {
        id: request.id,
        project: request.project,
        headed: true,
        createdAt: now,
        lastUsedAt: now,
        idleTimeoutMs: 0,
        url: current.url,
        title: current.title,
        paused: false,
        stopped: false,
      }
      sessions.set(request.id, {
        view,
        secrets: new Set(),
        ...(request.runID ? { runID: request.runID } : {}),
        ...(request.taskID ? { taskID: request.taskID } : {}),
        ...(request.sessionID ? { sessionID: request.sessionID } : {}),
      })
      return { ...view }
    },
    // Gone with the desktop: a session over a preview nobody hosts is not open.
    get(id) {
      const session = sessions.get(id)
      if (!session || !host.socket) return undefined
      return {
        ...session.view,
        url: redact(session, host.state?.url ?? session.view.url),
        title: redact(session, host.state?.title ?? session.view.title),
      }
    },
    async act(id, action) {
      const session = requireSession(id)
      if (action.kind === "navigate") {
        const shown = await show(action.url)
        return { url: shown.url, title: shown.title }
      }
      const value = await bySelector(action)
      const current = await state()
      return {
        url: redact(session, current.url),
        title: redact(session, current.title),
        ...(action.kind === "read" ? { value: value === undefined ? null : redact(session, value) } : {}),
      }
    },
    async snapshot(id) {
      const session = requireSession(id)
      const current = await state()
      return { url: redact(session, current.url), title: redact(session, current.title), text: (await snapshotText(session)).content }
    },
    async screenshot(id, options) {
      const session = requireSession(id)
      if (options?.store === false) {
        const captured = (await call("capture")) as { png?: string }
        return { bytes: Buffer.from(captured?.png ?? "", "base64") }
      }
      const stored = await store(session, options?.label)
      return { bytes: stored.bytes, artifactId: stored.artifactId }
    },
    async close(id) {
      return sessions.delete(id)
    },
    protect(id, value) {
      if (value.value) sessions.get(id)?.secrets.add(value.value)
    },
    beginRun: () => undefined,
    endRun: async () => undefined,
    async waitIfPaused(id) {
      if (sessions.get(id)?.view.stopped) throw new BrowserError("stopped", 409, "The preview session was stopped")
    },
    tabs,
  }

  const disconnect = (socket: PreviewSocket) => {
    if (socket !== host.socket) return
    host.socket = undefined
    host.state = undefined
    const pending = [...host.pending.values()]
    host.pending.clear()
    pending.forEach((entry) => entry.reject(unavailable()))
  }

  return {
    driver,
    /** The harness's own folder its pictures are written to (TI-11 serves them from there). */
    dataDir,
    /** Whether a desktop app hosts the preview right now. */
    connected: () => host.socket !== undefined,
    /** The page the preview shows, as main last reported it. */
    current: () => (host.socket ? host.state : undefined),
    show,
    /**
     * Where the elements the selectors name are, in the page's CSS pixels, and how wide the page's
     * viewport is in them, so a capture's own pixels can be told apart (CL-4: a visual check's masks).
     */
    async regions(selectors: string[]) {
      const metrics = await cdp<{ cssLayoutViewport?: { clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics")
      const nodes = (await Promise.all(selectors.map((selector) => select(selector).catch(() => [])))).flat()
      const quads = await Promise.all(nodes.map(boxOf))
      return {
        width: metrics.cssLayoutViewport?.clientWidth ?? 0,
        height: metrics.cssLayoutViewport?.clientHeight ?? 0,
        boxes: quads.flatMap((quad) => {
          if (!quad) return []
          const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!]
          const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
          return [{ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }]
        }),
      }
    },
    /** A picture the person marked up in the app, kept as a screenshot artifact of the session it is for. */
    annotation: (bytes: Uint8Array, meta: { title: string; sessionID?: string }) => file(bytes, meta),
    /** The desktop's main process, connected: the one host, replacing any earlier one. */
    connect(socket: PreviewSocket) {
      const previous = host.socket
      if (previous && previous !== socket) {
        disconnect(previous)
        previous.close(4000, "replaced")
      }
      host.socket = socket
      page.refs = new Map()
    },
    receive(socket: PreviewSocket, text: string) {
      if (socket !== host.socket) return
      const message = parseMessage(text)
      if (!message) return
      if (message.event === "state") host.state = readState(message.state)
      // A new document: the refs of the last snapshot name nodes that are gone.
      if (message.event === "navigated") {
        page.generation += 1
        page.refs = new Map()
      }
      if (typeof message.id !== "number") return
      const pending = host.pending.get(message.id)
      if (!pending) return
      host.pending.delete(message.id)
      if (message.error) return pending.reject(hostError(message.error))
      pending.resolve(message.result)
    },
    disconnect,
  }
}

export type Preview = ReturnType<typeof createPreview>

/**
 * A verify task's picture of the project's page (BU-06): the address `preview` names in
 * `.flupcode/project.yaml`, opened in the desktop's preview and kept as a screenshot artifact of the
 * run and task. It is evidence, not a check: what happens here never changes the verdict.
 *
 * Only a page on this machine, and only through the policy: the project's own declaration is the
 * consent, in a routine rule's grammar, for opening and reading that one origin; a blocked site
 * would still be refused. Nothing is captured when the project names no page (`undefined`) or the
 * desktop is not hosting the preview (`skipped`, with why).
 */
export function createPreviewCapture(input: { preview: Preview; policy: BrowserPolicy }): PreviewCapture {
  return async (task) => {
    const url = await previewTarget(task.directory)
    if (!url) return undefined
    if (!isLoopbackUrl(url))
      return { url, skipped: "it is not a page on this machine: a verify task only captures the project's dev server" }
    if (!input.preview.connected()) return { url, skipped: "the desktop app's preview is not open" }
    const question: DecideInput = {
      origin: url,
      tier: "navigate",
      runId: task.runID,
      taskId: task.taskID,
      action: "preview.capture",
      rules: [{ permission: "browser", pattern: originOf(url)!, action: "allow" }],
    }
    const verdict = input.policy.decide(question)
    if (verdict.decision !== "allow" || !input.policy.spend(verdict.permit, question))
      return { url, skipped: verdict.reason }
    const id = `verify:${task.taskID}`
    const driver = input.preview.driver
    return driver
      .open({ id, project: task.directory, runID: task.runID, taskID: task.taskID })
      .then(() => driver.act(id, { kind: "navigate", url }))
      .then(() => driver.screenshot(id, { label: `${task.name} — preview of ${url}` }))
      .then((shot) => {
        input.policy.recordAction(question, { outcome: "success", ...(shot.artifactId ? { artifactID: shot.artifactId } : {}) })
        return { url, artifactID: shot.artifactId ?? "" }
      })
      .catch((cause: unknown) => {
        const detail = cause instanceof Error ? cause.message : String(cause)
        input.policy.recordAction(question, { outcome: "failed", detail })
        return { url, skipped: detail }
      })
      .finally(() => driver.close(id))
  }
}

/** The verify task's evidence with what became of the preview's picture, when the project named a page. */
export function previewEvidence(evidence: string, preview: Awaited<ReturnType<PreviewCapture>>) {
  if (!preview) return evidence
  if ("artifactID" in preview) return `${evidence}\n\nPreview: captured ${preview.url} as a screenshot (artifact ${preview.artifactID}).`
  return `${evidence}\n\nPreview: ${preview.url} was not captured: ${preview.skipped}.`
}

export type PreviewCapture = (task: {
  directory: string
  runID: string
  taskID: string
  name: string
}) => Promise<{ url: string; artifactID: string } | { url: string; skipped: string } | undefined>

/** What the desktop's WebSocket looks like from here: Bun's `ServerWebSocket`, or a test's fake. */
export type PreviewSocket = { send(data: string): unknown; close(code?: number, reason?: string): unknown }

export type PreviewState = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }

/** The subprotocol the desktop asks for; the other one it offers carries the UI token. */
export const PREVIEW_PROTOCOL = "flupcode-preview"

/**
 * A page on this machine: `localhost` and its subdomains, `127.0.0.0/8`, `::1`. The same rule as
 * `previewVerdict` in the desktop's `preview-origin.ts`.
 */
export function isLoopbackUrl(value: string) {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true
  const octets = host.split(".")
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

/** The server's fetch, with the desktop's request to host the preview upgraded first. */
export function withPreviewHost(
  preview: Preview | undefined,
  token: string | undefined,
  handler: (request: Request) => Promise<Response> | Response,
) {
  return (request: Request, server: UpgradeServer) =>
    preview && token && new URL(request.url).pathname === PREVIEW_HOST_PATH
      ? upgradePreviewHost(request, server, token)
      : handler(request)
}

/** Bun's WebSocket handlers for that one socket; a server without a preview never upgrades one. */
export function previewSocket(preview: Preview | undefined) {
  return {
    open: (socket: PreviewSocket) => preview?.connect(socket),
    message: (socket: PreviewSocket, message: string | Buffer) => preview?.receive(socket, String(message)),
    close: (socket: PreviewSocket) => preview?.disconnect(socket),
  }
}

type UpgradeServer = {
  upgrade(request: Request, options: { headers?: HeadersInit; data: { id: string } }): boolean
}

/** The preview host's socket data, beside FlupCode Bridge's (whose ids are random UUIDs). */
export const PREVIEW_SOCKET = "preview-host"

/** Where the desktop's main process connects to host the preview. */
export const PREVIEW_HOST_PATH = "/harness/preview/host"

/**
 * The desktop's request to host the preview, upgraded to a WebSocket when it presents the UI's token
 * and asks for the preview's subprotocol. A page cannot be the host: a browser always says where it
 * comes from (`Origin`), and the desktop's main process does not.
 */
export function upgradePreviewHost(
  request: Request,
  server: UpgradeServer,
  token: string,
) {
  if (request.headers.has("origin")) return new Response("Forbidden", { status: 403 })
  if (!tokenMatches(token, previewTokenFrom(request))) return new Response("Forbidden", { status: 403 })
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((entry) => entry.trim())
  if (!protocols.includes(PREVIEW_PROTOCOL)) return new Response("Unknown protocol", { status: 400 })
  if (server.upgrade(request, { headers: { "sec-websocket-protocol": PREVIEW_PROTOCOL }, data: { id: PREVIEW_SOCKET } }))
    return undefined
  return new Response("Upgrade required", { status: 426 })
}

/**
 * The token the desktop presented when it asked to upgrade, as the second subprotocol
 * (`token.<hex>`): a WebSocket client cannot set an `Authorization` header.
 */
export function previewTokenFrom(request: Request) {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("token."))
    ?.slice("token.".length)
}

type PreviewSession = {
  view: BrowserSession
  secrets: Set<string>
  runID?: string
  taskID?: string
  sessionID?: string
}

const MAX_SNAPSHOT = 60_000

/** How often a selector is looked for again while a step waits for it. */
const SELECTOR_POLL_MS = 100

const centre = (quad: number[]) => ({
  x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
  y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
})

/**
 * An element's text, from its markup: tags and what scripts and styles hold dropped, the common
 * entities read, white space collapsed. Close to what a browser's `innerText` says, without running
 * anything in the page to ask it.
 */
export function textOf(html: string) {
  return html
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
      const lower = entity.toLowerCase()
      if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16))
      if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)))
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[lower] ?? ""
    })
    .replace(/\s+/g, " ")
    .trim()
}

const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

const KEYS: Record<string, { key: string; code?: string; windowsVirtualKeyCode?: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
}

const unavailable = () =>
  new BrowserError("preview_unavailable", 503, "The preview is only in the desktop app, and it is not connected")

function readState(value: unknown): PreviewState {
  const record = (value ?? {}) as Record<string, unknown>
  return {
    url: typeof record.url === "string" ? record.url : "",
    title: typeof record.title === "string" ? record.title : "",
    loading: record.loading === true,
    canGoBack: record.canGoBack === true,
    canGoForward: record.canGoForward === true,
  }
}

function parseMessage(text: string) {
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== "object") return undefined
    return value as { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown }; event?: unknown; state?: unknown }
  } catch {
    return undefined
  }
}

/** Main's refusal, as the driver's: a navigation it would not make is the egress guard's word. */
function hostError(error: { code?: unknown; message?: unknown }) {
  const message = typeof error.message === "string" ? error.message : "The preview failed"
  if (error.code === "navigation_blocked") return new NavigationBlockedError(message)
  return new BrowserError("action_failed", 422, message)
}
