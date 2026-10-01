import { OpenCode, type SessionMessageInfo } from "@opencode/client"
import { basename } from "node:path"
import { pathToFileURL } from "node:url"
import { detailOf, type Activity, type PermissionRule, type TranscriptMessage } from "./engine"

/**
 * What `Engine` does on an OpenCode 2 engine (V2-26), through its generated `@opencode/client`.
 *
 * 2.x has one runtime, so everything the 1.x code split between the legacy routes and `/api` goes
 * through `/api` here: a session is created with its location, permissions and metadata; a prompt is
 * admitted into the session's inbox, with the agent and the model selected on the session first
 * (2.x keeps them as session state, not per prompt); a running turn is in `session.active`, and it
 * is stopped with `interrupt`. Its messages are already one transcript, which is translated into the
 * legacy shape the rest of this server reads.
 *
 * Two things change meaning. A session has no `parentID` to be created under, so a task's session
 * carries its run's session in `metadata.parentID` instead. And the `bash` permission is `shell` in
 * 2.x, so rules are renamed on the way in.
 */
export class V2Engine {
  private readonly client: ReturnType<typeof OpenCode.make>

  constructor(url: string, authorization?: string) {
    this.client = OpenCode.make({ baseUrl: url, ...(authorization ? { headers: { authorization } } : {}) })
  }

  async createSession(input: { directory?: string; parentID?: string; title?: string; permission?: PermissionRule[] }) {
    const session = await call(
      this.client.session.create({
        ...(input.directory ? { location: { directory: input.directory } } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.permission ? { permissions: input.permission.map(toRule) } : {}),
        ...(input.parentID ? { metadata: { parentID: input.parentID } } : {}),
      }),
    )
    return { id: session.id }
  }

  async deleteSession(sessionID: string) {
    await call(this.client.session.remove({ sessionID }))
  }

  /** `undefined` for a session the engine does not have, as the 1.x code answers a 4xx. */
  async describeSession(sessionID: string) {
    const session = await this.client.session.get({ sessionID }).catch((cause: unknown) => {
      if ((cause as { _tag?: string })?._tag === "SessionNotFoundError") return undefined
      throw failure(cause)
    })
    if (!session) return undefined
    const parentID = session.parentID ?? (session.metadata as { parentID?: unknown } | undefined)?.parentID
    return {
      directory: session.location.directory,
      title: session.title ?? "",
      ...(typeof parentID === "string" ? { parentID } : {}),
      createdAt: session.time.created,
    }
  }

  async messages(sessionID: string): Promise<TranscriptMessage[]> {
    return (await this.transcript(sessionID)).flatMap(toTranscriptMessage)
  }

  async rename(sessionID: string, title: string) {
    await call(this.client.session.update({ sessionID, title }))
  }

  async createWorktree(input: { directory?: string; name?: string }) {
    const location = await call(
      this.client.location.get(input.directory ? { location: { directory: input.directory } } : {}),
    )
    const worktree = await call(
      this.client.worktree.create({ projectID: location.project.id, ...(input.name ? { name: input.name } : {}) }),
    )
    // 2.x answers with the folder alone, which is all the runner keeps of it.
    return { name: input.name ?? basename(worktree.directory), directory: worktree.directory }
  }

  async removeWorktree(input: { directory: string; project?: string }) {
    const location = await call(this.client.location.get({ location: { directory: input.project ?? input.directory } }))
    await call(this.client.worktree.remove({ projectID: location.project.id, directory: input.directory, force: true }))
  }

  /** The 1.x guarantee on 2.x's routes: every server not disabled is connected, or the run fails. */
  async mcpServers(directory: string) {
    return (await call(this.client.mcp.list({ location: { directory } }))).data.map((server) => ({
      name: server.name,
      status: server.status.status,
    }))
  }

  async connectMcp(name: string, directory: string) {
    await call(this.client.mcp.connect({ server: name, location: { directory } }))
  }

  async prompt(input: {
    sessionID: string
    text: string
    agent?: string
    model?: { providerID: string; id: string; variant?: string }
    files?: Array<{ path: string; filename?: string }>
  }) {
    if (input.model) await call(this.client.session.switchModel({ sessionID: input.sessionID, model: input.model }))
    if (input.agent) await call(this.client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent }))
    await call(
      this.client.session.prompt({
        sessionID: input.sessionID,
        text: input.text,
        ...(input.files?.length
          ? {
              files: input.files.map((file) => ({
                uri: pathToFileURL(file.path).toString(),
                ...(file.filename ? { name: file.filename } : {}),
              })),
            }
          : {}),
      }),
    )
  }

  async isBusy(sessionID: string) {
    return sessionID in (await call(this.client.session.active()))
  }

  async interrupt(sessionID: string) {
    await call(this.client.session.interrupt({ sessionID }))
  }

  /** The tool call the session's last assistant message is still inside, if any. */
  async activity(sessionID: string): Promise<Activity | undefined> {
    const assistant = (await this.transcript(sessionID)).findLast((message) => message.type === "assistant")
    if (assistant?.type !== "assistant") return undefined
    const running = assistant.content.findLast((item) => item.type === "tool" && item.state.status === "running")
    if (running?.type !== "tool" || running.state.status !== "running") return undefined
    return {
      tool: running.name,
      detail: detailOf(running.state.input),
      since: running.time.ran ?? running.time.created,
    }
  }

  /**
   * What the last turn answered, and what it cost. 2.x writes one assistant message per step, so the
   * answer is the last one's text and the cost is every step's since the turn's prompt.
   */
  async lastAnswer(sessionID: string) {
    const messages = await this.transcript(sessionID)
    const start = messages.findLastIndex((message) => message.type === "user") + 1
    const steps = messages.slice(start).flatMap((message) => (message.type === "assistant" ? [message] : []))
    const last = steps.at(-1)
    if (!last) return undefined
    const text = last.content
      .flatMap((item) => (item.type === "text" && item.text ? [item.text] : []))
      .join("\n")
      .trim()
    const tokens = steps.reduce((sum, step) => sum + (step.tokens?.input ?? 0) + (step.tokens?.output ?? 0), 0)
    const cost = steps.reduce((sum, step) => sum + Number(step.cost ?? 0), 0)
    return { text: text || undefined, tokens: tokens || undefined, cost }
  }

  /** Every message, oldest first: 2.x pages newest first. */
  private async transcript(sessionID: string) {
    const pages: SessionMessageInfo[] = []
    let cursor: string | undefined
    do {
      const page = await call(this.client.message.list({ sessionID, limit: 200, cursor }))
      pages.push(...page.data)
      cursor = page.data.length === 200 ? (page.cursor.next ?? undefined) : undefined
    } while (cursor)
    return pages.reverse()
  }
}

/** A 1.x rule as a 2.x one: same meaning, 2.x names, and `bash` is `shell`. */
function toRule(rule: PermissionRule) {
  return {
    action: rule.permission === "bash" ? "shell" : rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }
}

/** A 2.x message in the legacy shape the runner, replay and the drafter read. */
function toTranscriptMessage(message: SessionMessageInfo): TranscriptMessage[] {
  if (message.type === "user") return [{ info: { role: "user" }, parts: [{ type: "text", text: message.text }] }]
  if (message.type === "synthetic")
    return [{ info: { role: "user" }, parts: [{ type: "text", text: message.text, synthetic: true }] }]
  if (message.type !== "assistant") return []
  return [
    {
      info: {
        role: "assistant",
        agent: message.agent,
        model: {
          providerID: message.model.providerID,
          modelID: message.model.id,
          ...(message.model.variant ? { variant: message.model.variant } : {}),
        },
        ...(message.cost !== undefined ? { cost: Number(message.cost) } : {}),
        ...(message.tokens ? { tokens: message.tokens } : {}),
        ...(message.error ? { error: message.error } : {}),
      },
      parts: message.content.map((item) =>
        item.type === "tool" ? { type: "tool" } : { type: item.type, text: item.text },
      ),
    },
  ]
}

async function call<T>(request: Promise<T>) {
  return request.catch((cause: unknown) => {
    throw failure(cause)
  })
}

/** The engine's own message, as `unwrap` gives it on 1.x. */
function failure(cause: unknown) {
  const message = (cause as { message?: unknown })?.message
  return new Error(typeof message === "string" && message ? message : "Engine request failed")
}
