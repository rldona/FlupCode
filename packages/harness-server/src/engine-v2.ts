import { OpenCode, type SessionInfo, type SessionMessageInfo } from "@opencode/client"
import { basename } from "node:path"
import { pathToFileURL } from "node:url"
import { detailOf, type Activity, type PendingRequest, type PermissionRule, type TranscriptMessage } from "./engine"
import type { ToolEvent, UsageEvent } from "./usage-ledger"

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

  /**
   * Every folder the engine knows as a project, and every worktree of one (TI-11). A project's
   * `sandboxes` stays empty for the worktrees the engine itself creates, so they are listed per
   * project; a folder that is not a repository has none to list.
   */
  async projectRoots() {
    const projects = await call(this.client.project.list())
    const worktrees = await Promise.all(
      projects.map((project) => this.client.worktree.list({ projectID: project.id }).catch(() => [])),
    )
    return [...projects.map((project) => project.canonical), ...worktrees.flat().map((worktree) => worktree.directory)]
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

  /**
   * Asks the reader one question in the session itself, as a form the app shows like any question: 2.x
   * gives a plugin's tool no way to ask, so a web action's approval (V2-31) and the plan's hand-off to
   * build (V2-33) are asked from here. The value of the option picked, or `undefined` when the form was
   * cancelled or nobody answered in time.
   */
  async askChoice(input: {
    sessionID: string
    title: string
    description: string
    options: Array<{ value: string; label: string; description?: string }>
    /** What the app reads to show the form as something other than a plain question (BU-01). */
    metadata?: Record<string, string>
    timeoutMs: number
  }) {
    const form = await call(
      this.client.session.form.create({
        sessionID: input.sessionID,
        title: input.title,
        metadata: input.metadata ?? { flupcode: "choice" },
        fields: [
          {
            key: "choice",
            title: input.title,
            description: input.description,
            type: "string",
            required: true,
            options: input.options,
          },
        ],
      }),
    )
    const deadline = Date.now() + input.timeoutMs
    while (Date.now() < deadline) {
      const detail = await call(this.client.session.form.get({ sessionID: input.sessionID, formID: form.id }))
      if (detail.state.status === "cancelled") return undefined
      if (detail.state.status === "answered") {
        const choice = detail.state.answer.choice
        return typeof choice === "string" ? choice : undefined
      }
      await Bun.sleep(500)
    }
    // Unanswered: the form goes, so a late answer cannot act for a caller that already gave up.
    await this.client.session.form.cancel({ sessionID: input.sessionID, formID: form.id }).catch(() => undefined)
    return undefined
  }

  /**
   * What a session, or a subagent's session under it, is waiting on a person for (RP-05): a
   * permission the engine asked or a form (the `question` tool, the plan's hand-off, a browser
   * approval). Listed for the session's folder, where a subagent asks too, and kept to this session's
   * chain; `undefined` when nothing waits.
   */
  async pendingRequest(sessionID: string, directory?: string): Promise<PendingRequest | undefined> {
    const location = directory ? { location: { directory } } : undefined
    const [permissions, forms] = await Promise.all([
      call(this.client.permission.request.list(location)),
      call(this.client.form.list(location)),
    ])
    const requests = [
      ...permissions.data.map(
        (request): PendingRequest => ({
          kind: "permission",
          id: request.id,
          sessionID: request.sessionID,
          action: request.action === "shell" ? "bash" : request.action,
          resources: request.resources,
        }),
      ),
      ...forms.data.map(
        (form): PendingRequest => ({
          kind: "form",
          id: form.id,
          sessionID: form.sessionID,
          title: form.fields.find((field) => field.type !== "external")?.description ?? form.title ?? "",
        }),
      ),
    ]
    for (const request of requests)
      if (request.sessionID === sessionID || (await this.descends(request.sessionID, sessionID))) return request
    return undefined
  }

  /** Answers a request no person will: a permission is rejected with why, a form is withdrawn. */
  async refuseRequest(request: PendingRequest, message: string) {
    if (request.kind === "permission")
      return call(
        this.client.permission.reply({ sessionID: request.sessionID, requestID: request.id, decision: "reject", message }),
      )
    await call(this.client.session.form.cancel({ sessionID: request.sessionID, formID: request.id }))
  }

  /** Whether `sessionID` is a subagent's session somewhere under `ancestor`. */
  private async descends(sessionID: string, ancestor: string) {
    let current = sessionID
    // Bounded like `rootOf`: a chain longer than any real nesting is not followed.
    for (let depth = 0; depth < 32; depth++) {
      const session = await this.client.session.get({ sessionID: current }).catch(() => undefined)
      const parentID = session?.parentID
      if (!parentID) return false
      if (parentID === ancestor) return true
      current = parentID
    }
    return false
  }

  async switchAgent(sessionID: string, agent: string) {
    await call(this.client.session.switchAgent({ sessionID, agent }))
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

  /** What the last turn answered, what it cost, and why it failed if it did (TI-02). */
  async lastAnswer(sessionID: string) {
    return answerOf(await this.transcript(sessionID))
  }

  /**
   * Every session whose last change is at or after `since` (the engine's clock), newest first, and
   * whether a turn is still running in it. The engine lists across every folder, ordered by update.
   */
  async sessionsUpdatedSince(since: number) {
    const active = await call(this.client.session.active())
    const sessions: Array<{ id: string; updated: number; busy: boolean }> = []
    let cursor: string | undefined
    do {
      const page = await call(this.client.session.list({ limit: 200, order: "desc", ...(cursor ? { cursor } : {}) }))
      const recent = page.data.filter((session) => session.time.updated >= since)
      sessions.push(
        ...recent.map((session) => ({ id: session.id, updated: session.time.updated, busy: session.id in active })),
      )
      cursor =
        page.data.length === 200 && recent.length === page.data.length ? (page.cursor.next ?? undefined) : undefined
    } while (cursor)
    return sessions
  }

  /**
   * What a session's transcript says it spent (UL-03): a row per step, failed step and compaction, and
   * one per finished tool, keyed as the session-metrics plugin keys the same facts. `undefined` for a
   * session the engine no longer has.
   */
  async sessionUsage(sessionID: string) {
    const session = await this.client.session.get({ sessionID }).catch((cause: unknown) => {
      if ((cause as { _tag?: string })?._tag === "SessionNotFoundError") return undefined
      throw failure(cause)
    })
    if (!session) return undefined
    return usageOf(session, await this.rootOf(session), await this.transcript(sessionID))
  }

  /**
   * What the usage ledger needs to know about prices and connections (UL-05), for a folder: each
   * provider's integration, the host it calls and whether its config carries a key (never the key);
   * whether each model has a price (`ModelInfo.cost` is empty for a model nobody priced, and lists a
   * $0 tier for a free one); and how each integration is connected.
   */
  async usageCatalog(directory?: string) {
    const location = directory ? { location: { directory } } : undefined
    const [providers, models, integrations] = await Promise.all([
      call(this.client.provider.list(location)),
      call(this.client.model.list(location)),
      call(this.client.integration.list()),
    ])
    return {
      providers: providers.data.map((provider) => ({
        providerID: provider.id,
        ...(provider.integrationID ? { integrationID: provider.integrationID } : {}),
        ...(typeof provider.settings?.baseURL === "string" ? { baseURL: provider.settings.baseURL } : {}),
        configKey: typeof provider.settings?.apiKey === "string" && provider.settings.apiKey.length > 0,
      })),
      models: models.data.map((model) => ({
        providerID: model.providerID,
        modelID: model.id,
        priced: model.cost.length > 0,
      })),
      integrations: integrations.data.map((integration) => ({
        integrationID: integration.id,
        connections: integration.connections.map((connection) =>
          connection.type === "env" ? ("env" as const) : connection.method,
        ),
      })),
    }
  }

  /** The session a subagent's chain starts from: itself when it has no parent. */
  private async rootOf(session: SessionInfo) {
    let root = session
    // Bounded: a chain longer than any real nesting is cut rather than followed forever.
    for (let depth = 0; root.parentID && depth < 32; depth++) {
      const parent = await this.client.session.get({ sessionID: root.parentID }).catch(() => undefined)
      if (!parent) return root.parentID
      root = parent
    }
    return root.id
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

/**
 * The last turn of a transcript, oldest first: its answer, its cost, and its failure.
 *
 * 2.x writes one assistant message per step, so the answer is the last one's text and the cost is
 * every step's since the turn's prompt. A turn that ends idle is not a turn that worked: a provider
 * refusal (a bad key, a rate limit the engine gave up retrying) leaves an assistant step with an
 * `error` and the turn's `idle` marker says `failed`. That is a failure, and so is a turn in which
 * the engine never answered at all. Steps that failed and were retried by the engine do not stay in
 * the transcript, so a recovered turn reads as the success it is.
 */
export function answerOf(messages: SessionMessageInfo[]) {
  const turn = messages.slice(messages.findLastIndex((message) => message.type === "user") + 1)
  const steps = turn.flatMap((message) => (message.type === "assistant" ? [message] : []))
  const last = steps.at(-1)
  const outcome = turn.findLast((message) => message.type === "idle")
  const text = last?.content
    .flatMap((item) => (item.type === "text" && item.text ? [item.text] : []))
    .join("\n")
    .trim()
  const tokens = steps.reduce((sum, step) => sum + (step.tokens?.input ?? 0) + (step.tokens?.output ?? 0), 0)
  const cost = steps.reduce((sum, step) => sum + Number(step.cost ?? 0), 0)
  const error = last?.error?.message?.trim()
    ? last.error.message.trim()
    : !last
      ? "The engine ended the turn without answering"
      : outcome?.type === "idle" && outcome.outcome === "failed"
        ? "The engine reported the turn as failed"
        : outcome?.type === "idle" && outcome.outcome === "interrupted"
          ? "The turn was interrupted"
          : undefined
  return { text: text || undefined, tokens: tokens || undefined, cost, ...(error ? { error } : {}) }
}

/**
 * A session's billable facts, from its transcript (UL-03).
 *
 * 2.x writes one assistant message per step, carrying its agent, model, tokens and cost, and one
 * `compaction` message per compaction, paid for even when it failed. Ids are the session, the kind and
 * the engine's message (or tool call) id, which is what the live plugin sees too, so the two paths
 * store each fact once. What a transcript cannot show is not here: the title the engine generates
 * (counted only on `SessionInfo.cost`) and a failed step the engine retried (replaced by the retry).
 *
 * A fork starts with a copy of its parent's history under new ids and its original times; that is
 * the parent's spending, so every message older than the fork itself is skipped.
 */
export function usageOf(session: SessionInfo, rootSessionID: string, messages: SessionMessageInfo[]) {
  const own = session.fork ? messages.filter((message) => message.time.created >= session.time.created) : messages
  const where = {
    ...(session.parentID ? { parentSessionID: session.parentID } : {}),
    rootSessionID,
    directory: session.location.directory,
    engineProjectID: session.projectID,
  }
  const events = own.flatMap((message): UsageEvent[] => {
    if (message.type === "compaction" && message.status !== "running")
      return [
        {
          id: `${session.id}:compaction:${message.id}`,
          kind: "compaction",
          sessionID: session.id,
          messageID: message.id,
          ...where,
          ...(message.status === "completed" && message.model
            ? {
                providerID: message.model.providerID,
                modelID: message.model.id,
                ...(message.model.variant ? { variant: message.model.variant } : {}),
              }
            : {}),
          ...priced(message.cost, message.tokens),
          startedAt: message.time.created,
          ...(message.status === "failed" ? { errorType: message.error.type } : {}),
        },
      ]
    // A step still streaming has nothing final to say yet: the next pass, once it ends, reads it.
    if (message.type !== "assistant" || (!message.finish && !message.error)) return []
    const kind = message.error ? "step_failed" : "step"
    return [
      {
        id: `${session.id}:${kind}:${message.id}`,
        kind,
        sessionID: session.id,
        messageID: message.id,
        ...where,
        agent: message.agent,
        providerID: message.model.providerID,
        modelID: message.model.id,
        ...(message.model.variant ? { variant: message.model.variant } : {}),
        ...priced(message.cost, message.tokens),
        startedAt: message.time.created,
        ...(message.time.completed !== undefined ? { endedAt: message.time.completed } : {}),
        ...(message.time.streamed !== undefined ? { firstTokenMs: message.time.streamed - message.time.created } : {}),
        ...(message.finish ? { finish: message.finish } : {}),
        ...(message.error ? { errorType: message.error.type } : {}),
        ...(message.retry ? { retryAttempt: message.retry.attempt } : {}),
      },
    ]
  })
  const tools = own.flatMap((message): ToolEvent[] =>
    message.type !== "assistant"
      ? []
      : message.content.flatMap((item) => {
          if (item.type !== "tool" || (item.state.status !== "completed" && item.state.status !== "error")) return []
          const started = item.time.ran ?? item.time.created
          return [
            {
              id: `${session.id}:tool:${item.id}`,
              sessionID: session.id,
              messageID: message.id,
              tool: item.name,
              startedAt: started,
              ms: Math.max(0, (item.time.completed ?? started) - started),
              error: item.state.status === "error",
              bytes: (item.state.content ?? []).reduce(
                (total, part) =>
                  total + ("text" in part && typeof part.text === "string" ? Buffer.byteLength(part.text) : 0),
                0,
              ),
            },
          ]
        }),
  )
  return { events, tools }
}

/** The engine's cost is its list price; a fact it put no cost on is unpriced, never $0. */
function priced(cost: number | undefined, tokens: SessionInfo["tokens"] | undefined) {
  return {
    tokens: {
      input: tokens?.input ?? 0,
      output: tokens?.output ?? 0,
      reasoning: tokens?.reasoning ?? 0,
      cacheRead: tokens?.cache.read ?? 0,
      cacheWrite: tokens?.cache.write ?? 0,
    },
    ...(cost === undefined
      ? { costBasis: "unpriced" as const }
      : { costUSD: Number(cost), costBasis: "engine-list-price" as const }),
    billing: "unknown" as const,
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
