import type { MemoryInfo, ModelV2Info, SessionV2Info } from "@opencode-ai/sdk/v2/client"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type {
  AgentInfo,
  McpServer,
  McpResource,
  PermissionV2Request,
  QuestionV2Request,
  SessionInfo,
  SessionMessageInfo,
  SessionMessagesResponse,
} from "./engine-types"
import type { McpConfig } from "./types"
import { engineFetch } from "./transport"
import { SUGGESTION_SESSION_TITLE } from "./reply-suggestion"
import { chatFileParts } from "./chat"
import { fromLegacy, mergeTranscripts, type LegacyEntry } from "./transcript"
import type {
  Artifact,
  ArtifactKind,
  BranchState,
  CheckLog,
  Checkpoint,
  AgentFile,
  ContextReport,
  CapturedPrompt,
  ToolUses,
  SkillFile,
  CommandFile,
  ContextPack,
  FileText,
  ProjectMemory,
  Finding,
  GitCommit,
  PullRequest,
  RestorePlan,
  Routine,
  RoutineInput,
  RoutineRun,
  Run,
  RunPolicy,
  SessionPrefs,
  StashedPrompt,
  Task,
  TaskActivity,
  TaskTools,
  TouchedFiles,
  UsageReport,
  Workflow,
  WorkflowFile,
} from "./types"

type RoutineCreateRequest = RoutineInput & Partial<Pick<Routine, "id" | "enabled" | "createdAt" | "lastRunAt" | "runs">>

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

/**
 * A failed engine call, keeping the error's `_tag`. The app needs the tag, not just the message, to
 * tell a session the engine no longer has (`SessionNotFoundError`) from the engine being unreachable:
 * one means drop the stale session, the other means say the truth and leave it in place.
 */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly tag?: string,
  ) {
    super(message)
    this.name = "EngineError"
  }
}

export function isSessionGone(cause: unknown) {
  return cause instanceof EngineError && cause.tag === "SessionNotFoundError"
}

async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const result = await call
  if (result.error !== undefined && result.error !== null) {
    const error = result.error as { message?: string; _tag?: string }
    throw new EngineError(error?.message ?? "Request failed", error?._tag)
  }
  return result.data as T
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
      /**
       * `/global/health` rather than the v2 one: only this route reports the engine's own version,
       * and everything that compares versions — the Engine row in Settings, the warning about a UI
       * generated against a different engine — was reading a field the v2 route never sends.
       */
      get: async () => {
        const response = await engineFetch(`${baseUrl.replace(/\/$/, "")}/global/health`)
        if (!response.ok) throw new Error(`Request failed (HTTP ${response.status})`)
        const result = (await response.json()) as { healthy?: boolean; version?: string }
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
    /** The engine's settings, which decide when it folds a session: the meter reads the compaction
     *  ones. Only what this side asks for is typed; the rest of the config is the engine's. */
    config: async () =>
      (await unwrap(client.config.get())) as { compaction?: { auto?: boolean; reserved?: number } },
    /** Writes back one key of the engine's config and leaves the rest as it is (H-25). */
    updateConfig: (patch: Record<string, unknown>) => patchConfig(baseUrl, patch),
    session: {
      /**
       * The engine's list, searched and paged server-side (H-18).
       *
       * `search` matches the title, `limit` bounds a page and the response's `cursor.next` is what a
       * reader loads the next one with. The old wrapper capped the list at 200 and never used either,
       * so a session older than the last 200 simply did not exist for this app.
       */
      list: (input?: { order?: "asc" | "desc"; limit?: number; search?: string; cursor?: string; directory?: string }) =>
        unwrap(client.v2.session.list({ ...input, limit: input?.limit ?? 200 })),
      /**
       * One page of a session's durable events (H-33).
       *
       * The engine keeps them with a sequence number, so `after` reads exactly what a viewer has not
       * seen yet — that is what makes a replay a replay rather than a re-read of the current state.
       */
      history: (input: { sessionID: string; after?: number; limit?: number }) =>
        unwrap(client.v2.session.history(input)),
      /** Archive a session, or bring it back (H-18). Zero is the engine's "not archived". */
      setArchived: (sessionID: string, archived: boolean) =>
        unwrap(client.session.update({ sessionID, time: { archived: archived ? Date.now() : 0 } })),
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
      /**
       * The engine's compaction is `summarize`: it runs the model over the history and writes the
       * summary back. The v2 `compact` beside it is a stub that answers "not available yet".
       */
      compact: (input: { sessionID: string; directory?: string; providerID: string; modelID: string }) =>
        unwrap(
          client.session.summarize({
            sessionID: input.sessionID,
            directory: input.directory,
            providerID: input.providerID,
            modelID: input.modelID,
          }),
        ),
      /** Sessions whose run is still going, across all of its steps. */
      active: async () => new Set(Object.keys((await unwrap(client.v2.session.active()))?.data ?? {})),
      /**
       * Sends a prompt through the legacy runtime, which is the complete one: subagents, MCP, LSP,
       * retries and engine-written titles all live there, and the v2 runner has none of them. It
       * returns as soon as the turn is admitted; the folder's event stream carries the rest.
       *
       * A prompt sent while a turn is running joins that turn at its next boundary — the legacy
       * runner has no queue of its own, so waiting is the harness's job (see pending-prompts.ts).
       */
      send: (input: {
        sessionID: string
        directory?: string
        text: string
        id?: string
        agent?: string
        system?: string
        files?: Array<{ uri: string; name?: string }>
        model?: { providerID: string; id: string; variant?: string }
      }) =>
        unwrap(
          client.session.promptAsync({
            sessionID: input.sessionID,
            directory: input.directory,
            ...(input.id ? { messageID: input.id } : {}),
            ...(input.agent ? { agent: input.agent } : {}),
            ...(input.system ? { system: input.system } : {}),
            ...(input.model
              ? {
                  model: { providerID: input.model.providerID, modelID: input.model.id },
                  ...(input.model.variant ? { variant: input.model.variant } : {}),
                }
              : {}),
            parts: [{ type: "text", text: input.text }, ...chatFileParts(input.files ?? [])],
          }),
        ),
      /**
       * Which sessions of a folder the legacy runner is working on. `/api/session/active` only knows
       * about v2 runs — measured against a local engine, a legacy turn never appears there — so this
       * is what says whether a session is busy once prompts go through the legacy runtime.
       */
      status: async (input: { directory: string }) => {
        const map = (await unwrap(client.session.status({ directory: input.directory }))) as unknown as Record<
          string,
          { type?: string } | undefined
        >
        return new Set(
          Object.entries(map ?? {})
            .filter(([, value]) => value?.type === "busy" || value?.type === "retry")
            .map(([id]) => id),
        )
      },
      /**
       * Stops the turn running on this session, whichever runtime owns it. Code and chats run on the
       * legacy runtime, whose abort cancels its runner; a v2 run — a skill — is stopped by the v2
       * interrupt. Only one of the two has work and the other is a no-op, so both are asked and the
       * call only fails when neither could be reached.
       */
      abort: async (input: { sessionID: string; directory?: string }) => {
        const [legacy, v2] = await Promise.allSettled([
          unwrap(client.session.abort({ sessionID: input.sessionID, directory: input.directory })),
          unwrap(client.v2.session.interrupt({ sessionID: input.sessionID })),
        ])
        if (legacy.status === "rejected" && v2.status === "rejected") throw legacy.reason
      },
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
        /**
         * Code's turns run on the legacy runtime and write the legacy message store, so a revert has
         * to go there too. The v2 revert reads the v2 message table and answers "Message not found"
         * for a message that only the legacy turn wrote.
         */
        stage: (input: { sessionID: string; messageID: string; directory?: string }) =>
          unwrap(
            client.session.revert({
              sessionID: input.sessionID,
              directory: input.directory,
              messageID: input.messageID,
            }),
          ),
        clear: (input: { sessionID: string; directory?: string }) =>
          unwrap(client.session.unrevert({ sessionID: input.sessionID, directory: input.directory })),
        /** Drops the messages the staged revert hid, which is what the next prompt does on its own. */
        commit: (input: { sessionID: string; directory?: string }) =>
          unwrap(client.session.revertCommit({ sessionID: input.sessionID, directory: input.directory })),
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
      /** The engine's own todo store, which the todowrite tool keeps and the transcript may prune. */
      todos: async (input: { sessionID: string; directory?: string }) => ({
        data: (await unwrap(
          client.session.todo({ sessionID: input.sessionID, directory: input.directory }),
        )) as unknown as Array<{ content: string; status: string }>,
      }),
    },
    message: {
      list: async (input: { sessionID: string; order?: "asc" | "desc" }) => {
        const key = `${baseUrl}::${input.sessionID}`
        const cached =
          legacyHistory.get(key) ??
          unwrap(client.session.messages({ sessionID: input.sessionID })).then((entries) =>
            fromLegacy((entries ?? []) as unknown as LegacyEntry[]),
          )
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
      /**
       * The engine resolves providers once and caches them, key included, so a credential saved
       * afterwards is written but never used: requests keep going out with the previous key.
       * Disposing drops that cached state so the next request reads the credentials again.
       */
      reload: () => unwrap(client.global.dispose()),
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
    /**
     * Blocked work, from whichever runtime owns it. A request belongs to the runtime that raised it
     * and can only be answered there: the legacy runner — the one every Code and Chat turn runs on —
     * keeps its own registry at `/question` and `/permission`, and the v2 ones answer empty for it.
     * Reading only v2 is what left an agent waiting on a question no dock could show.
     */
    blocked: {
      questions: async (input: { directory?: string; sessionID?: string }) => {
        const legacy = ((await unwrap(client.question.list({ directory: input.directory }))) ??
          []) as unknown as QuestionV2Request[]
        return legacy
          .filter((request) => !input.sessionID || request.sessionID === input.sessionID)
          .map((request) => ({ ...request, questions: request.questions ?? [] }))
      },
      permissions: async (input: { directory?: string; sessionID?: string }) => {
        const legacy = (await unwrap(client.permission.list({ directory: input.directory }))) ?? []
        return legacy
          .filter((request) => !input.sessionID || request.sessionID === input.sessionID)
          .map(
            // Defaults matter: the legacy payload is looser than the v2 one, and a request without
            // patterns used to reach the dock as `undefined` and take the whole view down with it.
            (request): PermissionV2Request => ({
              id: request.id,
              sessionID: request.sessionID,
              action: request.permission ?? "",
              resources: request.patterns ?? [],
              save: request.always ?? [],
              metadata: request.metadata ?? {},
              ...(request.tool
                ? { source: { type: "tool", messageID: request.tool.messageID, callID: request.tool.callID } }
                : {}),
            }),
          )
      },
      answerQuestion: (input: { requestID: string; directory?: string; answers: string[][] }) =>
        unwrap(
          client.question.reply({
            requestID: input.requestID,
            directory: input.directory,
            answers: input.answers,
          }),
        ),
      rejectQuestion: (input: { requestID: string; directory?: string }) =>
        unwrap(client.question.reject({ requestID: input.requestID, directory: input.directory })),
      answerPermission: (input: {
        requestID: string
        directory?: string
        reply: "once" | "always" | "reject"
        message?: string
      }) =>
        unwrap(
          client.permission.reply({
            requestID: input.requestID,
            directory: input.directory,
            reply: input.reply,
            message: input.message,
          }),
        ),
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
      /**
       * The agents this folder actually has (H-13).
       *
       * `/api/agent` ignores the directory it is given and answers for wherever the engine itself
       * was opened — measured: asking it about a folder with its own `.opencode/agent/probe.md`
       * came back with *this* repository's agents and not that one's. The legacy `/agent?directory=`
       * answers per folder, and it is the one the engine reads those files for.
       */
      listFor: async (directory?: string) => {
        const answer = (await unwrap(
          client.app.agents(directory ? { directory } : {}) as Promise<Result<unknown>>,
        ).catch(() => undefined)) as Array<Record<string, unknown>> | undefined
        // The legacy shape names an agent `name`; everything here calls it `id`.
        return (answer ?? []).map((agent) => ({
          ...agent,
          id: (agent.id ?? agent.name) as string,
        })) as AgentInfo[]
      },
    },
    command: {
      list: (input?: LocationInput) => unwrap(client.v2.command.list(input)),
    },
    /** Every tool the engine offers, by id (H-17). */
    tools: async () => {
      const result = (await unwrap(client.tool.ids()).catch(() => undefined)) as
        | { data?: string[] }
        | string[]
        | undefined
      if (Array.isArray(result)) return result
      return result?.data ?? []
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
      /**
       * Changed files with their patches.
       *
       * `context` matters more than it looks. Without it the engine answers with the whole file as
       * one hunk: measured against a real repository, an eight-line change in a 250-line file came
       * back as 254 rows of patch, 246 of them unchanged. Three lines either side is what every
       * other diff starts at, and the viewer can ask for the rest.
       *
       * `mode` picks the question: "git" is the working tree against HEAD, "branch" is this branch
       * against the default one — the only one that still answers after a run commits.
       */
      diff: (directory: string, options: { mode?: "git" | "branch"; context?: number } = {}) =>
        unwrap(client.vcs.diff({ directory, mode: options.mode ?? "git", context: options.context ?? 3 })),
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
      /** The configured servers themselves, so the form can open one for editing instead of guessing. */
      config: async () => {
        const config = (await unwrap(client.config.get())) as { mcp?: Record<string, unknown> }
        return { data: (config?.mcp ?? {}) as Record<string, McpConfig> }
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
      /**
       * OAuth for a server that needs it (SE-2): start returns the URL to open, authenticate
       * waits for the engine's callback, remove forgets the credentials.
       */
      authStart: (input: { server: string }) => unwrap(client.mcp.auth.start({ name: input.server })),
      authenticate: (input: { server: string }) => unwrap(client.mcp.auth.authenticate({ name: input.server })),
      authRemove: (input: { server: string }) => unwrap(client.mcp.auth.remove({ name: input.server })),
      /**
       * What the connected servers expose (H-34).
       *
       * The engine never lists an MCP server's **tools** — they bypass its registry, so only the
       * calls it makes are known, which is what the context panel reads. Resources it does report.
       */
      resources: async () => {
        const resources = (await unwrap(client.experimental.resource.list())) as unknown as Record<string, McpResource>
        return Object.values(resources ?? {})
      },
    },
  }
}

export type HarnessClient = ReturnType<typeof createClient>

export function resolveHarnessServerUrl() {
  const configured = import.meta.env.VITE_FLUPCODE_HARNESS_SERVER_URL
  if (typeof configured === "string" && configured.length > 0) return configured
  return "http://localhost:4097"
}

async function harnessRequest<T>(baseUrl: string, path: string, init?: RequestInit) {
  const response = await engineFetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  })
  const body = (await response.json().catch(() => undefined)) as { data?: T; error?: string } | undefined
  if (!response.ok) throw new Error(body?.error ?? `Harness request failed (${response.status})`)
  return body?.data as T
}

export function createHarnessClient(baseUrl = resolveHarnessServerUrl()) {
  return {
    health: () => harnessRequest<{ healthy: boolean; capabilities?: string[] }>(baseUrl, "/harness/health"),
    /**
     * What the server changed, as it changes it. A different origin from the engine, so the
     * connection it holds does not come out of the handful the browser allows for talking to it.
     *
     * No cursor is sent on purpose: every connection re-reads the lists first, so the server's
     * backlog would only describe runs and routines that have since been deleted.
     */
    events: (options?: { signal?: AbortSignal }) => subscribeEvents(baseUrl, options?.signal, "/harness/events"),
    runs: {
      list: () => harnessRequest<Run[]>(baseUrl, "/harness/runs"),
      /**
       * The same task once per model (H-44), one run each, so the comparison reads runs as it always
       * has. Answers with them in the order they were asked for.
       */
      bestOfN: (input: {
        prompt: string
        models: string[]
        directory?: string
        packs?: string[]
        worktrees?: boolean
        policy?: RunPolicy
      }) =>
        harnessRequest<Run[]>(baseUrl, "/harness/best-of-n", { method: "POST", body: JSON.stringify(input) }),
      /** A run with the tasks it is made of; the list leaves them out. */
      get: (id: string) => harnessRequest<Run>(baseUrl, `/harness/runs/${encodeURIComponent(id)}`),
      /** Pick up a run that ended with work still queued (HF-5). */
      resume: (id: string) =>
        harnessRequest<Run>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/resume`, { method: "POST" }),
      tasks: (id: string) => harnessRequest<Task[]>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/tasks`),
      /** What its running tasks are doing right now. Polled while somebody watches, never stored. */
      activity: (id: string) =>
        harnessRequest<TaskActivity[]>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/activity`),
      /** What each task changed on disk, from the checkpoints taken around it. */
      files: (id: string) => harnessRequest<TouchedFiles[]>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/files`),
      /** What each task spent its time on, from the tool calls the engine plugin timed (H-16). */
      tools: (id: string) => harnessRequest<TaskTools[]>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/tools`),
      /** Do a task again as a new task of the same run, optionally on another model (H-12). */
      retry: (taskID: string, input: { model?: Task["model"] } = {}) =>
        harnessRequest<Task>(baseUrl, `/harness/tasks/${encodeURIComponent(taskID)}/retry`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      /** Take a queued task off the run; running work is stopped with the run (HF-4). */
      cancelTask: (taskID: string) =>
        harnessRequest<Task>(baseUrl, `/harness/tasks/${encodeURIComponent(taskID)}/cancel`, { method: "POST" }),
      /** Merge the worktrees this run's tasks wrote in, back into its folder (H-29). */
      mergeWorktrees: (id: string) =>
        harnessRequest<{ merged: Array<{ taskID: string; branch: string; sha: string }> }>(
          baseUrl,
          `/harness/runs/${encodeURIComponent(id)}/worktrees/merge`,
          { method: "POST" },
        ),
      /** Remove the worktrees this run's tasks wrote in (H-29). */
      cleanupWorktrees: (id: string) =>
        harnessRequest<{ removed: string[] }>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/worktrees/cleanup`, {
          method: "POST",
        }),
      /** Ask the server to interrupt what the run is doing; it finishes as stopped. */
      stop: (id: string) => harnessRequest<Run>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/stop`, { method: "POST" }),
      /** Let a run through the gate it stopped at. Refusing it is stopping it. */
      approve: (id: string) => harnessRequest<Run>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/approve`, { method: "POST" }),
      /** Interrupt every run still going. */
      stopAll: () => harnessRequest<{ stopped: number }>(baseUrl, "/harness/runs/stop", { method: "POST" }),
      /** Forget every run that has finished. Running ones stay. */
      clear: () => harnessRequest<{ removed: number }>(baseUrl, "/harness/runs", { method: "DELETE" }),
      /** Forget a run and its tasks. The server refuses while it is still going. */
      remove: (id: string) => harnessRequest<boolean>(baseUrl, `/harness/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
    artifacts: {
      list: (filter: { directory?: string; runID?: string; kind?: ArtifactKind; q?: string } = {}) => {
        const query = new URLSearchParams()
        for (const [name, value] of Object.entries(filter)) if (value) query.set(name, value)
        const search = query.toString()
        return harnessRequest<Artifact[]>(baseUrl, `/harness/artifacts${search ? `?${search}` : ""}`)
      },
      /** Keep one in front, or say when it may be forgotten (H-14). `expiresAt` null clears it. */
      update: (id: string, input: { pinned?: boolean; expiresAt?: number | null }) =>
        harnessRequest<Artifact>(baseUrl, `/harness/artifacts/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
      /** A download link for one artifact as Markdown or JSON (HF-7). */
      exportUrl: (id: string, format: "md" | "json" = "md") =>
        `${baseUrl}/harness/artifacts/${encodeURIComponent(id)}/export?format=${format}`,
      remove: (id: string) =>
        harnessRequest<boolean>(baseUrl, `/harness/artifacts/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
    // What a reader keeps about a session (H-18). On the server, so it travels to the phone.
    sessionPrefs: {
      list: () => harnessRequest<SessionPrefs[]>(baseUrl, "/harness/session-prefs"),
      update: (sessionID: string, input: { pinned?: boolean; tags?: string[] }) =>
        harnessRequest<SessionPrefs>(baseUrl, `/harness/session-prefs/${encodeURIComponent(sessionID)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
    },
    // Prompts set aside, on the server so any device sees them (H-18).
    stash: {
      list: () => harnessRequest<StashedPrompt[]>(baseUrl, "/harness/stash"),
      add: (text: string) =>
        harnessRequest<StashedPrompt>(baseUrl, "/harness/stash", { method: "POST", body: JSON.stringify({ text }) }),
      remove: (id: string) =>
        harnessRequest<boolean>(baseUrl, `/harness/stash/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
    /** Context packs (H-26): named sets of references the composer can pull back into a prompt. */
    packs: {
      list: (directory?: string) =>
        harnessRequest<ContextPack[]>(
          baseUrl,
          directory ? `/harness/packs?directory=${encodeURIComponent(directory)}` : "/harness/packs",
        ),
      save: (input: { name: string; refs: string[]; directory?: string }) =>
        harnessRequest<ContextPack>(baseUrl, "/harness/packs", { method: "POST", body: JSON.stringify(input) }),
      remove: (id: string) =>
        harnessRequest<boolean>(baseUrl, `/harness/packs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
    /** One file's text to look at (H-19), confined to the folder and capped by the server. */
    files: {
      read: (input: { directory: string; path: string }) => {
        const search = new URLSearchParams({ directory: input.directory, path: input.path })
        return harnessRequest<FileText>(baseUrl, `/harness/files/read?${search}`)
      },
    },
    /** A conversation kept on this server so it can be read at a link (H-35). */
    shares: {
      create: (input: { title: string; markdown: string }) =>
        harnessRequest<{ id: string; title: string; url: string }>(baseUrl, "/harness/shares", {
          method: "POST",
          body: JSON.stringify(input),
        }),
    },
    /** A project's notes, kept here and handed to every turn (H-37). */
    memory: {
      list: (directory: string) =>
        harnessRequest<ProjectMemory[]>(baseUrl, `/harness/memory?directory=${encodeURIComponent(directory)}`),
      add: (input: { directory: string; text: string }) =>
        harnessRequest<ProjectMemory>(baseUrl, "/harness/memory", { method: "POST", body: JSON.stringify(input) }),
      remove: (id: string) => harnessRequest<boolean>(baseUrl, `/harness/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
    workflows: {
      /** What this project can run. A project's own win over the ones shared across projects. */
      list: (directory?: string) =>
        harnessRequest<Workflow[]>(
          baseUrl,
          directory ? `/harness/workflows?directory=${encodeURIComponent(directory)}` : "/harness/workflows",
        ),
      run: (name: string, input: { inputs?: Record<string, string>; directory?: string; packs?: string[]; worktrees?: boolean; policy?: unknown; until?: string; fromCheckpoint?: string }) =>
        harnessRequest<Run>(baseUrl, `/harness/workflows/${encodeURIComponent(name)}/runs`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      /** The file as written, for the editor (H-28). */
      get: (name: string, directory?: string) =>
        harnessRequest<WorkflowFile>(
          baseUrl,
          `/harness/workflows/${encodeURIComponent(name)}${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`,
        ),
      /** Writes it back, validated by the server: what would not run cannot be saved as a workflow. */
      save: (name: string, input: { source: string; directory?: string; scope?: "project" | "global" }) =>
        harnessRequest<WorkflowFile>(baseUrl, `/harness/workflows/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: JSON.stringify(input),
        }),
      remove: (name: string, directory?: string) =>
        harnessRequest<boolean>(
          baseUrl,
          `/harness/workflows/${encodeURIComponent(name)}${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`,
          { method: "DELETE" },
        ),
    },
    /**
     * Git (H-20), which only the harness server can run.
     *
     * The engine's `/vcs` routes read the working tree and never write to it, and a browser cannot
     * run anything. Before this, committing meant asking a model to do it — a whole turn, paid for,
     * to run two commands.
     */
    git: {
      commit: (input: { directory: string; message: string; paths: string[]; hunks?: Record<string, number[]> }) =>
        harnessRequest<GitCommit>(baseUrl, "/harness/git/commit", { method: "POST", body: JSON.stringify(input) }),
      /** Throws away a change, or the named hunks of one (H-20). */
      discard: (input: { directory: string; path: string; hunks?: number[] }) =>
        harnessRequest<{ path: string }>(baseUrl, "/harness/git/discard", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      /** A commit message for the picked change, written by the engine (H-20). */
      message: (input: { directory: string; paths: string[]; hunks?: Record<string, number[]> }) =>
        harnessRequest<{ message: string }>(baseUrl, "/harness/git/message", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      branch: (input: { directory: string; name: string }) =>
        harnessRequest<{ branch: string }>(baseUrl, "/harness/git/branch", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      /** Where the branch stands on GitHub. One `gh` call behind it, so poll it, do not spam it. */
      state: (directory: string) =>
        harnessRequest<BranchState>(baseUrl, `/harness/git/pr?directory=${encodeURIComponent(directory)}`),
      /**
       * What one failing check printed. Asked for rather than polled: it is a network call per job.
       */
      checkLog: (directory: string, job: string) =>
        harnessRequest<CheckLog>(
          baseUrl,
          `/harness/git/pr/log?directory=${encodeURIComponent(directory)}&job=${encodeURIComponent(job)}`,
        ),
      /** Pushes the branch if it has never been pushed, then opens the pull request. */
      openPullRequest: (input: { directory: string; title: string; body?: string; base?: string }) =>
        harnessRequest<PullRequest>(baseUrl, "/harness/git/pr", { method: "POST", body: JSON.stringify(input) }),
    },
    /**
     * What the model was given (H-17).
     *
     * Read from disk by the engine's own rules, because the engine reports the agent's blurb and
     * not the prompt it actually assembles.
     */
    context: {
      get: (input: { directory: string; project?: string }) => {
        const search = new URLSearchParams({ directory: input.directory })
        if (input.project) search.set("project", input.project)
        return harnessRequest<ContextReport>(baseUrl, `/harness/context?${search}`)
      },
      file: (input: { directory: string; path: string; project?: string }) => {
        const search = new URLSearchParams({ directory: input.directory, path: input.path })
        if (input.project) search.set("project", input.project)
        return harnessRequest<{ content: string }>(baseUrl, `/harness/context/file?${search}`)
      },
      /**
       * The system prompt the engine assembled, which no engine endpoint reports: FlupCode's engine
       * plugin records it as the request goes out. A session has more than one recording — the turn,
       * its title, a compaction — so this is a list, newest first.
       */
      systemPrompt: (input: { sessionID: string }) =>
        harnessRequest<CapturedPrompt[]>(
          baseUrl,
          `/harness/context/system-prompt?${new URLSearchParams({ sessionID: input.sessionID })}`,
        ),
      /** What tools this session ran, which is as much as the engine can tell about MCP servers: it
       *  reports no list of what one offers. */
      toolUses: (input: { sessionID: string }) =>
        harnessRequest<ToolUses>(baseUrl, `/harness/context/tool-uses?${new URLSearchParams({ sessionID: input.sessionID })}`),
    },
    /** Agents you can edit (H-13): the markdown files behind the agents the engine reports. */
    agents: {
      list: (input: { directory?: string; project?: string }) => {
        const search = new URLSearchParams()
        if (input.directory) search.set("directory", input.directory)
        if (input.project) search.set("project", input.project)
        return harnessRequest<AgentFile[]>(baseUrl, `/harness/agents${search.size ? `?${search}` : ""}`)
      },
      save: (input: {
        name: string
        scope: "global" | "project"
        fields: Record<string, unknown>
        prompt: string
        directory?: string
        project?: string
      }) =>
        harnessRequest<{ path: string }>(baseUrl, "/harness/agents", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      remove: (input: { path: string; directory?: string; project?: string }) => {
        const search = new URLSearchParams({ path: input.path })
        if (input.directory) search.set("directory", input.directory)
        if (input.project) search.set("project", input.project)
        return harnessRequest<{ removed: boolean }>(baseUrl, `/harness/agents?${search}`, { method: "DELETE" })
      },
    },
    /** Skills (H-27): what is on disk, and what the engine would not load, and why. */
    skills: {
      list: (input: { directory?: string; project?: string }) => {
        const search = new URLSearchParams()
        if (input.directory) search.set("directory", input.directory)
        if (input.project) search.set("project", input.project)
        return harnessRequest<SkillFile[]>(baseUrl, `/harness/skills${search.size ? `?${search}` : ""}`)
      },
      file: (input: { path: string; directory?: string }) => {
        const search = new URLSearchParams({ path: input.path })
        if (input.directory) search.set("directory", input.directory)
        return harnessRequest<{ content: string }>(baseUrl, `/harness/skills/file?${search}`)
      },
      save: (input: { name: string; scope: "global" | "project"; description: string; body: string; directory?: string }) =>
        harnessRequest<{ path: string }>(baseUrl, "/harness/skills", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      remove: (input: { path: string; directory?: string }) => {
        const search = new URLSearchParams({ path: input.path })
        if (input.directory) search.set("directory", input.directory)
        return harnessRequest<{ removed: boolean }>(baseUrl, `/harness/skills?${search}`, { method: "DELETE" })
      },
    },
    /** Commands you can edit (H-25): the markdown files behind the engine's slash commands. */
    commands: {
      list: (input: { directory?: string; project?: string }) => {
        const search = new URLSearchParams()
        if (input.directory) search.set("directory", input.directory)
        if (input.project) search.set("project", input.project)
        return harnessRequest<CommandFile[]>(baseUrl, `/harness/commands${search.size ? `?${search}` : ""}`)
      },
      save: (input: {
        name: string
        scope: "global" | "project"
        fields: Record<string, unknown>
        template: string
        directory?: string
        project?: string
      }) =>
        harnessRequest<{ path: string }>(baseUrl, "/harness/commands", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      remove: (input: { path: string; directory?: string; project?: string }) => {
        const search = new URLSearchParams({ path: input.path })
        if (input.directory) search.set("directory", input.directory)
        if (input.project) search.set("project", input.project)
        return harnessRequest<{ removed: boolean }>(baseUrl, `/harness/commands?${search}`, { method: "DELETE" })
      },
    },
    /** Findings (H-32): a review's points, anchored to a file and a line. */
    findings: {
      list: (input: { directory?: string; runID?: string; open?: boolean }) => {
        const search = new URLSearchParams()
        if (input.directory) search.set("directory", input.directory)
        if (input.runID) search.set("runID", input.runID)
        if (input.open) search.set("open", "1")
        return harnessRequest<Finding[]>(baseUrl, `/harness/findings${search.size ? `?${search}` : ""}`)
      },
      resolve: (id: string, resolved: boolean) =>
        harnessRequest<Finding>(baseUrl, `/harness/findings/${encodeURIComponent(id)}/resolved`, {
          method: "PATCH",
          body: JSON.stringify({ resolved }),
        }),
    },
    /**
     * What the runs cost (H-16). Runs only — the harness never sees an ordinary chat turn, and
     * adding the engine's session totals on top would count every task twice.
     */
    usage: (input: { directory?: string; days?: number } = {}) => {
      const search = new URLSearchParams()
      if (input.directory) search.set("directory", input.directory)
      if (input.days) search.set("days", String(input.days))
      return harnessRequest<UsageReport>(baseUrl, `/harness/usage${search.size ? `?${search}` : ""}`)
    },
    /**
     * Checkpoints (H-15): a way back from what a run did.
     *
     * `plan` before `restore`, always. Restoring overwrites files and deletes others, and nothing
     * here does that without saying which ones first.
     */
    checkpoints: {
      list: (directory: string) =>
        harnessRequest<Checkpoint[]>(baseUrl, `/harness/checkpoints?directory=${encodeURIComponent(directory)}`),
      take: (input: { directory: string; title: string }) =>
        harnessRequest<Checkpoint>(baseUrl, "/harness/checkpoints", { method: "POST", body: JSON.stringify(input) }),
      plan: (id: string) => harnessRequest<RestorePlan>(baseUrl, `/harness/checkpoints/${encodeURIComponent(id)}/plan`),
      restore: (id: string) =>
        harnessRequest<{ plan: RestorePlan; safety: Checkpoint }>(
          baseUrl,
          `/harness/checkpoints/${encodeURIComponent(id)}/restore`,
          { method: "POST" },
        ),
      remove: (id: string) =>
        harnessRequest<boolean>(baseUrl, `/harness/checkpoints/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
    routines: {
      list: () => harnessRequest<Routine[]>(baseUrl, "/harness/routines"),
      get: (id: string) => harnessRequest<Routine>(baseUrl, `/harness/routines/${encodeURIComponent(id)}`),
      create: (input: RoutineCreateRequest) =>
        harnessRequest<Routine>(baseUrl, "/harness/routines", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (id: string, input: RoutineInput) =>
        harnessRequest<Routine>(baseUrl, `/harness/routines/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
      setEnabled: (id: string, enabled: boolean) =>
        harnessRequest<Routine>(baseUrl, `/harness/routines/${encodeURIComponent(id)}/enabled`, {
          method: "PATCH",
          body: JSON.stringify({ enabled }),
        }),
      remove: (id: string) =>
        harnessRequest<boolean>(baseUrl, `/harness/routines/${encodeURIComponent(id)}`, { method: "DELETE" }),
      run: (id: string, inputs?: Record<string, string>) =>
        harnessRequest<RoutineRun>(baseUrl, `/harness/routines/${encodeURIComponent(id)}/runs`, {
          method: "POST",
          ...(inputs ? { body: JSON.stringify({ inputs }) } : {}),
        }),
      stop: (id: string, runID: string) =>
        harnessRequest<RoutineRun | undefined>(
          baseUrl,
          `/harness/routines/${encodeURIComponent(id)}/runs/${encodeURIComponent(runID)}/stop`,
          { method: "POST" },
        ),
    },
  }
}
