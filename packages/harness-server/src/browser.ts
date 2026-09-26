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

/**
 * What a click-to-pick read back from a point in the page (WA-8).
 *
 * `candidates` are ranked selectors for the element under the point, up to three; the editor picks
 * one for a step. An element inside a frame is named as such rather than guessed at from the frame's
 * own document, because Playwright's frame selectors are a different thing.
 */
export type SelectorCapture = {
  found: boolean
  reason?: "none" | "iframe"
  viewport?: BrowserViewport
  box?: { x: number; y: number; width: number; height: number }
  tag?: string
  candidates?: string[]
  /** A little of the element's text, redacted, so the editor can say what was picked. */
  text?: string
}

export type BrowserRuntimeOptions = {
  repository: Pick<SqliteRoutineRepository, "addArtifact" | "append">
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
  /**
   * What this browser is working for (WA-7).
   *
   * A scheduled action has no session of a model to hang its evidence on, so the run and task that
   * asked for the browser travel with it and every artifact it stores is filed under them.
   */
  runID?: string
  taskID?: string
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
  /** Hold the agent at the next step boundary so a person can drive the window (WA-6). */
  pause(id: string): BrowserSession
  /** Let the agent carry on after a pause. */
  resume(id: string): BrowserSession
  /** Reveal a headed window and pause the agent on it. A headless session cannot be taken over. */
  takeOver(id: string): Promise<BrowserSession>
  /** Stop a run for good: the runner fails with `stopped`, and the session is closed. */
  abort(id: string): Promise<boolean>
  /** Block the caller while the session is paused; throw `stopped` if it was aborted meanwhile. */
  waitIfPaused(id: string): Promise<void>
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
  /**
   * What is at a point in the page, turned into selectors for the editor (WA-8).
   *
   * The point is a `0..1` fraction of the viewport, not a pixel: the editor reads it off a frame
   * whose resolution is the device's, while the page is measured in CSS pixels.
   */
  capture(id: string, point: { x: number; y: number }): Promise<SelectorCapture>
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
  | "stopped"

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

  /** Releases whoever is held by `waitIfPaused`, so a resume or an abort is not swallowed. */
  const wake = (session: ActiveSession): void => {
    session.wake?.()
    session.wake = undefined
  }

  /** The status a viewer watches (WA-6): every lifecycle change goes through here and is persisted. */
  const emitStatus = (session: ActiveSession, closed = false): void => {
    repository.append({
      type: "browser.status",
      sessionID: session.view.id,
      headed: session.view.headed,
      paused: session.paused,
      ...(closed ? { closed: true } : {}),
    })
  }

  const closeSession = async (id: string): Promise<boolean> => {
    const session = sessions.get(id)
    if (!session) return false
    if (session.timer) clearTimeout(session.timer)
    // Wake before the context goes: a `waitIfPaused` must not be left holding a session that is gone.
    wake(session)
    emitStatus(session, true)
    session.paused = false
    session.stopped = false
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
    paused: session.paused,
    stopped: session.stopped,
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
    session.view.viewport = session.page.viewportSize() ?? undefined
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
        paused: false,
        stopped: false,
      },
      context,
      page,
      timer: undefined,
      aborted: undefined,
      paused: false,
      stopped: false,
      wake: undefined,
      takeoverRequested: false,
      secrets: new Set(),
      maskSelectors: new Set(),
      runID: input.runID,
      taskID: input.taskID,
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
    emitStatus(session)
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

  const pause = (id: string): BrowserSession => {
    const session = requireSession(id)
    session.paused = true
    emitStatus(session)
    return redactedView(session)
  }

  const resume = (id: string): BrowserSession => {
    const session = requireSession(id)
    session.paused = false
    session.takeoverRequested = false
    wake(session)
    emitStatus(session)
    return redactedView(session)
  }

  const takeOver = async (id: string): Promise<BrowserSession> => {
    const session = requireSession(id)
    if (session.view.headed) {
      await session.page.bringToFront()
      return pause(id)
    }
    // No window to hand over yet: the agent runs headless and only the live view is shown. Mark it
    // and hold the agent; the window opens at the next step boundary, where no Playwright call is
    // in flight to kill, with the same persistent profile (and login) as the headless session.
    session.takeoverRequested = true
    return pause(id)
  }

  const abort = async (id: string): Promise<boolean> => {
    const session = sessions.get(id)
    if (!session) return false
    session.stopped = true
    session.paused = false
    wake(session)
    // Closing the context is what makes a Playwright call in flight reject instead of hanging.
    return closeSession(id)
  }

  const waitIfPaused = async (id: string): Promise<void> => {
    for (;;) {
      const session = requireSession(id)
      if (session.stopped) throw new BrowserError("stopped", 409, "That browser session was stopped")
      // A takeover asked for while headless opens the window here, at a step boundary: relaunching
      // anywhere else would kill the Playwright call in flight. The persistent profile (and login)
      // survives the relaunch; the agent stays held throughout.
      if (session.takeoverRequested && !session.view.headed) {
        session.takeoverRequested = false
        const project = session.view.project
        const idleTimeoutMs = session.view.idleTimeoutMs
        await closeSession(id)
        await start({ id, project, headed: true, idleTimeoutMs })
        pause(id)
        await sessions.get(id)?.page.bringToFront()
        continue
      }
      if (!session.paused) {
        touch(session)
        return
      }
      await new Promise<void>((resolve) => {
        session.wake = resolve
      })
      // The object outlives the map entry, so a closed session is told apart from a resumed one.
      if (session.stopped || !sessions.has(session.view.id))
        throw new BrowserError("stopped", 409, "That browser session was stopped")
    }
  }

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
      ...(session.runID ? { runID: session.runID } : {}),
      ...(session.taskID ? { taskID: session.taskID } : {}),
    })
    // Only a stored frame changes what a viewer can see, so only here does the stream carry it; a
    // `store: false` poll is served and forgotten and must not announce an artifact nobody has.
    const view = redactedView(session)
    repository.append({
      type: "browser.frame",
      sessionID: session.view.id,
      artifactId: artifact.id,
      url: view.url,
      title: view.title,
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

  /**
   * What is at a point on the page, and how to select it (WA-8).
   *
   * The read happens in the page, because only there is the rendered element knowable. The
   * candidates are ranked — a test attribute, a unique id, a name, then a structural path — and
   * capped at three so the editor offers a short list. An element inside a frame is reported as
   * `iframe` rather than reached into: a selector for the outer frame is not one a step can use.
   *
   * The point arrives as a `0..1` fraction of the viewport: the editor measured it against a frame
   * whose pixels are the device's, and only here, in the page, are the CSS pixels it must be
   * compared with known. A device pixel ratio other than one would otherwise land the click twice
   * as far from the corner as it was.
   */
  const capture = async (id: string, point: { x: number; y: number }): Promise<SelectorCapture> => {
    const session = requireSession(id)
    try {
      const result = (await session.page.evaluate(({ x, y }: { x: number; y: number }) => {
        const viewport = { width: window.innerWidth, height: window.innerHeight }
        const element = document.elementFromPoint(x * viewport.width, y * viewport.height)
        if (!element) return { found: false as const, reason: "none" as const, viewport }
        if (element.tagName === "IFRAME" || element.tagName === "FRAME")
          return { found: true as const, reason: "iframe" as const, viewport }
        const unique = (selector: string) => {
          try {
            return document.querySelectorAll(selector).length === 1
          } catch {
            return false
          }
        }
        const candidates: string[] = []
        for (const attribute of ["data-testid", "data-test", "data-cy", "data-qa"]) {
          const value = element.getAttribute(attribute)
          if (!value) continue
          const selector = `[${attribute}="${CSS.escape(value)}"]`
          if (unique(selector)) {
            candidates.push(selector)
            break
          }
        }
        if (element.id) candidates.push(`#${CSS.escape(element.id)}`)
        const name = element.getAttribute("name")
        if (name) {
          const selector = `[name="${CSS.escape(name)}"]`
          if (unique(selector)) candidates.push(selector)
        }
        const segments: string[] = []
        let node: Element | null = element
        for (let depth = 0; depth < 6 && node; depth++) {
          if (depth > 0 && node.id) {
            segments.unshift(`#${CSS.escape(node.id)}`)
            break
          }
          const tag = node.tagName.toLowerCase()
          let index = 1
          const parent: Element | null = node.parentElement
          if (parent)
            for (const child of parent.children) {
              if (child === node) break
              if (child.tagName === node.tagName) index++
            }
          segments.unshift(`${tag}:nth-of-type(${index})`)
          node = parent
          if (!node || node === document.body) break
        }
        const path = segments.join(" > ")
        if (path) candidates.push(path)
        const box = element.getBoundingClientRect()
        return {
          found: true as const,
          viewport,
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          tag: element.tagName.toLowerCase(),
          candidates: candidates.slice(0, 3),
          text: ((element as HTMLElement).innerText || element.textContent || "").slice(0, 500),
        }
      }, point)) as SelectorCapture
      return result.text === undefined
        ? result
        : { ...result, text: redactSecrets(result.text, await collectSecrets(session)) }
    } catch (cause) {
      throw new BrowserError("action_failed", 422, messageOf(cause))
    }
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
    pause,
    resume,
    takeOver,
    abort,
    waitIfPaused,
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
    capture,
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
  /** Held at the next step boundary so a person can drive the window (WA-6). */
  paused: boolean
  /** Stopped for good: the runner must fail with `stopped` and never resume. */
  stopped: boolean
  /** Resolves `waitIfPaused` so a resume or an abort is noticed. */
  wake: (() => void) | undefined
  /** A person asked for the window while headless: it opens at the next step boundary. */
  takeoverRequested: boolean
  /** The run and task this browser works for (WA-7), so its screenshots are filed under them. */
  runID?: string
  taskID?: string
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
