export * as MemoryTool from "./memory"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Memory } from "@opencode-ai/schema/memory"
import { makeLocationNode } from "../effect/app-node"
import { MemoryV2 } from "../memory"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "memory"

export const Input = Schema.Struct({
  action: Schema.Literals(["add", "update", "forget", "list"]).annotate({
    description: "add a durable memory, update one, forget one, or list what is currently remembered",
  }),
  id: Memory.ID.pipe(Schema.optional).annotate({ description: "Memory id for update or forget" }),
  title: Schema.String.pipe(Schema.optional).annotate({ description: "Short one-line label for an added memory" }),
  content: Schema.String.pipe(Schema.optional).annotate({ description: "The remembered fact, rule, or procedure" }),
  kind: Memory.Kind.pipe(Schema.optional),
  scope: Memory.Scope.pipe(Schema.optional).annotate({
    description: "Where the memory applies; defaults to the current project",
  }),
  tags: Schema.Array(Schema.String).pipe(Schema.optional),
  query: Schema.String.pipe(Schema.optional).annotate({ description: "Filter for the list action" }),
})

export const Output = Schema.Struct({
  memories: Schema.Array(Memory.Info),
})

export const toModelOutput = (output: (typeof Output)["Encoded"]) =>
  JSON.stringify(
    output.memories.map((memory) => ({
      id: memory.id,
      scope: memory.scope,
      kind: memory.kind,
      title: memory.title,
      content: memory.content,
      status: memory.status,
    })),
  )

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const memory = yield* MemoryV2.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Persist durable knowledge about this project, repository, user, or agent across sessions. Use it when you discover or are told stable facts, conventions, procedures, constraints, or preferences that would otherwise be rediscovered. Do not store temporary output, logs, or one-off errors.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              if (input.action === "list") {
                const memories = yield* memory.list({ text: input.query, limit: 20 })
                return { memories }
              }
              if (input.action === "forget") {
                if (!input.id) return yield* new ToolFailure({ message: "id is required to forget a memory" })
                yield* memory.remove(input.id)
                return { memories: [] }
              }
              if (input.action === "update") {
                if (!input.id) return yield* new ToolFailure({ message: "id is required to update a memory" })
                const updated = yield* memory.update(input.id, {
                  ...(input.title !== undefined ? { title: input.title } : {}),
                  ...(input.content !== undefined ? { content: input.content } : {}),
                  ...(input.kind !== undefined ? { kind: input.kind } : {}),
                  ...(input.tags !== undefined ? { tags: input.tags } : {}),
                })
                return { memories: updated ? [updated] : [] }
              }
              if (!input.title || !input.content)
                return yield* new ToolFailure({ message: "title and content are required to add a memory" })
              const created = yield* memory.create({
                scope: input.scope ?? "project",
                kind: input.kind ?? "fact",
                title: input.title,
                content: input.content,
                tags: input.tags ?? [],
                source: "agent_tool",
                status: "candidate",
                createdBy: context.agent,
                sessionID: context.sessionID,
                agent: context.agent,
                sourceRef: { sessionID: context.sessionID, toolCallID: context.toolCallID },
              })
              return { memories: [created] }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to update memory" }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/memory",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, MemoryV2.node],
})
