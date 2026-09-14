export * as MemoryV2 from "./memory"

import { and, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { isAbsolute, join } from "path"
import { Memory } from "@opencode-ai/schema/memory"
import { Config } from "./config"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { MemoryTable, MemoryUseTable } from "./memory/sql"
import {
  contradicts,
  estimateTokens,
  explicitCandidates,
  extractAnchors,
  fingerprint,
  lexicalScore,
  mergeStatus,
  normalizeContent,
  renderMemoryBlock,
  scopeWeight,
  strongestSource,
  tokenize,
  unionTags,
} from "./memory/utils"

export const ID = Memory.ID
export type ID = Memory.ID
export const Info = Memory.Info
export type Info = Memory.Info
export { extractAnchors, fingerprint, normalizeContent }

export type CreateInput = {
  readonly scope: Memory.Scope
  readonly kind: Memory.Kind
  readonly title: string
  readonly content: string
  readonly tags?: ReadonlyArray<string>
  readonly source: Memory.Source
  readonly sourceRef?: Memory.SourceRef
  readonly status?: Memory.Status
  readonly confidence?: number
  readonly importance?: number
  readonly createdBy?: string
  readonly directory?: string
  readonly sessionID?: string
  readonly agent?: string
  /** Explicit override; normally derived from the active location and scope. */
  readonly scopeID?: string
}

export type UpdateInput = {
  readonly title?: string
  readonly content?: string
  readonly kind?: Memory.Kind
  readonly tags?: ReadonlyArray<string>
  readonly source?: Memory.Source
  readonly sourceRef?: Memory.SourceRef
  readonly status?: Memory.Status
  readonly confidence?: number
  readonly importance?: number
  readonly supersededBy?: Memory.ID | null
}

export type Settings = {
  readonly enabled: boolean
  readonly auto: boolean
  readonly model?: string
  readonly maxInjected: number
  readonly maxTokens: number
  readonly staleAfterDays: number
  readonly extractInterval: number
  readonly maxCandidatesPerSession: number
}

const DEFAULTS: Settings = {
  enabled: true,
  auto: true,
  maxInjected: 8,
  maxTokens: 1000,
  staleAfterDays: 90,
  extractInterval: 30,
  maxCandidatesPerSession: 20,
}

const confidenceFor = (source: Memory.Source): number => {
  switch (source) {
    case "explicit_user":
      return 0.95
    case "manual":
      return 0.9
    case "agent_tool":
      return 0.8
    case "repository_file":
      return 0.8
    case "agent_discovery":
      return 0.6
    case "import":
      return 0.5
    case "tool_result":
      return 0.5
    case "conversation":
      return 0.4
    default:
      return 0.4
  }
}

const statusFor = (source: Memory.Source): Memory.Status =>
  source === "explicit_user" || source === "manual" ? "active" : "candidate"

const encodeValidation = Schema.encodeSync(Memory.Validation)
const decodeValidation = Schema.decodeUnknownSync(Memory.Validation)

const fromRow = (row: typeof MemoryTable.$inferSelect): Memory.Info =>
  Memory.Info.make({
    id: row.id,
    scope: row.scope,
    scopeID: row.scope_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    tags: row.tags,
    source: row.source,
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    status: row.status,
    confidence: row.confidence,
    importance: row.importance,
    createdBy: row.created_by,
    ...(row.directory ? { directory: row.directory } : {}),
    ...(row.validated_at !== null ? { validatedAt: DateTime.makeUnsafe(row.validated_at) } : {}),
    ...(row.validation ? { validation: decodeValidation(row.validation) } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    timeCreated: DateTime.makeUnsafe(row.time_created),
    timeUpdated: DateTime.makeUnsafe(row.time_updated),
    ...(row.time_last_used !== null ? { timeLastUsed: DateTime.makeUnsafe(row.time_last_used) } : {}),
    useCount: row.use_count,
  })

export interface Interface {
  readonly settings: () => Effect.Effect<Settings>
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly update: (id: Memory.ID, patch: UpdateInput) => Effect.Effect<Info | undefined>
  readonly remove: (id: Memory.ID) => Effect.Effect<void>
  readonly get: (id: Memory.ID) => Effect.Effect<Info | undefined>
  readonly list: (query?: Memory.SearchQuery) => Effect.Effect<Info[]>
  readonly used: (sessionID: string) => Effect.Effect<Info[]>
  readonly recordUse: (input: {
    readonly sessionID: string
    readonly memoryIDs: ReadonlyArray<Memory.ID>
    readonly agent?: string
    readonly messageID?: string
    readonly score?: number
  }) => Effect.Effect<void>
  readonly verify: (id: Memory.ID) => Effect.Effect<Info | undefined>
  readonly retrieve: (input: {
    readonly sessionID: string
    readonly agent?: string
    readonly query: string
    readonly limit?: number
    readonly maxTokens?: number
  }) => Effect.Effect<Memory.Match[]>
  readonly captureExplicit: (input: {
    readonly text: string
    readonly sessionID: string
    readonly agent?: string
    readonly createdBy?: string
  }) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Memory") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service

    const findRow = Effect.fn("MemoryV2.findRow")(function* (id: Memory.ID) {
      return yield* db.select().from(MemoryTable).where(eq(MemoryTable.id, id)).get().pipe(Effect.orDie)
    })

    const findFingerprint = Effect.fn("MemoryV2.findFingerprint")(function* (
      scope: Memory.Scope,
      scopeID: string,
      fp: string,
    ) {
      return yield* db
        .select()
        .from(MemoryTable)
        .where(and(eq(MemoryTable.scope, scope), eq(MemoryTable.scope_id, scopeID), eq(MemoryTable.fingerprint, fp)))
        .get()
        .pipe(Effect.orDie)
    })

    const resolveScopeID = (input: CreateInput): string => {
      if (input.scopeID) return input.scopeID
      if (input.scope === "global") return "global"
      if (input.scope === "session") return input.sessionID ?? `session:${location.project.id}`
      if (input.scope === "agent") return `${location.project.id}:${input.agent ?? "default"}`
      return location.project.id
    }

    const writeRow = (id: Memory.ID, patch: Partial<typeof MemoryTable.$inferInsert>) =>
      db.update(MemoryTable).set(patch).where(eq(MemoryTable.id, id)).run().pipe(Effect.orDie)

    const create = Effect.fn("MemoryV2.create")(function* (input: CreateInput) {
      const scopeID = resolveScopeID(input)
      const now = Date.now()
      const fp = fingerprint(input.content)
      const existing = yield* findFingerprint(input.scope, scopeID, fp)
      if (existing) {
        const status = input.status ?? statusFor(input.source)
        yield* writeRow(existing.id, {
          tags: unionTags(existing.tags, input.tags ?? []),
          importance: Math.max(existing.importance, input.importance ?? 3),
          confidence: Math.max(existing.confidence, input.confidence ?? confidenceFor(input.source)),
          status: mergeStatus(existing.status, status),
          source: strongestSource(existing.source, input.source),
          ...(input.sourceRef ? { source_ref: input.sourceRef } : {}),
          time_updated: now,
        })
        return fromRow((yield* findRow(existing.id))!)
      }
      const id = Memory.ID.create()
      yield* db
        .insert(MemoryTable)
        .values({
          id,
          scope: input.scope,
          scope_id: scopeID,
          kind: input.kind,
          title: input.title,
          content: input.content,
          tags: [...(input.tags ?? [])],
          source: input.source,
          source_ref: input.sourceRef ?? null,
          status: input.status ?? statusFor(input.source),
          confidence: input.confidence ?? confidenceFor(input.source),
          importance: input.importance ?? 3,
          created_by: input.createdBy ?? "unknown",
          directory: input.directory ?? null,
          fingerprint: fp,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      return fromRow((yield* findRow(id))!)
    })

    const applyUpdate = Effect.fn("MemoryV2.applyUpdate")(function* (id: Memory.ID, patch: UpdateInput) {
      const current = yield* findRow(id)
      if (!current) return
      const nextContent = patch.content ?? current.content
      const fp = fingerprint(nextContent)
      const collision =
        fp === current.fingerprint ? undefined : yield* findFingerprint(current.scope, current.scope_id, fp)
      if (collision && collision.id !== id) {
        yield* writeRow(collision.id, {
          tags: unionTags(collision.tags, patch.tags ?? current.tags),
          importance: Math.max(collision.importance, patch.importance ?? current.importance),
          confidence: Math.max(collision.confidence, patch.confidence ?? current.confidence),
          status: mergeStatus(collision.status, patch.status ?? current.status),
          time_updated: Date.now(),
        })
        yield* db.delete(MemoryTable).where(eq(MemoryTable.id, id)).run().pipe(Effect.orDie)
        return
      }
      yield* writeRow(id, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.content !== undefined ? { content: patch.content, fingerprint: fp } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
        ...(patch.source !== undefined ? { source: patch.source } : {}),
        ...(patch.sourceRef !== undefined ? { source_ref: patch.sourceRef } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
        ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
        ...(patch.supersededBy !== undefined ? { superseded_by: patch.supersededBy } : {}),
        time_updated: Date.now(),
      })
    })

    const update = Effect.fn("MemoryV2.update")(function* (id: Memory.ID, patch: UpdateInput) {
      const current = yield* findRow(id)
      if (!current) return undefined
      yield* applyUpdate(id, patch)
      const stored = yield* findRow(id)
      if (stored) return fromRow(stored)
      // A fingerprint collision merged this memory into an existing row.
      const fp = fingerprint(patch.content ?? current.content)
      const canonical = yield* findFingerprint(current.scope, current.scope_id, fp)
      return canonical ? fromRow(canonical) : undefined
    })

    const get = Effect.fn("MemoryV2.get")(function* (id: Memory.ID) {
      const row = yield* findRow(id)
      return row ? fromRow(row) : undefined
    })

    const remove = Effect.fn("MemoryV2.remove")(function* (id: Memory.ID) {
      yield* db.delete(MemoryTable).where(eq(MemoryTable.id, id)).run().pipe(Effect.orDie)
    })

    const list = Effect.fn("MemoryV2.list")(function* (query?: Memory.SearchQuery) {
      const conditions = []
      if (query?.scopes && query.scopes.length > 0) conditions.push(inArray(MemoryTable.scope, [...query.scopes]))
      if (query?.statuses && query.statuses.length > 0)
        conditions.push(inArray(MemoryTable.status, [...query.statuses]))
      if (query?.projectID) conditions.push(eq(MemoryTable.scope_id, query.projectID))
      if (query?.sessionID) conditions.push(eq(MemoryTable.scope_id, query.sessionID))
      if (query?.agent) conditions.push(like(MemoryTable.scope_id, `%:${query.agent}`))
      const rows = yield* db
        .select()
        .from(MemoryTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(MemoryTable.time_updated))
        .limit(query?.limit ?? 500)
        .all()
        .pipe(Effect.orDie)
      const memories = rows.map(fromRow)
      if (!query?.text) return memories
      const needle = normalizeContent(query.text)
      if (needle.length === 0) return memories
      return memories.filter((memory) =>
        normalizeContent(`${memory.title} ${memory.content} ${memory.tags.join(" ")}`).includes(needle),
      )
    })

    const used = Effect.fn("MemoryV2.used")(function* (sessionID: string) {
      const rows = yield* db
        .select()
        .from(MemoryUseTable)
        .where(eq(MemoryUseTable.session_id, sessionID))
        .orderBy(desc(MemoryUseTable.time_created))
        .all()
        .pipe(Effect.orDie)
      const ids = Array.from(new Set(rows.map((row) => row.memory_id)))
      if (ids.length === 0) return []
      const stored = yield* db.select().from(MemoryTable).where(inArray(MemoryTable.id, ids)).all().pipe(Effect.orDie)
      const byID = new Map(stored.map((row) => [row.id, fromRow(row)] as const))
      return ids.flatMap((id) => {
        const memory = byID.get(id)
        return memory ? [memory] : []
      })
    })

    const recordUse = Effect.fn("MemoryV2.recordUse")(function* (input: {
      readonly sessionID: string
      readonly memoryIDs: ReadonlyArray<Memory.ID>
      readonly agent?: string
      readonly messageID?: string
      readonly score?: number
    }) {
      const ids = Array.from(new Set(input.memoryIDs))
      if (ids.length === 0) return
      const now = Date.now()
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(MemoryUseTable)
              .values(
                ids.map((memoryID) => ({
                  session_id: input.sessionID,
                  memory_id: memoryID,
                  agent: input.agent ?? null,
                  message_id: input.messageID ?? null,
                  score: input.score ?? 0,
                  time_created: now,
                })),
              )
              .run()
            yield* tx
              .update(MemoryTable)
              .set({ use_count: sql`${MemoryTable.use_count} + 1`, time_last_used: now })
              .where(inArray(MemoryTable.id, ids))
              .run()
          }),
        )
        .pipe(Effect.orDie)
    })

    const verify = Effect.fn("MemoryV2.verify")(function* (id: Memory.ID) {
      const row = yield* findRow(id)
      if (!row) return undefined
      const anchors = extractAnchors(`${row.title}\n${row.content}`)
      const base = row.directory ?? location.project.directory
      const now = DateTime.makeUnsafe(Date.now())
      const checked = yield* Effect.forEach(anchors, (anchor) =>
        Effect.gen(function* () {
          if (anchor.kind === "url") return { ...anchor, checkedAt: now }
          if (anchor.kind === "command") {
            const binary = anchor.value.split(/\s+/)[0] ?? anchor.value
            const ok = typeof Bun === "undefined" ? true : Bun.which(binary) !== null
            return { ...anchor, ok, checkedAt: now }
          }
          const target = isAbsolute(anchor.value) ? anchor.value : join(base, anchor.value)
          const ok = anchor.kind === "directory" ? yield* fs.isDir(target) : yield* fs.existsSafe(target)
          return { ...anchor, ok, checkedAt: now }
        }),
      )
      const failed = checked.some((anchor) => !anchor.ok)
      const status: Memory.Status = failed ? "stale" : row.status === "stale" ? "active" : row.status
      yield* writeRow(id, {
        validation: encodeValidation({ anchors: checked }),
        validated_at: Date.now(),
        status,
        time_updated: Date.now(),
      })
      return fromRow((yield* findRow(id))!)
    })

    const settings = Effect.fn("MemoryV2.settings")(function* () {
      const entries = yield* config.entries()
      const memory = Config.latest(entries, "memory")
      const small = Config.latest(entries, "small_model")
      return {
        enabled: memory?.enabled ?? DEFAULTS.enabled,
        auto: memory?.auto ?? DEFAULTS.auto,
        ...((memory?.model ?? small) ? { model: memory?.model ?? small } : {}),
        maxInjected: memory?.max_injected ?? DEFAULTS.maxInjected,
        maxTokens: memory?.max_tokens ?? DEFAULTS.maxTokens,
        staleAfterDays: memory?.stale_after_days ?? DEFAULTS.staleAfterDays,
        extractInterval: memory?.extract_interval ?? DEFAULTS.extractInterval,
        maxCandidatesPerSession: memory?.max_candidates_per_session ?? DEFAULTS.maxCandidatesPerSession,
      }
    })

    const rankScore = (memory: Memory.Info, tokens: ReadonlyArray<string>, now: number) => {
      const lexical = lexicalScore(tokens, memory)
      const broadlyUseful = memory.scope === "global" && memory.importance >= 4
      if (lexical === 0 && !broadlyUseful) return Number.NEGATIVE_INFINITY
      const last = memory.timeLastUsed ?? memory.timeUpdated
      const ageDays = Math.max(0, (now - DateTime.toEpochMillis(last)) / 86_400_000)
      const recency = ageDays < 7 ? 0.6 : ageDays < 30 ? 0.3 : 0
      return lexical + scopeWeight(memory.scope) + memory.importance * 0.4 + memory.confidence * 1.5 + recency
    }

    const retrieve = Effect.fn("MemoryV2.retrieve")(function* (input: {
      readonly sessionID: string
      readonly agent?: string
      readonly query: string
      readonly limit?: number
      readonly maxTokens?: number
    }) {
      const resolved = yield* settings()
      if (!resolved.enabled) return []
      const projectID = location.project.id
      const rows = yield* db
        .select()
        .from(MemoryTable)
        .where(
          and(
            inArray(MemoryTable.status, ["active", "candidate"]),
            isNull(MemoryTable.superseded_by),
            or(
              eq(MemoryTable.scope, "global"),
              and(eq(MemoryTable.scope, "project"), eq(MemoryTable.scope_id, projectID)),
              and(eq(MemoryTable.scope, "agent"), eq(MemoryTable.scope_id, `${projectID}:${input.agent ?? "default"}`)),
              and(eq(MemoryTable.scope, "session"), eq(MemoryTable.scope_id, input.sessionID)),
            ),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const now = Date.now()
      const tokens = tokenize(input.query)
      const ranked = rows
        .map(fromRow)
        .map((memory) => ({ memory, score: rankScore(memory, tokens, now) }))
        .filter((entry) => Number.isFinite(entry.score))
        .sort((a, b) => b.score - a.score)

      const limit = input.limit ?? resolved.maxInjected
      const maxTokens = input.maxTokens ?? resolved.maxTokens
      const selected: Memory.Match[] = []
      let budget = 0
      for (const entry of ranked) {
        if (selected.length >= limit) break
        if (selected.some((chosen) => contradicts(chosen.memory, entry.memory))) continue
        const cost = estimateTokens(renderMemoryBlock([entry.memory]))
        if (selected.length > 0 && budget + cost > maxTokens) continue
        budget += cost
        selected.push(Memory.Match.make({ memory: entry.memory, score: entry.score }))
      }
      return selected
    })

    const captureExplicit = Effect.fn("MemoryV2.captureExplicit")(function* (input: {
      readonly text: string
      readonly sessionID: string
      readonly agent?: string
      readonly createdBy?: string
    }) {
      const resolved = yield* settings()
      if (!resolved.enabled || input.text.trim().length === 0) return []
      return yield* Effect.forEach(explicitCandidates(input.text), (candidate) =>
        create({
          scope: candidate.scope,
          kind: candidate.kind,
          title: candidate.title,
          content: candidate.content,
          source: "explicit_user",
          status: "active",
          confidence: 0.95,
          importance: 4,
          createdBy: input.createdBy ?? "user",
          sessionID: input.sessionID,
          ...(candidate.agent ? { agent: candidate.agent } : input.agent ? { agent: input.agent } : {}),
          sourceRef: { sessionID: input.sessionID },
        }),
      )
    })

    return Service.of({
      settings,
      create,
      update,
      remove,
      get,
      list,
      used,
      recordUse,
      verify,
      retrieve,
      captureExplicit,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, Config.node, FSUtil.node, Location.node],
})
