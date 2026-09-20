export * as MemoryExtract from "./extract"

import { LLM, LLMClient, LLMEvent, type LLMError, type LLMRequest, Message, type Model } from "@opencode-ai/llm"
import { Context, Effect, Layer, Stream } from "effect"
import { Memory } from "@opencode-ai/schema/memory"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { MemoryV2 } from "../memory"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { SessionMessage } from "../session/message"
import { SessionRunnerModel } from "../session/runner/model"

export type Candidate = {
  readonly title: string
  readonly content: string
  readonly kind: Memory.Kind
  readonly scope: Memory.Scope
  readonly tags: string[]
  readonly confidence: number
}

const KINDS = new Set<string>([
  "fact",
  "convention",
  "procedure",
  "preference",
  "constraint",
  "workflow",
  "decision",
  "issue",
  "solution",
])
const SCOPES = new Set<string>(["global", "project", "agent", "session"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isKind = (value: unknown): value is Memory.Kind => typeof value === "string" && KINDS.has(value)
const isScope = (value: unknown): value is Memory.Scope => typeof value === "string" && SCOPES.has(value)

const INSTRUCTIONS = `Extract durable knowledge that a future coding session should not have to rediscover.

Include:
- project conventions, architecture, and decisions
- deployment, release, test, and build procedures with exact commands
- user preferences and persistent instructions
- constraints, known issues, and solutions that worked
- stable repository facts and important paths

Exclude:
- temporary output, logs, stack traces, or one-off errors
- generated code, diffs, or normal question/answer chatter
- anything already obvious from a single file you have not verified
- secrets, credentials, or personal data

Respond with ONLY a JSON array. Each item:
{"title": string, "content": string, "kind": "fact|convention|procedure|preference|constraint|workflow|decision|issue|solution", "scope": "global|project|agent|session", "tags": string[], "confidence": number}

Return at most 5 items. Prefer an empty array [] over low-value items.`

/** Bounds the transcript so extraction stays cheap regardless of session length. */
export function serializeRecent(messages: ReadonlyArray<SessionMessage.Message>, limit = 40): string {
  const lines: string[] = []
  for (const message of messages.slice(-limit)) {
    if (message.type === "user") lines.push(`User: ${message.text}`)
    else if (message.type === "assistant") {
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim().length > 0) lines.push(`Assistant: ${part.text}`)
        else if (part.type === "tool") lines.push(`Assistant tool call: ${part.name}`)
      }
    }
  }
  const joined = lines.join("\n")
  return joined.length > 6000 ? joined.slice(-6000) : joined
}

export const buildPrompt = (transcript: string) =>
  [
    "Here is recent work from a coding session:",
    "",
    "<transcript>",
    transcript,
    "</transcript>",
    "",
    INSTRUCTIONS,
  ].join("\n")

/** Parses the model response into validated candidates, rejecting noise. */
export function parseCandidates(text: string): Candidate[] {
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) return []
  let decoded: unknown
  try {
    decoded = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(decoded)) return []
  return decoded.flatMap((item): Candidate[] => {
    if (!isRecord(item)) return []
    const record = item
    const title = typeof record.title === "string" ? record.title.trim() : ""
    const content = typeof record.content === "string" ? record.content.trim() : ""
    if (title.length < 3 || content.length < 8 || content.length > 2000) return []
    if (/^\s*(error|traceback|stack trace)/i.test(content)) return []
    const kind = isKind(record.kind) ? record.kind : "fact"
    const scope = isScope(record.scope) ? record.scope : "project"
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 8)
      : []
    const confidence =
      typeof record.confidence === "number" && Number.isFinite(record.confidence)
        ? Math.max(0, Math.min(1, record.confidence))
        : 0.6
    return [{ title: title.slice(0, 200), content, kind, scope, tags, confidence }]
  })
}

export type Dependencies = {
  readonly memory: MemoryV2.Interface
  readonly resolveModel: () => Effect.Effect<Model | undefined>
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
}

export type Input = {
  readonly sessionID: string
  readonly agent?: string
  readonly directory?: string
  readonly transcript: string
}

/**
 * Runs one cheap extraction pass. It never throws: a missing model, provider
 * error, or malformed response simply yields no candidates, so background
 * extraction can never disturb a session.
 */
export const make = (dependencies: Dependencies) => {
  const lastRun = new Map<string, number>()
  const extract = Effect.fn("MemoryExtract.extract")(function* (input: Input) {
    const settings = yield* dependencies.memory.settings()
    if (!settings.enabled || !settings.auto) return []
    if (input.transcript.trim().length < 40) return []
    const previous = lastRun.get(input.sessionID)
    const now = Date.now()
    if (previous !== undefined && now - previous < settings.extractInterval * 60_000) return []
    const model = yield* dependencies.resolveModel()
    if (!model) return []
    lastRun.set(input.sessionID, now)

    const chunks: string[] = []
    yield* dependencies.llm
      .stream(
        LLM.request({
          model,
          messages: [Message.user(buildPrompt(input.transcript))],
          tools: [],
          generation: { maxTokens: 1024 },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.catchTag("LLM.Error", () => Effect.void),
      )
    const candidates = parseCandidates(chunks.join("")).slice(0, settings.maxCandidatesPerSession)
    return yield* Effect.forEach(candidates, (candidate) =>
      dependencies.memory.create({
        scope: candidate.scope,
        kind: candidate.kind,
        title: candidate.title,
        content: candidate.content,
        tags: candidate.tags,
        source: "agent_discovery",
        status: "candidate",
        confidence: candidate.confidence,
        createdBy: "extractor",
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.directory ? { directory: input.directory } : {}),
      }),
    )
  })
  return { extract }
}

export interface Interface {
  readonly extract: (input: Input) => Effect.Effect<Memory.Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/MemoryExtractor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const memory = yield* MemoryV2.Service
    const models = yield* SessionRunnerModel.Service
    const llm = yield* LLMClient.Service
    const resolveModel = () =>
      Effect.gen(function* () {
        const settings = yield* memory.settings()
        if (!settings.model) return undefined
        const slash = settings.model.indexOf("/")
        if (slash <= 0) return undefined
        return yield* models
          .resolveRef({
            providerID: ProviderV2.ID.make(settings.model.slice(0, slash)),
            id: ModelV2.ID.make(settings.model.slice(slash + 1)),
          })
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
      })
    const service = make({ memory, llm, resolveModel })
    return Service.of({ extract: service.extract })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [MemoryV2.node, SessionRunnerModel.node, llmClient],
})
