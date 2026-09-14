import type { ModelV2Info, SessionV2Info } from "@opencode-ai/sdk/v2/client"
import type {
  AssistantMessage,
  Message,
  Part,
  ReasoningPart,
  TextPart,
  ToolPart,
  ToolState,
} from "@opencode-ai/sdk/v2/client"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { McpServer, SessionInfo, SessionMessageInfo, SessionMessagesResponse } from "./engine-types"
import { engineFetch } from "./transport"
import { SUGGESTION_SESSION_TITLE } from "./reply-suggestion"
import { chatFileParts } from "./chat"

const DEFAULT_SERVER_URL = "http://localhost:4096"
/** The largest page of v2 messages the engine returns. */
const MESSAGE_PAGE = 200

export function resolveServerUrl() {
  const configured = import.meta.env.VITE_OPENCODE_SERVER_URL
  if (typeof configured === "string" && configured.length > 0) return configured
  return DEFAULT_SERVER_URL
}

async function* subscribeEvents(baseUrl: string, signal?: AbortSignal, path = "/api/event") {
  const response = await engineFetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    headers: { Accept: "text/event-stream" },
    signal,
  })
  if (!response.ok || !response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n")
    let index = buffer.indexOf("\n\n")
    while (index !== -1) {
      const chunk = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
      if (data) {
        try {
          const event = JSON.parse(data) as { type?: string; data?: unknown; properties?: unknown }
          // Folder streams use the legacy shape, with the payload under `properties`.
          yield (event.data === undefined && event.properties !== undefined
            ? { ...event, data: event.properties }
            : event) as { type?: string }
        } catch {
          // ignore malformed frames
        }
      }
      index = buffer.indexOf("\n\n")
    }
  }
}

type LocationInput = { location?: { directory?: string; workspace?: string } }
type Result<T> = { data?: T; error?: unknown }

async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const result = await call
  if (result.error !== undefined && result.error !== null) {
    const error = result.error as { message?: string }
    throw new Error(error?.message ?? "Request failed")
  }
  return result.data as T
}

function toolOutput(state: ToolState) {
  if (state.status === "completed") return [{ type: "text", text: state.output }]
  return undefined
}

function fromLegacy(entries: Array<{ info: Message; parts: Part[] }>): SessionMessageInfo[] {
  return entries.map((entry) => {
    if (entry.info.role === "user") {
      const text = entry.parts
        .filter((part): part is TextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      return { id: entry.info.id, type: "user", time: entry.info.time, text } as unknown as SessionMessageInfo
    }

    const info = entry.info as AssistantMessage
    const content = entry.parts.flatMap((part): unknown[] => {
      if (part.type === "text") return [{ type: "text", text: part.text }]
      if (part.type === "reasoning") return [{ type: "reasoning", text: part.text }]
      if (part.type !== "tool") return []
      const tool = part as ToolPart
      return [
        {
          type: "tool",
          name: tool.tool,
          state: {
            status: tool.state.status,
            input: "input" in tool.state ? tool.state.input : undefined,
            content: toolOutput(tool.state),
            error: tool.state.status === "error" ? { message: tool.state.error } : undefined,
          },
        },
      ]
    })
    return {
      id: info.id,
      type: "assistant",
      time: info.time,
      agent: info.agent,
      model: info.modelID ? { providerID: info.providerID, id: info.modelID } : undefined,
      content,
      error: info.error,
    } as unknown as SessionMessageInfo
  })
}

const created = (message: SessionMessageInfo) => (message as { time?: { created?: number } }).time?.created ?? 0

/**
 * A session can hold history in both message stores: the legacy one (written by the TUI and older
 * clients) and v2 (written by FlupCode prompts). They never share messages, so show both in order.
 */
export function mergeTranscripts(v2: SessionMessageInfo[], legacy: SessionMessageInfo[]) {
  if (legacy.length === 0) return v2
  if (v2.length === 0) return legacy
  return [...legacy, ...v2]
    .map((message, index) => ({ message, index }))
    .sort((a, b) => created(a.message) - created(b.message) || a.index - b.index)
    .map((entry) => entry.message)
}

/**
 * Legacy history per session. It only changes when a legacy client writes to it (which emits
 * `message.*` events), while the app refetches messages on every event, so it is cached until then.
 */
const legacyHistory = new Map<string, Promise<SessionMessageInfo[]>>()

/** Drops cached legacy history for a session, or for every session when none is given. */
export function invalidateLegacyHistory(sessionID?: string) {
  if (!sessionID) return legacyHistory.clear()
  ;[...legacyHistory.keys()].filter((key) => key.endsWith(`::${sessionID}`)).forEach((key) => legacyHistory.delete(key))
}

export function createClient(baseUrl = resolveServerUrl()) {
  const client = createOpencodeClient({ baseUrl, fetch: ((request: Request) => engineFetch(request)) as typeof fetch })

  return {
    health: {
      get: async () => {
        const result = await unwrap<{ healthy?: boolean; version?: string }>(
          client.v2.health.get() as Promise<Result<{ healthy?: boolean; version?: string }>>,
        )
        return { healthy: result?.healthy ?? true, version: result?.version }
      },
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => subscribeEvents(baseUrl, options?.signal),
      /** One folder's full event stream: legacy runs (chats) only stream their deltas and status here. */
      subscribeDirectory: (directory: string, options?: { signal?: AbortSignal }) =>
        subscribeEvents(baseUrl, options?.signal, `/event?directory=${encodeURIComponent(directory)}`),
    },
    /** The engine's own folders; chats live in `state`, which always exists on the engine's machine. */
    paths: async () => {
      const response = await engineFetch(`${baseUrl.replace(/\/$/, "")}/path`)
      if (!response.ok) throw new Error("Request failed")
      return (await response.json()) as { home: string; state: string; config: string; directory: string }
    },
    session: {
      list: (input?: { order?: "asc" | "desc"; limit?: number }) =>
        unwrap(client.v2.session.list({ ...input, limit: input?.limit ?? 200 })),
      create: async (input?: {
        model?: { id: string; providerID: string; variant?: string }
        location?: { directory: string }
        agent?: string
      }) => {
        const body = { ...input }
        if (!body.model && !body.location && !body.agent) body.agent = "build"
        return (await unwrap(client.v2.session.create(body))).data
      },
      prompt: (input: {
        sessionID: string
        text: string
        id?: string
        files?: Array<{ uri: string; name?: string }>
        delivery?: "steer" | "queue"
      }) =>
        unwrap(
          client.v2.session.prompt({
            sessionID: input.sessionID,
            id: input.id,
            delivery: input.delivery,
            prompt: {
              text: input.text,
              ...(input.files && input.files.length > 0
                ? { files: input.files.map((file) => ({ uri: file.uri, name: file.name })) }
                : {}),
            },
          }),
        ),
      wait: (input: { sessionID: string }) => unwrap(client.v2.session.wait({ sessionID: input.sessionID })),
      compact: (input: { sessionID: string }) => unwrap(client.v2.session.compact({ sessionID: input.sessionID })),
      interrupt: (input: { sessionID: string }) => unwrap(client.v2.session.interrupt({ sessionID: input.sessionID })),
      /** Sends a chat message: the legacy prompt is the one that takes a system prompt. See chat.ts. */
      chat: (input: {
        sessionID: string
        directory: string
        text: string
        system: string
        files?: Array<{ uri: string; name?: string }>
        model?: { providerID: string; id: string; variant?: string }
      }) =>
        unwrap(
          client.session.promptAsync({
            sessionID: input.sessionID,
            directory: input.directory,
            system: input.system,
            ...(input.model
              ? {
                  model: { providerID: input.model.providerID, modelID: input.model.id },
                  ...(input.model.variant ? { variant: input.model.variant } : {}),
                }
              : {}),
            parts: [{ type: "text", text: input.text }, ...chatFileParts(input.files ?? [])],
          }),
        ),
      /** Stops a chat's legacy run. */
      abort: (input: { sessionID: string; directory: string }) =>
        unwrap(client.session.abort({ sessionID: input.sessionID, directory: input.directory })),
      switchModel: (input: { sessionID: string; model: { id: string; providerID: string; variant?: string } }) =>
        unwrap(client.v2.session.switchModel({ sessionID: input.sessionID, model: input.model })),
      switchAgent: (input: { sessionID: string; agent: string }) =>
        unwrap(client.v2.session.switchAgent({ sessionID: input.sessionID, agent: input.agent })),
      setPermission: async (input: {
        sessionID: string
        permission: Array<{ permission: string; pattern: string; action: "allow" | "ask" | "deny" }>
        directory?: string
      }) => {
        const base = baseUrl.replace(/\/$/, "")
        const query = input.directory ? `?directory=${encodeURIComponent(input.directory)}` : ""
        const response = await engineFetch(`${base}/session/${input.sessionID}${query}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permission: input.permission }),
        })
        if (!response.ok) throw new Error("Request failed")
        return (await response.json()) as SessionV2Info
      },
      revert: {
        stage: (input: { sessionID: string; messageID: string; files?: boolean }) =>
          unwrap(
            client.v2.session.revert.stage({
              sessionID: input.sessionID,
              messageID: input.messageID,
              files: input.files,
            }),
          ),
        clear: (input: { sessionID: string }) => unwrap(client.v2.session.revert.clear({ sessionID: input.sessionID })),
        commit: (input: { sessionID: string }) =>
          unwrap(client.v2.session.revert.commit({ sessionID: input.sessionID })),
      },
      permission: {
        list: (input: { sessionID: string }) =>
          unwrap(client.v2.session.permission.list({ sessionID: input.sessionID })),
        reply: (input: {
          sessionID: string
          requestID: string
          reply: "once" | "always" | "reject"
          message?: string
        }) => unwrap(client.v2.session.permission.reply(input)),
      },
      question: {
        list: (input: { sessionID: string }) => unwrap(client.v2.session.question.list({ sessionID: input.sessionID })),
        reply: (input: { sessionID: string; requestID: string; answers: string[][] }) =>
          unwrap(
            client.v2.session.question.reply({
              sessionID: input.sessionID,
              requestID: input.requestID,
              questionV2Reply: { answers: input.answers },
            }),
          ),
        reject: (input: { sessionID: string; requestID: string }) =>
          unwrap(client.v2.session.question.reject({ sessionID: input.sessionID, requestID: input.requestID })),
      },
      rename: (input: { sessionID: string; title: string }) =>
        unwrap(client.session.update({ sessionID: input.sessionID, title: input.title })),
      remove: (input: { sessionID: string }) => unwrap(client.session.delete({ sessionID: input.sessionID })),
      fork: async (input: { sessionID: string; messageID?: string }) => {
        const body = (await unwrap(
          client.session.fork({ sessionID: input.sessionID, messageID: input.messageID }),
        )) as unknown as {
          id?: string
          data?: { id: string }
        }
        return (body?.id ? body : body?.data) as unknown as SessionV2Info
      },
      shell: (input: { sessionID: string; command: string }) =>
        unwrap(client.session.shell({ sessionID: input.sessionID, command: input.command })),
      command: (input: { sessionID: string; command: string; arguments?: string }) =>
        unwrap(
          client.session.command({
            sessionID: input.sessionID,
            command: input.command,
            arguments: input.arguments,
          }),
        ),
      skill: async (_input: { sessionID: string; skill: string }) => {
        throw new Error("Skills are not supported by this server version")
      },
      move: async (_input: { sessionID: string; directory: string }) => {
        throw new Error("Moving sessions is not supported by this server version")
      },
      children: async (input: { sessionID: string }) => ({
        data: (await unwrap(client.session.children({ sessionID: input.sessionID }))) as unknown as SessionInfo[],
      }),
      diff: (input: { sessionID: string }) => unwrap(client.session.diff({ sessionID: input.sessionID })),
    },
    message: {
      list: async (input: { sessionID: string; order?: "asc" | "desc" }) => {
        const key = `${baseUrl}::${input.sessionID}`
        const cached =
          legacyHistory.get(key) ??
          unwrap(client.session.messages({ sessionID: input.sessionID })).then((entries) => fromLegacy(entries ?? []))
        legacyHistory.set(key, cached)
        // The engine pages v2 messages (50 by default, 200 at most) and every tool step is a message,
        // so read every page: a first page alone hides the newest turns of a long session.
        const allV2 = async () => {
          const first = await unwrap(
            client.v2.session.messages({ sessionID: input.sessionID, order: input.order, limit: MESSAGE_PAGE }),
          )
          const data = [...(first?.data ?? [])]
          let page = first
          while (page?.data.length === MESSAGE_PAGE && page.cursor.next) {
            page = await unwrap(
              client.v2.session.messages({ sessionID: input.sessionID, cursor: page.cursor.next, limit: MESSAGE_PAGE }),
            )
            data.push(...(page?.data ?? []))
          }
          return first && { ...first, data }
        }
        const [v2, legacy] = await Promise.all([
          allV2(),
          cached.catch(() => {
            // Retry on the next refetch instead of caching the failure.
            if (legacyHistory.get(key) === cached) legacyHistory.delete(key)
            return [] as SessionMessageInfo[]
          }),
        ])
        const merged = mergeTranscripts(v2?.data ?? [], legacy)
        const data = input.order === "desc" ? [...merged].reverse() : merged
        return { ...(v2 ?? { cursor: {} }), data } as SessionMessagesResponse
      },
    },
    suggest: {
      /** The configured `small_model` ("provider/model"), when the user set one. */
      smallModel: async () => {
        const config = (await unwrap(client.config.get())) as { small_model?: string } | undefined
        const value = config?.small_model
        const slash = value?.indexOf("/") ?? -1
        return value && slash > 0 ? { providerID: value.slice(0, slash), id: value.slice(slash + 1) } : undefined
      },
      /**
       * Predicts the user's next message from the end of a conversation. The engine has no
       * session-less completion, so this runs one prompt in a throwaway child session (hidden from
       * the session list, no tools, no title call) and deletes it.
       */
      reply: async (input: {
        parentID: string
        directory?: string
        model: { providerID: string; id: string }
        prompt: string
        system: string
      }) => {
        const created = (await unwrap(
          client.session.create({
            parentID: input.parentID,
            directory: input.directory,
            title: SUGGESTION_SESSION_TITLE,
            permission: [{ permission: "*", pattern: "*", action: "deny" }],
          }),
        )) as { id: string }
        try {
          const result = (await unwrap(
            client.session.prompt({
              sessionID: created.id,
              directory: input.directory,
              agent: "compaction",
              model: { providerID: input.model.providerID, modelID: input.model.id },
              system: input.system,
              parts: [{ type: "text", text: input.prompt }],
            }),
          )) as { parts?: Array<{ type: string; text?: string }> } | undefined
          return (result?.parts ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("")
            .trim()
        } finally {
          await unwrap(client.session.delete({ sessionID: created.id, directory: input.directory })).catch(
            () => undefined,
          )
        }
      },
    },
    model: {
      list: (input?: LocationInput) => unwrap(client.v2.model.list(input)),
      directory: () => unwrap(client.config.providers()),
      default: async () => ({ data: undefined as ModelV2Info | undefined }),
    },
    provider: {
      list: (input?: LocationInput) => unwrap(client.v2.provider.list(input)),
      directory: () => unwrap(client.provider.list()),
      auth: () => unwrap(client.provider.auth()),
    },
    auth: {
      set: (input: { providerID: string; key: string }) =>
        unwrap(client.auth.set({ providerID: input.providerID, auth: { type: "api", key: input.key } })),
      remove: (input: { providerID: string }) => unwrap(client.auth.remove({ providerID: input.providerID })),
    },
    integration: {
      list: () => unwrap(client.v2.integration.list()),
      connectKey: (input: { integrationID: string; key: string; label?: string }) =>
        unwrap(
          client.v2.integration.connect.key({
            integrationID: input.integrationID,
            key: input.key,
            label: input.label,
          }),
        ),
      oauth: (input: { integrationID: string; methodID?: string; inputs?: Record<string, string>; label?: string }) =>
        unwrap(
          client.v2.integration.connect.oauth({
            integrationID: input.integrationID,
            methodID: input.methodID,
            inputs: input.inputs ?? {},
            label: input.label,
          }),
        ),
      attempt: {
        status: (attemptID: string) => unwrap(client.v2.integration.attempt.status({ attemptID })),
        cancel: (attemptID: string) => unwrap(client.v2.integration.attempt.cancel({ attemptID })),
      },
      disconnect: (credentialID: string) => unwrap(client.v2.credential.remove({ credentialID })),
    },
    agent: {
      list: (input?: LocationInput) => unwrap(client.v2.agent.list(input)),
    },
    command: {
      list: (input?: LocationInput) => unwrap(client.v2.command.list(input)),
    },
    skill: {
      list: (input?: LocationInput) => unwrap(client.v2.skill.list(input)),
    },
    file: {
      find: (input: { query: string; limit?: number }) =>
        unwrap(
          client.v2.fs.find({ query: input.query, limit: input.limit !== undefined ? String(input.limit) : undefined }),
        ),
    },
    vcs: {
      get: (directory: string) => unwrap(client.vcs.get({ directory })),
      status: (directory: string) => unwrap(client.vcs.status({ directory })),
    },
    mcp: {
      list: async () => ({ data: [] as McpServer[] }),
      add: async (_input?: { server: string; config: unknown }) => {},
      remove: async (_input?: { server: string }) => {},
      connect: async (_input?: { server: string }) => {},
      disconnect: async (_input?: { server: string }) => {},
    },
  }
}

export type HarnessClient = ReturnType<typeof createClient>
