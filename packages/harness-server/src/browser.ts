/**
 * The browser the harness drives (WA-1).
 *
 * A real Chromium on the user's machine, launched with a persistent profile per project so a login
 * survives, keyed by the `x-flupcode-session` header. It never exposes a tool to the model: it is an
 * internal HTTP surface, and the egress guard is the boundary that keeps a page somebody else wrote
 * from pointing it at a cloud metadata endpoint or a machine on the local network.
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { BrowserContext, Page } from "playwright"
import type { EgressGuard } from "./browser-egress"
import { NavigationBlockedError, createEgressGuard } from "./browser-egress"
import { flupcodeConfigDir } from "./browser-token"
import { redactSecrets } from "./redact"
import type { SqliteRoutineRepository } from "./repository"

const DEFAULT_IDLE_TIMEOUT_MS = 600_000
/** How much page text a snapshot keeps, so a huge page cannot become an unbounded result. */
const MAX_PAGE_TEXT = 200_000
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
/** Credential-shaped fields the browser always blacks out, whatever the profile declared. */
const BASE_MASK = 'input[type="password"], [autocomplete^="cc-"]'

export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit"

export type BrowserSession = {
  id: string
  project: string
  headed: boolean
  createdAt: number
  lastUsedAt: number
  idleTimeoutMs: number
  url: string
  title: string
}

export type BrowserRuntimeOptions = {
  repository: Pick<SqliteRoutineRepository, "addArtifact">
  dataDir?: string
  executablePath?: string
  idleTimeoutMs?: number
  egress?: EgressGuard
  limit?: number
}

export type BrowserStartInput = {
  id: string
  project: string
  headed?: boolean
  idleTimeoutMs?: number
}

export type BrowserRuntime = {
  start(input: BrowserStartInput): Promise<BrowserSession>
  /** Opens the persistent profile headed by default: a login a person needs to see and finish. */
  openLogin(input: BrowserStartInput): Promise<BrowserSession>
  /** Remembers a value to redact and, when a selector comes with it, a field to black out. */
  protect(id: string, input: { selector?: string; value: string }): void
  /** Deletes a project's persistent profile; refuses while a browser for it is still open. */
  clearData(project: string): Promise<boolean>
  get(id: string): BrowserSession | undefined
  close(id: string): Promise<boolean>
  navigate(id: string, url: string, waitUntil?: WaitUntil): Promise<{ url: string; title: string }>
  snapshot(
    id: string,
    options?: { html?: boolean },
  ): Promise<{ url: string; title: string; text: string; html?: string }>
  click(id: string, selector: string, timeoutMs?: number): Promise<{ url: string; title: string }>
  type(id: string, selector: string, text: string, timeoutMs?: number): Promise<{ url: string; title: string }>
  submit(id: string, selector: string, timeoutMs?: number): Promise<{ url: string; title: string }>
  waitFor(
    id: string,
    selector: string,
    timeoutMs?: number,
    state?: "attached" | "visible",
  ): Promise<{ url: string; title: string }>
  upload(id: string, selector: string, filePath: string, timeoutMs?: number): Promise<{ url: string; title: string }>
  text(
    id: string,
    selector: string,
    options?: { as?: "text" | "html" | "attribute"; attribute?: string; timeoutMs?: number },
  ): Promise<{ value: string | null; url: string; title: string }>
  screenshot(id: string, label?: string): Promise<{ artifactId: string }>
  frame(id: string, options?: { store?: boolean }): Promise<{ bytes: Uint8Array; artifactId?: string }>
  stop(): Promise<void>
}

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

/**
 * The session id the runtime keys everything by, read from the header.
 *
 * Absent and empty are told apart from malformed on purpose: the first is a caller that forgot, the
 * second is one asking for something nobody could have started.
 */
export const readSessionID = (value: string | undefined): string => {
  if (value === undefined || value === "")
    throw new BrowserError("session_required", 400, "A browser session is required")
  if (!SESSION_ID.test(value)) throw new BrowserError("invalid_session", 400, "That browser session id is not valid")
  return value
}

export function createBrowserRuntime(options: BrowserRuntimeOptions): BrowserRuntime {
  const dataDir = options.dataDir ?? join(flupcodeConfigDir(), "browser")
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const egress = options.egress ?? createEgressGuard()
  const repository = options.repository
  const sessions = new Map<string, ActiveSession>()
  const projects = new Map<string, string>()

  const closeSession = async (id: string): Promise<boolean> => {
    const session = sessions.get(id)
    if (!session) return false
    if (session.timer) clearTimeout(session.timer)
    // The values live only for as long as the browser that saw them.
    session.secrets.clear()
    session.maskSelectors.clear()
    sessions.delete(id)
    if (projects.get(session.view.project) === id) projects.delete(session.view.project)
    await session.context.close().then(
      () => undefined,
      () => undefined,
    )
    return true
  }

  /** Every operation keeps the session alive, so a viewer polling frames does not lose it. */
  const touch = (session: ActiveSession): void => {
    session.view.lastUsedAt = Date.now()
    if (session.timer) clearTimeout(session.timer)
    session.timer = setTimeout(() => void closeSession(session.view.id), session.view.idleTimeoutMs)
  }

  const requireSession = (id: string): ActiveSession => {
    readSessionID(id)
    const session = sessions.get(id)
    if (!session) throw new BrowserError("no_session", 404, "No browser session is open")
    touch(session)
    return session
  }

  /** The view with every protected value stripped, since a URL or title can carry one. */
  const redactedView = (session: ActiveSession): BrowserSession => ({
    ...session.view,
    url: redactSecrets(session.view.url, [...session.secrets]),
    title: redactSecrets(session.view.title, [...session.secrets]),
  })

  /** The values the fields BASE_MASK always blacks out currently hold, however they were typed. */
  const maskedFieldValues = (session: ActiveSession): Promise<string[]> =>
    session.page
      .$$eval(BASE_MASK, (nodes) =>
        nodes.flatMap((node) => {
          const value = "value" in node ? node.value : undefined
          return typeof value === "string" && value !== "" ? [value] : []
        }),
      )
      .catch(() => [])

  /**
   * Remembers those values beside the protected ones, so every view, read and artifact title built
   * afterwards replaces them too: a login a person completed by hand never passed through `protect`.
   */
  const collectSecrets = async (session: ActiveSession): Promise<string[]> => {
    for (const value of await maskedFieldValues(session)) session.secrets.add(value)
    return [...session.secrets]
  }

  const syncView = async (session: ActiveSession): Promise<BrowserSession> => {
    await collectSecrets(session)
    session.view.url = session.page.url()
    session.view.title = await session.page.title().catch(() => "")
    return redactedView(session)
  }

  const start = async (input: BrowserStartInput): Promise<BrowserSession> => {
    const id = readSessionID(input.id)
    const project = input.project.trim()
    if (!project) throw new BrowserError("project_required", 400, "A project is required")
    const existing = sessions.get(id)
    if (existing) {
      if (existing.view.project !== project)
        throw new BrowserError("wrong_project", 409, "That browser session belongs to another project")
      touch(existing)
      return syncView(existing)
    }
    if (projects.has(project)) throw new BrowserError("browser_busy", 409, "This project already has a browser session")
    if (options.limit !== undefined && sessions.size >= options.limit)
      throw new BrowserError("browser_limit", 409, "Too many browsers are open")

    // Reserved in the same turn as the checks above: the launch yields, so without this a second
    // `start` for the same project would get past the check and open a second browser.
    projects.set(project, id)
    const context = await launch(options, input.headed === true, join(dataDir, "profiles", profileName(project))).catch(
      (cause) => {
        projects.delete(project)
        throw cause
      },
    )
    const page = context.pages()[0] ?? (await context.newPage())
    const session: ActiveSession = {
      view: {
        id,
        project,
        headed: input.headed === true,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        idleTimeoutMs: input.idleTimeoutMs ?? idleTimeoutMs,
        url: page.url(),
        title: "",
      },
      context,
      page,
      timer: undefined,
      aborted: undefined,
      secrets: new Set(),
      maskSelectors: new Set(),
    }
    await context.route("**/*", (route) => {
      const url = route.request().url()
      return egress.assertNavigable(url).then(
        () => route.continue(),
        (cause) => {
          // Only a navigation the guard refused is remembered: a blocked subresource is not what a
          // failed `goto` means, and treating it as one would turn a broken page into a 403.
          if (route.request().isNavigationRequest()) session.aborted = { reason: reasonOf(cause), url }
          return route.abort()
        },
      )
    })
    // The route guard only sees http(s): a WebSocket is a separate transport that could reach
    // loopback or RFC1918 without ever passing it, so in WA-1 every page's WebSockets are closed.
    await context.routeWebSocket("**/*", (ws) => ws.close())
    sessions.set(id, session)
    touch(session)
    return syncView(session)
  }

  const get = (id: string): BrowserSession | undefined => {
    const session = sessions.get(id)
    if (!session) return undefined
    touch(session)
    return redactedView(session)
  }

  const protect = (id: string, input: { selector?: string; value: string }): void => {
    const session = requireSession(id)
    if (input.value !== "") session.secrets.add(input.value)
    if (input.selector) session.maskSelectors.add(input.selector)
  }

  const openLogin = (input: BrowserStartInput): Promise<BrowserSession> =>
    start({ ...input, headed: input.headed ?? true })

  const clearData = async (project: string): Promise<boolean> => {
    const name = project.trim()
    if (!name) throw new BrowserError("project_required", 400, "A project is required")
    // The profile belongs to a live browser while one is open, so deleting out from under it is not a
    // clean forget: the caller has to close the session first.
    if (projects.has(name)) throw new BrowserError("browser_busy", 409, "This project already has a browser session")
    rmSync(join(dataDir, "profiles", profileName(name)), { recursive: true, force: true })
    return true
  }

  const navigate = async (id: string, url: string, waitUntil?: WaitUntil) => {
    const session = requireSession(id)
    clearAborted(session)
    await egress.assertNavigable(url)
    try {
      await session.page.goto(url, { waitUntil: waitUntil ?? "domcontentloaded" })
    } catch (cause) {
      const aborted = session.aborted
      if (aborted) throw new NavigationBlockedError(aborted.reason, aborted.url)
      throw new BrowserError("action_failed", 422, messageOf(cause))
    }
    // A redirect is a new request the guard sees on its own, but the URL it lands on is worth
    // checking too: a page can end somewhere the first one did not name.
    const landed = session.page.url()
    if (URL.canParse(landed)) await egress.assertNavigable(landed)
    return pick(await syncView(session))
  }

  const snapshot = async (id: string, options?: { html?: boolean }) => {
    const session = requireSession(id)
    const secrets = await collectSecrets(session)
    const text = redactSecrets(
      (await session.page.evaluate(() => document.body?.innerText ?? "")).slice(0, MAX_PAGE_TEXT),
      secrets,
    )
    const view = await syncView(session)
    const html = options?.html
      ? redactSecrets(
          (await session.page.evaluate(() => document.documentElement.outerHTML)).slice(0, MAX_PAGE_TEXT),
          secrets,
        )
      : undefined
    return { ...pick(view), text, ...(html !== undefined ? { html } : {}) }
  }

  const click = async (id: string, selector: string, timeoutMs?: number) => {
    const session = requireSession(id)
    try {
      await session.page.click(selector, timeoutOptions(timeoutMs))
    } catch (cause) {
      throw new BrowserError("action_failed", 422, messageOf(cause))
    }
    return pick(await syncView(session))
  }

  const type = async (id: string, selector: string, text: string, timeoutMs?: number) => {
    const session = requireSession(id)
    try {
      await session.page.fill(selector, text, timeoutOptions(timeoutMs))
    } catch (cause) {
      throw new BrowserError("action_failed", 422, messageOf(cause))
    }
    return pick(await syncView(session))
  }

  const submit = async (id: string, selector: string, timeoutMs?: number) => {
    const session = requireSession(id)
    try {
      await session.page.click(selector, timeoutOptions(timeoutMs))
      // A submit that did not navigate is not a failure; the click is the action, and this only
      // waits for the page if one is coming.
      await session.page.waitForLoadState("domcontentloaded", timeoutOptions(timeoutMs)).then(
        () => undefined,
        () => undefined,
      )
    } catch (cause) {
      throw new BrowserError("action_failed", 422, messageOf(cause))
    }
    return pick(await syncView(session))
  }

  const waitFor = async (id: string, selector: string, timeoutMs?: number, state?: "attached" | "visible") => {
    const session = requireSession(id)
    try {
      await session.page.waitForSelector(selector, { ...timeoutOptions(timeoutMs), state: state ?? "visible" })
    } catch (cause) {
      throw new BrowserError("action_failed", 422, messageOf(cause))
    }
    return pick(await syncView(session))
  }

  const upload = async (id: string, selector: string, filePath: string, timeoutMs?: number) => {
    const session = requireSession(id)
    try {
      await session.page.setInputFiles(selector, filePath, timeoutOptions(timeoutMs))
    } catch (cause) {
      throw new BrowserError("action_failed", 422, messageOf(cause))
    }
    return pick(await syncView(session))
  }

  const text = async (
    id: string,
    selector: string,
    options?: { as?: "text" | "html" | "attribute"; attribute?: string; timeoutMs?: number },
  ) => {
    const session = requireSession(id)
    const as = options?.as ?? "text"
    const secrets = await collectSecrets(session)
    try {
      const locator = session.page.locator(selector).first()
      // A hidden node still has attributes and inner HTML; only text needs it on screen.
      await locator.waitFor({ state: as === "text" ? "visible" : "attached", ...timeoutOptions(options?.timeoutMs) })
      const value =
        as === "html"
          ? await locator.innerHTML()
          : as === "attribute"
            ? await locator.getAttribute(options?.attribute ?? "")
            : await locator.innerText()
      return {
        // `null` stays `null`: a missing attribute is not a value that could leak.
        value: typeof value === "string" ? redactSecrets(value.slice(0, MAX_PAGE_TEXT), secrets) : value,
        ...pick(await syncView(session)),
      }
    } catch (cause) {
      throw new BrowserError("action_failed", 422, messageOf(cause))
    }
  }

  // Playwright applies the mask for the shot and lifts it again, so the profile on disk never learns
  // which fields were blacked out.
  const captureOptions = (session: ActiveSession) => ({
    type: "png" as const,
    mask: [
      session.page.locator(BASE_MASK),
      ...[...session.maskSelectors].map((selector) => session.page.locator(selector)),
    ],
    maskColor: "#000",
  })

  const storeScreenshot = async (session: ActiveSession, label?: string) => {
    const bytes = await session.page.screenshot(captureOptions(session))
    const relative = join("frames", session.view.id, `${randomUUID()}.png`)
    mkdirSync(dirname(join(dataDir, relative)), { recursive: true })
    writeFileSync(join(dataDir, relative), bytes)
    // A page title can carry a protected value, so the fallback is redacted before it becomes an artifact.
    const secrets = await collectSecrets(session)
    const fallback = (await session.page.title().catch(() => "")).trim()
    const title = label?.trim() || redactSecrets(fallback, secrets) || "Browser screenshot"
    const artifact = repository.addArtifact({
      kind: "screenshot",
      title,
      mime: "image/png",
      producer: "harness",
      path: relative,
      directory: dataDir,
    })
    return { bytes, artifactId: artifact.id }
  }

  const screenshot = async (id: string, label?: string) => {
    const session = requireSession(id)
    const { artifactId } = await storeScreenshot(session, label)
    return { artifactId }
  }

  const frame = async (
    id: string,
    options?: { store?: boolean },
  ): Promise<{ bytes: Uint8Array; artifactId?: string }> => {
    const session = requireSession(id)
    // A polled frame with `store: false` is served and forgotten: writing a PNG per poll would grow
    // the disk without anybody ever asking for it back.
    if (options?.store === false) return { bytes: await session.page.screenshot(captureOptions(session)) }
    return storeScreenshot(session)
  }

  const stop = async (): Promise<void> => {
    await Promise.all([...sessions.keys()].map((id) => closeSession(id)))
  }

  return {
    start,
    openLogin,
    protect,
    clearData,
    get,
    close: closeSession,
    navigate,
    snapshot,
    click,
    type,
    submit,
    waitFor,
    upload,
    text,
    screenshot,
    frame,
    stop,
  }
}

type ActiveSession = {
  view: BrowserSession
  context: BrowserContext
  page: Page
  timer: ReturnType<typeof setTimeout> | undefined
  aborted: { reason: string; url: string } | undefined
  /** Values to replace in anything read back, and selectors to black out in later captures. */
  secrets: Set<string>
  maskSelectors: Set<string>
}

const launch = async (
  options: BrowserRuntimeOptions,
  headed: boolean,
  userDataDir: string,
): Promise<BrowserContext> => {
  const { chromium } = await import("playwright")
  const headless = !headed
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
  if (options.executablePath)
    return chromium
      .launchPersistentContext(userDataDir, {
        headless,
        executablePath: options.executablePath,
        serviceWorkers: "block",
      })
      .catch((cause) => {
        throw launchFailed(cause)
      })
  // A managed machine may have Chrome but no bundled Chromium; the second attempt is the same
  // browser by another name, not a different policy.
  return chromium
    .launchPersistentContext(userDataDir, { headless, serviceWorkers: "block" })
    .catch(() => chromium.launchPersistentContext(userDataDir, { headless, channel: "chrome", serviceWorkers: "block" }))
    .catch((cause) => {
      throw launchFailed(cause)
    })
}

const launchFailed = (cause: unknown) =>
  new BrowserError("browser_launch_failed", 500, cause instanceof Error ? cause.message : String(cause))

const profileName = (project: string) => createHash("sha256").update(project).digest("hex").slice(0, 16)

/** Clearing through a call, so TypeScript does not narrow `aborted` to `undefined` for the rest of the body. */
const clearAborted = (session: ActiveSession): void => {
  session.aborted = undefined
}

const timeoutOptions = (timeoutMs: number | undefined) => (timeoutMs === undefined ? {} : { timeout: timeoutMs })

const pick = (view: BrowserSession) => ({ url: view.url, title: view.title })

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const reasonOf = (cause: unknown) =>
  cause instanceof NavigationBlockedError ? cause.reason : "That navigation is not allowed"
