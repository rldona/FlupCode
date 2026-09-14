import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Memory } from "@opencode-ai/schema/memory"
import { Timestamps } from "../database/schema.sql"

/**
 * Durable learned knowledge. `scope` + `scope_id` select who the memory belongs
 * to, while `fingerprint` makes repeated discoveries idempotent per scope.
 */
export const MemoryTable = sqliteTable(
  "memory",
  {
    id: text().$type<Memory.ID>().primaryKey(),
    scope: text().$type<Memory.Scope>().notNull(),
    scope_id: text().notNull(),
    kind: text().$type<Memory.Kind>().notNull(),
    title: text().notNull(),
    content: text().notNull(),
    tags: text({ mode: "json" }).$type<string[]>().notNull(),
    source: text().$type<Memory.Source>().notNull(),
    source_ref: text({ mode: "json" }).$type<Memory.SourceRef>(),
    status: text().$type<Memory.Status>().notNull(),
    confidence: real().notNull(),
    importance: integer().notNull(),
    created_by: text().notNull(),
    directory: text(),
    fingerprint: text().notNull(),
    validated_at: integer(),
    validation: text({ mode: "json" }).$type<Memory.ValidationEncoded>(),
    superseded_by: text().$type<Memory.ID>(),
    time_last_used: integer(),
    use_count: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [
    index("memory_scope_status_idx").on(table.scope, table.scope_id, table.status),
    uniqueIndex("memory_scope_fingerprint_idx").on(table.scope, table.scope_id, table.fingerprint),
    index("memory_status_updated_idx").on(table.status, table.time_updated),
    index("memory_superseded_by_idx").on(table.superseded_by),
  ],
)

/** Per-session audit of which memories were injected and when. */
export const MemoryUseTable = sqliteTable(
  "memory_use",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    session_id: text().notNull(),
    memory_id: text()
      .$type<Memory.ID>()
      .notNull()
      .references(() => MemoryTable.id, { onDelete: "cascade" }),
    agent: text(),
    message_id: text(),
    score: real().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("memory_use_session_time_idx").on(table.session_id, table.time_created),
    index("memory_use_memory_idx").on(table.memory_id),
  ],
)
