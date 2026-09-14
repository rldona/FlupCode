export * as PlanExitTool from "./plan-exit"

import { ToolFailure } from "@opencode-ai/llm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "plan_exit"

export const description = `Use this tool when you have completed the planning phase and the plan is ready for the user to approve.

It asks the user whether to switch to the build agent and start implementing, then switches the agent when they approve.

Call this tool:
- After you have presented a complete plan
- After you have clarified any questions with the user
- When you are confident the plan is ready for implementation

Do NOT call this tool:
- Before the plan is finalized
- If you still have unanswered questions about the implementation
- If the user has indicated they want to continue planning`

export const Input = Schema.Struct({})

export const Output = Schema.Struct({
  approved: Schema.Boolean,
})

export type Output = typeof Output.Type

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const question = yield* QuestionV2.Service
    const permission = yield* PermissionV2.Service
    const events = yield* EventV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: output.approved
                ? "The user approved the plan and switched to the build agent. Execute the plan now."
                : "The user chose to keep refining the plan. Stay in plan mode and continue working with them.",
            },
          ],
          execute: (_input, context) =>
            permission
              .assert({
                action: "plan_exit",
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                Effect.mapError(() => new ToolFailure({ message: "Permission denied: plan_exit" })),
                Effect.andThen(
                  Effect.gen(function* () {
                    const answers = yield* question
                      .ask({
                        sessionID: context.sessionID,
                        questions: [
                          {
                            question:
                              "The plan is complete. Would you like to switch to the build agent and start implementing?",
                            header: "Build agent",
                            custom: false,
                            options: [
                              {
                                label: "Yes",
                                description: "Switch to build agent and start implementing the plan",
                              },
                              {
                                label: "No",
                                description: "Stay with plan agent to continue refining the plan",
                              },
                            ],
                          },
                        ],
                        tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                      })
                      .pipe(Effect.orDie)
                    if (answers[0]?.[0] !== "Yes") return { approved: false }
                    // Switching the agent mid-drain makes the next provider turn run as build, so
                    // the model can execute the approved plan without a separate user prompt.
                    yield* events.publish(SessionEvent.AgentSwitched, {
                      sessionID: context.sessionID,
                      messageID: SessionMessage.ID.create(),
                      timestamp: yield* DateTime.now,
                      agent: AgentV2.ID.make("build"),
                    })
                    return { approved: true }
                  }),
                ),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/plan-exit",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, QuestionV2.node, EventV2.node],
})
