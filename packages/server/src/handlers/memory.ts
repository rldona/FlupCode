import { Location } from "@opencode-ai/core/location"
import { MemoryV2 } from "@opencode-ai/core/memory"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { MemoryNotFoundError } from "@opencode-ai/protocol/errors"
import { response } from "../location"

function missing(id: MemoryV2.ID) {
  return new MemoryNotFoundError({ memoryID: id, message: `Memory not found: ${id}` })
}

export const MemoryHandler = HttpApiBuilder.group(Api, "server.memory", (handlers) =>
  handlers
    .handle("memory.list", (ctx) =>
      response(
        Effect.gen(function* () {
          const memory = yield* MemoryV2.Service
          const limit = ctx.query.limit ? Number.parseInt(ctx.query.limit, 10) : undefined
          return yield* memory.list({
            ...(ctx.query.text ? { text: ctx.query.text } : {}),
            ...(ctx.query.scope ? { scopes: [ctx.query.scope] } : {}),
            ...(ctx.query.status ? { statuses: [ctx.query.status] } : {}),
            ...(ctx.query.sessionID ? { sessionID: ctx.query.sessionID } : {}),
            ...(ctx.query.agent ? { agent: ctx.query.agent } : {}),
            ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
          })
        }),
      ),
    )
    .handle("memory.get", (ctx) =>
      response(
        Effect.gen(function* () {
          const memory = yield* (yield* MemoryV2.Service).get(ctx.params.id)
          if (!memory) return yield* missing(ctx.params.id)
          return memory
        }),
      ),
    )
    .handle("memory.create", (ctx) =>
      response(
        Effect.gen(function* () {
          const location = yield* Location.Service
          return yield* (yield* MemoryV2.Service).create({
            scope: ctx.payload.scope ?? "project",
            kind: ctx.payload.kind ?? "fact",
            title: ctx.payload.title,
            content: ctx.payload.content,
            tags: ctx.payload.tags ?? [],
            source: ctx.payload.source ?? "manual",
            status: ctx.payload.status,
            confidence: ctx.payload.confidence,
            importance: ctx.payload.importance,
            createdBy: "user",
            directory: location.directory,
            sessionID: ctx.payload.sessionID,
            agent: ctx.payload.agent,
          })
        }),
      ),
    )
    .handle("memory.update", (ctx) =>
      response(
        Effect.gen(function* () {
          const updated = yield* (yield* MemoryV2.Service).update(ctx.params.id, {
            ...(ctx.payload.title !== undefined ? { title: ctx.payload.title } : {}),
            ...(ctx.payload.content !== undefined ? { content: ctx.payload.content } : {}),
            ...(ctx.payload.kind !== undefined ? { kind: ctx.payload.kind } : {}),
            ...(ctx.payload.tags !== undefined ? { tags: ctx.payload.tags } : {}),
            ...(ctx.payload.status !== undefined ? { status: ctx.payload.status } : {}),
            ...(ctx.payload.confidence !== undefined ? { confidence: ctx.payload.confidence } : {}),
            ...(ctx.payload.importance !== undefined ? { importance: ctx.payload.importance } : {}),
          })
          if (!updated) return yield* missing(ctx.params.id)
          return updated
        }),
      ),
    )
    .handle("memory.remove", (ctx) =>
      Effect.gen(function* () {
        yield* (yield* MemoryV2.Service).remove(ctx.params.id)
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle("memory.verify", (ctx) =>
      response(
        Effect.gen(function* () {
          const verified = yield* (yield* MemoryV2.Service).verify(ctx.params.id)
          if (!verified) return yield* missing(ctx.params.id)
          return verified
        }),
      ),
    )
    .handle("memory.used", (ctx) =>
      response(Effect.flatMap(MemoryV2.Service, (memory) => memory.used(ctx.params.sessionID))),
    ),
)
