/**
 * What FlupCode Bridge and the harness say to each other (BU-04), over one WebSocket the extension
 * opens to the loopback harness (`/harness/bridge/socket`). Shared by both ends so neither drifts.
 *
 * The extension speaks first with `hello`. Without a token it waits to be paired: the harness shows
 * the browser in the app with a code, the person clicks Pair there, and the harness sends `paired`
 * with a token that only opens this socket (`bridge` scope). With a token it is connected, and the
 * harness sends requests the extension answers. Closing the socket, for whatever reason, detaches
 * the debugger from every tab.
 */

/** The tab group the agent works in. A tab is the agent's only while it is in a group with this title. */
export const GROUP_TITLE = "FlupCode"

export const DEFAULT_PORT = 4097

export const SOCKET_PATH = "/harness/bridge/socket"

export const PROTOCOL_VERSION = 1

/** How often the extension speaks while connected: WebSocket traffic keeps its service worker alive. */
export const PING_MS = 20_000

/**
 * The CDP methods the harness may forward to a tab: read its accessibility tree, find and focus an
 * element, send input, move through its history, and capture it. Nothing that evaluates script,
 * reads cookies or storage, or reaches another target. Anything else is refused by the extension.
 */
export const CDP_METHODS: ReadonlySet<string> = new Set([
  "Accessibility.getFullAXTree",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.getContentQuads",
  "DOM.focus",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Page.navigate",
  "Page.reload",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.getLayoutMetrics",
  "Page.captureScreenshot",
])

/** A tab as the extension reports it: only tabs in the FlupCode group are ever reported. */
export type BridgeTab = {
  tabId: number
  url: string
  title: string
  loading: boolean
  active: boolean
  /** Only for a tab the debugger is attached to; otherwise the extension does not look. */
  canGoBack?: boolean
  canGoForward?: boolean
}

/** The requests the harness sends, and what each answers. */
export type BridgeRequest =
  | { method: "tabs.list"; params: Record<string, never> }
  | { method: "tabs.open"; params: Record<string, never> }
  | { method: "tabs.focus"; params: { tabId: number } }
  | { method: "tabs.close"; params: { tabId: number } }
  /** Waits for the tab to finish loading, after `settleMs` for a navigation an input may start. */
  | { method: "tabs.wait"; params: { tabId: number; settleMs?: number } }
  | { method: "cdp"; params: { tabId: number; method: string; params?: Record<string, unknown> } }
  /** The session ended: detach the debugger everywhere. The tabs stay where they are. */
  | { method: "release"; params: Record<string, never> }

export type ExtensionMessage =
  | { type: "hello"; version: number; browser: string; token?: string }
  | { type: "ping" }
  | { type: "result"; id: number; result: unknown }
  | { type: "error"; id: number; code: string; message: string }
  /** A document request in a tab the agent controls, held until the harness answers. */
  | { type: "egress"; request: string; tabId: number; url: string }
  /** A tab of the group moved to another document: refs read before it are stale. */
  | { type: "navigated"; tabId: number }
  /** The person took the browser back (the debugging bar's Cancel, or the popup). */
  | { type: "takeback" }

export type HarnessMessage =
  | { type: "welcome"; paired: true }
  | { type: "welcome"; paired: false; code: string }
  | { type: "paired"; token: string }
  | { type: "refused"; reason: "not_paired" | "replaced" | "bad_hello" }
  | { type: "pong" }
  | { type: "request"; id: number; method: BridgeRequest["method"]; params: Record<string, unknown> }
  | { type: "egress"; request: string; allowed: boolean }
