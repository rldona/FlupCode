import type { MemoryInfo, ModelV2Info, SessionV2Info } from "@opencode-ai/sdk/v2/client"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type {
  AgentInfo,
  ConsoleOrg,
  ConsoleState,
  McpServer,
  McpResource,
  PermissionV2Request,
  QuestionV2Request,
  SessionInfo,
  SessionMessageInfo,
  SessionMessagesResponse,
} from "../engine-types"
import type { McpConfig, McpScope } from "../types"
import type { ConfiguredProvider } from "../custom-provider"
import { engineFetch } from "../transport"
import { subscribeEvents } from "../event-stream"
import { EngineError, unsupported } from "./error"
import { SUGGESTION_SESSION_TITLE } from "../reply-suggestion"
import { chatFileParts } from "../chat"
import { fromLegacy, mergeTranscripts, type LegacyEntry } from "../transcript"

/**
 * The client for an OpenCode 1.x engine: its legacy routes (`/session`, `/event`, `/mcp`, `/config`,
 * `/permission`, …) through the generated `@opencode-ai/sdk`, plus the 1.x `/api/*` routes.
 *
 * Its return type is the contract every engine adapter meets (`EngineClient` in `../client`), so the
 * OpenCode 2 adapter (V2-20) can replace it behind `createClient` without the app changing. It is the
 * only module in the app that imports the SDK.
 */

/** The largest page of v2 messages the engine returns. */
const MESSAGE_PAGE = 200

/**
 * `PATCH /config` merges into the engine's configuration file. The generated client has no typed
 * call for it, and the shape is open-ended, so it goes through the transport directly.
 */
async function patchConfig(baseUrl: string, patch: Record<string, unknown>, directory?: string) {
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
  const response = await engineFetch(`${baseUrl.replace(/\/$/, "")}/config${query}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error(`Could not save the configuration (HTTP ${response.status})`)
}

/**
 * `PATCH /global/config` merges into the engine's global configuration file, the one that applies to
 * every directory rather than the instance's own. Same open-ended shape, same transport.
 */
async function patchGlobalConfig(baseUrl: string, patch: Record<string, unknown>) {
  const response = await engineFetch(`${baseUrl.replace(/\/$/, "")}/global/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error(`Could not save the global configuration (HTTP ${response.status})`)
}

/**
 * `POST /config/reload` re-reads the configuration-derived state (agents, skills, commands) for the
 * location it names, without disposing the instance, so a turn in flight survives. The generated
 * client has no typed call for it, so it goes through the transport directly, like the patches above.
 */
async function reloadConfig(baseUrl: string, input?: { directory?: string; workspace?: string }) {
  const params = new URLSearchParams()
  if (input?.directory) params.set("directory", input.directory)
  if (input?.workspace) params.set("workspace", input.workspace)
  const query = params.size ? `?${params.toString()}` : ""
  const response = await engineFetch(`${baseUrl.replace(/\/$/, "")}/config/reload${query}`, { method: "POST" })
  if (!response.ok) throw new Error(`Could not reload the configuration (HTTP ${response.status})`)
}

type LocationInput = { location?: { directory?: string; workspace?: string } }
type Result<T> = { data?: T; error?: unknown }

/** A prompt the engine admitted and holds until the session can take it (V2-41). */
export type InboxPrompt = {
  id: string
  text: string
  files: Array<{ uri: string; name: string }>
  delivery: "steer" | "queue"
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

export function createV1Client(baseUrl: string) {
  const client = createOpencodeClient({ baseUrl, fetch: ((request: Request) => engineFetch(request)) as typeof fetch })

  /** The `mcp` map as it is on disk in the file a scope names, so a write merges instead of replacing. */
  const readMcp = async (scope: McpScope, directory?: string) =>
    (await unwrap(
      scope === "global" ? client.global.config.get() : client.config.get(directory ? { directory } : undefined),
    )) as {
      mcp?: Record<string, unknown>
    }
  /** Writes one scope's config file, global or the instance's own. */
  const writeConfig = (scope: McpScope, patch: Record<string, unknown>, directory?: string) =>
    scope === "global" ? patchGlobalConfig(baseUrl, patch) : patchConfig(baseUrl, patch, directory)

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
    /**
     * Drop the engine's cached instances so the next request re-reads its configuration.
     *
     * The engine resolves agents and skills once per instance and never reloads them, so a file
     * written afterwards — by the Agents panel, say — is on disk but not in a running session. This
     * is the same dispose the credential flow already uses, exposed so the reader can ask for it.
     * It disposes every instance, so turns in flight are dropped: callers confirm first.
     */
    reload: () => unwrap(client.global.dispose()),
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
      (await unwrap(client.config.get())) as {
        compaction?: { auto?: boolean; reserved?: number }
        flupcode?: {
          composeTools?: string[]
          delivery?: Record<string, { composeTools?: string[] }>
          /** The repository `configFiles.export` copies global files into. */
          configRepo?: string
        }
      },
    /** The global config's provider lists, shared by every directory. */
    globalConfig: async () =>
      (await unwrap(client.global.config.get())) as {
        disabled_providers?: string[]
        provider?: Record<string, ConfiguredProvider>
      },
    /** Writes back one key of the engine's config and leaves the rest as it is (H-25). */
    updateConfig: (patch: Record<string, unknown>) => patchConfig(baseUrl, patch),
    /** Writes back one key of the engine's global config, shared by every directory (H-25). */
    updateGlobalConfig: (patch: Record<string, unknown>) => patchGlobalConfig(baseUrl, patch),
    /** Re-reads the engine's config-derived state for a location, without disposing its instances. */
    reloadConfig: (input?: { directory?: string; workspace?: string }) => reloadConfig(baseUrl, input),
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
      /**
       * Drop one message without reverting file changes (UN-1). The engine refuses while the
       * session is busy, so callers abort and wait for idle first.
       */
      removeMessage: (input: { sessionID: string; messageID: string; directory?: string }) =>
        unwrap(
          client.session.deleteMessage({
            sessionID: input.sessionID,
            messageID: input.messageID,
            ...(input.directory ? { directory: input.directory } : {}),
          }),
        ),
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
        /** Only 2.x holds a prompt back itself; here the harness does, so this is never sent. */
        delivery?: "steer" | "queue"
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
       * The prompts a session's engine holds back until it can take them (V2-41). 1.x keeps no such
       * queue, so it lists none and the harness keeps its own (pending-prompts.ts).
       */
      inbox: {
        list: async (_input: { sessionID: string }): Promise<InboxPrompt[]> => [],
        cancel: async (_input: { sessionID: string; inboxID: string }): Promise<void> =>
          unsupported("a server-side prompt queue"),
        update: async (_input: { sessionID: string; inboxID: string; delivery: "steer" | "queue" }): Promise<void> =>
          unsupported("a server-side prompt queue"),
      },
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
        model: { providerID: string; id: string; variant?: string }
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
              ...(input.model.variant ? { variant: input.model.variant } : {}),
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
      // Only the data: the location a list was read at is not something the app looks at.
      list: async (input?: LocationInput) => ({ data: (await unwrap(client.v2.model.list(input))).data }),
      directory: () => unwrap(client.config.providers()),
      default: async () => ({ data: undefined as ModelV2Info | undefined }),
    },
    provider: {
      list: async (input?: LocationInput) => ({ data: (await unwrap(client.v2.provider.list(input))).data }),
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
       * The engine's legacy provider OAuth, the one the TUI uses. A stock OpenCode CLI registers
       * Copilot's device flow here but not in the v2 integration registry, so the panel falls back
       * to this when a provider advertises an OAuth method in `provider.auth()` and the integration
       * has none. `callback` blocks until the provider authorizes (device flow) and stores the
       * credential itself; unlike the v2 attempt there is no cancel, so it keeps polling server-side.
       */
      oauth: {
        authorize: (input: { providerID: string; method: number; inputs?: Record<string, string> }) =>
          unwrap(
            client.provider.oauth.authorize({
              providerID: input.providerID,
              method: input.method,
              inputs: input.inputs ?? {},
            }),
          ),
        callback: (input: { providerID: string; method: number; code?: string }) =>
          unwrap(client.provider.oauth.callback({ providerID: input.providerID, method: input.method, code: input.code })),
      },
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
      list: async () => ({ data: (await unwrap(client.v2.integration.list())).data }),
      connectKey: (input: { integrationID: string; key: string; label?: string }) =>
        unwrap(
          client.v2.integration.connect.key({
            integrationID: input.integrationID,
            key: input.key,
            label: input.label,
          }),
        ),
      oauth: async (input: {
        integrationID: string
        methodID?: string
        inputs?: Record<string, string>
        label?: string
      }) => ({
        data: (
          await unwrap(
            client.v2.integration.connect.oauth({
              integrationID: input.integrationID,
              methodID: input.methodID,
              inputs: input.inputs ?? {},
              label: input.label,
            }),
          )
        ).data,
      }),
      attempt: {
        status: async (attemptID: string) => ({
          data: (await unwrap(client.v2.integration.attempt.status({ attemptID }))).data,
        }),
        cancel: (attemptID: string) => unwrap(client.v2.integration.attempt.cancel({ attemptID })),
      },
      disconnect: (credentialID: string) => unwrap(client.v2.credential.remove({ credentialID })),
    },
    /**
     * The Console org behind providers (CO-1): which org is active, which can become active,
     * and the switch. Absent Console means these answer empty, and the UI stays as it was.
     */
    console: {
      active: async () => {
        const state = (await unwrap(client.experimental.console.get())) as unknown as ConsoleState | undefined
        return state ?? { consoleManagedProviders: [], switchableOrgCount: 0 }
      },
      orgs: async () => {
        const result = (await unwrap(client.experimental.console.listOrgs())) as unknown as
          | { orgs?: ConsoleOrg[] }
          | undefined
        return result?.orgs ?? []
      },
      switchOrg: (input: { accountID: string; orgID: string }) =>
        unwrap(client.experimental.console.switchOrg({ accountID: input.accountID, orgID: input.orgID })),
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
      // Only the requests: the location they were read at is not something the app looks at.
      pending: async (input?: LocationInput) => ({
        data: (await unwrap(client.v2.permission.request.list(input))).data,
      }),
      saved: {
        list: (input?: { projectID?: string }) => unwrap(client.v2.permission.saved.list(input)),
        remove: (input: { id: string }) => unwrap(client.v2.permission.saved.remove({ id: input.id })),
      },
    },
    agent: {
      list: async (input?: LocationInput) => ({ data: (await unwrap(client.v2.agent.list(input))).data }),
      /**
       * The agents this folder actually has (H-13), through the legacy `/agent?directory=`, which is
       * the list the engine reads those files with.
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
      list: async (input?: LocationInput) => ({ data: (await unwrap(client.v2.command.list(input))).data }),
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
      list: async (input?: LocationInput) => ({ data: (await unwrap(client.v2.skill.list(input))).data }),
    },
    memory: {
      list: async (input?: {
        location?: { directory?: string }
        text?: string
        scope?: MemoryInfo["scope"]
        status?: MemoryInfo["status"]
        sessionID?: string
        agent?: string
        limit?: number
      }) => ({
        data: (
          await unwrap(
            client.v2.memory.list({
              ...(input?.location ? { location: input.location } : {}),
              ...(input?.text ? { text: input.text } : {}),
              ...(input?.scope ? { scope: input.scope } : {}),
              ...(input?.status ? { status: input.status } : {}),
              ...(input?.sessionID ? { sessionID: input.sessionID } : {}),
              ...(input?.agent ? { agent: input.agent } : {}),
              ...(input?.limit !== undefined ? { limit: String(input.limit) } : {}),
            }),
          )
        ).data,
      }),
      get: async (input: { id: string }) => ({ data: (await unwrap(client.v2.memory.get({ id: input.id }))).data }),
      create: async (input: {
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
      }) => ({ data: (await unwrap(client.v2.memory.create({ memoryCreatePayload: input }))).data }),
      update: async (input: {
        id: string
        title?: string
        content?: string
        kind?: MemoryInfo["kind"]
        tags?: string[]
        status?: MemoryInfo["status"]
        confidence?: number
        importance?: number
      }) => ({
        data: (
          await unwrap(
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
          )
        ).data,
      }),
      remove: (input: { id: string }) => unwrap(client.v2.memory.remove({ id: input.id })),
      verify: async (input: { id: string }) => ({
        data: (await unwrap(client.v2.memory.verify({ id: input.id }))).data,
      }),
      used: async (input: { sessionID: string }) => ({
        data: (await unwrap(client.v2.memory.used({ sessionID: input.sessionID }))).data,
      }),
    },
    file: {
      find: async (input: { query: string; limit?: number }) => ({
        data: (
          await unwrap(
            client.v2.fs.find({
              query: input.query,
              limit: input.limit !== undefined ? String(input.limit) : undefined,
            }),
          )
        ).data,
      }),
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
     *
     * Every call takes the directory the list was read for. Without one the engine acts on the
     * instance of its own working directory, so a server connected, authorized or added to the
     * project from the panel could land in a different instance than the one the panel shows.
     */
    mcp: {
      list: async (input?: { directory?: string }) => {
        const status = (await unwrap(
          client.mcp.status(input?.directory ? { directory: input.directory } : undefined),
        )) as unknown as Record<string, { status?: string }>
        return {
          data: Object.entries(status ?? {}).map(([name, value]) => ({ name, status: value })) as McpServer[],
        }
      },
      /** The configured servers themselves, so the form can open one for editing instead of guessing. */
      config: async (input?: { directory?: string }) => {
        const config = (await unwrap(
          client.config.get(input?.directory ? { directory: input.directory } : undefined),
        )) as { mcp?: Record<string, unknown> }
        return { data: (config?.mcp ?? {}) as Record<string, McpConfig> }
      },
      add: async (input: { server: string; config: McpConfig; scope?: McpScope; directory?: string }) => {
        const scope = input.scope ?? "global"
        const config = await readMcp(scope, input.directory)
        await writeConfig(scope, { mcp: { ...(config?.mcp ?? {}), [input.server]: input.config } }, input.directory)
        await unwrap(client.mcp.add({ name: input.server, config: input.config, directory: input.directory }))
      },
      remove: async (input: { server: string; directory?: string }) => {
        // A server's scope is not readable from the list, so removal clears it wherever it is: both
        // config files are written with the map minus that server, rather than guessing one.
        const [project, global] = await Promise.all([readMcp("project", input.directory), readMcp("global")])
        const { [input.server]: _removedProject, ...projectRest } = project?.mcp ?? {}
        const { [input.server]: _removedGlobal, ...globalRest } = global?.mcp ?? {}
        await Promise.all([
          writeConfig("project", { mcp: projectRest }, input.directory),
          writeConfig("global", { mcp: globalRest }),
        ])
        // The running instance keeps its copy until it restarts, so stop it talking to it now.
        await unwrap(client.mcp.disconnect({ name: input.server, directory: input.directory })).catch(() => undefined)
      },
      connect: (input: { server: string; directory?: string }) =>
        unwrap(client.mcp.connect({ name: input.server, directory: input.directory })),
      disconnect: (input: { server: string; directory?: string }) =>
        unwrap(client.mcp.disconnect({ name: input.server, directory: input.directory })),
      /**
       * OAuth for a server that needs it (SE-2): start returns the URL to open, authenticate
       * waits for the engine's callback, remove forgets the credentials.
       */
      authStart: (input: { server: string; directory?: string }) =>
        unwrap(client.mcp.auth.start({ name: input.server, directory: input.directory })),
      authenticate: (input: { server: string; directory?: string }) =>
        unwrap(client.mcp.auth.authenticate({ name: input.server, directory: input.directory })),
      authRemove: (input: { server: string; directory?: string }) =>
        unwrap(client.mcp.auth.remove({ name: input.server, directory: input.directory })),
      /**
       * What the connected servers expose (H-34).
       *
       * The engine never lists an MCP server's **tools** — they bypass its registry, so only the
       * calls it makes are known, which is what the context panel reads. Resources it does report.
       */
      resources: async (input?: { directory?: string }) => {
        const resources = (await unwrap(
          client.experimental.resource.list(input?.directory ? { directory: input.directory } : undefined),
        )) as unknown as Record<string, McpResource>
        return Object.values(resources ?? {})
      },
    },
  }
}
