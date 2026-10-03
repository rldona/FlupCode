import type { V2Engine } from "./engine-v2"
import type { BrowserAllowRule, Unattended } from "./types"

/**
 * The `authorization` header the engine requires, when it was started password-protected.
 *
 * The desktop generates the engine password itself and signs its own renderer in, so it hands the
 * harness the same base64 credentials in `FLUPCODE_ENGINE_AUTH`; without it every request from this
 * server met a 401. A harness started on its own, with the engine's own environment, is covered by
 * the username/password pair instead.
 */
export function engineAuthorization(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const preset = env.FLUPCODE_ENGINE_AUTH?.trim()
  if (preset) return `Basic ${preset}`
  const password = env.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = env.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

/**
 * Everything this server asks of the engine, in one place.
 *
 * Not tidiness: the audit's §16 bis is a list of what two paths to the same thing cost, and the
 * scheduler having its own was the last of them. A task and a routine now reach the engine the same
 * way, so a lesson learned about one is learned about both.
 */
/** What a task is doing right now: one tool call, and since when. */
/** How often a run with a declared ceiling is asked what it is doing. */
const CHECK_EVERY_MS = 5_000

/** One message of a legacy transcript, in the fields this server reads from it. */
export type TranscriptMessage = {
  info?: {
    role?: string
    agent?: string
    model?: { providerID?: string; modelID?: string; variant?: string }
    cost?: number
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
    error?: unknown
  }
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean; ignored?: boolean }>
}

export type Activity = { tool: string; detail?: string; since?: number }

/**
 * What a session waits on a person for (RP-05): a permission the engine asked before a tool runs, or
 * a form (the `question` tool, the plan's hand-off, a browser approval). `sessionID` is the session
 * that asked, which is a subagent's when one asked under the task.
 */
export type PendingRequest =
  | { kind: "permission"; id: string; sessionID: string; action: string; resources: string[] }
  | { kind: "form"; id: string; sessionID: string; title: string }

/** A session-level permission rule, in the shape the legacy runtime reads them. */
export type PermissionRule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" }

/**
 * A run confined to the project it runs in (H-47).
 *
 * `external_directory` is the engine's own name for "a path outside this project", asked for by
 * `read`, `write`, `edit`, `glob`, `grep`, `apply_patch` and `lsp` before they touch one, and by the
 * shell tool itself for an external `workdir` and for the paths of the file commands its parser
 * recognises (`cat`, `rm`, `cp`, `cd`…). Denying it turns the ask into a refusal the tool reports
 * back to the model, with nobody prompted.
 *
 * **It is not a sandbox.** A command the parser does not read (`grep`, `sed`, an interpreter), a
 * redirection, or any expansion can still reach outside, so a confined run states this edge instead
 * of claiming more. `NO_SHELL` is the one exact wall the engine offers.
 */
export const CONFINED: PermissionRule[] = [{ permission: "external_directory", pattern: "*", action: "deny" }]

/**
 * A run whose model may not run shell commands at all (H-47).
 *
 * The shell asks `bash` for every command it parses, so a `*` deny blocks each one; and because the
 * last rule for the tool is a `*` deny, the engine also hides it from the model's tool list. Both
 * read in `opencode/src/permission/index.ts` before being relied on.
 */
export const NO_SHELL: PermissionRule[] = [{ permission: "bash", pattern: "*", action: "deny" }]

/**
 * A run with no tools at all (H-47).
 *
 * `*` is the engine's wildcard for "any permission", so a single `deny` matches every tool; because
 * it is the last rule and `disabled()` reads the last matching rule, the engine also hides the whole
 * tool list from the model. This is the ceiling for a session that only needs to read text and answer
 * — the skill drafter, whose prompt carries untrusted observed content (ADR-0020 §5).
 */
export const NO_TOOLS: PermissionRule[] = [{ permission: "*", pattern: "*", action: "deny" }]

/**
 * The rules a run's sessions are created under (H-47, WA-7).
 *
 * `outside` opens the boundary and `shell: false` closes the shell; everything else keeps the
 * confined default. A run that carries the allow rules a scheduled action was consented under also
 * gets them, because a task of that run may still reach the browser through the plan (WA-7).
 * Nothing here is guessed: every rule is stated on the run.
 */
export function sessionPermission(run: {
  outside?: boolean
  shell?: boolean
  allow?: BrowserAllowRule[]
}): PermissionRule[] {
  return [
    ...(run.outside ? [] : CONFINED),
    ...(run.shell === false ? NO_SHELL : []),
    ...(run.allow ?? []).map((rule) => ({
      permission: rule.permission,
      pattern: rule.pattern,
      action: "allow" as const,
    })),
  ]
}

/** What a task was stopped for: one tool call that ran past the run's declared ceiling (H-47). */
export class ToolLimitReached extends Error {
  constructor(
    readonly tool: string,
    readonly waitedMs: number,
    readonly limitMs: number,
  ) {
    super(
      `\`${tool}\` ran for ${Math.round(waitedMs / 60_000)} minutes, over this run's limit of ${Math.round(
        limitMs / 60_000,
      )} for a single tool call`,
    )
    this.name = "ToolLimitReached"
  }
}

/**
 * What a task was failed for in `deny` mode (RP-05): it needed a person and nobody is there. The
 * message names the tool and what it asked about, because it is the task's error and its verdict.
 */
export class NeedsPerson extends Error {
  constructor(readonly request: PendingRequest) {
    super(
      request.kind === "permission"
        ? `Needed approval to use \`${request.action}\`${
            request.resources.length > 0 ? ` on ${request.resources.slice(0, 3).join(", ")}` : ""
          }, and this run fails a task that needs a person`
        : `Asked "${request.title.slice(0, 160)}", and this run fails a task that needs a person`,
    )
    this.name = "NeedsPerson"
  }
}

/** The argument worth showing beside a tool's name — the one that says what it is working on. */
const ARGUMENTS = ["command", "pattern", "filePath", "file", "path", "query", "url", "description"]

export function detailOf(input: Record<string, unknown> | undefined) {
  if (!input) return undefined
  for (const key of ARGUMENTS) {
    const value = input[key]
    // A whole file's contents can arrive in here. This is a label, not the argument itself.
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 160)
  }
  return undefined
}

/**
 * A run's project has an MCP server that is neither connected nor disabled, after trying.
 *
 * The run fails on this rather than starting a session that quietly lacks the server's tools: a
 * reduced toolset is a different project than the one that was configured, and the run would report
 * a success it did not earn.
 */
export class McpNotConnectedError extends Error {
  constructor(
    readonly server: string,
    readonly status: string,
    readonly directory: string,
  ) {
    super(
      `MCP server "${server}" is not connected (${status}) for ${directory}, so this run would start without its tools`,
    )
    this.name = "McpNotConnectedError"
  }
}

export class Engine {
  private readonly authorization: string | undefined
  private backend: Promise<V2Engine> | undefined

  /** `authorization` defaults to the engine credentials of this process; a test hands its own. */
  constructor(
    readonly url: string,
    authorization = engineAuthorization(),
  ) {
    this.authorization = authorization
  }

  /** The OpenCode 2 client, loaded on first use: `engine-v2.ts` imports this module's helpers. */
  private v2() {
    this.backend ??= import("./engine-v2").then((module) => new module.V2Engine(this.url, this.authorization))
    return this.backend
  }

  /**
   * A session of its own. The agent and the model are not given here because the prompt carries
   * them. `permission` holds the rules the session runs under (H-47): a `deny` stops the call without
   * asking anybody.
   */
  async createSession(input: { directory?: string; parentID?: string; title?: string; permission?: PermissionRule[] }) {
    return (await this.v2()).createSession(input)
  }

  /** Remove a throwaway session and its messages, so helper sessions do not pile up in the list. */
  async deleteSession(sessionID: string) {
    return (await this.v2()).deleteSession(sessionID)
  }

  /**
   * Who an interactive session is, for the episode it closes (AH-B03): its folder, its title and
   * whether it is a subagent's child.
   *
   * `undefined` when the engine refuses it as a request (deleted, or never a session): the caller may
   * forget it. A throw when the engine could not be asked or would not let us in, so the caller tries
   * again later instead of forgetting a session it never saw.
   */
  async describeSession(sessionID: string) {
    return (await this.v2()).describeSession(sessionID)
  }

  /** A session's whole transcript, oldest first: every message with its parts. */
  async messages(sessionID: string) {
    return (await this.v2()).messages(sessionID)
  }

  /** The sessions changed since `since` (the engine's clock), newest first, and which are busy (UL-03). */
  async sessionsUpdatedSince(since: number) {
    return (await this.v2()).sessionsUpdatedSince(since)
  }

  /** A session's billable facts as its transcript records them (UL-03); `undefined` once it is gone. */
  async sessionUsage(sessionID: string) {
    return (await this.v2()).sessionUsage(sessionID)
  }

  /** Prices, providers and connections, for pricing and billing the ledger's rows (UL-05). */
  async usageCatalog(directory?: string) {
    return (await this.v2()).usageCatalog(directory)
  }

  /** The integrations with a connection, the only ones whose quota is read (UL-07). */
  async connectedIntegrations() {
    return (await this.v2()).connectedIntegrations()
  }

  /** A provider's quota answer, read by the engine's quota plugin with the key it keeps (UL-07). */
  async readQuota(integrationID: string) {
    return (await this.v2()).readQuota(integrationID)
  }

  async rename(sessionID: string, title: string) {
    return (await this.v2()).rename(sessionID, title)
  }

  /**
   * A worktree of its own for a task (H-29).
   *
   * The engine does the git work, so the branch, the sandbox bookkeeping and the eventual cleanup all
   * stay its. A task writes here and the primary checkout is left alone until somebody merges.
   */
  async createWorktree(input: {
    directory?: string
    name?: string
  }): Promise<{ name: string; branch?: string; directory: string }> {
    return (await this.v2()).createWorktree(input)
  }

  /** Removes a worktree and the branch it was on. The engine's own bookkeeping too. */
  async removeWorktree(input: { directory: string; project?: string }) {
    return (await this.v2()).removeWorktree(input)
  }

  /** The folders the engine knows as projects, with their worktrees: what the harness may read (TI-11). */
  async projectRoots() {
    return (await this.v2()).projectRoots()
  }

  /**
   * Bring up every MCP server of a project before a run creates its session.
   *
   * A session created while a server is still connecting starts without that server's tools, and the
   * run then works against a project smaller than the one that was configured. Connecting can answer
   * success while the server stays unauthenticated, so the status is read again afterwards and a
   * non-disabled server that is still not connected fails the run by name.
   *
   * An engine whose MCP routes fail must not break the run: every connectivity error is swallowed and
   * the run proceeds as it did before this existed. The one thing never swallowed is this method's
   * own refusal, thrown after the second read.
   */
  async ensureMcp(directory: string) {
    const v2 = await this.v2()
    try {
      const pending = (await v2.mcpServers(directory)).filter(
        (server) => server.status !== "connected" && server.status !== "disabled",
      )
      for (const server of pending) await v2.connectMcp(server.name, directory).catch(() => undefined)
      const stranded = (await v2.mcpServers(directory)).find(
        (server) => server.status !== "connected" && server.status !== "disabled",
      )
      if (stranded) throw new McpNotConnectedError(stranded.name, stranded.status ?? "unknown", directory)
    } catch (cause) {
      if (cause instanceof McpNotConnectedError) throw cause
      // A read that failed: the run continues without this guarantee.
    }
  }

  /** Ask in a session. It returns once the engine admitted the prompt, before the turn ends. */
  async prompt(input: {
    sessionID: string
    text: string
    directory?: string
    agent?: string
    model?: { providerID: string; id: string; variant?: string }
    /**
     * Files to hand the turn as parts (H-31), read by the engine's own Read tool.
     *
     * A path is not text: a file attachment is how the engine puts a file's contents in front of the
     * model, and a path typed into the message would not be.
     */
    files?: Array<{ path: string; filename?: string }>
  }) {
    return (await this.v2()).prompt(input)
  }

  /** Whether the engine is still working on this session. */
  async isBusy(sessionID: string) {
    return (await this.v2()).isBusy(sessionID)
  }

  /**
   * Wait for the turn to end.
   *
   * "Not busy yet" reads exactly like "already finished", so the session is given a moment to appear
   * busy first: without it, a turn slower to start than the first check would be called a success
   * before doing anything. One that finishes inside that window never appears, and the wait ends on
   * its first check.
   */
  async waitForIdle(
    sessionID: string,
    options: {
      stopped?: () => boolean
      timeoutMs?: number
      toolLimitMs?: number
      /**
       * What a wait on a person does (RP-05). Absent, the session waits as an attended one does. With
       * `deny` the request is refused, the turn interrupted and `NeedsPerson` thrown; with `gate` the
       * wait is reported through `onWaiting` and does not count against `timeoutMs`, because the time
       * is the person's, not the work's.
       */
      unattended?: Unattended
      /** The session's folder, where a subagent under it asks too. */
      directory?: string
      /** A request the session started waiting on, or `undefined` once nothing waits any more. */
      onWaiting?: (request: PendingRequest | undefined) => void
      /** Only tests set these; production uses the constants above. */
      pollMs?: number
      checkEveryMs?: number
      settleMs?: number
    } = {},
  ) {
    const stopped = options.stopped ?? (() => false)
    const timeoutMs = options.timeoutMs ?? 30 * 60_000
    let deadline = Date.now() + timeoutMs
    const pollMs = options.pollMs ?? 1000
    const checkEveryMs = options.checkEveryMs ?? CHECK_EVERY_MS
    const settleUntil = Date.now() + (options.settleMs ?? 3000)
    // Stopped means the engine stopped (TI-01): the turn is interrupted before the caller is told,
    // so nothing is written down as stopped while the session is still working.
    const halt = () => this.interrupt(sessionID)
    while (Date.now() < settleUntil) {
      if (stopped()) return halt()
      if (await this.isBusy(sessionID)) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, pollMs)))
    }
    // Only when a limit was declared: asking for the transcript every few seconds costs a request
    // per poll, and a run with no ceiling has nothing to check it against.
    let nextCheck = options.toolLimitMs ? Date.now() + checkEveryMs : Infinity
    let waiting: { request: PendingRequest; since: number } | undefined
    while (waiting || Date.now() < deadline) {
      if (stopped()) return halt()
      if (!(await this.isBusy(sessionID))) return
      if (options.unattended) {
        const request = await this.pendingRequest(sessionID, options.directory).catch(() => undefined)
        if (request && options.unattended === "deny") {
          // Refused before the turn is stopped, so the engine does not keep a question nobody answers.
          await this.refuseRequest(request, "Nobody is attending this task, so it cannot be approved").catch(
            () => undefined,
          )
          await this.interrupt(sessionID).catch(() => undefined)
          throw new NeedsPerson(request)
        }
        if (request?.id !== waiting?.request.id) {
          // The time somebody took to answer is given back to the turn, and a call held at a
          // permission is not running past the tool ceiling: it has not run yet.
          if (waiting) {
            deadline += Date.now() - waiting.since
            nextCheck = options.toolLimitMs ? Date.now() + checkEveryMs : Infinity
          }
          waiting = request ? { request, since: Date.now() } : undefined
          options.onWaiting?.(request)
        }
        if (waiting) {
          await new Promise((resolve) => setTimeout(resolve, pollMs))
          continue
        }
      }
      if (Date.now() >= nextCheck) {
        nextCheck = Date.now() + checkEveryMs
        const overrun = await this.overrunning(sessionID, options.toolLimitMs!)
        if (overrun) {
          // Stopped, not left to the thirty-minute cap. The turn is interrupted first so the engine
          // stops working before the task is written down as stopped.
          await this.interrupt(sessionID).catch(() => undefined)
          throw overrun
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    // Out of time is the same: the turn ends before the task is written down as failed.
    await halt().catch(() => undefined)
    throw new Error(
      `The work was still running after ${timeoutMs >= 60_000 ? `${timeoutMs / 60_000} minutes` : `${timeoutMs / 1000} seconds`}`,
    )
  }

  /** The running tool call, if it has been running longer than this run allows. */
  private async overrunning(sessionID: string, limitMs: number) {
    const doing = await this.activity(sessionID).catch(() => undefined)
    // No start time means the engine did not say when it began. Stopping a task on a guess is worse
    // than letting the thirty-minute cap have it.
    if (!doing?.since) return undefined
    const waited = Date.now() - doing.since
    return waited > limitMs ? new ToolLimitReached(doing.tool, waited, limitMs) : undefined
  }

  /** What the session, or a subagent under it, waits on a person for (RP-05). */
  async pendingRequest(sessionID: string, directory?: string) {
    return (await this.v2()).pendingRequest(sessionID, directory)
  }

  /** Answers a request nobody will: a permission rejected with why, a form withdrawn (RP-05). */
  async refuseRequest(request: PendingRequest, message: string) {
    return (await this.v2()).refuseRequest(request, message)
  }

  /** One question asked in the session (a web action's approval, V2-31; the plan's hand-off, V2-33). */
  async askChoice(input: Parameters<V2Engine["askChoice"]>[0]) {
    return (await this.v2()).askChoice(input)
  }

  /** Switches a session's agent: 2.x keeps it as session state. */
  /** One method of the engine's browser attach protocol (BU-05, ADR-0028). */
  async browserCall(
    method: string,
    input: Record<string, unknown>,
    options?: { directory?: string; signal?: AbortSignal },
  ) {
    return (await this.v2()).browserCall(method, input, options)
  }

  /** The attach protocol's `control` events, until `signal` ends. */
  async *browserControl(signal: AbortSignal) {
    yield* (await this.v2()).browserControl(signal)
  }

  /** Offers the session the engine's `browser.*` tools, or takes them away (BU-05). */
  async setBrowserRule(sessionID: string, effect: "allow" | "deny") {
    return (await this.v2()).setBrowserRule(sessionID, effect)
  }

  async switchAgent(sessionID: string, agent: string) {
    await (await this.v2()).switchAgent(sessionID, agent)
  }

  async interrupt(sessionID: string) {
    return (await this.v2()).interrupt(sessionID)
  }

  /**
   * What a running task is doing right now (H-12).
   *
   * The harness knows a task has been going for eighteen minutes; only the engine knows it has been
   * eighteen minutes inside one `glob`. That was H-47's finding and it is the difference between a
   * run that looks stuck and one you can do something about — the reader can stop it, but not while
   * a call that never returns looks exactly like work.
   *
   * Never stored: it changes by the second, and writing it to the event log would drown everything
   * else in there. It is asked for while somebody is looking.
   */
  async activity(sessionID: string): Promise<Activity | undefined> {
    return (await this.v2()).activity(sessionID)
  }

  /**
   * A commit message for a diff, from a session of its own.
   *
   * Not a turn in the reader's session: the whole point of H-20 was that committing should not spend
   * the conversation's context. The prompt is the diff and the instruction to answer with the message
   * alone, and the session is a throwaway with no folder history behind it.
   */
  async commitMessage(input: {
    directory?: string
    diff: string
    onSession?: (sessionID: string) => void
  }): Promise<string> {
    const session = await this.createSession({
      ...(input.directory ? { directory: input.directory } : {}),
      title: "Commit message",
    })
    // Said before the prompt, so what the session spends is attributed from its first fact (UL-04).
    input.onSession?.(session.id)
    await this.prompt({
      sessionID: session.id,
      ...(input.directory ? { directory: input.directory } : {}),
      text: [
        "Write a commit message for the change below.",
        "Answer with the message alone: a short subject line, and a body only if it needs one.",
        "No code fences, no quotes, no preamble.",
        "",
        input.diff,
      ].join("\n"),
    })
    await this.waitForIdle(session.id, { timeoutMs: 120_000 })
    const answer = await this.lastAnswer(session.id)
    return (answer?.text ?? "").trim()
  }

  /**
   * A closing note for one task, for the next one to start from (H-31).
   *
   * §6.2's "a handoff, not a transcript": the next task gets what this one decided, rejected and left
   * pending — not its conversation. A session of its own, like the commit message, so the note costs
   * no turn of the step it is about. An empty answer means the caller keeps what it had.
   */
  async handoff(input: {
    directory?: string
    task: string
    answer: string
    /** The model to write it on; absent, the engine's default (CL-2 moves it to a run's fallback). */
    model?: { providerID: string; id: string; variant?: string }
    onSession?: (sessionID: string) => void
  }): Promise<string> {
    const session = await this.createSession({
      ...(input.directory ? { directory: input.directory } : {}),
      title: `${input.task} — handoff`,
    })
    input.onSession?.(session.id)
    await this.prompt({
      sessionID: session.id,
      ...(input.directory ? { directory: input.directory } : {}),
      ...(input.model ? { model: input.model } : {}),
      text: [
        "Summarise this step for the next one.",
        "Answer with at most 15 lines under these headings, facts only, no preamble:",
        "Decided, Rejected, Risks, Files, Pending.",
        "",
        `Step: ${input.task}`,
        input.answer,
      ].join("\n"),
    })
    await this.waitForIdle(session.id, { timeoutMs: 120_000 })
    return (await this.lastAnswer(session.id))?.text?.trim() ?? ""
  }

  /** What the session answered last, and what the turn cost. */
  async lastAnswer(sessionID: string) {
    return (await this.v2()).lastAnswer(sessionID)
  }
}
