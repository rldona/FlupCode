import { Location } from "@opencode-ai/schema/location"
import { Memory } from "@opencode-ai/schema/memory"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { MemoryNotFoundError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const OptionalString = Schema.String.pipe(Schema.optional)

export const MemoryListQuery = Schema.Struct({
  ...LocationQuery.fields,
  text: OptionalString,
  scope: Memory.Scope.pipe(Schema.optional),
  status: Memory.Status.pipe(Schema.optional),
  sessionID: OptionalString,
  agent: OptionalString,
  limit: OptionalString,
}).annotate({ identifier: "MemoryListQuery" })

export const MemoryCreatePayload = Schema.Struct({
  scope: Memory.Scope.pipe(Schema.optional),
  kind: Memory.Kind.pipe(Schema.optional),
  title: Schema.String,
  content: Schema.String,
  tags: Schema.Array(Schema.String).pipe(Schema.optional),
  status: Memory.Status.pipe(Schema.optional),
  confidence: Schema.Finite.pipe(Schema.optional),
  importance: Schema.Int.pipe(Schema.optional),
  source: Memory.Source.pipe(Schema.optional),
  sessionID: OptionalString,
  agent: OptionalString,
}).annotate({ identifier: "MemoryCreatePayload" })

export const MemoryUpdatePayload = Schema.Struct({
  title: OptionalString,
  content: OptionalString,
  kind: Memory.Kind.pipe(Schema.optional),
  tags: Schema.Array(Schema.String).pipe(Schema.optional),
  status: Memory.Status.pipe(Schema.optional),
  confidence: Schema.Finite.pipe(Schema.optional),
  importance: Schema.Int.pipe(Schema.optional),
}).annotate({ identifier: "MemoryUpdatePayload" })

export const MemoryGroup = HttpApiGroup.make("server.memory")
  .add(
    HttpApiEndpoint.get("memory.list", "/api/memory", {
      query: MemoryListQuery,
      success: Location.response(Schema.Array(Memory.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.list",
          summary: "List memories",
          description: "List durable memories for a location, optionally filtered by text, scope, or status.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("memory.get", "/api/memory/:id", {
      params: { id: Memory.ID },
      success: Location.response(Memory.Info),
      error: MemoryNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.get",
        summary: "Get memory",
        description: "Retrieve one durable memory by ID.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("memory.create", "/api/memory", {
      payload: MemoryCreatePayload,
      success: Location.response(Memory.Info),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.create",
        summary: "Create memory",
        description: "Create a durable memory, merging it with an equivalent existing memory.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("memory.update", "/api/memory/:id", {
      params: { id: Memory.ID },
      payload: MemoryUpdatePayload,
      success: Location.response(Memory.Info),
      error: MemoryNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.update",
        summary: "Update memory",
        description: "Edit a memory's content, metadata, or status.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("memory.remove", "/api/memory/:id", {
      params: { id: Memory.ID },
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.remove",
        summary: "Remove memory",
        description: "Permanently forget a durable memory.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("memory.verify", "/api/memory/:id/verify", {
      params: { id: Memory.ID },
      success: Location.response(Memory.Info),
      error: MemoryNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.verify",
        summary: "Verify memory",
        description: "Re-check the file, command, and URL anchors referenced by a memory.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("memory.used", "/api/memory/session/:sessionID", {
      params: { sessionID: Schema.String },
      success: Location.response(Schema.Array(Memory.Info)),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.used",
        summary: "List memories used in a session",
        description: "List the memories retrieved for a session, for the context inspector.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "memory",
      description: "Persistent learned knowledge for the user, project, agents, and sessions.",
    }),
  )
