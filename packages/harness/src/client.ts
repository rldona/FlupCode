import type { ModelV2Info, SessionV2Info } from "@opencode-ai/sdk/v2/client"
import type { AssistantMessage, Message, Part, ReasoningPart, TextPart, ToolPart, ToolState } from "@opencode-ai/sdk/v2/client"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { McpServer, SessionInfo, SessionMessageInfo, SessionMessagesResponse } from "./engine-types"

const DEFAULT_SERVER_URL = "http://localhost:4096"

export function resolveServerUrl() {
  const configured = import.meta.env.VITE_OPENCODE_SERVER_URL
  if (typeof configured === "string" && configured.length > 0) return configured
  return DEFAULT_SERVER_URL
}

async function* subscribeEvents(baseUrl: string, signal?: AbortSignal) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/event`, {
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
          yield JSON.parse(data) as { type?: string }
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
      agent: info.agent,
      content,
      error: info.error,
    } as unknown as SessionMessageInfo
  })
}

export function createClient(baseUrl = resolveServerUrl()) {
  const client = createOpencodeClient({ baseUrl })

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
      switchModel: (input: { sessionID: string; model: { id: string; providerID: string; variant?: string } }) =>
        unwrap(client.v2.session.switchModel({ sessionID: input.sessionID, model: input.model })),
      switchAgent: (input: { sessionID: string; agent: string }) =>
        unwrap(client.v2.session.switchAgent({ sessionID: input.sessionID, agent: input.agent })),
      revert: {
        stage: (input: { sessionID: string; messageID: string; files?: boolean }) =>
          unwrap(client.v2.session.revert.stage({ sessionID: input.sessionID, messageID: input.messageID, files: input.files })),
        clear: (input: { sessionID: string }) => unwrap(client.v2.session.revert.clear({ sessionID: input.sessionID })),
        commit: (input: { sessionID: string }) => unwrap(client.v2.session.revert.commit({ sessionID: input.sessionID })),
      },
      permission: {
        list: (input: { sessionID: string }) => unwrap(client.v2.session.permission.list({ sessionID: input.sessionID })),
        reply: (input: { sessionID: string; requestID: string; reply: "once" | "always" | "reject"; message?: string }) =>
          unwrap(client.v2.session.permission.reply(input)),
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
        const body = (await unwrap(client.session.fork({ sessionID: input.sessionID, messageID: input.messageID }))) as unknown as {
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
    },
    message: {
      list: async (input: { sessionID: string; order?: "asc" | "desc" }) => {
        const v2 = await unwrap(client.v2.session.messages({ sessionID: input.sessionID, order: input.order }))
        if ((v2?.data?.length ?? 0) > 0) return v2
        const legacy = await unwrap(client.session.messages({ sessionID: input.sessionID }))
        return { data: fromLegacy(legacy ?? []), cursor: {} } as SessionMessagesResponse
      },
    },
    model: {
      list: (input?: LocationInput) => unwrap(client.v2.model.list(input)),
      default: async () => ({ data: undefined as ModelV2Info | undefined }),
    },
    provider: {
      list: (input?: LocationInput) => unwrap(client.v2.provider.list(input)),
    },
    auth: {
      set: (input: { providerID: string; key: string }) =>
        unwrap(client.auth.set({ providerID: input.providerID, auth: { type: "api", key: input.key } })),
      remove: (input: { providerID: string }) => unwrap(client.auth.remove({ providerID: input.providerID })),
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
        unwrap(client.v2.fs.find({ query: input.query, limit: input.limit !== undefined ? String(input.limit) : undefined })),
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
