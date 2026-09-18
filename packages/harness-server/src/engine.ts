import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { basename } from "node:path"
import { pathToFileURL } from "node:url"

type Result<T> = { data?: T; error?: unknown }

export const unwrap = async <T>(call: Promise<Result<T>>) => {
  const result = await call
  if (result.error !== undefined && result.error !== null) {
    const error = result.error as { message?: string }
    throw new Error(error.message ?? "Engine request failed")
  }
  if (result.data === undefined) throw new Error("Engine returned no data")
  return result.data
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

export type Activity = { tool: string; detail?: string; since?: number }

/** A session-level permission rule, in the shape the legacy runtime reads them. */
export type PermissionRule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" }

/**
 * A run confined to the project it runs in (H-47).
 *
 * `external_directory` is the engine's own name for "a path outside this project", asked for by
 * `read`, `write`, `edit`, `glob`, `grep`, `apply_patch` and `lsp` before they touch one. Denying it
 * turns the ask into a refusal the tool reports back to the model, with nobody prompted.
 *
 * **It does not cover the shell.** The shell tool does not call that check — verified by reading
 * which tools import `assertExternalDirectory` — so a command can still read outside the project.
 * This is said on screen rather than papered over: a confinement claimed and not delivered is worse
 * than one that states its edge.
 */
export const CONFINED: PermissionRule[] = [{ permission: "external_directory", pattern: "*", action: "deny" }]

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
 * A tool call, in either shape the engine reports one.
 *
 * The legacy `/session/:id/message` — the one every run's turn goes through — names the tool in
 * `tool` and times it in `state.time.start`. The v2 types in the SDK say `name` and `time.ran`.
 * Coding against the types alone reads `undefined` for both against a real engine, which is what
 * happened here.
 */
type RunningToolPart = {
  tool?: string
  name?: string
  state?: { status?: string; input?: Record<string, unknown>; time?: { start?: number; end?: number } }
  time?: { created?: number; ran?: number; completed?: number }
}

export const toolNameOf = (part: RunningToolPart) => part.tool ?? part.name
export const toolStartOf = (part: RunningToolPart) => part.state?.time?.start ?? part.time?.ran ?? part.time?.created

export const isRunningTool = (part: unknown): part is RunningToolPart => {
  const tool = part as RunningToolPart | undefined
  if (!tool || tool.state?.status !== "running") return false
  if (tool.state?.time?.end !== undefined || tool.time?.completed !== undefined) return false
  return typeof toolNameOf(tool) === "string"
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

export class Engine {
  private readonly client: ReturnType<typeof createOpencodeClient>

  constructor(readonly url: string) {
    this.client = createOpencodeClient({ baseUrl: url })
  }

  /**
   * A session of its own, created through the legacy runtime like everything else here.
   *
   * `parentID` is why: the v2 create takes the field and does nothing with it — a run whose tasks
   * passed it still had no children, checked against the engine — while the legacy one is what the
   * app itself uses to put a session under another. The agent and the model are not given here
   * because the prompt carries them.
   */
  async createSession(input: {
    directory?: string
    parentID?: string
    title?: string
    /**
     * Rules the session runs under (H-47).
     *
     * Passed to the legacy `session.create`, which is where they belong: the legacy runtime merges
     * `agent.permission` with the session's own and evaluates them on every tool call, so a `deny`
     * here stops the call without asking anybody. Verified in `opencode/src/session/tools.ts` and
     * `permission/index.ts` before being relied on.
     */
    permission?: PermissionRule[]
  }) {
    return (await unwrap(
      this.client.session.create({
        ...(input.parentID ? { parentID: input.parentID } : {}),
        ...(input.directory ? { directory: input.directory } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.permission ? { permission: input.permission } : {}),
      }),
    )) as { id: string }
  }

  rename(sessionID: string, title: string) {
    return unwrap(this.client.session.update({ sessionID, title }))
  }

  /**
   * Ask, through the legacy runtime — the one every Code and Chat turn goes to since H-01, where
   * subagents, MCP, retries and titles live, and where a question or permission raised by this work
   * can be answered from the app at all. It returns before the turn does.
   */
  prompt(input: {
    sessionID: string
    text: string
    directory?: string
    agent?: string
    model?: { providerID: string; id: string; variant?: string }
    /**
     * Files to hand the turn as parts (H-31), read by the engine's own Read tool.
     *
     * A path is not text: a `file` part with a `file://` URL is how the engine puts a file's contents
     * in front of the model, and a path typed into the message would not be.
     */
    files?: Array<{ path: string; filename?: string }>
  }) {
    return unwrap(
      this.client.session.promptAsync({
        sessionID: input.sessionID,
        ...(input.directory ? { directory: input.directory } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model
          ? {
              model: { providerID: input.model.providerID, modelID: input.model.id },
              ...(input.model.variant ? { variant: input.model.variant } : {}),
            }
          : {}),
        parts: [
          { type: "text", text: input.text },
          ...(input.files ?? []).map((file) => ({
            type: "file" as const,
            mime: "text/plain",
            url: pathToFileURL(file.path).toString(),
            filename: file.filename ?? basename(file.path),
          })),
        ],
      }),
    )
  }

  /**
   * Whether the engine is still working on this session. A legacy turn never appears in
   * `/api/session/active` — measured against a local engine — so the folder's own status map answers
   * for it, and the v2 list is only the fallback when there is no folder to ask.
   */
  async isBusy(sessionID: string, directory?: string) {
    if (directory) {
      const status = (await unwrap(this.client.session.status({ directory })).catch(() => undefined)) as
        | Record<string, { type?: string } | undefined>
        | undefined
      if (status) {
        const state = status[sessionID]?.type
        return state === "busy" || state === "retry"
      }
    }
    const active = await unwrap(this.client.v2.session.active()).catch(() => undefined)
    const running = active?.data as Record<string, unknown> | undefined
    return running ? sessionID in running : false
  }

  /**
   * Wait for the turn to end.
   *
   * Not with `session.wait`: the engine answers 503 for it, and a run whose work had finished was
   * marked failed because of it. And "not busy yet" reads exactly like "already finished", so the
   * session is given a moment to appear busy first — without it, a turn slower to start than the
   * first check would be called a success before doing anything. One that finishes inside that
   * window never appears, and the wait ends on its first check.
   */
  async waitForIdle(
    sessionID: string,
    options: {
      directory?: string
      stopped?: () => boolean
      timeoutMs?: number
      toolLimitMs?: number
      /** Only tests set these; production uses the constants above. */
      pollMs?: number
      checkEveryMs?: number
      settleMs?: number
    } = {},
  ) {
    const stopped = options.stopped ?? (() => false)
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000)
    const pollMs = options.pollMs ?? 1000
    const checkEveryMs = options.checkEveryMs ?? CHECK_EVERY_MS
    const settleUntil = Date.now() + (options.settleMs ?? 3000)
    while (Date.now() < settleUntil) {
      if (stopped()) return
      if (await this.isBusy(sessionID, options.directory)) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, pollMs)))
    }
    // Only when a limit was declared: asking for the transcript every few seconds costs a request
    // per poll, and a run with no ceiling has nothing to check it against.
    let nextCheck = options.toolLimitMs ? Date.now() + checkEveryMs : Infinity
    while (Date.now() < deadline) {
      if (stopped()) return
      if (!(await this.isBusy(sessionID, options.directory))) return
      if (Date.now() >= nextCheck) {
        nextCheck = Date.now() + checkEveryMs
        const overrun = await this.overrunning(sessionID, options.directory, options.toolLimitMs!)
        if (overrun) {
          // Stopped, not left to the thirty-minute cap. The turn is aborted first so the engine
          // stops working before the task is written down as stopped.
          await this.interrupt(sessionID, options.directory).catch(() => undefined)
          throw overrun
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    throw new Error("The work was still running after 30 minutes")
  }

  /** The running tool call, if it has been running longer than this run allows. */
  private async overrunning(sessionID: string, directory: string | undefined, limitMs: number) {
    const doing = await this.activity(sessionID, directory).catch(() => undefined)
    // No start time means the engine did not say when it began. Stopping a task on a guess is worse
    // than letting the thirty-minute cap have it.
    if (!doing?.since) return undefined
    const waited = Date.now() - doing.since
    return waited > limitMs ? new ToolLimitReached(doing.tool, waited, limitMs) : undefined
  }

  /** Stop the turn where it runs: a legacy one is aborted per folder, not interrupted by id. */
  async interrupt(sessionID: string, directory?: string) {
    if (directory) {
      const aborted = await unwrap(this.client.session.abort({ sessionID, directory })).then(
        () => true,
        () => false,
      )
      if (aborted) return
    }
    await unwrap(this.client.v2.session.interrupt({ sessionID })).catch(() => undefined)
  }

  /**
   * What the session answered last, and what the turn cost.
   *
   * Read from the legacy message table, because that is where a legacy turn writes: `/api/session/:id/message`
   * stays empty for one. Tokens and cost come from the assistant message the engine wrote them on.
   */
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
  async activity(sessionID: string, directory?: string): Promise<Activity | undefined> {
    const messages = (await unwrap(
      this.client.session.messages({ sessionID, ...(directory ? { directory } : {}) }) as Promise<Result<unknown>>,
    ).catch(() => undefined)) as Array<{ info?: { role?: string }; parts?: unknown[] }> | undefined
    const assistant = [...(messages ?? [])].reverse().find((message) => message.info?.role === "assistant")
    if (!assistant) return undefined
    // The last one that has started and not finished. Tools run one at a time in a turn, but taking
    // the last is right either way: it is the one the turn is currently inside.
    const running = [...(assistant.parts ?? [])].reverse().find((part) => isRunningTool(part))
    if (!running) return undefined
    const tool = running as RunningToolPart
    return { tool: toolNameOf(tool)!, detail: detailOf(tool.state?.input), since: toolStartOf(tool) }
  }

  /**
   * A commit message for a diff, from a session of its own.
   *
   * Not a turn in the reader's session: the whole point of H-20 was that committing should not spend
   * the conversation's context. The prompt is the diff and the instruction to answer with the message
   * alone, and the session is a throwaway with no folder history behind it.
   */
  async commitMessage(input: { directory?: string; diff: string }): Promise<string> {
    const session = await this.createSession({
      ...(input.directory ? { directory: input.directory } : {}),
      title: "Commit message",
    })
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
    await this.waitForIdle(session.id, { directory: input.directory, timeoutMs: 120_000 })
    const answer = await this.lastAnswer(session.id, input.directory)
    return (answer?.text ?? "").trim()
  }

  /**
   * A closing note for one task, for the next one to start from (H-31).
   *
   * §6.2's "a handoff, not a transcript": the next task gets what this one decided, rejected and left
   * pending — not its conversation. A session of its own, like the commit message, so the note costs
   * no turn of the step it is about. An empty answer means the caller keeps what it had.
   */
  async handoff(input: { directory?: string; task: string; answer: string }): Promise<string> {
    const session = await this.createSession({
      ...(input.directory ? { directory: input.directory } : {}),
      title: `${input.task} — handoff`,
    })
    await this.prompt({
      sessionID: session.id,
      ...(input.directory ? { directory: input.directory } : {}),
      text: [
        "Summarise this step for the next one.",
        "Answer with at most 15 lines under these headings, facts only, no preamble:",
        "Decided, Rejected, Risks, Files, Pending.",
        "",
        `Step: ${input.task}`,
        input.answer,
      ].join("\n"),
    })
    await this.waitForIdle(session.id, { directory: input.directory, timeoutMs: 120_000 })
    return (await this.lastAnswer(session.id, input.directory))?.text?.trim() ?? ""
  }

  async lastAnswer(sessionID: string, directory?: string) {
    const messages = (await unwrap(
      this.client.session.messages({ sessionID, ...(directory ? { directory } : {}) }) as Promise<Result<unknown>>,
    ).catch(() => undefined)) as
      | Array<{
          info?: { role?: string; tokens?: { input?: number; output?: number }; cost?: number }
          parts?: Array<{ type?: string; text?: string }>
        }>
      | undefined
    const assistant = [...(messages ?? [])].reverse().find((message) => message.info?.role === "assistant")
    if (!assistant) return undefined
    const text = (assistant.parts ?? [])
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n")
      .trim()
    const tokens = (assistant.info?.tokens?.input ?? 0) + (assistant.info?.tokens?.output ?? 0)
    return { text: text || undefined, tokens: tokens || undefined, cost: assistant.info?.cost }
  }
}
