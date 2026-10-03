import {
  CDP_METHODS,
  DEFAULT_PORT,
  GROUP_TITLE,
  PING_MS,
  PROTOCOL_VERSION,
  SOCKET_PATH,
  type BridgeTab,
  type ExtensionMessage,
  type HarnessMessage,
} from "./protocol"

/**
 * FlupCode Bridge's service worker (BU-04): the one WebSocket to the loopback harness, and the only
 * code that touches the browser.
 *
 * What the agent may reach is decided here as well as in the harness, so a harness bug cannot widen
 * it: a request names a tab, and the tab has to be in a group titled "FlupCode" at that moment (the
 * agent's own tabs, plus any the person dragged in or handed over from the popup); a CDP call has to
 * be one of `CDP_METHODS`. The debugger attaches only to a tab the agent acts on, and Chrome shows its
 * "started debugging this browser" bar for as long as it is attached: nothing here hides it.
 *
 * While attached, every document a tab loads (redirects and frames included) waits for the harness's
 * egress guard; no answer in time is a no. When the socket closes (the app quit, crashed or was
 * restarted) the debugger is detached from every tab at once.
 */

const EGRESS_TIMEOUT_MS = 10_000
const TAKE_BACK_BINDING = "__flupcodeTakeBack"
const INDICATOR_ID = "flupcode-bridge-indicator"

const state = {
  socket: undefined as WebSocket | undefined,
  status: "offline" as "offline" | "pairing" | "connected",
  code: "",
  attached: new Set<number>(),
  attaching: new Map<number, Promise<void>>(),
  egress: new Map<string, (allowed: boolean) => void>(),
}

class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const send = (message: ExtensionMessage) => {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message))
}

async function connect() {
  if (state.socket) return
  const stored = await chrome.storage.local.get(["port", "token"])
  if (state.socket) return
  const socket = new WebSocket(`ws://127.0.0.1:${portOf(stored.port)}${SOCKET_PATH}`)
  state.socket = socket
  const ping = setInterval(() => send({ type: "ping" }), PING_MS)
  socket.onopen = () =>
    send({
      type: "hello",
      version: PROTOCOL_VERSION,
      browser: browserName(),
      ...(typeof stored.token === "string" ? { token: stored.token } : {}),
    })
  socket.onmessage = (event) => void receive(JSON.parse(String(event.data)) as HarnessMessage)
  socket.onclose = () => {
    clearInterval(ping)
    if (state.socket !== socket) return
    state.socket = undefined
    void setStatus("offline")
    // The app is gone: nothing may keep driving a tab. The alarm tries again later.
    void releaseAll()
  }
}

async function receive(message: HarnessMessage) {
  if (message.type === "welcome") return setStatus(message.paired ? "connected" : "pairing", message.paired ? "" : message.code)
  if (message.type === "paired") {
    await chrome.storage.local.set({ token: message.token })
    return setStatus("connected")
  }
  // The app forgot this browser: it pairs again from scratch. The harness closes the socket.
  if (message.type === "refused" && message.reason === "not_paired") return chrome.storage.local.remove("token")
  if (message.type === "egress") return state.egress.get(message.request)?.(message.allowed)
  if (message.type !== "request") return
  const handler = HANDLERS[message.method]
  const outcome: ExtensionMessage = await (handler
    ? handler(message.params)
    : Promise.reject(new Refusal("unsupported", `Unknown request ${message.method}`))
  ).then(
    (result) => ({ type: "result" as const, id: message.id, result: result ?? null }),
    (cause: unknown) => ({
      type: "error" as const,
      id: message.id,
      code: cause instanceof Refusal ? cause.code : "failed",
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  )
  send(outcome)
}

const HANDLERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  "tabs.list": async () => ({ tabs: await Promise.all((await scopedTabs()).map(describe)) }),
  "tabs.open": async () => {
    const tab = await chrome.tabs.create({ url: "about:blank", active: true })
    await joinGroup(tab)
    return describe(await chrome.tabs.get(tab.id!))
  },
  "tabs.focus": async (params) => {
    const tab = await scoped(params.tabId)
    return describe(await chrome.tabs.update(tab.id!, { active: true }))
  },
  "tabs.close": async (params) => {
    const tab = await scoped(params.tabId)
    await release(tab.id!)
    await chrome.tabs.remove(tab.id!)
    return {}
  },
  "tabs.wait": async (params) => {
    const tab = await scoped(params.tabId)
    // An input that starts a navigation does not mark the tab loading at once.
    if (typeof params.settleMs === "number") await sleep(Math.min(params.settleMs, 2000))
    const deadline = Date.now() + 30_000
    const loaded = async (): Promise<chrome.tabs.Tab> => {
      const current = await chrome.tabs.get(tab.id!)
      if (current.status !== "loading" || Date.now() > deadline) return current
      await sleep(100)
      return loaded()
    }
    return describe(await loaded())
  },
  cdp: async (params) => {
    const method = String(params.method ?? "")
    if (!CDP_METHODS.has(method)) throw new Refusal("unsupported", `FlupCode Bridge does not forward ${method}`)
    const tab = await scoped(params.tabId)
    const args = (params.params ?? {}) as Record<string, unknown>
    if (method === "Page.navigate" && !navigable(args.url))
      throw new Refusal("navigation_blocked", "FlupCode Bridge only opens http and https pages")
    await attach(tab.id!)
    return chrome.debugger.sendCommand({ tabId: tab.id! }, method, args)
  },
  release: async () => releaseAll(),
}

/** The tab, if it is in a FlupCode group right now; anything else is refused before it is touched. */
async function scoped(tabId: unknown) {
  const tab = typeof tabId === "number" ? await chrome.tabs.get(tabId).catch(() => undefined) : undefined
  if (!tab || !(await inGroup(tab)))
    throw new Refusal("out_of_scope", "That tab is not in the FlupCode tab group, so the agent cannot reach it")
  return tab
}

async function inGroup(tab: chrome.tabs.Tab) {
  if (tab.groupId === -1) return false
  const group = await chrome.tabGroups.get(tab.groupId).catch(() => undefined)
  return group?.title === GROUP_TITLE
}

async function scopedTabs() {
  const groups = (await chrome.tabGroups.query({})).filter((group) => group.title === GROUP_TITLE)
  return (await Promise.all(groups.map((group) => chrome.tabs.query({ groupId: group.id })))).flat()
}

/** Puts a tab in its window's FlupCode group, making the group when the window has none. */
async function joinGroup(tab: chrome.tabs.Tab) {
  const existing = (await chrome.tabGroups.query({ windowId: tab.windowId })).find((group) => group.title === GROUP_TITLE)
  const groupId = await chrome.tabs.group({
    tabIds: [tab.id!],
    ...(existing ? { groupId: existing.id } : { createProperties: { windowId: tab.windowId } }),
  })
  if (!existing) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "orange" })
}

async function describe(tab: chrome.tabs.Tab): Promise<BridgeTab> {
  const history = state.attached.has(tab.id!)
    ? ((await chrome.debugger.sendCommand({ tabId: tab.id! }, "Page.getNavigationHistory").catch(() => undefined)) as
        | { currentIndex: number; entries: unknown[] }
        | undefined)
    : undefined
  return {
    tabId: tab.id!,
    url: tab.url ?? "",
    title: tab.title ?? "",
    loading: tab.status === "loading",
    active: tab.active,
    ...(history
      ? { canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1 }
      : {}),
  }
}

/** Attaches the debugger to a tab once, with the egress gate and the in-page indicator. */
function attach(tabId: number) {
  if (state.attached.has(tabId)) return Promise.resolve()
  const known = state.attaching.get(tabId)
  if (known) return known
  const target = { tabId }
  const pending = (async () => {
    await chrome.debugger.attach(target, "1.3")
    state.attached.add(tabId)
    try {
      await chrome.debugger.sendCommand(target, "Fetch.enable", {
        patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
      })
      await chrome.debugger.sendCommand(target, "Runtime.enable")
      await chrome.debugger.sendCommand(target, "Runtime.addBinding", { name: TAKE_BACK_BINDING })
      const script = indicatorScript()
      await chrome.debugger.sendCommand(target, "Page.addScriptToEvaluateOnNewDocument", { source: script })
      // The script for each new document only runs with the Page domain on.
      await chrome.debugger.sendCommand(target, "Page.enable")
      await chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression: script })
    } catch (cause) {
      await release(tabId)
      throw cause
    }
    await badge()
  })().finally(() => state.attaching.delete(tabId))
  state.attaching.set(tabId, pending)
  return pending
}

async function release(tabId: number) {
  state.attached.delete(tabId)
  await chrome.debugger
    .sendCommand({ tabId }, "Runtime.evaluate", { expression: `document.getElementById(${JSON.stringify(INDICATOR_ID)})?.remove()` })
    .catch(() => undefined)
  await chrome.debugger.detach({ tabId }).catch(() => undefined)
  await badge()
}

/** Detaches from every tab this extension may be attached to, including any it lost track of. */
async function releaseAll() {
  const targets = await chrome.debugger.getTargets().catch(() => [])
  const tabs = new Set([...state.attached, ...targets.flatMap((target) => (target.attached && target.tabId !== undefined ? [target.tabId] : []))])
  await Promise.all([...tabs].map(release))
}

/** The person takes tabs back: the debugger lets go and the tabs leave the group, so the agent loses them. */
async function takeBack(tabIds?: number[]) {
  const tabs = tabIds ?? (await scopedTabs()).map((tab) => tab.id!)
  await Promise.all(tabs.map(release))
  if (tabs.length > 0) await chrome.tabs.ungroup(tabs).catch(() => undefined)
  if (!tabIds) send({ type: "takeback" })
}

/** Holds a document request until the harness's egress guard answers; no answer is a no. */
async function gate(tabId: number, params: Record<string, unknown>) {
  const requestId = String(params.requestId ?? "")
  const url = String((params.request as { url?: unknown } | undefined)?.url ?? "")
  const allowed = await new Promise<boolean>((resolve) => {
    if (state.status !== "connected") return resolve(false)
    const request = crypto.randomUUID()
    const timer = setTimeout(() => answer(false), EGRESS_TIMEOUT_MS)
    const answer = (value: boolean) => {
      clearTimeout(timer)
      state.egress.delete(request)
      resolve(value)
    }
    state.egress.set(request, answer)
    send({ type: "egress", request, tabId, url })
  })
  await chrome.debugger
    .sendCommand(
      { tabId },
      allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
      allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" },
    )
    .catch(() => undefined)
}

async function setStatus(status: typeof state.status, code = "") {
  state.status = status
  state.code = code
  await badge()
}

/** The toolbar says when the agent holds a tab, beside the debugging bar Chrome shows. */
const badge = async () => {
  await chrome.action.setBadgeBackgroundColor({ color: "#f97316" }).catch(() => undefined)
  await chrome.action
    .setBadgeText({ text: state.attached.size > 0 ? "ON" : state.status === "pairing" ? "…" : "" })
    .catch(() => undefined)
}

/** A fixed frame and a "Take back" button on the page, in a closed shadow root the reader cannot see. */
const indicatorScript = () => `(() => {
  if (window.top !== window) return;
  const mount = () => {
    if (document.getElementById(${JSON.stringify(INDICATOR_ID)})) return;
    const host = document.createElement("flupcode-bridge");
    host.id = ${JSON.stringify(INDICATOR_ID)};
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = '<style>.frame{position:fixed;inset:0;border:3px solid #f97316;box-sizing:border-box}.bar{position:fixed;right:12px;bottom:12px;display:flex;gap:8px;align-items:center;padding:4px 4px 4px 12px;border-radius:8px;background:#f97316;color:#1c1917;font:600 12px/1.6 system-ui,sans-serif;pointer-events:auto;box-shadow:0 2px 8px rgba(0,0,0,.25)}button{font:inherit;border:0;border-radius:6px;padding:2px 10px;background:#ffedd5;color:#1c1917;cursor:pointer}</style><div class="frame"></div><div class="bar"><span></span><button type="button"></button></div>';
    root.querySelector("span").textContent = ${JSON.stringify(chrome.i18n.getMessage("indicator"))};
    const button = root.querySelector("button");
    button.textContent = ${JSON.stringify(chrome.i18n.getMessage("indicatorTakeBack"))};
    button.addEventListener("click", () => window.${TAKE_BACK_BINDING}?.("take-back"));
    document.documentElement.appendChild(host);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})()`

const navigable = (url: unknown) =>
  typeof url === "string" &&
  (url === "about:blank" || (URL.canParse(url) && ["http:", "https:"].includes(new URL(url).protocol)))

const portOf = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_PORT

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** "Google Chrome", "Microsoft Edge", ... as the app shows the browser waiting to pair. */
function browserName() {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData?.brands
  return brands?.map((entry) => entry.brand).find((brand) => !/not.a.brand|chromium/i.test(brand)) ?? "Chromium"
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return
  if (method === "Fetch.requestPaused") void gate(source.tabId, params ?? {})
  if (method === "Runtime.bindingCalled" && params?.name === TAKE_BACK_BINDING) void takeBack([source.tabId])
})

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return
  state.attached.delete(source.tabId)
  void badge()
  // The debugging bar's Cancel: the person takes the whole browser back.
  if (reason === "canceled_by_user") void takeBack()
})

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url !== undefined && state.attached.has(tabId)) send({ type: "navigated", tabId })
})

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const reply = (work: Promise<unknown>) => {
    void work.then(respond, (cause: unknown) => respond({ error: String(cause) }))
    return true
  }
  if (message.type === "status")
    return reply(
      chrome.storage.local
        .get(["port"])
        .then((stored) => ({ status: state.status, code: state.code, port: portOf(stored.port) })),
    )
  if (message.type === "hand")
    return reply(
      chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(async ([tab]) => {
        if (tab?.id !== undefined && !(await inGroup(tab))) await joinGroup(tab)
      }),
    )
  if (message.type === "takeBack") return reply(takeBack())
  if (message.type === "port") return reply(chrome.storage.local.set({ port: portOf(message.port) }))
  return false
})

// A new port is a new harness: the old socket goes, and with it anything it was driving.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("port" in changes)) return
  const old = state.socket
  state.socket = undefined
  old?.close()
  void setStatus("offline")
  void releaseAll().then(connect)
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "connect") void connect()
})
chrome.runtime.onStartup.addListener(() => void connect())
chrome.runtime.onInstalled.addListener(() => void connect())
// The harness may start after the browser: the alarm looks for it every 30 seconds.
void chrome.alarms.create("connect", { periodInMinutes: 0.5 })
void connect()
