/**
 * Test support for BU-03: a second `BrowserDriver`, so the runner's tests run over two drivers.
 *
 * It attaches to a browser somebody else launched and owns, as a driver for the user's own browser
 * would: `open` adds a window to it and `close` takes that window away, and the browser keeps
 * running. It has none of the recipe driver's lifecycle (no persistent profile, no relaunch, no
 * takeover, no egress routing) and no pause, so what the runner needs from a driver is the interface
 * alone.
 */

import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Browser, BrowserContext, Page } from "playwright-core"
import { BrowserError } from "./browser-driver"
import type { BrowserAction, BrowserDriver, BrowserSession } from "./browser-driver"
import { redactSecrets } from "./redact"
import type { SqliteRoutineRepository } from "./repository"

export function createAttachedDriver(options: {
  browser: () => Promise<Browser>
  repository: Pick<SqliteRoutineRepository, "addArtifact">
  dataDir: string
}): BrowserDriver & { stop(): Promise<void> } {
  const sessions = new Map<
    string,
    { view: BrowserSession; context: BrowserContext; page: Page; secrets: Set<string>; runID?: string; taskID?: string }
  >()

  const sessionOf = (id: string) => {
    const session = sessions.get(id)
    if (!session) throw new BrowserError("no_session", 404, "No browser session is open")
    return session
  }

  const view = (id: string) => {
    const session = sessionOf(id)
    return {
      ...session.view,
      url: redactSecrets(session.page.url(), [...session.secrets]),
      title: redactSecrets(session.view.title, [...session.secrets]),
    }
  }

  const settle = async (id: string) => {
    const session = sessionOf(id)
    session.view.title = await session.page.title().catch(() => "")
    const current = view(id)
    return { url: current.url, title: current.title }
  }

  const perform = async (page: Page, action: BrowserAction): Promise<string | null | undefined> => {
    const timeout = action.kind !== "navigate" && action.timeoutMs !== undefined ? { timeout: action.timeoutMs } : {}
    if (action.kind === "navigate")
      return void (await page.goto(action.url, { waitUntil: action.waitUntil ?? "domcontentloaded" }))
    if (action.kind === "waitFor")
      return void (await page.waitForSelector(action.selector, { ...timeout, state: action.state ?? "visible" }))
    if (action.kind === "click") return void (await page.click(action.selector, timeout))
    if (action.kind === "type") return void (await page.fill(action.selector, action.text, timeout))
    if (action.kind === "upload") return void (await page.setInputFiles(action.selector, action.file, timeout))
    if (action.kind === "submit") {
      await page.click(action.selector, timeout)
      return void (await page.waitForLoadState("domcontentloaded", timeout).catch(() => undefined))
    }
    const locator = page.locator(action.selector).first()
    await locator.waitFor({
      state: action.as === undefined || action.as === "text" ? "visible" : "attached",
      ...timeout,
    })
    if (action.as === "html") return locator.innerHTML()
    if (action.as === "attribute") return locator.getAttribute(action.attribute ?? "")
    return locator.innerText()
  }

  return {
    capabilities: { actions: new Set(["navigate", "waitFor", "click", "type", "submit", "upload", "read"]) },

    async open(input) {
      const existing = sessions.get(input.id)
      if (existing) return view(input.id)
      const context = await (await options.browser()).newContext()
      const page = await context.newPage()
      sessions.set(input.id, {
        view: {
          id: input.id,
          project: input.project,
          headed: false,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          idleTimeoutMs: 0,
          url: page.url(),
          title: "",
          paused: false,
          stopped: false,
        },
        context,
        page,
        secrets: new Set(),
        ...(input.runID ? { runID: input.runID } : {}),
        ...(input.taskID ? { taskID: input.taskID } : {}),
      })
      return view(input.id)
    },

    get: (id) => (sessions.has(id) ? view(id) : undefined),

    async act(id, action) {
      const session = sessionOf(id)
      const value = await perform(session.page, action).catch((cause) => {
        throw new BrowserError("action_failed", 422, cause instanceof Error ? cause.message : String(cause))
      })
      const where = await settle(id)
      if (action.kind !== "read") return where
      return { ...where, value: typeof value === "string" ? redactSecrets(value, [...session.secrets]) : null }
    },

    async snapshot(id) {
      const session = sessionOf(id)
      const text = await session.page.evaluate(() => document.body?.innerText ?? "")
      return { ...(await settle(id)), text: redactSecrets(text, [...session.secrets]) }
    },

    async screenshot(id, input) {
      const session = sessionOf(id)
      const bytes = await session.page.screenshot({ type: "png" })
      if (input?.store === false) return { bytes }
      const relative = join("frames", id, `${randomUUID()}.png`)
      mkdirSync(dirname(join(options.dataDir, relative)), { recursive: true })
      writeFileSync(join(options.dataDir, relative), bytes)
      const artifact = options.repository.addArtifact({
        kind: "screenshot",
        title: input?.label?.trim() || (await settle(id)).title || "Browser screenshot",
        mime: "image/png",
        producer: "harness",
        path: relative,
        directory: options.dataDir,
        ...(session.runID ? { runID: session.runID } : {}),
        ...(session.taskID ? { taskID: session.taskID } : {}),
      })
      return { bytes, artifactId: artifact.id }
    },

    // Detaching takes the window away and leaves the browser to whoever launched it.
    async close(id) {
      const session = sessions.get(id)
      if (!session) return false
      sessions.delete(id)
      await session.context.close().catch(() => undefined)
      return true
    },

    protect(id, input) {
      if (input.value !== "") sessionOf(id).secrets.add(input.value)
    },

    // What the test closes: every window this driver added, and still not the browser.
    stop: async () => {
      await Promise.all([...sessions.values()].map((session) => session.context.close().catch(() => undefined)))
      sessions.clear()
    },

    beginRun: () => {},
    endRun: async () => {},
    // Nobody can hold this browser between steps: there is no takeover to wait for.
    waitIfPaused: async (id) => void sessionOf(id),
  }
}
