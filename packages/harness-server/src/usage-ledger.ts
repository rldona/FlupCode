/**
 * The usage ledger (UL-01, audit §8.4).
 *
 * One append-only store of billable facts: a row per provider step, failed step, compaction, title
 * or any other call that spent tokens, and a row per finished tool. Every cost figure the app shows
 * is meant to come from here, so a number without a row behind it is a bug.
 *
 * Rows are keyed by the engine's own event id (or `sessionID:kind:sourceID` where the engine has
 * none), and a row is never updated: posting the same fact twice, from the plugin and later from the
 * reconciler, stores it once.
 *
 * The plugin reports what the engine did. Which run, task, routine or workflow caused it is the
 * server's to say (UL-04), so the ingest route drops any attribution a caller sends.
 */

import { basename, dirname } from "node:path"
import { childEnv } from "./child-env"

export const USAGE_KINDS = ["step", "step_failed", "compaction", "title", "generate", "adaptive", "external"] as const
export type UsageKind = (typeof USAGE_KINDS)[number]

export const COST_BASES = ["engine-list-price", "flupcode-priced", "provider-reported", "unpriced"] as const
export type CostBasis = (typeof COST_BASES)[number]

export const BILLINGS = ["metered", "subscription", "local", "unknown"] as const
export type Billing = (typeof BILLINGS)[number]

export const PURPOSES = [
  "chat",
  "run-task",
  "handoff",
  "commit-message",
  "suggestion",
  "adaptive",
  "title",
  "compaction",
] as const
export type UsagePurpose = (typeof PURPOSES)[number]

export type UsageTokens = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

/** What the engine reported about one billable fact. */
export type UsageEvent = {
  id: string
  kind: UsageKind
  sessionID: string
  parentSessionID?: string
  rootSessionID?: string
  messageID?: string
  turnID?: string
  engineSeq?: number
  agent?: string
  providerID?: string
  modelID?: string
  variant?: string
  tokens: UsageTokens
  /** What the engine reported; absent when nothing priced it, which is shown as unpriced, never $0. */
  costUSD?: number
  costBasis: CostBasis
  billing: Billing
  startedAt?: number
  endedAt?: number
  firstTokenMs?: number
  finish?: string
  errorType?: string
  retryAttempt?: number
  directory?: string
  engineProjectID?: string
}

/** Which FlupCode primitive caused a fact. Written by the server, never taken from the caller. */
export type UsageAttribution = {
  runID?: string
  taskID?: string
  attempt?: number
  routineID?: string
  workflowName?: string
  workflowHash?: string
  purpose?: UsagePurpose
  tags?: Record<string, string>
}

export type LedgerEvent = UsageEvent & UsageAttribution

/**
 * Who a session works for (UL-04), kept once per session in `session_attribution`.
 *
 * The server writes it when it opens a session for a run, a task's closing note or a commit message.
 * A session the server did not open is learnt from the engine the first time the ledger hears of
 * it: a subagent names its parent and inherits from it, field by field, nearest first; a top-level
 * session nobody stamped is a person's conversation, a `chat`. `directory` is the repository root,
 * with worktrees resolved to the checkout they belong to.
 */
export type SessionAttribution = Omit<UsageAttribution, "tags"> & { parentSessionID?: string; directory?: string }

/** What the engine says of a session, as `Engine.describeSession` answers. */
export type SessionDescriber = (
  sessionID: string,
) => Promise<{ directory: string; parentID?: string; createdAt: number } | undefined>

/**
 * The purpose a fact has whatever session it happened in: a title or a compaction in a run's task
 * is still billed to the run, but it is the engine's own overhead and is labelled as such.
 */
export const KIND_PURPOSE: Partial<Record<UsageKind, UsagePurpose>> = {
  title: "title",
  compaction: "compaction",
  adaptive: "adaptive",
}

export type ToolEvent = {
  id: string
  sessionID: string
  messageID?: string
  tool: string
  startedAt?: number
  ms: number
  error: boolean
  bytes: number
}

export type UsageRepository = {
  /** Stores what it has not seen, by id, attributed; returns how many rows were new. */
  recordUsage(batch: { events: LedgerEvent[]; tools: ToolEvent[] }): { events: number; tools: number }
  /** Whether the session already has an attribution row, of any source. */
  knowsSession(sessionID: string): boolean
  attributeSession(sessionID: string, attribution: SessionAttribution, source?: "server" | "engine"): void
  /** When attribution started: an unstamped session created before it may be anything. */
  attributionSince(): number
}

/** The most items one POST may carry, per list. A plugin with more sends more batches. */
export const MAX_USAGE_BATCH = 500
/** The largest body the route reads: a full batch of long-named events fits well inside it. */
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_ID = 512
const MAX_NAME = 256
const MAX_PATH = 4096

/**
 * `POST /harness/usage/events` with `{ events?: [], tools?: [] }`. The caller is the plugin, already
 * checked. A malformed item is skipped and named in `rejected`, so one bad event cannot block the
 * batch it came with from ever being delivered; the valid ones are stored.
 */
export async function handleUsageIngest(
  request: Request,
  repository: UsageRepository,
  describe?: SessionDescriber,
  classify?: <T extends UsageEvent>(events: T[]) => Promise<T[]>,
  /** The sessions that got new rows, once they are stored: where budgets are decided (UL-08). */
  onStored?: (sessionIDs: string[]) => void,
) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return tooLarge()
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return tooLarge()
  const body = parse(text)
  if (!body)
    return Response.json(
      { error: "Expected a JSON object with events and tools", code: "invalid_body" },
      { status: 400 },
    )
  const events = body.events ?? []
  const tools = body.tools ?? []
  if (!Array.isArray(events) || !Array.isArray(tools))
    return Response.json({ error: "events and tools must be lists", code: "invalid_body" }, { status: 400 })
  if (events.length > MAX_USAGE_BATCH || tools.length > MAX_USAGE_BATCH)
    return Response.json(
      { error: `At most ${MAX_USAGE_BATCH} events and ${MAX_USAGE_BATCH} tools per batch`, code: "batch_too_large" },
      { status: 413 },
    )
  const parsedEvents = events.map(usageEventFrom)
  const parsedTools = tools.map(toolEventFrom)
  const valid = parsedEvents.filter((event): event is UsageEvent => typeof event !== "string")
  if (describe)
    for (const sessionID of new Set(valid.map((event) => event.sessionID))) await learnSession(sessionID, repository, describe)
  const stored = repository.recordUsage({
    // The plugin reports the engine's list price and no billing; the server says what it can (UL-05).
    events: classify ? await classify(valid) : valid,
    tools: parsedTools.filter((tool): tool is ToolEvent => typeof tool !== "string"),
  })
  if (stored.events > 0) onStored?.([...new Set(valid.map((event) => event.sessionID))])
  const rejected = [
    ...parsedEvents.flatMap((event, index) =>
      typeof event === "string" ? [{ list: "events", index, error: event }] : [],
    ),
    ...parsedTools.flatMap((tool, index) => (typeof tool === "string" ? [{ list: "tools", index, error: tool }] : [])),
  ]
  return Response.json({ data: { stored, rejected } })
}

/** One event as the wire carries it, or why it was refused. Attribution fields are not read. */
export function usageEventFrom(input: unknown): UsageEvent | string {
  if (!isRecord(input)) return "not an object"
  const id = text(input.id, MAX_ID)
  if (!id) return "id is required"
  if (!USAGE_KINDS.includes(input.kind as UsageKind)) return `kind must be one of ${USAGE_KINDS.join(", ")}`
  const sessionID = text(input.sessionID, MAX_ID)
  if (!sessionID) return "sessionID is required"
  const tokens = tokensFrom(input.tokens)
  if (!tokens) return "tokens must hold non-negative input, output, reasoning, cacheRead and cacheWrite"
  if (!COST_BASES.includes(input.costBasis as CostBasis)) return `costBasis must be one of ${COST_BASES.join(", ")}`
  if (!BILLINGS.includes(input.billing as Billing)) return `billing must be one of ${BILLINGS.join(", ")}`
  if (input.costUSD !== undefined && count(input.costUSD) === undefined) return "costUSD must be a non-negative number"
  return {
    id,
    kind: input.kind as UsageKind,
    sessionID,
    tokens,
    costBasis: input.costBasis as CostBasis,
    billing: input.billing as Billing,
    ...optional("parentSessionID", text(input.parentSessionID, MAX_ID)),
    ...optional("rootSessionID", text(input.rootSessionID, MAX_ID)),
    ...optional("messageID", text(input.messageID, MAX_ID)),
    ...optional("turnID", text(input.turnID, MAX_ID)),
    ...optional("engineSeq", count(input.engineSeq)),
    ...optional("agent", text(input.agent, MAX_NAME)),
    ...optional("providerID", text(input.providerID, MAX_NAME)),
    ...optional("modelID", text(input.modelID, MAX_NAME)),
    ...optional("variant", text(input.variant, MAX_NAME)),
    ...optional("costUSD", count(input.costUSD)),
    ...optional("startedAt", count(input.startedAt)),
    ...optional("endedAt", count(input.endedAt)),
    ...optional("firstTokenMs", count(input.firstTokenMs)),
    ...optional("finish", text(input.finish, MAX_NAME)),
    ...optional("errorType", text(input.errorType, MAX_NAME)),
    ...optional("retryAttempt", count(input.retryAttempt)),
    ...optional("directory", text(input.directory, MAX_PATH)),
    ...optional("engineProjectID", text(input.engineProjectID, MAX_ID)),
  }
}

export function toolEventFrom(input: unknown): ToolEvent | string {
  if (!isRecord(input)) return "not an object"
  const id = text(input.id, MAX_ID)
  if (!id) return "id is required"
  const sessionID = text(input.sessionID, MAX_ID)
  if (!sessionID) return "sessionID is required"
  const tool = text(input.tool, MAX_NAME)
  if (!tool) return "tool is required"
  const ms = count(input.ms)
  const bytes = count(input.bytes)
  if (ms === undefined || bytes === undefined) return "ms and bytes must be non-negative numbers"
  if (typeof input.error !== "boolean") return "error must be a boolean"
  return {
    id,
    sessionID,
    tool,
    ms,
    bytes,
    error: input.error,
    ...optional("messageID", text(input.messageID, MAX_ID)),
    ...optional("startedAt", count(input.startedAt)),
  }
}

/**
 * Records who a session the server did not open works for, from what the engine says of it: its
 * parent (learnt first, so the chain is there to inherit from) and its folder. A top-level session
 * created since attribution started is a chat; one from before is left without a purpose, since an
 * old run's closing note looks the same. An engine that cannot answer records nothing, so the
 * session's next event asks again and fills in the rows stored meanwhile.
 */
export async function learnSession(
  sessionID: string,
  repository: Pick<UsageRepository, "knowsSession" | "attributeSession" | "attributionSince">,
  describe: SessionDescriber,
  depth = 0,
) {
  if (depth > 16 || repository.knowsSession(sessionID)) return
  const session = await describe(sessionID).catch(() => null)
  if (session === null) return
  if (session?.parentID) await learnSession(session.parentID, repository, describe, depth + 1)
  repository.attributeSession(
    sessionID,
    {
      ...(session?.parentID ? { parentSessionID: session.parentID } : {}),
      ...(session ? { directory: session.directory } : {}),
      ...(session && !session.parentID && session.createdAt >= repository.attributionSince()
        ? { purpose: "chat" as const }
        : {}),
    },
    "engine",
  )
}

const roots = new Map<string, string>()

/**
 * The checkout a folder belongs to: a worktree resolves to the repository it was made from, so a
 * project's cost is one figure however many trees its runs used. Anything else, a plain checkout, a
 * subfolder or a folder outside git, is kept as it is. Asked of git once per folder per process.
 */
export function repositoryRoot(directory: string) {
  const known = roots.get(directory)
  if (known) return known
  const result = Bun.spawnSync(
    ["git", "-C", directory, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    { stdout: "pipe", stderr: "ignore", env: childEnv() },
  )
  const [own, common] = result.success ? result.stdout.toString().trim().split("\n") : []
  // A worktree's own git folder differs from the common one, which is the main checkout's `.git`.
  const root = own && common && own !== common && basename(common) === ".git" ? dirname(common) : directory
  roots.set(directory, root)
  return root
}

function tooLarge() {
  return Response.json({ error: "The batch is too large", code: "batch_too_large" }, { status: 413 })
}

function parse(body: string) {
  try {
    const value: unknown = JSON.parse(body)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function tokensFrom(input: unknown): UsageTokens | undefined {
  if (!isRecord(input)) return undefined
  const tokens = {
    input: count(input.input),
    output: count(input.output),
    reasoning: count(input.reasoning),
    cacheRead: count(input.cacheRead),
    cacheWrite: count(input.cacheWrite),
  }
  if (Object.values(tokens).some((value) => value === undefined)) return undefined
  return tokens as UsageTokens
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown, max: number) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function optional<K extends string, V>(key: K, value: V | undefined) {
  return (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>
}
