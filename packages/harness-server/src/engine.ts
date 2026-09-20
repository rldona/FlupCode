import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

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
export type Activity = { tool: string; detail?: string; since?: number }

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
  async createSession(input: { directory?: string; parentID?: string; title?: string }) {
    return (await unwrap(
      this.client.session.create({
        ...(input.parentID ? { parentID: input.parentID } : {}),
        ...(input.directory ? { directory: input.directory } : {}),
        ...(input.title ? { title: input.title } : {}),
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
        parts: [{ type: "text", text: input.text }],
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
  async waitForIdle(sessionID: string, options: { directory?: string; stopped?: () => boolean; timeoutMs?: number } = {}) {
    const stopped = options.stopped ?? (() => false)
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000)
    const settleUntil = Date.now() + 3000
    while (Date.now() < settleUntil) {
      if (stopped()) return
      if (await this.isBusy(sessionID, options.directory)) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    while (Date.now() < deadline) {
      if (stopped()) return
      if (!(await this.isBusy(sessionID, options.directory))) return
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error("The work was still running after 30 minutes")
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
