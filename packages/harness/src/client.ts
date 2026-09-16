import type { MemoryInfo, ModelV2Info, SessionV2Info } from "@opencode-ai/sdk/v2/client"
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
import type { McpConfig } from "./types"
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

declare const __FLUPCODE_ENGINE_VERSION__: string | undefined

/**
 * The engine version this build's client was generated against, injected by Vite from
 * `@opencode-ai/sdk`. Undefined outside a Vite build (tests), where nothing is compared.
 */
export const engineTargetVersion =
  typeof __FLUPCODE_ENGINE_VERSION__ === "string" ? __FLUPCODE_ENGINE_VERSION__ : undefined

/** Why the engine is unreachable, as far as the browser can tell. */
export type ServerStatus = "online" | "offline" | "blocked"

/**
 * A request the browser blocks (CORS, mixed content, Local Network Access) rejects exactly like a
 * server that is not running, so `no-cors` tells them apart: it needs no permission to send, so an
 * opaque success means the engine is listening and something else withheld the response.
 */
export async function probeServer(baseUrl: string): Promise<ServerStatus> {
  const health = `${baseUrl.replace(/\/$/, "")}/global/health`
  const reachable = await engineFetch(health, { signal: AbortSignal.timeout(2000) }).then(
    () => true,
    () => false,
  )
  if (reachable) return "online"
  const listening = await engineFetch(health, { mode: "no-cors", signal: AbortSignal.timeout(2000) }).then(
    () => true,
    () => false,
  )
  return listening ? "blocked" : "offline"
}

/** Whether the connected engine is FlupCode's build (with its patches) or the stock OpenCode CLI. */
export type EngineProfile = "flupcode" | "stock" | "unknown"

/**
 * FlupCode's engine exposes the memory API at `/api/memory`; the stock OpenCode CLI does not, and
 * its UI catch-all answers HTML for that path. Content type, not the status code, tells them apart
 * because that catch-all also returns 200.
 */
export async function probeEngineProfile(baseUrl: string): Promise<EngineProfile> {
  const response = await engineFetch(`${baseUrl.replace(/\/$/, "")}/api/memory`, {
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined)
  if (!response) return "unknown"
  void response.body?.cancel()
  return (response.headers.get("content-type") ?? "").includes("application/json") ? "flupcode" : "stock"
}

/**
 * How long a stream may go without a single byte before it is treated as dead. The engine beats
 * every 10 seconds (`/event`) or 15 (`/api/event`), so this is three missed beats. Without it a
 * socket that dies without closing — sleep, a NAT timeout, a dropped tunnel — leaves the read
 * pending forever, which is how the app could sit on "Connected" while the engine moved on.
 */
const STREAM_IDLE_TIMEOUT = 45_000

export async function* subscribeEvents(
  baseUrl: string,
  signal?: AbortSignal,
  path = "/api/event",
  idleTimeout = STREAM_IDLE_TIMEOUT,
) {
  // Own controller so an idle stream can be dropped without touching the caller's signal, which it
  // uses to tell a stream it ended from one it should reopen.
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) controller.abort()
  const response = await engineFetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  })
  if (!response.ok || !response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let quiet = false
  while (true) {
    // Cancelling the reader, not just aborting the request, is what makes a pending read resolve:
    // a body the fetch never produced (the remote tunnel, a test transport) ignores the signal.
    const idle = setTimeout(() => {
      quiet = true
      abort()
      void reader.cancel().catch(() => undefined)
    }, idleTimeout)
    const { done, value } = await reader.read().finally(() => clearTimeout(idle))
    if (quiet) throw new Error("Event stream went quiet")
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
          yield (
            event.data === undefined && event.properties !== undefined ? { ...event, data: event.properties } : event
          ) as { type?: string }
        } catch {
          // ignore malformed frames
        }
      }
      index = buffer.indexOf("\n\n")
    }
  }
}

/**
 * `PATCH /config` merges into the engine's configuration file. The generated client has no typed
 * call for it, and the shape is open-ended, so it goes through the transport directly.
 */
async function patchConfig(baseUrl: string, patch: Record<string, unknown>) {
  const response = await engineFetch(`${baseUrl.replace(/\/$/, "")}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error(`Could not save the configuration (HTTP ${response.status})`)
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
      subscribe: (options?: { signal?: AbortSignal; idleTimeout?: number }) =>
        subscribeEvents(baseUrl, options?.signal, "/api/event", options?.idleTimeout),
      /** One folder's full event stream: legacy runs (chats) only stream their deltas and status here. */
      subscribeDirectory: (directory: string, options?: { signal?: AbortSignal; idleTimeout?: number }) =>
        subscribeEvents(
          baseUrl,
          options?.signal,
          `/event?directory=${encodeURIComponent(directory)}`,
          options?.idleTimeout,
        ),
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
        if (!body.model && !body.location && !body.agent) body.agent = "plan"
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
      /** Sessions whose run is still going, across all of its steps. */
      active: async () => new Set(Object.keys((await unwrap(client.v2.session.active()))?.data ?? {})),
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
          /** Shown to the agent when rejecting, so it can pick another way instead of guessing. */
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
      /**
       * Runs a skill. The engine has no endpoint for this: a skill is something the agent loads
       * with its `skill` tool, so asking for one is a prompt that names it. The prompt below is what
       * the TUI sends, and the agent answers it by loading the skill's instructions.
       */
      skill: (input: { sessionID: string; skill: string; arguments?: string }) =>
        unwrap(
          client.v2.session.prompt({
            sessionID: input.sessionID,
            prompt: {
              text: input.arguments
                ? `Use the ${input.skill} skill: ${input.arguments}`
                : `Use the ${input.skill} skill.`,
            },
          }),
        ),
      move: (input: { sessionID: string; directory: string }) =>
        unwrap(
          client.experimental.controlPlane.moveSession({
            sessionID: input.sessionID,
            destination: { directory: input.directory },
            moveChanges: true,
          }),
        ),
      /** A public link to the conversation, served by the engine's share host. */
      share: async (input: { sessionID: string; directory?: string }) => {
        const shared = (await unwrap(
          client.session.share({ sessionID: input.sessionID, directory: input.directory }),
        )) as unknown as { share?: { url?: string } }
        return shared?.share?.url
      },
      unshare: (input: { sessionID: string; directory?: string }) =>
        unwrap(client.session.unshare({ sessionID: input.sessionID, directory: input.directory })),
      children: async (input: { sessionID: string }) => ({
        data: (await unwrap(client.session.children({ sessionID: input.sessionID }))) as unknown as SessionInfo[],
      }),
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
      /**
       * The engine answers this one with every configured API key in the clear. Nothing in the UI
       * needs the key itself, and over remote control the answer crosses to a phone, so the keys are
       * dropped here and never reach app state, a component prop or another device.
       */
      directory: async () => {
        const result = await unwrap(client.provider.list())
        return { ...result, all: result.all.map(({ key: _key, ...provider }) => provider) }
      },
      auth: () => unwrap(client.provider.auth()),
      /**
       * Registers the API keys already in the engine's own configuration as v2 credentials, which is
       * what makes those providers usable by v2 sessions. The keys stay inside this call: the reader
       * asks for it from the providers panel, it is never done on its own.
       */
      linkConfiguredKeys: async () => {
        const directory = await unwrap(client.provider.list())
        const integrations = await unwrap(client.v2.integration.list())
        const pending = directory.all.filter(
          (provider): provider is (typeof directory.all)[number] & { key: string } =>
            provider.source === "api" &&
            !!provider.key &&
            !integrations.data
              .find((item) => item.id === provider.id)
              ?.connections?.some((connection) => connection.type === "credential"),
        )
        const linked = await Promise.all(
          pending.map((provider) =>
            unwrap(
              client.v2.integration.connect.key({
                integrationID: provider.id,
                key: provider.key,
                label: provider.id,
              }),
            ).then(
              () => true,
              () => false,
            ),
          ),
        )
        return linked.filter(Boolean).length
      },
      /** Providers whose configured key is not a v2 credential yet, by id; never carries the key. */
      unlinked: async () => {
        const directory = await unwrap(client.provider.list())
        const integrations = await unwrap(client.v2.integration.list())
        return directory.all
          .filter(
            (provider) =>
              provider.source === "api" &&
              !!provider.key &&
              !integrations.data
                .find((item) => item.id === provider.id)
                ?.connections?.some((connection) => connection.type === "credential"),
          )
          .map((provider) => provider.id)
      },
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
    /** Permissions across every session, and the ones the reader told the engine to remember. */
    permission: {
      /** Everything waiting for an answer, not just the open session's: a blocked agent is silent. */
      pending: (input?: LocationInput) => unwrap(client.v2.permission.request.list(input)),
      saved: {
        list: (input?: { projectID?: string }) => unwrap(client.v2.permission.saved.list(input)),
        remove: (input: { id: string }) => unwrap(client.v2.permission.saved.remove({ id: input.id })),
      },
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
    memory: {
      list: (input?: {
        location?: { directory?: string }
        text?: string
        scope?: MemoryInfo["scope"]
        status?: MemoryInfo["status"]
        sessionID?: string
        agent?: string
        limit?: number
      }) =>
        unwrap(
          client.v2.memory.list({
            ...(input?.location ? { location: input.location } : {}),
            ...(input?.text ? { text: input.text } : {}),
            ...(input?.scope ? { scope: input.scope } : {}),
            ...(input?.status ? { status: input.status } : {}),
            ...(input?.sessionID ? { sessionID: input.sessionID } : {}),
            ...(input?.agent ? { agent: input.agent } : {}),
            ...(input?.limit !== undefined ? { limit: String(input.limit) } : {}),
          }),
        ),
      get: (input: { id: string }) => unwrap(client.v2.memory.get({ id: input.id })),
      create: (input: {
        scope?: MemoryInfo["scope"]
        kind?: MemoryInfo["kind"]
        title: string
        content: string
        tags?: string[]
        status?: MemoryInfo["status"]
        confidence?: number
        importance?: number
        source?: MemoryInfo["source"]
        sessionID?: string
        agent?: string
      }) => unwrap(client.v2.memory.create({ memoryCreatePayload: input })),
      update: (input: {
        id: string
        title?: string
        content?: string
        kind?: MemoryInfo["kind"]
        tags?: string[]
        status?: MemoryInfo["status"]
        confidence?: number
        importance?: number
      }) =>
        unwrap(
          client.v2.memory.update({
            id: input.id,
            memoryUpdatePayload: {
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.content !== undefined ? { content: input.content } : {}),
              ...(input.kind !== undefined ? { kind: input.kind } : {}),
              ...(input.tags !== undefined ? { tags: input.tags } : {}),
              ...(input.status !== undefined ? { status: input.status } : {}),
              ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
              ...(input.importance !== undefined ? { importance: input.importance } : {}),
            },
          }),
        ),
      remove: (input: { id: string }) => unwrap(client.v2.memory.remove({ id: input.id })),
      verify: (input: { id: string }) => unwrap(client.v2.memory.verify({ id: input.id })),
      used: (input: { sessionID: string }) => unwrap(client.v2.memory.used({ sessionID: input.sessionID })),
    },
    file: {
      find: (input: { query: string; limit?: number }) =>
        unwrap(
          client.v2.fs.find({ query: input.query, limit: input.limit !== undefined ? String(input.limit) : undefined }),
        ),
      /**
       * Lists one directory level. The engine only lists inside a location, so the folder browser
       * passes the folder it browses from as the location and walks it with relative paths.
       */
      list: async (input: { directory: string; path?: string }) => {
        const result = await unwrap(
          client.v2.fs.list({ location: { directory: input.directory }, path: input.path || undefined }),
        )
        return result.data
      },
    },
    vcs: {
      get: (directory: string) => unwrap(client.vcs.get({ directory })),
      status: (directory: string) => unwrap(client.vcs.status({ directory })),
      /** Working-tree changes against HEAD, with patches; the "files changed" view. */
      diff: (directory: string) => unwrap(client.vcs.diff({ directory, mode: "git" })),
    },
    /**
     * MCP servers. The engine's `/mcp` routes drive the running instance, while the servers
     * themselves live in the configuration, so adding and removing one writes there as well —
     * otherwise a server added here would be gone the next time the engine started. Every call in
     * here used to be a no-op behind a working-looking panel.
     */
    mcp: {
      list: async () => {
        const status = (await unwrap(client.mcp.status())) as unknown as Record<string, { status?: string }>
        return {
          data: Object.entries(status ?? {}).map(([name, value]) => ({ name, status: value })) as McpServer[],
        }
      },
      add: async (input: { server: string; config: McpConfig }) => {
        const config = (await unwrap(client.config.get())) as { mcp?: Record<string, unknown> }
        await patchConfig(baseUrl, { mcp: { ...(config?.mcp ?? {}), [input.server]: input.config } })
        await unwrap(client.mcp.add({ name: input.server, config: input.config }))
      },
      remove: async (input: { server: string }) => {
        const config = (await unwrap(client.config.get())) as { mcp?: Record<string, unknown> }
        const { [input.server]: _removed, ...rest } = config?.mcp ?? {}
        await patchConfig(baseUrl, { mcp: rest })
        // The running instance keeps its copy until it restarts, so stop it talking to it now.
        await unwrap(client.mcp.disconnect({ name: input.server })).catch(() => undefined)
      },
      connect: (input: { server: string }) => unwrap(client.mcp.connect({ name: input.server })),
      disconnect: (input: { server: string }) => unwrap(client.mcp.disconnect({ name: input.server })),
    },
  }
}

export type HarnessClient = ReturnType<typeof createClient>
