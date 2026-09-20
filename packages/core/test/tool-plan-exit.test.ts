import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { PlanExitTool } from "@opencode-ai/core/tool/plan-exit"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_plan_exit_tool_test")
const published: Array<{ readonly type: string; readonly data: unknown }> = []
const assertions: PermissionV2.AssertInput[] = []
let captured: QuestionV2.AskInput | undefined
const capturedInput = () => captured
let answer = "Yes"
let deny = false

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const question = Layer.succeed(
  QuestionV2.Service,
  QuestionV2.Service.of({
    ask: (input: QuestionV2.AskInput) =>
      Effect.sync(() => {
        captured = input
      }).pipe(Effect.andThen(Effect.succeed([[answer]]))),
    reply: () => Effect.die("unused"),
    reject: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const events = Layer.succeed(
  EventV2.Service,
  EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        published.push({
          type: definition.durable ? EventV2.versionedType(definition.type, definition.durable.version) : definition.type,
          data,
        })
        return { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
      }),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    durable: () => Stream.empty,
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, PlanExitTool.node]), [
    [PermissionV2.node, permission],
    [QuestionV2.node, question],
    [EventV2.node, events],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)

const call = (id: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "plan_exit", input: {} },
})

describe("PlanExitTool", () => {
  it.effect("switches to the build agent and tells the model to execute when approved", () =>
    Effect.gen(function* () {
      published.length = 0
      assertions.length = 0
      captured = undefined
      answer = "Yes"
      deny = false
      const registry = yield* ToolRegistry.Service

      const settlement = yield* settleTool(registry, call("call-plan-exit-yes"))

      expect(settlement.result).toEqual({
        type: "text",
        value: "The user approved the plan and switched to the build agent. Execute the plan now.",
      })
      expect(settlement.output).toMatchObject({ structured: { approved: true } })
      expect(assertions).toMatchObject([{ sessionID, action: "plan_exit", resources: ["*"] }])
      expect(capturedInput()?.sessionID).toBe(sessionID)
      expect(published).toHaveLength(1)
      expect(published[0].type).toBe(EventV2.versionedType(SessionEvent.AgentSwitched.type, 1))
      expect(published[0].data).toMatchObject({ sessionID, agent: "build" })
    }),
  )

  it.effect("keeps the plan agent when the user declines", () =>
    Effect.gen(function* () {
      published.length = 0
      captured = undefined
      answer = "No"
      deny = false
      const registry = yield* ToolRegistry.Service

      const settlement = yield* settleTool(registry, call("call-plan-exit-no"))

      expect(settlement.result).toEqual({
        type: "text",
        value: "The user chose to keep refining the plan. Stay in plan mode and continue working with them.",
      })
      expect(settlement.output).toMatchObject({ structured: { approved: false } })
      expect(published).toEqual([])
    }),
  )

  it.effect("omits the tool and refuses a stale call without plan_exit permission", () =>
    Effect.gen(function* () {
      captured = undefined
      deny = true
      const registry = yield* ToolRegistry.Service

      expect(
        yield* toolDefinitions(registry, [
          { action: "plan_exit", resource: "*", effect: "deny" },
        ]),
      ).toEqual([])
      expect(yield* settleTool(registry, call("call-plan-exit-denied"))).toEqual({
        result: { type: "error", value: "Permission denied: plan_exit" },
      })
      expect(capturedInput()).toBeUndefined()
      deny = false
    }),
  )
})
