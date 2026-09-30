import { OpenCode } from "@opencode/client"
import type { EngineClient } from "../client"
import { engineFetch } from "../transport"
import { EngineError, unsupported } from "./error"
import { toMessages, toSession } from "./v2-convert"

/**
 * The client for an OpenCode 2 engine, through its generated `@opencode/client` (pinned to the same
 * version as the sandbox engine, see packages/engine-contract/src/opencode-v2.ts).
 *
 * It is being built domain by domain against `EngineClient`, the 1.x adapter's type, so the app keeps
 * one contract: sessions and messages here (V2-20), then events (V2-21), permissions and forms
 * (V2-22), MCP (V2-23), config (V2-24) and providers (V2-25). `createClient` picks it once every
 * domain exists. What 2.x removed (sharing, todos, deleting a message, the 1.x replay history) fails
 * with an `UnsupportedByEngine` EngineError, or reads as empty where the app has an empty state.
 */
export function createV2Domains(baseUrl: string) {
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
    // Permissions and forms arrive with V2-22; until then 2.x's pending requests read as none.
    permission: {
      list: async () => ({ data: [] }),
      reply: async () => unsupported("answering a permission yet"),
    },
    question: {
      list: async () => ({ data: [] }),
      reply: async () => unsupported("answering a question yet"),
      reject: async () => unsupported("rejecting a question yet"),
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

  return { session, message }
}

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
