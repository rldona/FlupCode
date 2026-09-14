import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { MemoryV2 } from "@opencode-ai/core/memory"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { MemoryTool } from "@opencode-ai/core/tool/memory"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_memory_tool")
const projectID = ProjectV2.ID.make("prj_memory_tool")
const directory = AbsolutePath.make("/project")
const assertions: PermissionV2.AssertInput[] = []

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, MemoryTool.node, MemoryV2.node]), [
    [PermissionV2.node, permission],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of({ directory, project: { id: projectID, directory } })),
    ],
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)

const call = (id: string, input: Record<string, unknown>) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "memory", input },
})

describe("MemoryTool", () => {
  it.effect("adds a memory and lists it back", () =>
    Effect.gen(function* () {
      assertions.length = 0
      const registry = yield* ToolRegistry.Service
      const memory = yield* MemoryV2.Service

      expect((yield* toolDefinitions(registry)).map((definition) => definition.name)).toContain("memory")

      const added = yield* settleTool(
        registry,
        call("call-memory-add", {
          action: "add",
          title: "Production deploy",
          content: "Production deploy uses ./scripts/release.sh",
          tags: ["deploy"],
        }),
      )
      expect(added.result.type).toBe("text")
      expect(assertions[0]).toMatchObject({ action: "memory", resources: ["*"] })

      const stored = yield* memory.list({ text: "release" })
      expect(stored).toHaveLength(1)
      expect(stored[0]?.createdBy).toBe("build")

      const listed = yield* settleTool(registry, call("call-memory-list", { action: "list", query: "release" }))
      expect(listed.result.type).toBe("text")
      if (listed.result.type === "text") expect(listed.result.value).toContain("Production deploy")
    }),
  )

  it.effect("forgets a memory by id", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const memory = yield* MemoryV2.Service

      const created = yield* memory.create({
        scope: "project",
        kind: "fact",
        title: "Temporary",
        content: "A temporary fact",
        source: "agent_tool",
      })
      yield* settleTool(registry, call("call-memory-forget", { action: "forget", id: created.id }))
      expect(yield* memory.get(created.id)).toBeUndefined()
    }),
  )
})
