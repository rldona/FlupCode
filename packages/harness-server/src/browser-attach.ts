import { randomUUID } from "node:crypto"
import { approvalOptions, type BrowserApprovalMetadata } from "./action-approval"
import { BrowserError, type BrowserDriver, type BrowserTabs, type TabAction } from "./browser-driver"
import { NavigationBlockedError } from "./browser-egress"
import {
  TIER_WORDS,
  UNTRUSTED_NOTICE,
  originOf,
  type BrowserAnswer,
  type BrowserPermit,
  type BrowserPolicy,
  type BrowserTier,
  type DecideInput,
} from "./browser-policy"

/**
 * The agent's own browser (BU-05, ADR-0028): FlupCode as the client of the engine's
 * `experimental.browser` attach protocol (version 4).
 *
 * The engine already offers the tools (`tools.browser.*` in Code Mode, from its built-in
 * `opencode.browser` plugin); a call reaches the client attached to the session as a `command`, and
 * whatever the client answers is what the model gets. So harness-server attaches for a session the
 * person handed a browser to, runs each command on a `BrowserDriver`'s tabs, and answers. The engine
 * checks nothing per action, so every command that touches a page asks `BrowserPolicy.decide` here,
 * before the driver acts, and is written to the audit after (P7). Listing, picking and closing the
 * agent's own tabs read no page and are only written down.
 *
 * **Approvals in time.** The engine gives a command 60 seconds. An `ask` is put to the person in the
 * session as for a web action, and a command waits `answerWindowMs` for the answer; past that it
 * answers `approval_pending`, nothing ran, and the model is told to call again once the person has
 * answered. The question stays open: a later call for the same site and tier waits on it instead of
 * asking twice, and a yes that arrives after its command gave up is kept for the next one.
 *
 * **What the model reads.** Code Mode hands the model what the script returns, not the engine's own
 * "untrusted page data" line, so a snapshot's text carries `UNTRUSTED_NOTICE` itself. A failure is
 * `[browser.<code>] <why>`, which reaches the model as the call's error, reason included.
 *
 * **Never** the engine's tunnels (`tunnel.*`): this browser runs on the engine's machine and egress
 * stays the driver's guard. Sessions without a browser are not offered the tools (`setBrowserRule`).
 */
export function createBrowserAttach(input: {
  engine: BrowserAttachEngine
  driver: BrowserDriver & { tabs: BrowserTabs }
  policy: BrowserPolicy
  /** Asks the reader in the session: the value of the option picked, if any. */
  ask: (request: {
    sessionID: string
    title: string
    description: string
    options: Array<{ value: string; label: string }>
    metadata: BrowserApprovalMetadata
    timeoutMs: number
  }) => Promise<string | undefined>
  /** How long a command waits on an answer before it answers `approval_pending`. */
  answerWindowMs?: number
  /** How often an attachment checks that its browser is still open. */
  watchMs?: number
  /** Where the agent acts, as the approval names it: the person's own browser says so (BU-04). */
  place?: string
}) {
  const attachments = new Map<string, Attachment>()
  const asks = new Map<string, Promise<BrowserPermit | undefined>>()
  const leftover = new Map<string, BrowserPermit>()
  const waiting = new Map<string, () => void>()
  // A session being detached still holds the tools until the engine is told to stop offering them:
  // until then it is still attached to whoever asks, so nobody acts on a browser it no longer has.
  const leaving = new Map<string, Promise<void>>()
  const stream = { controller: undefined as AbortController | undefined }
  const answerWindowMs = input.answerWindowMs ?? 45_000

  const listen = () => {
    if (stream.controller) return
    const controller = new AbortController()
    stream.controller = controller
    void (async () => {
      for await (const event of input.engine.browserControl(controller.signal)) {
        const connectionID = String(event.connectionID ?? "")
        if (event.type === "attached") waiting.get(connectionID)?.()
        const attachment = [...attachments.values()].find((entry) => entry.connectionID === connectionID)
        if (event.type === "command" && attachment) void command(attachment, String(event.requestID ?? ""))
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        if (stream.controller === controller) stream.controller = undefined
        // A stream that ended under live attachments is opened again: their commands come on it.
        if (!controller.signal.aborted && attachments.size > 0) setTimeout(listen, 1000)
      })
  }

  const detach = async (sessionID: string, attachment?: Attachment) => {
    const current = attachments.get(sessionID)
    if (!current || (attachment && current !== attachment)) return
    attachments.delete(sessionID)
    const done = release(sessionID, current).finally(() => {
      if (leaving.get(sessionID) === done) leaving.delete(sessionID)
    })
    leaving.set(sessionID, done)
    await done
  }

  const release = async (sessionID: string, current: Attachment) => {
    clearInterval(current.watch)
    current.controller.abort()
    if (attachments.size === 0) {
      stream.controller?.abort()
      stream.controller = undefined
    }
    await input.engine.setBrowserRule(sessionID, "deny").catch(() => undefined)
    if (current.owned && input.driver.get(sessionID)) await input.driver.close(sessionID).catch(() => undefined)
  }

  const publish = async (attachment: Attachment) =>
    input.engine.browserCall(
      "state",
      {
        sessionID: attachment.sessionID,
        connectionID: attachment.connectionID,
        state: await input.driver.tabs.list(attachment.sessionID),
      },
      { directory: attachment.directory },
    )

  const command = async (attachment: Attachment, requestID: string) => {
    const ids = { sessionID: attachment.sessionID, connectionID: attachment.connectionID, requestID }
    const body = (await input.engine
      .browserCall("command", ids, { directory: attachment.directory })
      .catch(() => undefined)) as { action?: Record<string, unknown> } | undefined
    // A command the engine already dropped (cancelled, timed out) has nothing left to answer.
    if (!body?.action) return
    const outcome = await execute(attachment, body.action).catch(failureOf)
    // The tabs first: the engine only lets the next call target a tab it was told about.
    await publish(attachment).catch(() => undefined)
    await input.engine
      .browserCall("result", { ...ids, outcome }, { directory: attachment.directory })
      .catch(() => undefined)
  }

  const execute = async (attachment: Attachment, action: Record<string, unknown>): Promise<Outcome> => {
    const type = String(action.type ?? "")
    const spec = ACTIONS[type]
    if (!spec)
      return failure(
        "unsupported",
        `FlupCode's browser does not offer browser.${type}. It offers ${Object.keys(ACTIONS)
          .map((name) => `browser.${name}`)
          .join(", ")}.`,
      )
    const sessionID = attachment.sessionID
    const tabs = input.driver.tabs
    const tier = spec.tier(action)
    const target = await targetOf(action, tabs, sessionID)
    const question: DecideInput = {
      origin: (target && originOf(target)) ?? target ?? "",
      tier: tier === "tabs" ? "read" : tier,
      sessionId: sessionID,
      action: `browser.${type}`,
    }
    if (tier !== "tabs") {
      if (input.driver.get(sessionID)?.paused)
        return failure("paused", "The person paused this browser. Call again after they resume it; nothing ran.")
      const refused = await refusal(attachment, question, tier, target)
      if (refused) return refused
    }
    const done = await spec.run(tabs, sessionID, action).catch((cause: unknown) => {
      input.policy.recordAction(question, { outcome: "failed", detail: messageOf(cause) })
      throw cause
    })
    input.policy.recordAction(question, {
      outcome: "success",
      ...(done.artifactID ? { artifactID: done.artifactID } : {}),
      ...(tier === "tabs" ? { detail: "Listed, picked or closed the agent's tabs" } : {}),
    })
    return { type: "success", result: { value: done.value, files: [] } }
  }

  /**
   * Why a command may not run, or nothing when the policy allows it: asks the reader when nothing
   * decides it yet, and spends the permit, since the driver acts right after this (P7).
   */
  const refusal = async (
    attachment: Attachment,
    question: DecideInput,
    tier: BrowserTier,
    target: string | undefined,
  ): Promise<Outcome | undefined> => {
    const verdict = input.policy.decide(question)
    if (verdict.decision === "deny")
      return failure(
        "denied",
        originOf(question.origin)
          ? verdict.reason
          : `This tab shows no web page (${target ?? "nothing"}). Open a site with browser.navigate first.`,
      )
    const key = `${attachment.sessionID}|${originOf(question.origin)}|${tier}`
    const kept = leftover.get(key)
    leftover.delete(key)
    const permit =
      verdict.decision === "allow" ? verdict.permit : (kept ?? (await answered(attachment, question, tier, key)))
    if (permit === "pending")
      return failure(
        "approval_pending",
        `The person has not answered yet whether the agent may ${TIER_WORDS[tier]} on ${hostOf(question.origin)}. Nothing ran. Call browser.${question.action?.replace(/^browser\./, "")} again after they answer.`,
      )
    if (permit && input.policy.spend(permit, question)) return undefined
    return failure(
      "denied",
      permit
        ? "The policy issued no permit"
        : `The person did not allow the agent to ${TIER_WORDS[tier]} on ${hostOf(question.origin)}.`,
    )
  }

  /** The reader's answer, if it comes within the window; the question itself stays open past it. */
  const answered = async (attachment: Attachment, question: DecideInput, tier: BrowserTier, key: string) => {
    const known = asks.get(key)
    const asked =
      known ??
      (() => {
        const site = hostOf(question.origin)
        const pending = input
          .ask({
            sessionID: attachment.sessionID,
            title: `Allow the agent to ${TIER_WORDS[tier]} on ${site}?`,
            description: `In ${input.place ?? "FlupCode's browser for this session"}: ${question.action}.`,
            options: approvalOptions(tier, site),
            metadata: {
              flupcode: "browser-approval",
              origin: originOf(question.origin)!,
              site,
              tier,
              action: question.action ?? "",
            },
            timeoutMs: 10 * 60 * 1000,
          })
          .catch(() => undefined)
          .then((answer) => input.policy.answer(question, readAnswer(answer)))
          // An answer that lands after the server stopped has nowhere to be written: nothing runs on it.
          .catch(() => undefined)
          .finally(() => asks.delete(key))
        asks.set(key, pending)
        return pending
      })()
    const timer = Promise.withResolvers<"pending">()
    const timeout = setTimeout(() => timer.resolve("pending"), answerWindowMs)
    const result = await Promise.race([asked, timer.promise]).finally(() => clearTimeout(timeout))
    // A yes that lands after this command gave up is the next command's to spend.
    if (result === "pending")
      void asked.then((permit) => {
        if (permit) leftover.set(key, permit)
      })
    return result
  }

  return {
    /** Gives the session a browser: opens the driver's session and attaches to the engine for it. */
    async attach(sessionID: string) {
      const known = attachments.get(sessionID)
      if (known && input.driver.get(sessionID)) return input.driver.get(sessionID)!
      const session = await input.engine.describeSession(sessionID)
      if (!session) throw new BrowserError("no_session", 404, "That session is not in the engine")
      const owned = !input.driver.get(sessionID)
      const view = await input.driver.open({ id: sessionID, project: session.directory, sessionID })
      const attachment: Attachment = {
        sessionID,
        connectionID: randomUUID(),
        directory: session.directory,
        owned,
        controller: new AbortController(),
        watch: undefined,
      }
      attachments.set(sessionID, attachment)
      listen()
      const attached = Promise.withResolvers<void>()
      waiting.set(attachment.connectionID, attached.resolve)
      // Held open while attached; when it ends (replaced, closed, the engine gone) so does this.
      void input.engine
        .browserCall(
          "attach",
          { sessionID, connectionID: attachment.connectionID, version: 4 },
          { directory: session.directory, signal: attachment.controller.signal },
        )
        .catch(() => undefined)
        .finally(() => {
          attached.resolve()
          void detach(sessionID, attachment)
        })
      await Promise.race([attached.promise, Bun.sleep(10_000)])
      waiting.delete(attachment.connectionID)
      if (attachments.get(sessionID) !== attachment) {
        if (owned) await input.driver.close(sessionID).catch(() => undefined)
        throw new BrowserError("action_failed", 502, "The engine did not take the browser for this session")
      }
      await publish(attachment)
      await input.engine.setBrowserRule(sessionID, "allow")
      // The browser closes on its own (stopped, idle): the session loses its tools with it.
      attachment.watch = setInterval(() => {
        if (!input.driver.get(sessionID)) void detach(sessionID, attachment)
      }, input.watchMs ?? 1000)
      return view
    },

    detach: (sessionID: string) => detach(sessionID),

    attached: (sessionID: string) => attachments.has(sessionID) || leaving.has(sessionID),

    async stop() {
      await Promise.all([...attachments.keys()].map((sessionID) => detach(sessionID)))
    },
  }
}

export type BrowserAttach = ReturnType<typeof createBrowserAttach>

/** What the attach client needs of the engine: its adapter's browser methods (P9). */
export type BrowserAttachEngine = {
  browserCall(
    method: string,
    input: Record<string, unknown>,
    options?: { directory?: string; signal?: AbortSignal },
  ): Promise<unknown>
  browserControl(signal: AbortSignal): AsyncIterable<Record<string, unknown>>
  setBrowserRule(sessionID: string, effect: "allow" | "deny"): Promise<void>
  describeSession(sessionID: string): Promise<{ directory: string } | undefined>
}

type Attachment = {
  sessionID: string
  connectionID: string
  directory: string
  /** Whether attaching opened the browser, so detaching closes it. */
  owned: boolean
  controller: AbortController
  watch: ReturnType<typeof setInterval> | undefined
}

type Outcome =
  | { type: "success"; result: { value: unknown; files: [] } }
  | { type: "failure"; code: string; message: string }

/**
 * The engine's actions FlupCode's browser runs, with the tier each one needs. A page is read by
 * `snapshot`, `find` and `screenshot`; `navigate`, `back`, `forward`, `reload` and opening a tab on
 * an address move it; `click`, `fill`, `press` and `scroll` act in it (`interact`). Listing, picking
 * and closing the agent's own tabs read no page (`tabs`). Anything else answers `unsupported`.
 */
const ACTIONS: Record<
  string,
  {
    tier: (action: Record<string, unknown>) => BrowserTier | "tabs"
    run: (
      tabs: BrowserTabs,
      id: string,
      action: Record<string, unknown>,
    ) => Promise<{ value: unknown; artifactID?: string }>
  }
> = {
  "tabs.list": { tier: () => "tabs", run: async (tabs, id) => ({ value: await tabs.list(id) }) },
  "tabs.open": {
    tier: (action) => (typeof action.url === "string" && action.url !== "about:blank" ? "navigate" : "tabs"),
    run: async (tabs, id, action) => ({
      value: await tabs.open(id, typeof action.url === "string" ? action.url : undefined),
    }),
  },
  "tabs.focus": {
    tier: () => "tabs",
    run: async (tabs, id, action) => ({ value: await tabs.focus(id, tabID(action)) }),
  },
  "tabs.close": {
    tier: () => "tabs",
    run: async (tabs, id, action) => ({ value: await tabs.close(id, tabID(action)) }),
  },
  navigate: {
    tier: () => "navigate",
    run: (tabs, id, action) => acted(tabs, id, action, { kind: "navigate", url: String(action.url) }),
  },
  back: { tier: () => "navigate", run: (tabs, id, action) => acted(tabs, id, action, { kind: "back" }) },
  forward: { tier: () => "navigate", run: (tabs, id, action) => acted(tabs, id, action, { kind: "forward" }) },
  reload: { tier: () => "navigate", run: (tabs, id, action) => acted(tabs, id, action, { kind: "reload" }) },
  snapshot: { tier: () => "read", run: (tabs, id, action) => snapshotOf(tabs, id, action) },
  find: { tier: () => "read", run: (tabs, id, action) => snapshotOf(tabs, id, action, String(action.text ?? "")) },
  screenshot: {
    tier: () => "read",
    run: async (tabs, id, action) => {
      const shot = await tabs.screenshot(id, tabID(action))
      return {
        artifactID: shot.artifactId,
        value: {
          tab: shot.tab,
          files: [
            {
              id: `file_${shot.artifactId}`,
              name: "screenshot.png",
              mime: "image/png",
              bytes: shot.bytes,
              path: shot.path,
            },
          ],
        },
      }
    },
  },
  click: {
    tier: () => "interact",
    run: (tabs, id, action) =>
      acted(tabs, id, action, {
        kind: "click",
        ref: String(action.ref),
        ...(action.button === "left" || action.button === "right" || action.button === "middle"
          ? { button: action.button }
          : {}),
        ...(action.count === 2 ? { count: 2 as const } : {}),
      }),
  },
  fill: {
    tier: () => "interact",
    run: (tabs, id, action) =>
      acted(tabs, id, action, { kind: "type", ref: String(action.ref), text: String(action.text ?? "") }),
  },
  press: {
    tier: () => "interact",
    run: (tabs, id, action) => acted(tabs, id, action, { kind: "key", key: String(action.key) }),
  },
  scroll: {
    tier: () => "interact",
    run: (tabs, id, action) =>
      acted(tabs, id, action, {
        kind: "scroll",
        deltaY: Number(action.deltaY ?? 0),
        ...(typeof action.deltaX === "number" ? { deltaX: action.deltaX } : {}),
      }),
  },
}

const tabID = (action: Record<string, unknown>) => String(action.tabID ?? "")

const acted = async (tabs: BrowserTabs, id: string, action: Record<string, unknown>, step: TabAction) => ({
  value: await tabs.act(id, tabID(action), step),
})

/** A snapshot as the model reads it: the page's text, said to be the page's and not instructions. */
const snapshotOf = async (tabs: BrowserTabs, id: string, action: Record<string, unknown>, find?: string) => {
  const snapshot = await tabs.snapshot(id, tabID(action), find ? { find } : undefined)
  return { value: { ...snapshot, content: `${UNTRUSTED_NOTICE}\n${snapshot.content}` } }
}

/**
 * The address a command acts on: the one it opens, or the page its tab shows. A tab that is not one
 * of this browser's fails before anything is decided, and nothing acts on it.
 */
async function targetOf(action: Record<string, unknown>, tabs: BrowserTabs, sessionID: string) {
  if (action.type === "navigate" || action.type === "tabs.open")
    return typeof action.url === "string" ? action.url : undefined
  if (action.type === "tabs.list") return undefined
  const tab = (await tabs.list(sessionID)).tabs.find((entry) => entry.id === action.tabID)
  if (!tab)
    throw new BrowserError(
      "tab_unavailable",
      404,
      "This tab is closed or is not one of this browser's tabs. Call browser.tabs.list({}) and use a tabID from it.",
    )
  return tab.url
}

const failure = (code: string, message: string): Outcome => ({ type: "failure", code, message })

/** A driver's refusal, as the model reads it: its code, and what to do about it. */
function failureOf(cause: unknown): Outcome {
  if (cause instanceof NavigationBlockedError)
    return failure(
      "navigation_blocked",
      `${cause.reason}${cause.url ? `: ${cause.url}` : ""}. FlupCode's browser does not go there.`,
    )
  if (cause instanceof BrowserError) return failure(cause.code, cause.message)
  return failure("action_failed", messageOf(cause))
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const hostOf = (origin: string) => (URL.canParse(origin) ? new URL(origin).host : origin)

const readAnswer = (value: string | undefined): BrowserAnswer =>
  value === "once" || value === "session" || value === "always" || value === "deny" ? value : undefined
