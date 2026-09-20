import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { MemoryV2 } from "@opencode-ai/core/memory"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const projectID = ProjectV2.ID.make("prj_memory_retrieval")
const directory = AbsolutePath.make("/project")
const location = Layer.succeed(
  Location.Service,
  Location.Service.of({ directory, project: { id: projectID, directory } }),
)
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([] as Config.Entry[]) }))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, MemoryV2.node]), [
    [Location.node, location],
    [Config.node, config],
  ]),
)

describe("MemoryV2 retrieval", () => {
  it.effect("ranks lexical matches above unrelated memories", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      yield* memory.create({
        scope: "project",
        kind: "procedure",
        title: "Production deploy",
        content: "Production deploy uses ./scripts/release.sh",
        tags: ["deploy"],
        source: "agent_discovery",
        status: "active",
      })
      yield* memory.create({
        scope: "project",
        kind: "procedure",
        title: "Run tests",
        content: "Run the tests with bun test",
        tags: ["tests"],
        source: "agent_discovery",
        status: "active",
      })

      const matches = yield* memory.retrieve({ sessionID: "ses_r1", query: "how do I deploy production?" })
      expect(matches[0]?.memory.title).toBe("Production deploy")
      expect(matches.map((match) => match.memory.title)).not.toContain("Run tests")
    }),
  )

  it.effect("injects important global preferences even without a lexical match", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      yield* memory.create({
        scope: "global",
        kind: "preference",
        title: "Answer in Spanish",
        content: "Always answer in Spanish",
        source: "explicit_user",
        importance: 5,
        status: "active",
      })

      const matches = yield* memory.retrieve({ sessionID: "ses_r2", query: "zzz unrelated request" })
      expect(matches.map((match) => match.memory.title)).toContain("Answer in Spanish")
    }),
  )

  it.effect("excludes stale and archived memories", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      const created = yield* memory.create({
        scope: "project",
        kind: "procedure",
        title: "Legacy deploy",
        content: "Legacy deploy uses ./scripts/legacy.sh",
        tags: ["deploy"],
        source: "agent_discovery",
        status: "active",
      })
      yield* memory.update(created.id, { status: "stale" })

      const matches = yield* memory.retrieve({ sessionID: "ses_r3", query: "legacy deploy" })
      expect(matches).toHaveLength(0)
    }),
  )

  it.effect("isolates agent memories to the matching agent", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      yield* memory.create({
        scope: "agent",
        kind: "fact",
        title: "Playwright",
        content: "The test agent uses Playwright for end to end tests",
        tags: ["playwright"],
        source: "agent_tool",
        agent: "test",
        status: "active",
      })

      const other = yield* memory.retrieve({ sessionID: "ses_r4", agent: "build", query: "playwright" })
      const own = yield* memory.retrieve({ sessionID: "ses_r4", agent: "test", query: "playwright" })
      expect(other).toHaveLength(0)
      expect(own.map((match) => match.memory.title)).toContain("Playwright")
    }),
  )

  it.effect("never injects two contradictory memories together", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      yield* memory.create({
        scope: "project",
        kind: "convention",
        title: "Use npm",
        content: "Always use npm to install dependencies",
        tags: ["package-manager"],
        source: "agent_discovery",
        status: "active",
      })
      yield* memory.create({
        scope: "project",
        kind: "convention",
        title: "Use pnpm",
        content: "Always use pnpm to install dependencies",
        tags: ["package-manager"],
        source: "explicit_user",
        status: "active",
      })

      const matches = yield* memory.retrieve({ sessionID: "ses_r5", query: "install dependencies" })
      const titles = matches.map((match) => match.memory.title)
      expect(titles).toContain("Use pnpm")
      expect(titles).not.toContain("Use npm")
    }),
  )

  it.effect("respects the injected memory limit", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      for (const index of [1, 2, 3]) {
        yield* memory.create({
          scope: "project",
          kind: "fact",
          title: `Deploy note ${index}`,
          content: `Deploy note number ${index}`,
          tags: ["deploy"],
          source: "agent_discovery",
          status: "active",
        })
      }

      const matches = yield* memory.retrieve({ sessionID: "ses_r6", query: "deploy", limit: 1 })
      expect(matches).toHaveLength(1)
    }),
  )
})
