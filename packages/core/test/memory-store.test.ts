import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config } from "@opencode-ai/core/config"
import { ConfigMemory } from "@opencode-ai/core/config/memory"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { MemoryV2 } from "@opencode-ai/core/memory"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const projectID = ProjectV2.ID.make("prj_memory_test")
const directory = AbsolutePath.make("/project")

const location = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory,
    project: { id: projectID, directory },
  }),
)

const config = (info?: Config.Info) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      reload: () => Effect.void,
      entries: () => Effect.succeed(info ? [new Config.Document({ type: "document", info })] : ([] as Config.Entry[])),
    }),
  )

const build = (info?: Config.Info) =>
  AppNodeBuilder.build(LayerNode.group([Database.node, MemoryV2.node]), [
    [Location.node, location],
    [Config.node, config(info)],
  ])

const it = testEffect(build())
const configured = testEffect(
  build(
    new Config.Info({
      small_model: "anthropic/claude-haiku",
      memory: new ConfigMemory.Info({ auto: false, max_injected: 3, stale_after_days: 7 }),
    }),
  ),
)

describe("MemoryV2 store", () => {
  it.effect("creates and reads a project memory", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      const created = yield* memory.create({
        scope: "project",
        kind: "procedure",
        title: "Production deploy",
        content: "Run ./scripts/release.sh then check /health",
        tags: ["deploy", "release"],
        source: "agent_discovery",
      })

      expect(created.scope).toBe("project")
      expect(created.scopeID).toBe(projectID)
      expect(created.status).toBe("candidate")
      expect(created.confidence).toBeGreaterThan(0)

      const stored = yield* memory.get(created.id)
      expect(stored?.title).toBe("Production deploy")
      expect(stored?.tags).toEqual(["deploy", "release"])
    }),
  )

  it.effect("merges repeated discoveries instead of duplicating them", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      const first = yield* memory.create({
        scope: "project",
        kind: "convention",
        title: "Use pnpm",
        content: "This project uses pnpm",
        tags: ["pnpm"],
        source: "agent_discovery",
        confidence: 0.4,
      })
      const second = yield* memory.create({
        scope: "project",
        kind: "convention",
        title: "Use pnpm",
        content: "  this project   USES pnpm ",
        tags: ["package-manager"],
        source: "explicit_user",
      })

      expect(second.id).toBe(first.id)
      expect(second.source).toBe("explicit_user")
      expect(second.status).toBe("active")
      expect(second.tags).toEqual(["package-manager", "pnpm"])
      expect(second.confidence).toBeGreaterThanOrEqual(0.95)

      const all = yield* memory.list({ scopes: ["project"] })
      expect(all).toHaveLength(1)
    }),
  )

  it.effect("resolves global, session, and agent scope keys", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      const global = yield* memory.create({
        scope: "global",
        kind: "preference",
        title: "Concise commits",
        content: "Prefer concise commit messages",
        source: "explicit_user",
      })
      const session = yield* memory.create({
        scope: "session",
        kind: "decision",
        title: "Migrating",
        content: "During this session we are migrating X",
        source: "conversation",
        sessionID: "ses_memory_test",
      })
      const agent = yield* memory.create({
        scope: "agent",
        kind: "fact",
        title: "Playwright",
        content: "The test agent uses Playwright",
        source: "agent_tool",
        agent: "test",
      })

      expect(global.scopeID).toBe("global")
      expect(session.scopeID).toBe("ses_memory_test")
      expect(agent.scopeID).toBe(`${projectID}:test`)
    }),
  )

  it.effect("updates and removes memories", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      const created = yield* memory.create({
        scope: "project",
        kind: "issue",
        title: "Known failure",
        content: "The deploy failed because X",
        source: "conversation",
      })

      const updated = yield* memory.update(created.id, { status: "active", importance: 5 })
      expect(updated?.status).toBe("active")
      expect(updated?.importance).toBe(5)

      yield* memory.remove(created.id)
      expect(yield* memory.get(created.id)).toBeUndefined()
    }),
  )

  it.effect("filters by scope, status, and text", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      yield* memory.create({
        scope: "global",
        kind: "preference",
        title: "Output style",
        content: "Always answer in Spanish",
        source: "explicit_user",
      })
      yield* memory.create({
        scope: "project",
        kind: "procedure",
        title: "Tests",
        content: "Run the tests with bun test",
        source: "agent_discovery",
      })

      expect(yield* memory.list({ scopes: ["global"] })).toHaveLength(1)
      expect(yield* memory.list({ statuses: ["candidate"] })).toHaveLength(1)
      expect((yield* memory.list({ text: "spanish" })).at(0)?.title).toBe("Output style")
    }),
  )

  it.effect("marks a memory stale when its file anchor disappears", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      const dir = mkdtempSync(join(tmpdir(), "flupcode-memory-"))
      try {
        mkdirSync(join(dir, "scripts"), { recursive: true })
        writeFileSync(join(dir, "scripts", "deploy.sh"), "#!/bin/sh\n")
        const present = yield* memory.create({
          scope: "project",
          kind: "procedure",
          title: "Deploy",
          content: "Production deploy uses ./scripts/deploy.sh",
          source: "agent_discovery",
          status: "active",
          directory: dir,
        })
        const missing = yield* memory.create({
          scope: "project",
          kind: "procedure",
          title: "Old deploy",
          content: "Production deploy uses ./scripts/legacy.sh",
          source: "agent_discovery",
          status: "active",
          directory: dir,
        })

        const presentVerified = yield* memory.verify(present.id)
        const missingVerified = yield* memory.verify(missing.id)

        expect(presentVerified?.validation?.anchors[0]?.value).toBe("./scripts/deploy.sh")
        expect(presentVerified?.validation?.anchors[0]?.ok).toBe(true)
        expect(missingVerified?.status).toBe("stale")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )

  it.effect("records retrieval usage per session", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      const created = yield* memory.create({
        scope: "project",
        kind: "procedure",
        title: "Deploy",
        content: "Run ./scripts/release.sh",
        source: "agent_discovery",
      })

      yield* memory.recordUse({ sessionID: "ses_memory_use", memoryIDs: [created.id], agent: "build", score: 3 })
      yield* memory.recordUse({ sessionID: "ses_memory_use", memoryIDs: [created.id], agent: "build", score: 3 })

      const used = yield* memory.used("ses_memory_use")
      expect(used).toHaveLength(1)
      expect(used[0]?.id).toBe(created.id)
      expect((yield* memory.get(created.id))?.useCount).toBe(2)
    }),
  )

  configured.effect("reads memory settings from config", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      const settings = yield* memory.settings()

      expect(settings.auto).toBe(false)
      expect(settings.maxInjected).toBe(3)
      expect(settings.staleAfterDays).toBe(7)
      expect(settings.model).toBe("anthropic/claude-haiku")
    }),
  )
})
