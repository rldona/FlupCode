import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
// A pull that a test wants to hold open, so a reload can land while a list is still loading.
let pullGate: { url: string; started: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      const gate = pullGate
      if (!gate || gate.url !== url) return Effect.succeed(urls.get(url) ?? [])
      return Effect.gen(function* () {
        yield* Deferred.succeed(gate.started, undefined)
        yield* Deferred.await(gate.release)
        return urls.get(url) ?? []
      })
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [[SkillDiscovery.node, discovery]]),
)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

describe("SkillV2", () => {
  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "review", "Second")
            await fs.writeFile(path.join(first, "foo.md"), "---\nslash: true\n---\n# foo")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          expect(yield* skill.list()).toEqual([
            SkillV2.Info.make({
              name: "foo",
              slash: true,
              location: AbsolutePath.make(path.join(first, "foo.md")),
              content: "# foo",
            }),
            {
              name: "review",
              description: "Second",
              location: AbsolutePath.make(path.join(second, "review", "SKILL.md")),
              content: "# review",
            },
          ])
        }),
      ),
    ),
  )

  it.live("reload refreshes cached skill contents from disk", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const dir = path.join(tmp.path, "skills")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(dir, "alpha"), { recursive: true })
            await write(dir, "alpha", "Alpha")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(dir) }))
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["alpha"])

          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(dir, "beta"), { recursive: true })
            await write(dir, "beta", "Beta")
            await fs.rm(path.join(dir, "alpha"), { recursive: true })
          })
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["alpha"])

          yield* skill.reload()
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["beta"])
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect(pulls).toBe(1)
          expect(SkillV2.available(yield* skill.list(), (yield* agents.get(AgentV2.ID.make("reviewer")))!)).toEqual([])
        }),
      ),
    ),
  )

  it.live("a reload while a list is loading does not let it cache the stale read", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const dir = path.join(tmp.path, "skills")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(dir, "alpha"), { recursive: true })
            await write(dir, "alpha", "Alpha")
          })
          const url = "https://example.test/race/"
          urls.set(url, [AbsolutePath.make(dir)])

          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          pullGate = { url, started, release }
          yield* Effect.addFinalizer(() => Effect.sync(() => (pullGate = undefined)))

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url }))

          // The list misses the cache and blocks inside its source pull; the reload lands while it
          // is still loading, so its read is pre-reload content.
          const loading = yield* skill.list().pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* skill.reload()
          yield* Deferred.succeed(release, undefined)
          expect((yield* Fiber.join(loading)).map((item) => item.name)).toEqual(["alpha"])

          // Change the source on disk: the next list must answer from a fresh read, not from what
          // the interrupted one tried to cache after the reload.
          yield* Effect.promise(async () => {
            await fs.rm(path.join(dir, "alpha"), { recursive: true })
            await fs.mkdir(path.join(dir, "beta"), { recursive: true })
            await write(dir, "beta", "Beta")
          })
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["beta"])
        }),
      ),
    ),
  )
})
