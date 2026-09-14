import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { MemoryV2 } from "@opencode-ai/core/memory"
import { explicitCandidates, parseExplicit } from "@opencode-ai/core/memory/utils"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const projectID = ProjectV2.ID.make("prj_memory_explicit")
const directory = AbsolutePath.make("/project")
const itEffect = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, MemoryV2.node]), [
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of({ directory, project: { id: projectID, directory } })),
    ],
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
  ]),
)

describe("explicit memory parsing", () => {
  test("extracts clauses from English and Spanish instructions", () => {
    expect(parseExplicit("Remember that we always use pnpm.")).toEqual(["we always use pnpm"])
    expect(parseExplicit("No olvides que production nunca se despliega a mano.")).toEqual([
      "production nunca se despliega a mano",
    ])
    expect(
      parseExplicit("Remember that this project uses pnpm. Remember that I prefer concise commit messages."),
    ).toEqual(["this project uses pnpm", "I prefer concise commit messages"])
    expect(parseExplicit("Just a normal question?")).toEqual([])
  })

  test("infers scope from cues", () => {
    const project = explicitCandidates("Remember that this project uses pnpm.")[0]
    const global = explicitCandidates("Remember that I prefer concise commit messages.")[0]
    const agent = explicitCandidates("Remember that the release agent must check CI before publishing.")[0]

    expect(project.scope).toBe("project")
    expect(global.scope).toBe("global")
    expect(global.kind).toBe("preference")
    expect(agent.scope).toBe("agent")
    expect(agent.agent).toBe("release")
  })
})

describe("MemoryV2.captureExplicit", () => {
  itEffect.effect("stores explicit memories with the resolved scope and active status", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      const created = yield* memory.captureExplicit({
        text: "Remember that this project uses pnpm. Remember that I prefer concise commit messages.",
        sessionID: "ses_explicit",
      })

      expect(created).toHaveLength(2)
      expect(created.every((entry) => entry.source === "explicit_user")).toBe(true)
      expect(created.every((entry) => entry.status === "active")).toBe(true)
      expect(created.map((entry) => entry.scope).toSorted()).toEqual(["global", "project"])

      const stored = yield* memory.list({ statuses: ["active"] })
      expect(stored).toHaveLength(2)
    }),
  )

  itEffect.effect("attributes a named agent instruction to that agent", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      const created = yield* memory.captureExplicit({
        text: "Remember that the release agent must check CI before publishing.",
        sessionID: "ses_explicit_agent",
        agent: "build",
      })

      expect(created[0]?.scope).toBe("agent")
      expect(created[0]?.scopeID).toBe(`${projectID}:release`)
    }),
  )

  itEffect.effect("stores nothing when the prompt has no explicit instruction", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      const created = yield* memory.captureExplicit({ text: "Can you fix the failing build?", sessionID: "ses_x" })
      expect(created).toEqual([])
    }),
  )
})
