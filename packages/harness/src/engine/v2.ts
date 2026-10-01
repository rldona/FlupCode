import { OpenCode } from "@opencode/client"
import type { EngineClient } from "../client"
import { openExternalUrl } from "../external-links"
import { engineFetch } from "../transport"
import { EngineError, unsupported } from "./error"
import {
  toFormAnswer,
  toIntegration,
  toMessages,
  toModel,
  toPermission,
  toProvider,
  toProviderDirectory,
  toQuestion,
  toSession,
} from "./v2-convert"

/**
 * The client for an OpenCode 2 engine, through its generated `@opencode/client` (pinned to the same
 * version as the sandbox engine, see packages/engine-contract/src/opencode-v2.ts).
 *
 * It is being built domain by domain against `EngineClient`, the 1.x adapter's type, so the app keeps
 * one contract: sessions and messages (V2-20), events (V2-21), permissions and forms (V2-22), MCP
 * (V2-23), config (V2-24) and providers (V2-25). `createClient` picks it once every
 * domain exists. What 2.x removed (sharing, todos, deleting a message, the 1.x replay history) fails
 * with an `UnsupportedByEngine` EngineError, or reads as empty where the app has an empty state.
 */
export function createV2Domains(
  baseUrl: string,
  options: {
    /** Where a sign-in URL is opened: the reader's browser, or a test that follows it itself. */
    openUrl?: (url: string) => void
    /** The engine's config files, which 2.x no longer writes itself: the harness server's (V2-24). */
    configStore?: EngineConfigStore
  } = {},
) {
  const openUrl = options.openUrl ?? openExternalUrl
  const store = options.configStore
  const client = OpenCode.make({ baseUrl, fetch: ((input, init) => engineFetch(input, init)) as typeof fetch })

  const session: EngineClient["session"] = {
    list: async (input) => {
      const page = await call(
        client.session.list({
          limit: input?.limit ?? 200,
          order: input?.order,
          search: input?.search,
          cursor: input?.cursor,
          directory: input?.directory,
        }),
      )
      return { data: page.data.map(toSession), cursor: nonNull(page.cursor) }
    },
    history: async () => unsupported("the session replay history"),
    setArchived: async () => unsupported("archiving a session"),
    removeMessage: async () => unsupported("deleting a message"),
    create: async (input) =>
      toSession(
        await call(
          client.session.create({
            ...(input?.model ? { model: input.model } : {}),
            ...(input?.location ? { location: input.location } : {}),
            // The 1.x adapter names `plan` when nothing else is given; the same default here.
            agent: input?.agent ?? (input?.model || input?.location ? undefined : "plan"),
          }),
        ),
      ),
    prompt: async (input) => {
      const admitted = await call(
        client.session.prompt({
          sessionID: input.sessionID,
          ...(input.id ? { id: input.id } : {}),
          text: input.text,
          ...(input.files?.length ? { files: input.files.map((file) => ({ uri: file.uri, name: file.name })) } : {}),
          ...(input.delivery ? { delivery: input.delivery } : {}),
        }),
      )
      // 2.x admits the prompt into the session inbox; its admission sequence is not part of the reply.
      return {
        data: {
          admittedSeq: 0,
          id: admitted.id,
          sessionID: admitted.sessionID,
          prompt: { text: admitted.payload.text },
          delivery: admitted.delivery,
          timeCreated: admitted.time.created,
        },
      }
    },
    wait: (input) => call(client.session.wait({ sessionID: input.sessionID })),
    /** 2.x compacts with the session's own model; the one the app names is for the 1.x summarize. */
    compact: async (input) => {
      await call(client.session.compact({ sessionID: input.sessionID }))
      return true
    },
    active: async () => new Set(Object.keys(await call(client.session.active()))),
    /**
     * 2.x has one runner, so the prompt the app sends through the 1.x runtime goes through the same
     * inbox as any other. A model or agent picked for this turn is selected on the session first: 2.x
     * keeps them as session state, not per prompt. It has no per-prompt system text.
     */
    send: async (input) => {
      if (input.model) await call(client.session.switchModel({ sessionID: input.sessionID, model: input.model }))
      if (input.agent) await call(client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent }))
      await call(
        client.session.prompt(
          {
            sessionID: input.sessionID,
            ...(input.id ? { id: input.id } : {}),
            text: input.text,
            ...(input.files?.length ? { files: input.files.map((file) => ({ uri: file.uri, name: file.name })) } : {}),
          },
          at(input.directory),
        ),
      )
      return nothing()
    },
    /** A session is busy while its execution runs; 2.x reports that for every location at once. */
    status: async () => new Set(Object.keys(await call(client.session.active()))),
    abort: async (input) => {
      await call(client.session.interrupt({ sessionID: input.sessionID }))
    },
    switchModel: (input) => call(client.session.switchModel({ sessionID: input.sessionID, model: input.model })),
    switchAgent: (input) => call(client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent })),
    setPermission: async (input) => {
      await call(
        client.session.update({
          sessionID: input.sessionID,
          permissions: input.permission.map((rule) => ({
            action: rule.permission,
            resource: rule.pattern,
            effect: rule.action,
          })),
        }),
      )
      return toSession(await call(client.session.get({ sessionID: input.sessionID })))
    },
    revert: {
      stage: async (input) => {
        await call(client.session.revert.stage({ sessionID: input.sessionID, messageID: input.messageID }))
        return nothing()
      },
      clear: async (input) => {
        await call(client.session.revert.clear({ sessionID: input.sessionID }))
        return nothing()
      },
      commit: async (input) => {
        await call(client.session.revert.commit({ sessionID: input.sessionID }))
        return nothing()
      },
    },
    permission: {
      list: async (input) => ({
        data: (await call(client.permission.list({ sessionID: input.sessionID }))).map(toPermission),
      }),
      reply: async (input) => {
        await call(
          client.permission.reply({
            sessionID: input.sessionID,
            requestID: input.requestID,
            decision: input.reply,
            ...(input.message ? { message: input.message } : {}),
          }),
        )
        return nothing()
      },
    },
    // 2.x asks questions as forms; see `toQuestion`.
    question: {
      list: async (input) => ({
        data: (await call(client.session.form.list({ sessionID: input.sessionID }))).map(toQuestion),
      }),
      reply: async (input) => {
        // The answer is keyed by field and typed by it, so the form is read first.
        const form = await call(client.session.form.get({ sessionID: input.sessionID, formID: input.requestID }))
        await call(
          client.session.form.reply({
            sessionID: input.sessionID,
            formID: input.requestID,
            answer: toFormAnswer(form, input.answers),
          }),
        )
        return nothing()
      },
      reject: async (input) => {
        await call(client.session.form.cancel({ sessionID: input.sessionID, formID: input.requestID }))
        return nothing()
      },
    },
    rename: async (input) => {
      await call(client.session.update({ sessionID: input.sessionID, title: input.title }))
      return nothing()
    },
    remove: async (input) => {
      await call(client.session.remove({ sessionID: input.sessionID }))
      return nothing()
    },
    fork: async (input) =>
      toSession(
        await call(
          client.session.fork({ sessionID: input.sessionID, ...(input.messageID ? { before: input.messageID } : {}) }),
        ),
      ),
    shell: async (input) => {
      await call(client.session.shell({ sessionID: input.sessionID, command: input.command }))
      return nothing()
    },
    command: async (input) => {
      await call(
        client.session.command({ sessionID: input.sessionID, name: input.command, text: input.arguments ?? "" }),
      )
      return nothing()
    },
    skill: async (input) => {
      await call(client.session.skill({ sessionID: input.sessionID, id: input.skill }))
      return nothing()
    },
    move: async (input) => {
      await call(client.session.move({ sessionID: input.sessionID, directory: input.directory }))
      return nothing()
    },
    share: async () => unsupported("sharing a session"),
    unshare: async () => unsupported("sharing a session"),
    children: async (input) => ({
      data: (await call(client.session.list({ parentID: input.sessionID, limit: 200 }))).data.map(toSession),
    }),
    // 2.x has no todo list; the app's Tasks view has an empty state for exactly this.
    todos: async () => ({ data: [] }),
  }

  const message: EngineClient["message"] = {
    /**
     * Every page, oldest first. 2.x pages newest first (see docs/V2-CONTRACT-REPORT.md, surprise 3)
     * and keeps one transcript, so there is no 1.x history to merge in.
     */
    list: async (input) => {
      const pages = []
      let cursor: string | undefined
      do {
        const page = await call(client.message.list({ sessionID: input.sessionID, limit: 200, cursor }))
        pages.push(...page.data)
        cursor = page.data.length === 200 ? (page.cursor.next ?? undefined) : undefined
      } while (cursor)
      const data = toMessages([...pages].reverse())
      return { data: input.order === "desc" ? data.reverse() : data, cursor: {} }
    },
  }

  /**
   * The 1.x legacy runner's own registry. 2.x has one runtime, so there is nothing here: the lists
   * read empty and answering one fails, which is what sends the app to `session.permission` and
   * `session.question`, where every 2.x request lives.
   */
  const blocked: EngineClient["blocked"] = {
    questions: async () => [],
    permissions: async () => [],
    answerQuestion: async () => unsupported("the legacy question registry"),
    rejectQuestion: async () => unsupported("the legacy question registry"),
    answerPermission: async () => unsupported("the legacy permission registry"),
  }

  const permission: EngineClient["permission"] = {
    pending: async (input) => {
      const directory = input?.location?.directory
      const pending = await call(client.permission.request.list(directory ? { location: { directory } } : undefined))
      return { data: pending.data.map(toPermission) }
    },
    saved: {
      list: async (input) => ({ data: await call(client.permission.saved.list(input)) }),
      remove: async (input) => {
        await call(client.permission.saved.remove({ id: input.id }))
        return nothing()
      },
    },
  }

  /**
   * Configuration (V2-24). 2.x serves its config migrated to its own shape and without the keys it
   * does not know, `flupcode` among them, and writes none of it but its shell. Both lines still load
   * an `opencode.json` in 1.x shape, so the config is read from and written to those files through
   * the harness server, in that shape, and the engine is asked to reload. A folder's settings go to
   * the engine's own folder, as 1.x's `PATCH /config` did. Without a store the config reads as empty
   * and saving says why.
   */
  const configFile = async (scope: "global" | "project", directory?: string) => {
    if (!store) return {}
    const folder = scope === "project" ? (directory ?? (await call(client.location.get())).directory) : undefined
    return (await store.read(scope, folder)).config
  }
  const merged = async (directory?: string) =>
    deepMerge(await configFile("global"), await configFile("project", directory))
  const save = async (scope: "global" | "project", patch: Record<string, unknown>, directory?: string) => {
    if (!store) return unsupported("saving the engine config without the harness server")
    const folder = scope === "project" ? (directory ?? (await call(client.location.get())).directory) : undefined
    await store.patch(scope, patch, folder)
    await call(client.location.reload(at(folder)))
  }
  const config: Pick<EngineClient, "config" | "globalConfig" | "updateConfig" | "updateGlobalConfig" | "reloadConfig"> =
    {
      config: async () => (await merged()) as Awaited<ReturnType<EngineClient["config"]>>,
      globalConfig: async () => (await configFile("global")) as Awaited<ReturnType<EngineClient["globalConfig"]>>,
      updateConfig: (patch) => save("project", patch),
      updateGlobalConfig: (patch) => save("global", patch),
      reloadConfig: async (input) => {
        await call(client.location.reload(at(input?.directory)))
      },
    }

  /**
   * Models, providers and integrations (V2-25). 2.x has only the `/api` ones, so the 1.x directory the
   * providers panel reads is rebuilt from them (`toProviderDirectory`). 2.x keeps a key only as an
   * integration credential: a custom provider in the config gets an integration of its own, and the
   * app already stores a key through `integration.connectKey` right after `auth.set`, so `auth` has
   * nothing left to do. A key in the config is used as it is, so there is nothing to link either.
   */
  const model: EngineClient["model"] = {
    list: async (input) => ({
      data: (await call(client.model.list(where(input?.location?.directory)))).data.map(toModel),
    }),
    directory: async () => ({ providers: [], default: {} }),
    default: async () => {
      const chosen = (await call(client.model.default())).data
      return { data: chosen ? toModel(chosen) : undefined }
    },
  }
  const provider: EngineClient["provider"] = {
    list: async (input) => ({
      data: (await call(client.provider.list(where(input?.location?.directory)))).data.map(toProvider),
    }),
    directory: async () => {
      const [integrations, providers, models] = await Promise.all([
        call(client.integration.list()),
        call(client.provider.list()),
        call(client.model.list()),
      ])
      return toProviderDirectory({ integrations: integrations.data, providers: providers.data, models: models.data })
    },
    // 1.x's own provider sign-in; every 2.x provider signs in through its integration instead.
    auth: async () => ({}),
    oauth: {
      authorize: async () => unsupported("the 1.x provider sign-in"),
      callback: async () => unsupported("the 1.x provider sign-in"),
    },
    linkConfiguredKeys: async () => 0,
    unlinked: async () => [],
  }
  const auth: EngineClient["auth"] = {
    set: async () => nothing(),
    remove: async () => nothing(),
    reload: async () => {
      await call(client.location.reload())
      return nothing()
    },
  }
  // The attempt an OAuth sign-in is waiting on belongs to an integration, which 2.x asks for again.
  const integrationAttempts = new Map<string, string>()
  const integration: EngineClient["integration"] = {
    list: async () => ({ data: (await call(client.integration.list())).data.map(toIntegration) }),
    connectKey: async (input) => {
      await call(
        client.integration.connect.key({
          integrationID: input.integrationID,
          key: input.key,
          ...(input.label ? { label: input.label } : {}),
        }),
      )
      return nothing()
    },
    oauth: async (input) => {
      const methods = (await call(client.integration.get({ integrationID: input.integrationID }))).data.methods
      const methodID = input.methodID ?? methods.find((method) => method.type === "oauth")?.id
      if (!methodID) throw new EngineError(`${input.integrationID} does not sign in with OAuth`)
      const attempt = (
        await call(
          client.integration.oauth.connect({
            integrationID: input.integrationID,
            methodID,
            // 1.x's text answers are 2.x's form answer, by the same keys.
            ...(input.inputs && Object.keys(input.inputs).length ? { answer: input.inputs } : {}),
            ...(input.label ? { label: input.label } : {}),
          }),
        )
      ).data
      integrationAttempts.set(attempt.attemptID, input.integrationID)
      return { data: attempt }
    },
    attempt: {
      status: async (attemptID) => {
        const integrationID = integrationAttempts.get(attemptID)
        if (!integrationID) throw new EngineError(`No sign-in ${attemptID} was started here`)
        const status = (await call(client.integration.oauth.status({ integrationID, attemptID }))).data
        if (status.status !== "pending") integrationAttempts.delete(attemptID)
        return { data: status }
      },
      cancel: async (attemptID) => {
        const integrationID = integrationAttempts.get(attemptID)
        integrationAttempts.delete(attemptID)
        if (integrationID) await call(client.integration.oauth.cancel({ integrationID, attemptID }))
        return nothing()
      },
    },
    disconnect: async (credentialID) => {
      await call(client.credential.remove({ credentialID }))
      return nothing()
    },
  }

  // The OAuth attempt each server's sign-in is waiting on, from `authStart` to `authenticate`.
  const attempts = new Map<string, { integrationID: string; attemptID: string; url: string }>()
  const where = (directory?: string) => (directory ? { location: { directory } } : {})
  /** A server's sign-in is an integration in 2.x, with an OAuth method when it can sign in. */
  const integrationOf = async (server: string, directory?: string) => {
    const servers = await call(client.mcp.list(where(directory)))
    const integrationID = servers.data.find((item) => item.name === server)?.integrationID
    if (!integrationID) throw new EngineError(`MCP server "${server}" has no sign-in`, "McpServerNotFoundError")
    return (await call(client.integration.get({ integrationID, ...where(directory) }))).data
  }

  /**
   * MCP servers (V2-23). 2.x reads the location from `location[directory]`, not `?directory=`. Its
   * `mcp.add` and `mcp.remove` only change the running engine, so a server is kept by writing it
   * into the config files (V2-24), then reloading the location, which connects or drops it.
   */
  const mcp: EngineClient["mcp"] = {
    list: async (input) => ({ data: (await call(client.mcp.list(where(input?.directory)))).data }),
    config: async (input) => ({
      data: ((await merged(input?.directory)).mcp ?? {}) as Awaited<ReturnType<EngineClient["mcp"]["config"]>>["data"],
    }),
    add: async (input) => save(input.scope ?? "global", { mcp: { [input.server]: input.config } }, input.directory),
    // A server's scope is not readable from the list, so removal clears it from both files, as on 1.x.
    remove: async (input) => {
      await save("project", { mcp: { [input.server]: null } }, input.directory)
      await save("global", { mcp: { [input.server]: null } })
    },
    connect: async (input) => {
      await call(client.mcp.connect({ server: input.server, ...where(input.directory) }))
      return nothing()
    },
    disconnect: async (input) => {
      await call(client.mcp.disconnect({ server: input.server, ...where(input.directory) }))
      return nothing()
    },
    /**
     * 2.x signs a server in through its integration's OAuth method: it hands back the URL and an
     * attempt to wait on, where 1.x opened the browser itself.
     */
    authStart: async (input) => {
      const integration = await integrationOf(input.server, input.directory)
      const method = integration.methods.find((item) => item.type === "oauth")
      if (!method) throw new EngineError(`MCP server "${input.server}" does not sign in with OAuth`)
      const attempt = (
        await call(
          client.integration.oauth.connect({
            integrationID: integration.id,
            methodID: method.id,
            ...where(input.directory),
          }),
        )
      ).data
      if (attempt.mode === "code") {
        await client.integration.oauth.cancel({ integrationID: integration.id, attemptID: attempt.attemptID })
        return unsupported("an MCP sign-in that needs a pasted code")
      }
      attempts.set(input.server, { integrationID: integration.id, attemptID: attempt.attemptID, url: attempt.url })
      // 1.x's state names the flow; in 2.x the attempt does.
      return { authorizationUrl: attempt.url, oauthState: attempt.attemptID }
    },
    /** Opens the sign-in in the reader's browser, as 1.x did, and waits for the engine's callback. */
    authenticate: async (input) => {
      const attempt = attempts.get(input.server)
      if (!attempt) throw new EngineError(`No sign-in was started for MCP server "${input.server}"`)
      attempts.delete(input.server)
      openUrl(attempt.url)
      for (;;) {
        const status = (
          await call(
            client.integration.oauth.status({
              integrationID: attempt.integrationID,
              attemptID: attempt.attemptID,
              ...where(input.directory),
            }),
          )
        ).data
        if (status.status === "complete") return nothing()
        if (status.status === "failed") throw new EngineError(status.message)
        if (status.status === "expired") throw new EngineError("The sign-in expired")
        await Bun.sleep(OAUTH_POLL)
      }
    },
    authRemove: async (input) => {
      const integration = await integrationOf(input.server, input.directory)
      await Promise.all(
        integration.connections
          .filter((connection) => connection.type === "credential")
          .map((connection) => call(client.credential.remove({ credentialID: connection.id }))),
      )
      return nothing()
    },
    resources: async (input) =>
      (await call(client.mcp.resource.catalog(where(input?.directory)))).data.resources.map((resource) => ({
        name: resource.name,
        uri: resource.uri,
        ...(resource.description ? { description: resource.description } : {}),
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        client: resource.server,
      })),
  }

  return { session, message, blocked, permission, mcp, model, provider, auth, integration, ...config }
}

/** Reads and patches one scope of the engine's config files, in the 1.x shape (V2-24). */
export type EngineConfigStore = {
  read: (scope: "global" | "project", directory?: string) => Promise<{ path: string; config: Record<string, unknown> }>
  /** Merges `patch` in: objects deeply, `null` removing a key, each `provider` entry whole. */
  patch: (
    scope: "global" | "project",
    patch: Record<string, unknown>,
    directory?: string,
  ) => Promise<{ path: string; changed: boolean }>
}

/** A folder's settings over the global ones, objects merged key by key, as the engine layers them. */
function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  return Object.entries(over).reduce(
    (result, [key, value]) => {
      const current = result[key]
      const both = isRecord(current) && isRecord(value)
      return { ...result, [key]: both ? deepMerge(current, value) : value }
    },
    { ...base },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** How often a sign-in in progress is asked about. */
const OAUTH_POLL = 500

/**
 * What an action returns on 1.x is a legacy record the app never reads (every caller only awaits it),
 * and 2.x answers the same action with no body. This keeps the 1.x type without inventing a record.
 */
function nothing<T>() {
  return undefined as T
}

/** OpenCode 2 reads the location from this header; `?directory=` is ignored there. */
function at(directory?: string) {
  return directory ? { headers: { "x-opencode-directory": encodeURIComponent(directory) } } : undefined
}

/** The engine's declared errors keep their `_tag`, as `EngineError` does for the 1.x adapter. */
async function call<T>(request: Promise<T>) {
  return request.catch((cause: unknown) => {
    const tagged = cause as { _tag?: string; message?: string }
    throw new EngineError(tagged?.message ?? String(cause), tagged?._tag)
  })
}

function nonNull(cursor: { previous?: string | null; next?: string | null }) {
  return {
    ...(cursor.previous ? { previous: cursor.previous } : {}),
    ...(cursor.next ? { next: cursor.next } : {}),
  }
}
