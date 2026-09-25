import { describe, expect, test } from "bun:test"
import { ContentBlockID, LLMEvent } from "@opencode-ai/llm"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { Effect, Layer, Stream } from "effect"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { MemoryV2 } from "@opencode-ai/core/memory"
import { buildPrompt, make, parseCandidates } from "@opencode-ai/core/memory/extract"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const projectID = ProjectV2.ID.make("prj_memory_extract")
const directory = AbsolutePath.make("/project")
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, MemoryV2.node]), [
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of({ directory, project: { id: projectID, directory } })),
    ],
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]), reload: () => Effect.void }))],
  ]),
)

const model = OpenAIResponses.route.with({ provider: "test" }).model({ id: "test-model" })

const streamOf = (text: string) => Stream.make(LLMEvent.textDelta({ id: ContentBlockID.make("text-0"), text }))

describe("MemoryExtract parsing", () => {
  test("parses a valid candidate array", () => {
    const candidates = parseCandidates(
      'Here you go:\n[{"title":"Use pnpm","content":"This project always uses pnpm to install dependencies","kind":"convention","scope":"project","tags":["pnpm"],"confidence":0.8}]',
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ title: "Use pnpm", kind: "convention", scope: "project", confidence: 0.8 })
  })

  test("rejects malformed responses and noise", () => {
    expect(parseCandidates("no json here")).toEqual([])
    expect(parseCandidates("[not json]")).toEqual([])
    expect(parseCandidates('[{"title":"x","content":"Error: boom in the logs"}]')).toEqual([])
  })

  test("falls back to safe kind and scope", () => {
    const candidate = parseCandidates('[{"title":"Something","content":"A durable project fact here"}]')[0]
    expect(candidate.kind).toBe("fact")
    expect(candidate.scope).toBe("project")
    expect(candidate.confidence).toBe(0.6)
  })

  test("builds a bounded prompt", () => {
    expect(buildPrompt("User: hello")).toContain("<transcript>")
    expect(buildPrompt("User: hello")).toContain("User: hello")
  })
})

describe("MemoryExtract extraction", () => {
  it.effect("creates candidate memories from a model response", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      let calls = 0
      const extractor = make({
        memory,
        resolveModel: () => Effect.succeed(model),
        llm: {
          stream: () => {
            calls += 1
            return streamOf(
              '[{"title":"Production deploy","content":"Production uses ./scripts/release.sh then checks /health","kind":"procedure","scope":"project","tags":["deploy"],"confidence":0.7}]',
            )
          },
        },
      })

      const created = yield* extractor.extract({
        sessionID: "ses_extract",
        transcript: "User: how do we deploy?\nAssistant: Production uses ./scripts/release.sh then checks /health",
      })

      expect(calls).toBe(1)
      expect(created).toHaveLength(1)
      expect(created[0]).toMatchObject({ status: "candidate", source: "agent_discovery", createdBy: "extractor" })
      expect((yield* memory.list({ statuses: ["candidate"] })).length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.effect("does not call the model when no small model is configured", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      let calls = 0
      const extractor = make({
        memory,
        resolveModel: () => Effect.succeed(undefined),
        llm: {
          stream: () => {
            calls += 1
            return Stream.empty
          },
        },
      })

      const created = yield* extractor.extract({ sessionID: "ses_extract_none", transcript: "User: deploy please" })
      expect(created).toEqual([])
      expect(calls).toBe(0)
    }),
  )
})
