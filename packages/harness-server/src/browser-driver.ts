/**
 * What drives a page for an action (BU-03, audit §9.5).
 *
 * The runner asks the browser policy first and records what happened after (BU-01), and only in
 * between does it reach a driver, so a driver never decides whether to act and every driver is under
 * the same policy and audit. A driver knows how to reach a page: the recipe runner's own Chromium
 * (`createRecipeDriver` in `browser.ts`) is the first one.
 *
 * A session is an id the caller picked, not a process: `open` may launch a browser or attach to one
 * that was already running, and `close` ends the session, whatever that means for the browser.
 */

export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit"

export type BrowserViewport = { width: number; height: number }

export type BrowserSession = {
  id: string
  project: string
  headed: boolean
  createdAt: number
  lastUsedAt: number
  idleTimeoutMs: number
  url: string
  title: string
  /** The page's viewport, so a click-to-pick knows what its coordinates are relative to (WA-8). */
  viewport?: BrowserViewport
  /** The agent is held at the next step boundary; a person may be driving the window (WA-6). */
  paused: boolean
  /** The run was stopped: the runner must fail with `stopped`, not retry, and never resume. */
  stopped: boolean
}

export type BrowserOpenInput = {
  id: string
  project: string
  headed?: boolean
  idleTimeoutMs?: number
  /**
   * What this browser is working for (WA-7).
   *
   * A scheduled action has no session of a model to hang its evidence on, so the run and task that
   * asked for the browser travel with it and every artifact it stores is filed under them.
   */
  runID?: string
  taskID?: string
  /** The engine session the agent's own tool browses for (BU-05), so its screenshots are filed under it. */
  sessionID?: string
}

/** One thing done to the page. `read` reads an element; everything else may change the page. */
export type BrowserAction =
  | { kind: "navigate"; url: string; waitUntil?: WaitUntil }
  | { kind: "waitFor"; selector: string; timeoutMs?: number; state?: "attached" | "visible" }
  | { kind: "click"; selector: string; timeoutMs?: number }
  | { kind: "type"; selector: string; text: string; timeoutMs?: number }
  | { kind: "submit"; selector: string; timeoutMs?: number }
  | { kind: "upload"; selector: string; file: string; timeoutMs?: number }
  | { kind: "read"; selector: string; as?: "text" | "html" | "attribute"; attribute?: string; timeoutMs?: number }

export type BrowserActionKind = BrowserAction["kind"]

/** Where the page is after an action; `value` only for a `read` (`null`: a missing attribute). */
export type BrowserActResult = { url: string; title: string; value?: string | null }

export type BrowserDriver = {
  /** The actions this driver can do; the runner refuses a recipe that needs another before it opens. */
  capabilities: { actions: ReadonlySet<BrowserActionKind> }
  open(input: BrowserOpenInput): Promise<BrowserSession>
  /** The session as a viewer may see it, with every protected value redacted. */
  get(id: string): BrowserSession | undefined
  act(id: string, action: BrowserAction): Promise<BrowserActResult>
  /** The page's text (and its HTML when asked), redacted and bounded. */
  snapshot(
    id: string,
    options?: { html?: boolean },
  ): Promise<{ url: string; title: string; text: string; html?: string }>
  /**
   * A capture of the page with protected fields blacked out. It is filed as a screenshot artifact
   * unless `store` is false, which serves the bytes and keeps nothing.
   */
  screenshot(
    id: string,
    options?: { label?: string; store?: boolean },
  ): Promise<{ bytes: Uint8Array; artifactId?: string }>
  close(id: string): Promise<boolean>
  /** Remembers a value to redact and, when a selector comes with it, a field to black out. */
  protect(id: string, input: { selector?: string; value: string }): void
  /**
   * Marks the session as driven by a run, until `endRun` (WA-6): whatever a person asked of the
   * browser meanwhile waits for a step boundary instead of landing under an action.
   */
  beginRun(id: string): void
  endRun(id: string): Promise<void>
  /** A step boundary: blocks while a person holds the session, throws `stopped` if it was stopped. */
  waitIfPaused(id: string): Promise<void>
  /** Tabs and element refs for the agent's own browser tool (BU-05), when the driver has them. */
  tabs?: BrowserTabs
}

/**
 * A page the agent's browser tool works in (BU-05), in the shape the engine's `opencode.browser`
 * plugin publishes (ADR-0028). `generation` moves on with every navigation of the tab's document.
 */
export type BrowserTab = {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  generation: number
}

export type BrowserTabList = { tabs: BrowserTab[]; focusedTabID: string | null }

/**
 * One thing the agent does in a tab. Elements are named by a ref from that tab's latest snapshot,
 * never by a selector: a ref the page has moved past fails as `stale_ref` instead of acting on
 * whatever is there now.
 */
export type TabAction =
  | { kind: "navigate"; url: string }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  | { kind: "click"; ref: string; button?: "left" | "right" | "middle"; count?: 1 | 2 }
  | { kind: "type"; ref: string; text: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; deltaX?: number; deltaY: number }

export type BrowserTabs = {
  list(id: string): Promise<BrowserTabList>
  /** A new tab, on `url` when one is given. */
  open(id: string, url?: string): Promise<BrowserTab>
  focus(id: string, tab: string): Promise<BrowserTab>
  close(id: string, tab: string): Promise<BrowserTabList>
  /**
   * The tab's accessibility tree, one element per line with a ref (`e1`, `e2`, ...), redacted and
   * bounded. Refs hold until the next snapshot or navigation of that tab. `find` keeps the lines that
   * contain it (the refs are still those of the whole tree).
   */
  snapshot(
    id: string,
    tab: string,
    options?: { find?: string },
  ): Promise<{ tab: BrowserTab; content: string; truncated: boolean }>
  act(id: string, tab: string, action: TabAction): Promise<BrowserTab>
  /** A capture of the tab, filed as a screenshot artifact; `path` is its file. */
  screenshot(id: string, tab: string): Promise<{ tab: BrowserTab; artifactId: string; path: string; bytes: number }>
}

/** A driver's refusal or failure, with the HTTP status a route answers it with. */
export class BrowserError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "BrowserError"
  }
}

export type BrowserErrorCode =
  | "session_required"
  | "invalid_session"
  | "no_session"
  | "browser_busy"
  | "wrong_project"
  | "browser_limit"
  | "browser_launch_failed"
  | "action_failed"
  | "navigation_blocked"
  | "project_required"
  | "stopped"
  | "invalid_viewport"
  | "tab_unavailable"
  | "stale_ref"
  | "not_editable"
  /** FlupCode Bridge: a tab outside the browser's FlupCode tab group (BU-04). */
  | "out_of_scope"
  /** FlupCode Bridge: no paired browser is connected (BU-04). */
  | "browser_unavailable"
