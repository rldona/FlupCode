export * as Memory from "./memory"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"

/**
 * Durable learned knowledge about the user, project, repository, agents, or a
 * single session. Memory is retrieved by relevance and injected per provider
 * turn; it is never a full dump of everything the harness has seen.
 */
export const ID = Schema.String.check(Schema.isStartsWith("mem_")).pipe(
  Schema.brand("Memory.ID"),
  statics((schema) => ({ create: () => schema.make("mem_" + ascending()) })),
)
export type ID = typeof ID.Type

/** Where a memory applies. Repository knowledge shares `project` scope. */
export const Scope = Schema.Literals(["global", "project", "agent", "session"])
export type Scope = typeof Scope.Type

export const Kind = Schema.Literals([
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
export type Kind = typeof Kind.Type

/** How the memory entered the store. Source participates in conflict resolution. */
export const Source = Schema.Literals([
  "explicit_user",
  "agent_tool",
  "agent_discovery",
  "repository_file",
  "conversation",
  "tool_result",
  "manual",
  "import",
])
export type Source = typeof Source.Type

/** Candidate memories await review; stale ones failed validation but stay editable. */
export const Status = Schema.Literals(["candidate", "active", "stale", "archived"])
export type Status = typeof Status.Type

/** A verifiable reference found in memory content, such as a script or file path. */
export const ValidationAnchor = Schema.Struct({
  kind: Schema.Literals(["file", "directory", "command", "url", "script", "config"]),
  value: Schema.String,
  ok: Schema.Boolean,
  checkedAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Memory.ValidationAnchor" })
export interface ValidationAnchor extends Schema.Schema.Type<typeof ValidationAnchor> {}

export const Validation = Schema.Struct({
  anchors: Schema.Array(ValidationAnchor),
}).annotate({ identifier: "Memory.Validation" })
export interface Validation extends Schema.Schema.Type<typeof Validation> {}
export type ValidationEncoded = (typeof Validation)["Encoded"]

/** Where a memory came from: the session, message, tool call, or file that produced it. */
export const SourceRef = Schema.Struct({
  sessionID: Schema.String.pipe(optional),
  messageID: Schema.String.pipe(optional),
  toolCallID: Schema.String.pipe(optional),
  path: Schema.String.pipe(optional),
  url: Schema.String.pipe(optional),
}).annotate({ identifier: "Memory.SourceRef" })
export interface SourceRef extends Schema.Schema.Type<typeof SourceRef> {}

export const Info = Schema.Struct({
  id: ID,
  scope: Scope,
  /** `global`, a project ID, `projectID:agentID`, or a session ID. */
  scopeID: Schema.String,
  kind: Kind,
  title: Schema.String,
  content: Schema.String,
  tags: Schema.Array(Schema.String),
  source: Source,
  sourceRef: SourceRef.pipe(optional),
  status: Status,
  confidence: Schema.Finite,
  importance: NonNegativeInt,
  createdBy: Schema.String,
  /** Repository anchor for project memories discovered in a worktree directory. */
  directory: Schema.String.pipe(optional),
  validatedAt: DateTimeUtcFromMillis.pipe(optional),
  validation: Validation.pipe(optional),
  /** The memory that replaced this one after a contradiction. */
  supersededBy: ID.pipe(optional),
  timeCreated: DateTimeUtcFromMillis,
  timeUpdated: DateTimeUtcFromMillis,
  timeLastUsed: DateTimeUtcFromMillis.pipe(optional),
  useCount: NonNegativeInt,
}).annotate({ identifier: "Memory.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

/** A memory together with why it matched a search, for the manager UI. */
export const Match = Schema.Struct({
  memory: Info,
  score: Schema.Finite,
}).annotate({ identifier: "Memory.Match" })
export interface Match extends Schema.Schema.Type<typeof Match> {}

export const SearchQuery = Schema.Struct({
  text: Schema.String.pipe(optional),
  scopes: Schema.Array(Scope).pipe(optional),
  statuses: Schema.Array(Status).pipe(optional),
  projectID: Schema.String.pipe(optional),
  sessionID: Schema.String.pipe(optional),
  agent: Schema.String.pipe(optional),
  limit: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "Memory.SearchQuery" })
export interface SearchQuery extends Schema.Schema.Type<typeof SearchQuery> {}
