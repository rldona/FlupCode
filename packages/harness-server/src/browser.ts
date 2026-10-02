/**
 * The recipe runner's browser (WA-1), the first `BrowserDriver` (BU-03).
 *
 * A real Chromium on the user's machine, launched with a persistent profile per project so a login
 * survives, keyed by the `x-flupcode-session` header. It never exposes a tool to the model: it is an
 * internal HTTP surface, and the egress guard is the boundary that keeps a page somebody else wrote
 * from pointing it at a cloud metadata endpoint or a machine on the local network.
 *
 * What only this driver has stays here: it owns its Chromium (one exclusive profile per project, a
 * headed window is a relaunch on it, egress by `context.route`), so the person's controls of that
 * window — log in, take over, pause, resize, pick an element, clear the profile — are
 * `RecipeDriver`'s, not every driver's.
 */

import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import type { Dirent } from "node:fs"
import { dirname, join } from "node:path"
import type { BrowserContext, Page } from "playwright-core"
import { BrowserError } from "./browser-driver"
import type {
  BrowserAction,
  BrowserActionKind,
  BrowserDriver,
  BrowserOpenInput,
  BrowserSession,
  BrowserViewport,
  WaitUntil,
} from "./browser-driver"
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
/** The bounds a live-view resize is clamped to (WA-6). */
export const MIN_VIEWPORT = 1
export const MAX_VIEWPORT = 4096

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

export type RecipeDriverOptions = {
  repository: Pick<SqliteRoutineRepository, "addArtifact" | "append">
  dataDir?: string
  executablePath?: string
  idleTimeoutMs?: number
  egress?: EgressGuard
  limit?: number
}

/** Every action the runner asks of a driver: the recipe vocabulary (WA-2). */
const RECIPE_ACTIONS: ReadonlySet<BrowserActionKind> = new Set([
  "navigate",
  "waitFor",
  "click",
  "type",
  "submit",
  "upload",
  "read",
])

/** The driver plus the person's own controls of the Chromium it owns. */
export type RecipeDriver = BrowserDriver & {
  /** Opens the persistent profile headed by default: a login a person needs to see and finish. */
  openLogin(input: BrowserOpenInput): Promise<BrowserSession>
  /** Deletes a project's persistent profile; refuses while a browser for it is still open. */
  clearData(project: string): Promise<boolean>
  /** Hold the agent at the next step boundary so a person can drive the window (WA-6). */
  pause(id: string): BrowserSession
  /** Let the agent carry on after a pause. */
  resume(id: string): BrowserSession
  /** Reveal a headed window and pause the agent on it (WA-6). */
  takeOver(id: string): Promise<BrowserSession>
  /** Stop a run for good: the runner fails with `stopped`, and the session is closed. */
  abort(id: string): Promise<boolean>
  /**
   * Resizes the headless page to match the live view's panel (WA-6).
   *
   * The size is validated and clamped at the HTTP boundary (`parseViewport`), which also fixes the
   * error precedence: a bad size is `invalid_viewport` before a missing session can be `no_session`.
   */
  setViewport(id: string, viewport: BrowserViewport): Promise<BrowserSession>
  /**
   * What is at a point in the page, turned into selectors for the editor (WA-8).
   *
   * The point is a `0..1` fraction of the viewport, not a pixel: the editor reads it off a frame
   * whose resolution is the device's, while the page is measured in CSS pixels.
   */
  capture(id: string, point: { x: number; y: number }): Promise<SelectorCapture>
  stop(): Promise<void>
}

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

/**
 * The size a live-view resize asks for, refused or clamped (WA-6).
 *
 * The number comes from a renderer that measured a panel: a missing, non-finite or non-positive
 * side is a caller's bug, not a size to guess at, so it is refused. A real size outside what a page
 * can be told is clamped instead, because a panel taller than the cap is still a panel to fill.
 */
export function parseViewport(width: unknown, height: unknown): BrowserViewport {
  if (!isPositiveFinite(width) || !isPositiveFinite(height))
    throw new BrowserError("invalid_viewport", 400, "A viewport needs a positive width and height")
  return { width: clampViewport(width), height: clampViewport(height) }
}

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0

const clampViewport = (value: number): number => Math.min(MAX_VIEWPORT, Math.max(MIN_VIEWPORT, Math.round(value)))

export function createRecipeDriver(options: RecipeDriverOptions): RecipeDriver {
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
    session.timer = setTimeout(() => {
      // A page call or a reveal in flight is the session being used, so the idle clock restarts
      // instead of closing the browser out from under it.
      if (session.inflight > 0 || session.revealTask) {
        touch(session)
        return
      }
      void closeSession(session.view.id)
    }, session.view.idleTimeoutMs)
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

  /** One lifecycle change at a time per session, so two reveals can never overlap. */
  const lifecycle = <T>(session: ActiveSession, work: () => Promise<T>): Promise<T> => {
    const run = session.queue.then(work, work)
    session.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Whether this exact session object is still the one registered under its id. */
  const isLive = (session: ActiveSession): boolean => sessions.get(session.view.id) === session

  /**
   * Wires the egress guard and the WebSocket close onto a context (WA-1, WA-6).
   *
   * The route guard only sees http(s): a WebSocket is a separate transport that could reach
   * loopback or RFC1918 without ever passing it, so every page's WebSockets are closed. The target
   * context is a parameter, not `session.context`, because a headed reveal binds the new context
   * **before** publishing it: the guard must be in place before the restored profile can navigate.
   */
  const bindContext = async (session: ActiveSession, context: BrowserContext): Promise<void> => {
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
  }

  /**
   * Runs a page call with any wanted reveal deferred until it is done (WA-6).
   *
   * A page call awaits a reveal already running, and counts as in flight while it runs so a
   * takeover asked for mid-call waits for the call instead of killing the Playwright request.
   */
  const pageOp = async <T>(session: ActiveSession, work: () => Promise<T>): Promise<T> => {
    const reveal = session.revealTask
    if (reveal) await reveal
    session.inflight += 1
    try {
      return await work()
    } finally {
      session.inflight -= 1
      void maybeReveal(session)?.catch(() => undefined)
    }
  }

  /**
   * Opens the headed window for a session that was asked to be taken over (WA-6).
   *
   * The headless page is a different Chromium process, so the window is a relaunch on the same
   * persistent profile: the login survives, and the id, project, secrets, run and task are kept,
   * with no closed status and no release of the project's reservation. The new context is built and
   * its guards bound **before** it is published, so the restored profile can never navigate before
   * the egress boundary is in place. A real window is sized by its user, so no viewport is applied;
   * the reported viewport is refreshed from the new page instead.
   */
  const revealHeaded = async (session: ActiveSession): Promise<void> => {
    if (session.view.headed || session.stopped || !isLive(session)) return
    // The persistent profile is locked by the running Chromium, so the old context has to go before
    // the headed one can start on it. If the relaunch then fails, the session is closed below rather
    // than left registered with a dead context.
    const previous = session.context
    await previous.close().catch(() => undefined)
    const context = await launch(options, true, join(dataDir, "profiles", profileName(session.view.project))).catch(
      async (cause) => {
        if (isLive(session)) await closeSession(session.view.id)
        throw cause
      },
    )
    try {
      const page = context.pages()[0] ?? (await context.newPage())
      // Adopt nothing until the guards are on the new context: a restored page that navigates while
      // we are still binding must not be reached without the egress boundary.
      await bindContext(session, context)
      // The session can be stopped, closed, or have its id reused while launch/bind yield: the new
      // window is then a browser nobody owns, so it is closed instead of published.
      if (session.stopped || !isLive(session)) {
        await context.close().catch(() => undefined)
        return
      }
      session.context = context
      session.page = page
      session.view.headed = true
      // The headed page is not the one the panel measured, so the reported size must be the truth of
      // the new page, not the size the headless one had.
      session.view.viewport = page.viewportSize() ?? undefined
      await page.bringToFront().catch(() => undefined)
      // Abort or close can land during `bringToFront`, which closes the context we just published;
      // a status for a session that is gone would only restart a viewer that should stay cleared.
      if (session.stopped || !isLive(session)) return
      emitStatus(session)
    } catch (cause) {
      await context.close().catch(() => undefined)
      // The previous context is already gone and the new one just failed, so a session left
      // registered would only hold a dead context: close it and surface the failure. Identity is
      // checked so a reused id is never closed in this session's name.
      if (isLive(session)) await closeSession(session.view.id)
      throw cause
    }
  }

  /**
   * Starts a wanted reveal if the moment allows it (WA-6).
   *
   * A reveal must not race a page call, so it defers while anything is in flight. It also waits for
   * a run to reach a step boundary unless the caller is that boundary (`force`): relaunching under
   * a Playwright call would kill it. An idle session, with no run and nothing in flight, reveals
   * at once. The wish is cleared only once the reveal really opened a window, so a failed launch
   * does not lose the request.
   */
  const maybeReveal = (session: ActiveSession, force = false): Promise<void> | undefined => {
    if (force) session.revealForced = true
    if (!session.revealWanted) return undefined
    if (session.revealTask) return session.revealTask
    if (session.inflight > 0) return undefined
    if (session.runActive > 0 && !session.revealForced) return undefined
    session.revealTask = lifecycle(session, async () => {
      try {
        await revealHeaded(session)
        session.revealWanted = false
        session.revealForced = false
      } finally {
        session.revealTask = undefined
      }
    })
    return session.revealTask
  }

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

  const open = async (input: BrowserOpenInput): Promise<BrowserSession> => {
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
      runActive: 0,
      inflight: 0,
      revealWanted: false,
      revealForced: false,
      revealTask: undefined,
      queue: Promise.resolve(),
      secrets: new Set(),
      maskSelectors: new Set(),
      runID: input.runID,
      taskID: input.taskID,
    }
    await bindContext(session, context)
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

  const openLogin = (input: BrowserOpenInput): Promise<BrowserSession> =>
    open({ ...input, headed: input.headed ?? true })

  const pause = (id: string): BrowserSession => {
    const session = requireSession(id)
    session.paused = true
    emitStatus(session)
    return redactedView(session)
  }

  const resume = (id: string): BrowserSession => {
    const session = requireSession(id)
    session.paused = false
    // A reveal already running is not cancelled; only a wish still waiting is dropped.
    session.revealWanted = false
    session.revealForced = false
    wake(session)
    emitStatus(session)
    return redactedView(session)
  }

  const takeOver = async (id: string): Promise<BrowserSession> => {
    const session = requireSession(id)
    session.paused = true
    if (session.view.headed) {
      await session.page.bringToFront().catch(() => undefined)
      emitStatus(session)
      return redactedView(session)
    }
    // No window yet: mark the wish and let `maybeReveal` decide. With no run and nothing in flight
    // it opens the window now; mid-run it waits for the next step boundary, where no Playwright
    // call is in flight to kill. Either way the agent stays held.
    session.revealWanted = true
    await (maybeReveal(session) ?? Promise.resolve())
    // Abort or close during the reveal removes the session; a status for one that is gone would only
    // restart a viewer that should stay cleared.
    if (!isLive(session)) return redactedView(session)
    emitStatus(session)
    return redactedView(session)
  }

  const beginRun = (id: string): void => {
    // Advisory: after a close or an abort there is no session to count a run on, and that is fine.
    const session = sessions.get(id)
    if (session) session.runActive += 1
  }

  const endRun = (id: string): Promise<void> => {
    const session = sessions.get(id)
    if (!session) return Promise.resolve()
    session.runActive = Math.max(0, session.runActive - 1)
    // The run is over, so a window somebody asked for no longer has a boundary to wait for. Awaiting
    // the reveal lets the caller's `finally` order before a `closeOnFinish` close.
    if (session.runActive > 0) return Promise.resolve()
    return maybeReveal(session) ?? Promise.resolve()
  }

  const abort = async (id: string): Promise<boolean> => {
    const session = sessions.get(id)
    if (!session) return false
    session.stopped = true
    session.paused = false
    wake(session)
    // Closing the context is what makes a Playwright call in flight reject instead of hanging.
    // Deliberately not queued behind a reveal: a stopped session must die now, and the reveal's
    // identity/`stopped` re-checks are what close any window it had started to launch.
    return closeSession(id)
  }

  const waitIfPaused = async (id: string): Promise<void> => {
    for (;;) {
      const session = requireSession(id)
      if (session.stopped) throw new BrowserError("stopped", 409, "That browser session was stopped")
      // This is a step boundary, so a takeover asked for mid-run may open the window here even
      // though the run is still active; the persistent profile (and login) survives the relaunch.
      if (session.revealWanted) {
        const reveal = maybeReveal(session, true)
        if (reveal) {
          await reveal
          continue
        }
      }
      if (!session.paused) {
        touch(session)
        return
      }
      await new Promise<void>((resolve) => {
        session.wake = resolve
      })
      // The object outlives the map entry, so identity — not mere presence of the id — is what tells
      // a closed or reused session from the one that was resumed.
      if (session.stopped || !isLive(session)) throw new BrowserError("stopped", 409, "That browser session was stopped")
    }
  }

  const setViewport = async (id: string, viewport: BrowserViewport): Promise<BrowserSession> => {
    const session = requireSession(id)
    // The size is already parsed and clamped at the HTTP boundary; the re-check below is the one
    // that matters here, because `pageOp` can run after a reveal swapped in the headed window.
    await pageOp(session, async () => {
      if (session.view.headed) return
      await session.page.setViewportSize(viewport)
      session.view.viewport = session.page.viewportSize() ?? viewport
    })
    touch(session)
    return redactedView(session)
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
    return pageOp(session, async () => {
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
    })
  }

  const snapshot = async (id: string, options?: { html?: boolean }) => {
    const session = requireSession(id)
    return pageOp(session, async () => {
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
    })
  }

  const click = async (id: string, selector: string, timeoutMs?: number) => {
    const session = requireSession(id)
    return pageOp(session, async () => {
      try {
        await session.page.click(selector, timeoutOptions(timeoutMs))
      } catch (cause) {
        throw new BrowserError("action_failed", 422, messageOf(cause))
      }
      return pick(await syncView(session))
    })
  }

  const type = async (id: string, selector: string, text: string, timeoutMs?: number) => {
    const session = requireSession(id)
    return pageOp(session, async () => {
      try {
        await session.page.fill(selector, text, timeoutOptions(timeoutMs))
      } catch (cause) {
        throw new BrowserError("action_failed", 422, messageOf(cause))
      }
      return pick(await syncView(session))
    })
  }

  const submit = async (id: string, selector: string, timeoutMs?: number) => {
    const session = requireSession(id)
    return pageOp(session, async () => {
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
    })
  }

  const waitFor = async (id: string, selector: string, timeoutMs?: number, state?: "attached" | "visible") => {
    const session = requireSession(id)
    return pageOp(session, async () => {
      try {
        await session.page.waitForSelector(selector, { ...timeoutOptions(timeoutMs), state: state ?? "visible" })
      } catch (cause) {
        throw new BrowserError("action_failed", 422, messageOf(cause))
      }
      return pick(await syncView(session))
    })
  }

  const upload = async (id: string, selector: string, filePath: string, timeoutMs?: number) => {
    const session = requireSession(id)
    return pageOp(session, async () => {
      try {
        await session.page.setInputFiles(selector, filePath, timeoutOptions(timeoutMs))
      } catch (cause) {
        throw new BrowserError("action_failed", 422, messageOf(cause))
      }
      return pick(await syncView(session))
    })
  }

  const text = async (
    id: string,
    selector: string,
    options?: { as?: "text" | "html" | "attribute"; attribute?: string; timeoutMs?: number },
  ) => {
    const session = requireSession(id)
    const as = options?.as ?? "text"
    return pageOp(session, async () => {
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
    })
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

  const screenshot = async (
    id: string,
    options?: { label?: string; store?: boolean },
  ): Promise<{ bytes: Uint8Array; artifactId?: string }> => {
    const session = requireSession(id)
    return pageOp(session, async () => {
      // A polled frame with `store: false` is served and forgotten: writing a PNG per poll would grow
      // the disk without anybody ever asking for it back.
      if (options?.store === false) return { bytes: await session.page.screenshot(captureOptions(session)) }
      return storeScreenshot(session, options?.label)
    })
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
    return pageOp(session, async () => {
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
    })
  }

  const act = (id: string, action: BrowserAction) => {
    if (action.kind === "navigate") return navigate(id, action.url, action.waitUntil)
    if (action.kind === "waitFor") return waitFor(id, action.selector, action.timeoutMs, action.state)
    if (action.kind === "click") return click(id, action.selector, action.timeoutMs)
    if (action.kind === "type") return type(id, action.selector, action.text, action.timeoutMs)
    if (action.kind === "submit") return submit(id, action.selector, action.timeoutMs)
    if (action.kind === "upload") return upload(id, action.selector, action.file, action.timeoutMs)
    return text(id, action.selector, action)
  }

  const stop = async (): Promise<void> => {
    await Promise.all([...sessions.keys()].map((id) => closeSession(id)))
  }

  return {
    capabilities: { actions: RECIPE_ACTIONS },
    open,
    openLogin,
    protect,
    clearData,
    get,
    close: closeSession,
    pause,
    resume,
    takeOver,
    abort,
    beginRun,
    endRun,
    setViewport,
    waitIfPaused,
    act,
    snapshot,
    screenshot,
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
  /** How many runs currently drive this session (WA-6); a wanted reveal waits for them. */
  runActive: number
  /** Page calls in flight; a reveal is deferred until this is zero (WA-6). */
  inflight: number
  /** Somebody asked for the headed window and it is not open yet (WA-6). */
  revealWanted: boolean
  /** The reveal was asked for at a step boundary, so it need not wait for the run (WA-6). */
  revealForced: boolean
  /** The reveal in progress, so a second one does not start and page calls can wait for it. */
  revealTask: Promise<void> | undefined
  /** The tail of this session's lifecycle changes: reveals run one at a time (WA-6). */
  queue: Promise<unknown>
  /** The run and task this browser works for (WA-7), so its screenshots are filed under them. */
  runID?: string
  taskID?: string
}

/**
 * Which browser to launch (WA-9), in the order that decides it: an explicit option first, then the
 * environment, then the Chromium Playwright manages, and finally nothing — the system's Chrome.
 *
 * Kept pure so the precedence is testable without launching anything.
 */
export function resolveBrowserExecutable(input: {
  option?: string
  env?: string
  managed?: string
}): string | undefined {
  return input.option ?? input.env ?? input.managed
}

/**
 * The Chromium inside a browsers folder, without asking the package where it lives.
 *
 * `chromium.executablePath()` resolves its own `package.json`, which does not exist inside the
 * compiled harness — so the packaged app finds its browser by layout instead: one `chromium-*`
 * folder per download, with the binary in its platform spot. Returns nothing when there is no
 * folder or no binary, and never throws.
 *
 * The relative paths follow Playwright's own `EXECUTABLE_PATHS` (Chrome for Testing), which moved
 * to arch-suffixed folders (`chrome-mac-arm64`, `chrome-linux64`, `chrome-win64`); the old
 * `chrome-mac/Chromium.app` paths stay as a last resort so a folder from an older download is not
 * lost. A bundled revision can differ from the one the harness's `playwright-core` expects — the
 * desktop fetches the browser separately — which is exactly why the folder is scanned by layout
 * rather than named by revision.
 */
export function managedExecutableFromDir(directory: string | undefined): string | undefined {
  if (!directory) return undefined
  let entries: Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return undefined
  }
  const arm64 = process.arch === "arm64"
  const candidates =
    process.platform === "darwin"
      ? [
          join(
            "chrome-mac-" + (arm64 ? "arm64" : "x64"),
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
          ),
          join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        ]
      : process.platform === "win32"
        ? [join("chrome-win64", "chrome.exe"), join("chrome-win", "chrome.exe")]
        : [join("chrome-linux64", "chrome"), join("chrome-linux", "chrome")]
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("chromium-")) continue
    for (const relative of candidates) {
      const full = join(directory, entry.name, relative)
      try {
        if (existsSync(full)) return full
      } catch {
        continue
      }
    }
  }
  return undefined
}

const launch = async (
  options: RecipeDriverOptions,
  headed: boolean,
  userDataDir: string,
): Promise<BrowserContext> => {
  const { chromium } = await import("playwright-core")
  const headless = !headed
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
  // The page size is not set at launch: the live view measures its panel and posts it to
  // `/harness/browser/viewport`, which is also the only place a headless page is resized.
  // The import above is safe without node_modules: `script/build.ts` drops the package.json lookup
  // playwright's nodePlatform runs at load, which is otherwise baked to the build machine's path.
  // The Chromium Playwright installed, when it is really on disk: a machine without it is exactly
  // the one the system Chrome is for. `executablePath()` looks up its own package, which is absent
  // from the compiled harness, so it is tried last and never allowed to throw past this point.
  const fromDir = managedExecutableFromDir(process.env.PLAYWRIGHT_BROWSERS_PATH)
  let fromPackage: string | undefined
  try {
    const candidate = chromium.executablePath()
    if (existsSync(candidate)) fromPackage = candidate
  } catch {
    fromPackage = undefined
  }
  const executablePath = options.executablePath ?? fromDir ?? fromPackage
  if (executablePath)
    return chromium
      .launchPersistentContext(userDataDir, {
        headless,
        executablePath,
        serviceWorkers: "block",
      })
      .catch((cause) => {
        throw launchFailed(cause)
      })
  // A managed machine may have Chrome but no bundled Chromium; the second attempt is the same
  // browser by another name, not a different policy.
  return chromium
    .launchPersistentContext(userDataDir, { headless, serviceWorkers: "block" })
    .catch(() =>
      chromium.launchPersistentContext(userDataDir, {
        headless,
        channel: "chrome",
        serviceWorkers: "block",
      }),
    )
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
